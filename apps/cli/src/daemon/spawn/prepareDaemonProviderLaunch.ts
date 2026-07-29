import { join } from 'node:path';

import type {
    BackendTargetRefV2,
    SessionModelSelectionV1,
    SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import {
    ConnectedServiceBindingsV1Schema,
    createProviderErrorV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { configuration } from '@/configuration';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { prepareProviderLaunch } from '@/providers/lifecycle/prepareLaunch';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type { ProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import {
    getActiveAccountSettingsSnapshot,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { validateSpawnProfileEnvironment } from '@/settings/profiles/validateSpawnProfile';
import { logger } from '@/ui/logger';
import type {
    ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnPluginRuntimeLease } from './spawnPluginRuntimeLease';
import { buildProviderSpawnErrorResult } from './buildProviderSpawnErrorResult';

type PreparedDaemonProviderLaunch = Readonly<{
    ok: true;
    options: SpawnSessionOptions;
    attempt: ProviderSpawnAuthorizationAttempt | null;
    agentTargetKey: string | null;
    providerSessionId: string | null;
}>;

type DaemonProviderLaunchRefusal = Readonly<{
    ok: false;
    result: Extract<SpawnSessionResult, { type: 'error' }>;
}>;

export async function prepareDaemonProviderLaunch(input: Readonly<{
    options: SpawnSessionOptions;
    effectiveBackendTarget: BackendTargetRefV2;
    catalogAgentId: CatalogAgentId | null;
    modelSelection?: SessionModelSelectionV1;
    profileEnvironmentVariables: Readonly<Record<string, string>>;
    daemonSpawnHooks: DaemonSpawnHooks | null;
    persistedProviderBinding: SessionProviderBindingMetadataV1 | null;
    normalizedExistingSessionId: string;
    pluginRuntimeLease: SpawnPluginRuntimeLease;
    launchResourceScope: ProviderLaunchResourceScope;
    resolveProvidersFeatureEnabled?: () => boolean | Promise<boolean>;
    resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
    processEnv: NodeJS.ProcessEnv;
}>): Promise<PreparedDaemonProviderLaunch | DaemonProviderLaunchRefusal> {
    const appliedPluginRuntimeLease = await input.pluginRuntimeLease.acquire();

    if (typeof input.options.profileId === 'string' && input.options.profileId.trim().length > 0) {
        const reservedEnvironmentVariableNames = new Set(
            input.catalogAgentId
                ? readLeasedAgentProviderRequirements({
                    lease: appliedPluginRuntimeLease,
                    agentId: input.catalogAgentId,
                })
                    ?.authIsolation.ownedEnvKeys ?? []
                : [],
        );
        const profileValidation = validateSpawnProfileEnvironment({
            rawSettings: getActiveAccountSettingsSnapshot()?.settings,
            profileId: input.options.profileId,
            providedEnvironmentVariables: input.profileEnvironmentVariables,
            reservedEnvironmentVariableNames,
        });
        if (!profileValidation.ok) {
            return {
                ok: false,
                result: {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
                    errorMessage: profileValidation.message,
                },
            };
        }
    }

    let optionsWithProviderIsolation: SpawnSessionOptions = {
        ...input.options,
        backendTarget: input.effectiveBackendTarget,
    };
    const providerSessionId = input.normalizedExistingSessionId || null;
    const prepared = await prepareProviderLaunch({
        ...(input.modelSelection ? { selection: input.modelSelection } : {}),
        backendTarget: input.effectiveBackendTarget,
        machineId: input.options.machineId,
        agentId: input.catalogAgentId,
        ...(providerSessionId ? { sessionId: providerSessionId } : {}),
        previousBinding: input.persistedProviderBinding,
        confirmation: input.options.providerBindingSecurityChangeConfirmationV1 ?? null,
        connectedServices: (() => {
            const parsed = ConnectedServiceBindingsV1Schema.safeParse(input.options.connectedServices);
            return parsed.success ? parsed.data : null;
        })(),
        featureEnabled: input.modelSelection?.ref.providerConnectionId != null
            ? await input.resolveProvidersFeatureEnabled?.() === true
            : false,
        resolvePrerequisites: async (providerBindingContext) => {
            const providerPrerequisites = await resolveSpawnChildEnvironment({
                happyHomeDir: configuration.happyHomeDir,
                pluginRuntimeRegistry: appliedPluginRuntimeLease.registry,
                options: optionsWithProviderIsolation,
                profileEnvironmentVariables: input.profileEnvironmentVariables,
                daemonSpawnHooks: input.daemonSpawnHooks,
                processEnv: input.processEnv,
                logDebug: (message) => logger.debug(message),
                logInfo: (message) => logger.info(message),
                logWarn: (message) => logger.warn(message),
                connectedServiceAuth: null,
                providerBindingContext: { v: 1, ...providerBindingContext },
                providerBindingPrerequisitesOnly: true,
            });
            if (providerPrerequisites.cleanupOnFailure || providerPrerequisites.cleanupOnExit) {
                input.launchResourceScope.register({
                    onFailure: providerPrerequisites.cleanupOnFailure ?? (() => {}),
                    onExit: providerPrerequisites.cleanupOnExit ?? (() => {}),
                });
            }
            return providerPrerequisites.ok
                ? { ok: true as const }
                : {
                    ok: false as const,
                    error: createProviderErrorV1('provider_agent_runtime_unsupported', {
                        connectionId: providerBindingContext.connectionId,
                        ...(input.options.machineId ? { machineId: input.options.machineId } : {}),
                    }),
                };
        },
        createAuthorizationAttempt: async ({
            selection,
            machineId,
            agentTargetKey,
            agentId,
            managedPurposeBindingSnapshot,
        }) => {
            return createRuntimeProviderSpawnAuthorizationAttempt({
                selection,
                machineId,
                agentTargetKey,
                agentId,
                lease: appliedPluginRuntimeLease,
                getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                subscribeAccountSettingsSnapshot: (listener) =>
                    subscribeActiveAccountSettingsSnapshot(() => listener()),
                runtimeStateStore: createProviderRuntimeStateStore({
                    happyHomeDir: configuration.happyHomeDir,
                    machineId,
                }),
                materializationBaseDir: join(configuration.happyHomeDir, 'providers', 'materialized'),
                ...(providerSessionId ? { sessionId: providerSessionId } : {}),
                ...(input.resolveManagedPurposeBindingIntent
                    ? {
                        resolveManagedPurposeBindingIntent:
                            input.resolveManagedPurposeBindingIntent,
                    }
                    : {}),
                ...(managedPurposeBindingSnapshot
                    ? { managedPurposeBindingSnapshot }
                    : {}),
            });
        },
    });
    if (!prepared.ok) {
        return { ok: false, result: buildProviderSpawnErrorResult(prepared.error) };
    }
    if (prepared.kind === 'native') {
        return {
            ok: true,
            options: optionsWithProviderIsolation,
            attempt: null,
            agentTargetKey: null,
            providerSessionId: null,
        };
    }

    input.launchResourceScope.register({
        onFailure: prepared.attempt.cleanupOnFailure,
        onExit: () => {},
    });
    if (prepared.connectedServices) {
        optionsWithProviderIsolation = {
            ...optionsWithProviderIsolation,
            connectedServices: prepared.connectedServices,
        };
        if (prepared.suppressedConnectedServiceIds.length > 0) {
            logger.info(
                `[DAEMON RUN] Provider binding suppressed conflicting connected services for this spawn: ${prepared.suppressedConnectedServiceIds.join(', ')}`,
            );
        }
    }
    return {
        ok: true,
        options: optionsWithProviderIsolation,
        attempt: prepared.attempt,
        agentTargetKey: prepared.agentTargetKey,
        providerSessionId,
    };
}
