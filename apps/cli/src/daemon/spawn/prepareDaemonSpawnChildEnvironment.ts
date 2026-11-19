import { SESSION_HOLDER_ADOPT_ENV_KEY } from '@/subprocess/supervision/sessionHolder';
import { omitLaunchScopedSpawnOptions } from '@/daemon/spawn/omitLaunchScopedSpawnOptions';
import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { restoreAcceptedSessionTeamCredentialModelIntent } from '@/agent/runtime/mergeSessionMetadataForStartup';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { configuration } from '@/configuration';
import { buildToolIdleTimeoutEnvironmentOverlay, type MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type { PreparedManagedPurposeLaunch } from '@/providers/lifecycle/managedPurposeLaunch';
import type {
    ProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';
import type {
    ProviderRedactionLease,
    ProviderStreamingSanitizer,
} from '@/providers/spawn/redaction';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';
import { logger } from '@/ui/logger';

import type { resolveConnectedServiceAuthForSpawn } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { withConnectedServiceMaterializationIdentityEnv } from '../connectedServices/materialization/identity';
import { buildTrackedSessionRespawnEnvironmentVariables } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { projectChildEnvironmentFailure } from './projectChildEnvironmentFailure';
import {
    HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
    serializePendingFirstInputForEnv,
} from './pendingFirstInput';
import {
    HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY,
    serializeInitialGoalForEnv,
} from './initialGoal';
import {
    HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
    serializePersistedTakeoverAdmissionForEnv,
} from './persistedTakeoverAdmission';
import { SESSION_TARGET_PLACEMENT_ENV_KEY } from '@/subprocess/supervision/sessionTargetRelay';
import type { ManagedSessionTarget } from '@/machines/managed/acquire';
import { exposeManagedTargetProviderConsumer } from '@/machines/managed/providerConsumer';

type ConnectedServiceAuth = Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>>;
export async function prepareDaemonSpawnChildEnvironment(input: Readonly<{
    memberAgentCliLaunch?: import('@/plugins/runtime/exec/system/tools/agentCliBinding').MemberAgentCliLaunchContext;
    savedSecretOperationContext?: import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationContextV1;
    readMachineResourcesPolicy?: MachineResourcesPolicyReader;
    options: SpawnSessionOptions;
    existingSessionMetadata?: Readonly<Record<string, unknown>> | null;
    sessionAttachPayload?: import('@/agent/runtime/sessionAttachPayload').SessionAttachFilePayload | null;
    resolvedAgentId?: string | null;
    effectiveModelSelection: SpawnSessionOptions['modelSelection'];
    terminal: SpawnSessionOptions['terminal'];
    admittedTerminalRequest?: ResolvedTerminalRequest;
    profileEnvironmentVariables: Readonly<Record<string, string>>;
    daemonSpawnHooks: DaemonSpawnHooks | null;
    pluginRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    processEnv: NodeJS.ProcessEnv;
    connectedServiceAuth: ConnectedServiceAuth;
    connectedServiceMaterializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
    providerBindingAttempt: ProviderSpawnAuthorizationAttempt | null;
    managedPurpose?: PreparedManagedPurposeLaunch;
    managedTarget?: Pick<ManagedSessionTarget, 'home' | 'holderPath' | 'openChannel' | 'lifetime'>;
    providerAgentTargetKey: string | null;
    providerDiagnosticRedactionLease: ProviderRedactionLease;
    launchResourceScope: ProviderLaunchResourceScope;
}>): Promise<Readonly<{
    ok: false;
    result: Extract<SpawnSessionResult, { type: 'error' }>;
}> | Readonly<{
    ok: true;
    spawnEnvironment: Extract<Awaited<ReturnType<typeof resolveSpawnChildEnvironment>>, { ok: true }>;
    extraEnv: Record<string, string>;
    extraEnvForChild: Record<string, string>;
    trackedSpawnOptions: SpawnSessionOptions;
    terminalRequest: ReturnType<typeof resolveTerminalRequestFromSpawnOptions>;
    sanitizeDiagnosticText: (value: string) => string;
    createStreamingSanitizer?: () => ProviderStreamingSanitizer;
}>> {
    const providerBindingLaunchInput = (() => {
        if (!input.providerBindingAttempt) return null;
        if (!input.providerAgentTargetKey) {
            throw new Error('Provider binding launch requires an Agent target key');
        }
        return Object.freeze({
            attempt: input.providerBindingAttempt,
            agentTargetKey: input.providerAgentTargetKey,
        });
    })();
    const materializeProviderBindingAfterHooks =
        providerBindingLaunchInput
        && 'materializeAfterHooks' in providerBindingLaunchInput.attempt
            ? providerBindingLaunchInput.attempt.materializeAfterHooks
            : null;
    const retainedModel = readSessionModelSelectionV2FromMetadata(input.existingSessionMetadata);
    const acceptedModel = restoreAcceptedSessionTeamCredentialModelIntent(
        retainedModel, input.sessionAttachPayload?.snapshot?.acceptedTeamCredentialBinding);
    const existingSessionMetadata = acceptedModel !== retainedModel && input.existingSessionMetadata
        ? { ...input.existingSessionMetadata, modelSelectionIntentV2: acceptedModel }
        : input.existingSessionMetadata;
    const spawnEnvironment = await resolveSpawnChildEnvironment({
        memberAgentCliLaunch: input.memberAgentCliLaunch,
        savedSecretOperationContext: input.savedSecretOperationContext,
        happyHomeDir: configuration.happyHomeDir,
        pluginRuntimeRegistry: input.pluginRuntimeRegistry,
        options: input.options,
        ...(existingSessionMetadata ? { existingSessionMetadata } : {}),
        acceptedTeamCredentialBinding: input.sessionAttachPayload?.snapshot?.acceptedTeamCredentialBinding,
        resolvedAgentId: input.resolvedAgentId,
        profileEnvironmentVariables: input.profileEnvironmentVariables,
        daemonSpawnHooks: input.daemonSpawnHooks,
        processEnv: input.processEnv,
        logDebug: (message) => logger.debug(message),
        logInfo: (message) => logger.info(message),
        logWarn: (message) => logger.warn(message),
        connectedServiceAuth: input.connectedServiceAuth,
        ...(input.options.requesterSessionBootstrap
            ? { allowNativeAccountCredentials: input.options.requesterSessionBootstrap.allowNativeAccountCredentials === true } : {}),
        ...(input.managedPurpose
            ? {
                providerBindingContext: { v: 1 as const, agentTargetKey: input.managedPurpose.agentTargetKey,
                    modelId: input.managedPurpose.model.id },
                materializeProviderBindingAfterHooks: async () => {
                    const sessionId = input.options.existingSessionId;
                    if (!sessionId) throw new Error('Managed purpose launch requires a committed Session');
                    const target = input.managedTarget;
                    const materialized = await input.managedPurpose!.materialize({ kind: 'session', sessionId }, target
                        ? endpoint => exposeManagedTargetProviderConsumer({ target, ...endpoint }) : undefined);
                    if (!materialized.ok) return { ok: false as const,
                        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                        errorMessage: materialized.error.code, providerError: materialized.error };
                    input.launchResourceScope.register(materialized.cleanup);
                    input.providerDiagnosticRedactionLease.add(materialized.additionalRedactionValues);
                    return { ok: true as const, providerEnvironmentOverlay: materialized.environmentOverlay,
                        providerBindingLaunchHandoff: { v: 1 as const, materialization: materialized.providerBinding.materialization,
                            providerBinding: materialized.providerBinding, selection: input.managedPurpose!.selection } };
                },
            }
            : providerBindingLaunchInput
            ? {
                providerBindingContext: {
                    v: 1 as const,
                    agentTargetKey: providerBindingLaunchInput.agentTargetKey,
                    connectionId: providerBindingLaunchInput.attempt.authorization.ticket.connectionId,
                    modelId: providerBindingLaunchInput.attempt.authorization.binding.selection.model.id,
                },
                runtimePrerequisitesAlreadyResolved:
                    materializeProviderBindingAfterHooks !== null,
                ...(materializeProviderBindingAfterHooks
                    ? {
                        materializeProviderBindingAfterHooks:
                            async () => {
                                const materialized =
                                    await materializeProviderBindingAfterHooks(input.options.existingSessionId);
                                if (!materialized.ok) {
                                    return {
                                        ok: false as const,
                                        errorCode:
                                            SPAWN_SESSION_ERROR_CODES
                                                .SPAWN_VALIDATION_FAILED,
                                        errorMessage:
                                            materialized.error.code,
                                        providerError:
                                            materialized.error,
                                    };
                                }
                                input.providerDiagnosticRedactionLease.add(
                                    materialized.redactionLease.values(),
                                );
                                return {
                                    ok: true as const,
                                    providerEnvironmentOverlay:
                                        materialized.materialization
                                            .providerEnvironmentOverlay,
                                    providerBindingLaunchHandoff: {
                                        v: 1 as const,
                                        materialization:
                                            materialized.materialization
                                                .launchMaterialization,
                                        sessionBindingMetadata:
                                            providerBindingLaunchInput
                                                .attempt.authorization
                                                .sessionBindingMetadata,
                                    },
                                };
                            },
                    }
                    : {}),
            }
            : {}),
    });
    if (spawnEnvironment.cleanupOnFailure || spawnEnvironment.cleanupOnExit) {
        input.launchResourceScope.register({
            onFailure: spawnEnvironment.cleanupOnFailure ?? (() => {}),
            onExit: spawnEnvironment.cleanupOnExit ?? (() => {}),
        });
    }
    if (!spawnEnvironment.ok) {
        return {
            ok: false,
            result: projectChildEnvironmentFailure(spawnEnvironment),
        };
    }

    const extraEnv = spawnEnvironment.expandedEnvironmentVariables;
    const connectedServiceChildEnvironment = input.connectedServiceMaterializationIdentity
        ? withConnectedServiceMaterializationIdentityEnv(
            spawnEnvironment.extraEnvForChild,
            input.connectedServiceMaterializationIdentity,
        )
        : spawnEnvironment.extraEnvForChild;
    const extraEnvForChild = {
        ...connectedServiceChildEnvironment,
        ...(input.readMachineResourcesPolicy ? buildToolIdleTimeoutEnvironmentOverlay({
            environment: { ...input.processEnv, ...connectedServiceChildEnvironment },
            policy: input.readMachineResourcesPolicy(),
            unsetEnvKeys: spawnEnvironment.unsetEnvKeys,
        }) : {}),
    };
    // Inherited daemon/tmux state is never requester authority. Only the
    // admitted launch owner supplies this exact protected Session custody.
    delete extraEnvForChild.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
    delete extraEnvForChild.HAPPIER_SESSION_REQUESTER_SESSION_ID;
    if (input.options.requesterSessionCredentialFile) {
        if (!input.options.existingSessionId) throw new Error('requester_session_custody_requires_committed_session');
        extraEnvForChild.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE = input.options.requesterSessionCredentialFile;
        extraEnvForChild.HAPPIER_SESSION_REQUESTER_SESSION_ID = input.options.existingSessionId;
    }
    delete extraEnvForChild[SESSION_HOLDER_ADOPT_ENV_KEY];
    if (input.options.adoptSessionHolder) {
        extraEnvForChild[SESSION_HOLDER_ADOPT_ENV_KEY] = JSON.stringify(input.options.adoptSessionHolder);
    }
    // Inherited placement is never this spawn's: only the spawn's own launch step sets it (executeSpawnSessionRequest).
    delete extraEnvForChild[SESSION_TARGET_PLACEMENT_ENV_KEY];
    delete extraEnvForChild[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
    if (input.options.pendingFirstInput) {
        extraEnvForChild[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY] =
            serializePendingFirstInputForEnv(input.options.pendingFirstInput);
    }
    delete extraEnvForChild[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY];
    if (input.options.initialGoal) {
        extraEnvForChild[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY] =
            serializeInitialGoalForEnv(input.options.initialGoal);
    }
    delete extraEnvForChild[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
    if (input.options.persistedTakeoverAdmission) {
        extraEnvForChild[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY] =
            serializePersistedTakeoverAdmissionForEnv(
                input.options.persistedTakeoverAdmission,
            );
    }
    const trackedSessionEnvironmentVariables = buildTrackedSessionRespawnEnvironmentVariables({
        expandedEnvironmentVariables: extraEnv,
        extraEnvForChild,
        excludedEnvironmentVariableKeys: [
            ...(spawnEnvironment.providerEnvKeys ?? []),
            HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
            HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY,
            HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
            'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE',
            'HAPPIER_SESSION_REQUESTER_SESSION_ID',
        ],
    });
    // Model selection and provider binding are re-derived for this launch just below.
    const {
        modelSelection: _requestedModelSelection,
        providerBindingMetadataV1: _priorProviderBindingMetadataV1,
        ...trackedSpawnOptionsBase
    } = omitLaunchScopedSpawnOptions(input.options);
    const trackedSpawnOptions: SpawnSessionOptions = {
        ...trackedSpawnOptionsBase,
        // The protected attach is the accepted source, not the caller's old
        // pre-create intent. Keep all other purpose slots at their own owner.
        ...(input.sessionAttachPayload?.snapshot ? { teamCredentialBindings: [
            ...(trackedSpawnOptionsBase.teamCredentialBindings ?? []).filter(binding => binding.slot.kind !== 'provider_model'),
            ...(input.sessionAttachPayload.snapshot.acceptedTeamCredentialBinding?.slot.kind === 'provider_model'
                ? [input.sessionAttachPayload.snapshot.acceptedTeamCredentialBinding] : []),
        ] } : {}),
        ...(input.effectiveModelSelection
            ? { modelSelection: input.effectiveModelSelection }
            : {}),
        ...(input.providerBindingAttempt
            ? { providerBindingMetadataV1: input.providerBindingAttempt.authorization.sessionBindingMetadata }
            : {}),
        ...(trackedSessionEnvironmentVariables
            ? { environmentVariables: trackedSessionEnvironmentVariables }
            : {}),
        ...(spawnEnvironment.materializationDiagnostics
            ? { materializationDiagnostics: spawnEnvironment.materializationDiagnostics }
            : {}),
    };

    return {
        ok: true,
        spawnEnvironment,
        extraEnv,
        extraEnvForChild,
        trackedSpawnOptions,
        terminalRequest: input.admittedTerminalRequest ?? resolveTerminalRequestFromSpawnOptions({
            happyHomeDir: configuration.happyHomeDir,
            terminal: input.terminal,
            environmentVariables: extraEnv,
        }),
        sanitizeDiagnosticText: input.providerDiagnosticRedactionLease.redact,
        createStreamingSanitizer:
            input.providerDiagnosticRedactionLease.createStreamingSanitizer,
    };
}
