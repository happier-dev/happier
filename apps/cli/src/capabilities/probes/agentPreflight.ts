import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { isRecord } from '@happier-dev/plugin-sdk';
import { SessionRuntimeFailureCauseV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { CreateAgentInvocationServices } from '@/plugins/runtime/invocation/services/types';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import type { ResolveContributedProviderCatalogParsers } from '@/providers/probe/runtimeServices';
import { projectNativeCatalogModels } from './nativeCatalogModels';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { CapabilitiesInvokeResponse } from '@/capabilities/types';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';
import { ConnectedServicesProviderStateSharingSettingsV1Schema } from '@happier-dev/protocol/account/settings/connected-services';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { AgentPassiveRealtimeSetupResultV1Schema } from '@happier-dev/protocol/capabilities/agentPassiveRealtimeSetup';
import { ProbedCatalogOptionValueSchema } from '@happier-dev/protocol/capabilities';
import { NonBlankOpaqueIdentifierSchema } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { z } from 'zod/mini';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { isProviderSourceModelCatalogConfidenceUsable } from '@happier-dev/protocol/rpc/providers';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { buildScopedProcessEnv, stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';
import { getAgentModelConfig } from '@happier-dev/agents';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { readDeclaredCatalogConnectedServiceIds, resolveCatalogAgentConnectedServiceIds, readDeclaredCatalogConnectedAccountServiceIds, resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { resolveProbeBackendContext } from '@/rpc/handlers/capabilitiesProbeContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { buildConnectedServiceCredentialSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { isConnectedServiceUxDiagnosticSpawnErrorDetail } from '@happier-dev/protocol/spawnSession';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { parseConnectedServiceBindingSelections } from '@/daemon/connectedServices/parseConnectedServicesBindings';
import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { sanitizeEnvVarRecord } from '@/terminal/runtime/envVarSanitization';
import { stripSessionControlEnvOverrides } from '@/session/runtime/control/sessionControlEnvironment';
import { isDynamicModelProbeEnabled, resolveNativeCatalogTarget, type NativeCatalogTargetResolution } from '@/providers/probe/nativeCatalogCredential';
import { resolveNativeCatalogObservationContext } from '@/providers/probe/resolveNativeCatalogObservationContext';
import { ProviderProbeCancelledError } from '@/providers/probe/client';
import { probeAgentModelsBestEffort } from './agentModelsProbe';
import { probeAgentModesBestEffort } from './agentModesProbe';
import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';
import { probeAgentCatalogs } from './agentCatalogsProbe';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { prepareProfileProbeEnvironment, type ProfileProbeEnvironment } from './resolveProfileProbeEnvironment';
import { resolvePreflightSessionControlsProbeEnvironment, withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 30_000;
const ConfigOptionOverridesSchema = z.record(NonBlankOpaqueIdentifierSchema, ProbedCatalogOptionValueSchema);

type ConnectedServiceProbeCredentials = NonNullable<
    Awaited<ReturnType<typeof resolveProbeBackendContext>>['credentials']
>;
type ConnectedServiceProbeApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];

export type CliProbeDependencies = Readonly<{
    savedSecretOperationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
    secretSources?: import('@/plugins/runtime/lifecycle/contributions/targetSecretSources').TargetSecretSourcesV1;
    accountContext?: NonNullable<Parameters<typeof resolveProbeBackendContext>[1]>['accountContext'];
    createAgentInvocationServices?: CreateAgentInvocationServices;
    agentCatalogEntry?: AgentCatalogEntry | null;
    agentRuntimeCacheKey?: string;
    createApiClient?: (credentials: ConnectedServiceProbeCredentials) => Promise<ConnectedServiceProbeApi>;
    getAgentCatalogObservation?: () => Readonly<{
        machineId: string;
        service: AgentProviderCatalogObservationService;
    }> | null;
    agentRegistrySnapshot?: ResolvedContributionRegistry;
    resolveContributedCatalogParsers?: ResolveContributedProviderCatalogParsers;
    activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
    connectedAccountsOwner?: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['connectedAccountsOwner'];
    isAgentRegistryCurrent?: () => boolean;
    resolveNativeCatalogTarget?: (input: Parameters<typeof resolveNativeCatalogTarget>[0]) => Promise<NativeCatalogTargetResolution>;
}>;

export type CliProbeRequestContext = Readonly<{
    machineAdmission?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1['machineAdmission'];
    signal?: AbortSignal;
    deadlineSignal?: AbortSignal;
    deadlineAtMs?: number;
    cleanupScope?: PreflightCatalogCleanupScope;
}>;

type ConnectedServiceProbeEnvironment = Readonly<{
    exactPurposeBindingSubjectId?: string;
    materializedEnv: Readonly<Record<string, string>> | null;
    unsetEnvKeys: readonly string[];
    connectedServiceSelectionCacheKey: string | null;
    cleanup: (() => Promise<void>) | null;
}>;

async function resolveConnectedServiceProbeEnvironment(params: Readonly<{
    agentId: string;
    cwd: string;
    connectedServices: ReturnType<typeof ConnectedServiceBindingsV2IngressSchema.parse> | null;
    credentials: Awaited<ReturnType<typeof resolveProbeBackendContext>>['credentials'];
    accountSettings: Record<string, unknown> | null;
    requiresMaterializedAuth: boolean;
    nativeCatalog: boolean;
    signal?: AbortSignal;
    cleanupScope?: PreflightCatalogCleanupScope;
    dependencies: CliProbeDependencies;
    processEnv: NodeJS.ProcessEnv;
}>): Promise<ConnectedServiceProbeEnvironment> {
    if (!params.requiresMaterializedAuth || !params.connectedServices) {
        return {
            materializedEnv: null,
            unsetEnvKeys: [],
            connectedServiceSelectionCacheKey: null,
            cleanup: null,
        };
    }
    if (!params.credentials) {
        throw new Error('Connected-service credentials are unavailable for this preflight probe');
    }
    if (!params.dependencies.createApiClient) {
        throw new Error('Connected-service API owner is unavailable for this preflight probe');
    }

    const materializationIdentity = generateConnectedServiceMaterializationIdentityV1();
    const materializationBaseDir = join(
        configuration.happyHomeDir,
        'daemon',
        'connected-services',
        'materialized',
    );
    const registry = params.dependencies.agentRegistrySnapshot ?? readCurrentContributionRegistry();
    const consumer = registry.agentDefinitionsById.get(params.agentId)?.identity ?? null;
    const stateSharing = params.nativeCatalog
        ? await params.dependencies.agentCatalogEntry?.getConnectedServiceStateSharingDescriptor?.() ?? null
        : null;
    params.signal?.throwIfAborted();
    // Catalog probes need selected credentials but never persisted conversation state.
    const probeStateSharing = ConnectedServicesProviderStateSharingSettingsV1Schema.parse(
        params.accountSettings?.connectedServicesProviderStateSharingSettingsV1,
    );
    const resolved = await resolveConnectedServiceAuthForSpawn({
        signal: params.signal,
        retainCleanup: params.cleanupScope?.retain,
        agentId: params.agentId,
        sessionDirectory: params.cwd,
        connectedServicesBindingsRaw: params.connectedServices,
        materializationKey: materializationIdentity.id,
        probePurpose: 'probe',
        activeServerDir: configuration.activeServerDir,
        baseDir: materializationBaseDir,
        credentials: params.credentials,
        api: await params.dependencies.createApiClient(params.credentials),
        connectedAccountsOwner: params.dependencies.connectedAccountsOwner,
        accountSettings: {
            ...params.accountSettings,
            connectedServicesProviderStateSharingSettingsV1: {
                ...probeStateSharing,
                byAgentId: {
                    ...probeStateSharing.byAgentId,
                    [params.agentId]: { ...probeStateSharing.byAgentId[params.agentId], stateMode: 'isolated' },
                },
            },
        },
        processEnv: params.processEnv,
        resolveQualifiedPurposeBindingSnapshot: (bindings) => {
            const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: params.agentId,
                bindings,
                contributions: registry,
                catalogEntry: params.dependencies.agentCatalogEntry,
            });
            if (params.nativeCatalog && snapshot) {
                // A purpose declaration alone does not put credentials in a native process.
                // The Agent's native preparation hook is also a credential
                // destination and runs below with this exact admitted purpose.
                for (const binding of snapshot.bindings) {
                    const key = qualifiedPurposeKey(binding.purpose);
                    const hasEnvironment = snapshot.environmentUses?.some(use => qualifiedPurposeKey(use.purpose) === key);
                    const hasFileEnvironment = snapshot.fileEnvironmentUses?.some(use => qualifiedPurposeKey(use.purpose) === key);
                    const hasNativeHome = stateSharing?.providerSupportStatus === 'supported'
                        && stateSharing.nativeHome
                        && stateSharing.authIsolation.secretEntries.length > 0
                        && snapshot.fileMaterializationPurposes?.some(scope => qualifiedPurposeKey(scope.purpose) === key);
                    if (!hasEnvironment && !hasFileEnvironment && !hasNativeHome
                        && !params.dependencies.agentCatalogEntry?.preparePreflightLaunchEnvironment) {
                        throw new Error('Selected Connected Account has no declared native catalog credential destination');
                    }
                }
            }
            return snapshot;
        },
        ...(params.dependencies.activatePurposeBindings && consumer
            ? {
                activateQualifiedPurposeBindings: (snapshot) =>
                    params.dependencies.activatePurposeBindings!({
                        subject: {
                            kind: 'operation',
                            operationId: materializationIdentity.id,
                            consumer,
                            isCurrent: () => !params.signal?.aborted && params.dependencies.isAgentRegistryCurrent?.() === true,
                        },
                        purposes: snapshot.purposes,
                        bindings: snapshot.bindings,
                    }),
            }
            : {}),
        // Capability probes observe the current selection. Spawn/runtime owners alone may refresh
        // credentials or advance an auth group.
        authGroupSwitchCoordinator: null,
        credentialRefreshService: null,
    });
    if (!resolved) {
        throw new Error('The selected connected-service account could not be materialized for this preflight probe');
    }

    const ephemeralRoot = resolveConnectedServiceMaterializedRootDir({
        baseDir: materializationBaseDir,
        agentId: params.agentId,
        materializationKey: materializationIdentity.id,
    });
    return {
        materializedEnv: resolved.env,
        unsetEnvKeys: resolved.unsetEnvKeys ?? [],
        exactPurposeBindingSubjectId: resolved.materializationPurposeLease?.subjectId,
        connectedServiceSelectionCacheKey:
            resolved.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] ?? null,
        cleanup: async () => {
            // The materialization cleanups publish awaited removal receipts;
            // this probe's own receipt is the bounded rm of the ephemeral
            // root below, so cleanup failures here are observed, not decisive.
            await Promise.allSettled([
                Promise.resolve(resolved.cleanupOnExit?.()),
                Promise.resolve(resolved.cleanupOnFailure?.()),
                Promise.resolve(resolved.materializationPurposeLease?.dispose()),
            ]);
            await rm(ephemeralRoot, { recursive: true, force: true });
        },
    };
}

export function resolveCliProbeInvokeParams(params?: Record<string, unknown>): Readonly<{
    cwd: string;
    timeoutMs: number;
}> {
    const rawParams = params ?? {};
    const timeoutMsRaw = rawParams.timeoutMs;
    const cwdRaw = rawParams.cwd;
    return {
        cwd: typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? expandHomeDirPath(cwdRaw.trim(), sessionProcessEnvironment()) : sessionWorkingDirectory(),
        timeoutMs: typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS,
    };
}

export async function invokeCliPreflightMethod(
    agentId: AgentCatalogEntry['id'],
    method: string,
    params: Record<string, unknown> | undefined,
    dependencies: CliProbeDependencies,
    requestContext: CliProbeRequestContext,
): Promise<CapabilitiesInvokeResponse> {
    const processEnv = sessionProcessEnvironment();
    const { cwd, timeoutMs } = resolveCliProbeInvokeParams(params);
    const registrySnapshot = dependencies.agentRegistrySnapshot ?? readCurrentContributionRegistry();
    const probeDeadlineAtMs = requestContext.deadlineAtMs ?? Date.now() + timeoutMs;
    const configOverrides = params?.configOptionOverrides === undefined ? null
        : ConfigOptionOverridesSchema.safeParse(params.configOptionOverrides);
    if (configOverrides && !configOverrides.success) {
        return { ok: false, error: { code: 'invalid_params', message: 'Configuration overrides must contain opaque option ids and scalar values.' } };
    }
    const configOptionOverrides = configOverrides?.success ? configOverrides.data : undefined;
    const selectedModel = params?.modelId === undefined ? null : NonBlankOpaqueIdentifierSchema.safeParse(params.modelId);
    if (selectedModel && !selectedModel.success) {
        return { ok: false, error: { code: 'invalid_params', message: 'The selected model must be a nonblank identifier.' } };
    }
    const modelId = selectedModel?.success ? selectedModel.data : undefined;
    const parsedConnectedServices = ConnectedServiceBindingsV2IngressSchema.safeParse(params?.connectedServices);
    const connectedServices = parsedConnectedServices.success ? parsedConnectedServices.data : null;
    if (params?.connectedServices != null && !parsedConnectedServices.success) {
        return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Could not prepare the selected connected-service account for this probe.' } };
    }
    const connectedServiceSelections = parseConnectedServiceBindingSelections(connectedServices);
    // Team material requires an admitted Session. These operation probes have
    // neither that authority nor a direct-material origin, so do not reinterpret
    // the requested resource as personal Account credentials or native auth.
    if (connectedServiceSelections.some((selection) => selection.kind === 'team_resource')) {
        return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Could not prepare the selected connected-service account for this probe.' } };
    }
    const hasConnectedServiceSelection = connectedServiceSelections.length > 0;
    const explicitEnvironment = method === 'probeCatalogs'
        ? stripSessionControlEnvOverrides(sanitizeEnvVarRecord(params?.environmentVariables))
        : {};
    const materializationAgentId =
        (dependencies.agentCatalogEntry === undefined
            ? resolveCatalogAgentConnectedServiceIds(agentId).length + resolveCatalogAgentConnectedAccountServiceIds(agentId).length
            : readDeclaredCatalogConnectedServiceIds(dependencies.agentCatalogEntry).length
                + readDeclaredCatalogConnectedAccountServiceIds(dependencies.agentCatalogEntry).length) > 0
            ? agentId
            : null;
    if (hasConnectedServiceSelection && !materializationAgentId) {
        return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Could not prepare the selected connected-service account for this probe.' } };
    }
    const preflightAdapter = method === 'probePassiveRealtimeSetup'
        ? await resolvePreflightSessionControlsProbeAdapter(agentId, dependencies.agentCatalogEntry).catch(() => null)
        : null;
    if (
        method === 'probePassiveRealtimeSetup'
        && (
            !materializationAgentId
            || !hasConnectedServiceSelection
        )
    ) {
        return { ok: true, result: { v: 1, status: 'unavailable' } };
    }
    const requiresMaterializedAuth = Boolean(
        materializationAgentId
        && hasConnectedServiceSelection,
    );
    const probeContext = await resolveProbeBackendContext(
        { ...params, agentId },
        { requireCredentials: requiresMaterializedAuth, catalogEntry: dependencies.agentCatalogEntry, signal: requestContext.signal,
          accountContext: dependencies.accountContext },
    );
    // Cache evidence per Account without changing the executable occurrence
    // supplied to the invocation-services owner for native preparation.
    const runtimeCacheKey = probeContext.credentials
        ? JSON.stringify([dependencies.agentRuntimeCacheKey ?? null, resolveAccountSettingsScopeKey(probeContext.credentials)])
        : dependencies.agentRuntimeCacheKey;
    const modelConfig = method === 'probeModels' ? getAgentModelConfig(agentId) : null;
    if (method === 'probeModels' && !isDynamicModelProbeEnabled({
        modelConfig,
        accountSettings: probeContext.accountSettings,
        environment: processEnv,
    })) {
        return { ok: true, result: await probeAgentModelsBestEffort({
            agentId,
            catalogEntry: dependencies.agentCatalogEntry,
            registrySnapshot,
            runtimeCacheKey,
            savedSecretOperationContext: dependencies.savedSecretOperationContext,
            secretSources: dependencies.secretSources,
            machineAdmission: requestContext.machineAdmission,
            ...(requestContext.signal ? { signal: requestContext.signal } : {}),
            backendTarget: probeContext.backendTarget,
            runtimeDescriptorV1: probeContext.runtimeDescriptorV1,
            runtimeKindOverride: probeContext.runtimeKindOverride,
            pluginSettings: probeContext.pluginSettings,
            configOptionOverrides,
            modelId,
            cwd,
            timeoutMs,
            accountSettings: probeContext.accountSettings,
            credentials: probeContext.credentials,
            env: processEnv,
        }) };
    }
    let preparedProfile: Awaited<ReturnType<typeof prepareProfileProbeEnvironment>> = null;
    let profileProbeEnvironment: ProfileProbeEnvironment | null = null;
    let profilePreparationFailed = false;
    const profileFailure = () => ({
        ok: false, error: {
            code: 'profile-preflight-failed',
            message: 'Could not prepare the selected backend profile for this probe.',
        },
    } as const);
    const acquireProfileEnvironment = async (signal?: AbortSignal) => {
        try {
            requestContext.signal?.throwIfAborted();
            profileProbeEnvironment = preparedProfile ? await preparedProfile.materialize(signal) : null;
            return profileProbeEnvironment;
        } catch (error) {
            profilePreparationFailed = true;
            throw error;
        }
    };
    try {
        const secretReferenceOverlay = params?.secretReferenceOverlay == null
            ? undefined : SecretReferenceOverlayV1Schema.parse(params.secretReferenceOverlay);
        preparedProfile = await prepareProfileProbeEnvironment({
            agentId,
            profileId: params?.profileId,
            secretReferenceOverlay,
            accountSettings: probeContext.accountSettings,
            credentials: probeContext.credentials,
            processEnv: { ...processEnv, ...explicitEnvironment },
            savedSecretOperationContext: dependencies.savedSecretOperationContext,
            machineAdmission: requestContext.machineAdmission,
            secretSources: dependencies.secretSources,
            signal: requestContext.signal,
        });
        profileProbeEnvironment = preparedProfile;
        // Existing native-home and Connected Account preparation consume the complete
        // Profile environment at their acquisition boundary.
        if (method === 'probeCatalogs' && dependencies.agentCatalogEntry?.resolveSessionRuntimePreferences
            || requiresMaterializedAuth) {
            await acquireProfileEnvironment();
        }
    } catch {
        return profileFailure();
    }
    const nativeLaunchPreferences = method === 'probeCatalogs'
        ? await dependencies.agentCatalogEntry?.resolveSessionRuntimePreferences?.({
            isExplicitCliSubcommand: false,
            parsed: { agentArgs: [] },
            settings: probeContext.accountSettings ?? {},
            pluginSettings: probeContext.pluginSettings ?? {},
            environment: { ...processEnv, ...explicitEnvironment, ...(profileProbeEnvironment?.env ?? {}) },
            startOrigin: 'daemon',
        })
        : undefined;
    requestContext.signal?.throwIfAborted();
    const nativeHome = method === 'probeCatalogs'
        ? (await dependencies.agentCatalogEntry?.getConnectedServiceStateSharingDescriptor?.())?.nativeHome
        : null;
    requestContext.signal?.throwIfAborted();
    const nativeHomeValue = nativeHome
        ? sanitizeEnvVarRecord(nativeLaunchPreferences?.environmentVariables)[nativeHome.environmentKey]
        : undefined;
    // Session preferences may carry the whole launch environment. Cold catalogs consume
    // only the declared native-home destination; scoped credentials retain their own owners.
    const nativeLaunchEnvironment = nativeHome && nativeHomeValue !== undefined
        ? { [nativeHome.environmentKey]: nativeHomeValue }
        : {};
    const profileProcessEnv: NodeJS.ProcessEnv = {
        ...processEnv,
        ...nativeLaunchEnvironment,
        ...explicitEnvironment,
        ...(profileProbeEnvironment?.env ?? {}),
    };
    let connectedServiceProbeEnvironment: ConnectedServiceProbeEnvironment = {
        materializedEnv: null,
        unsetEnvKeys: [],
        connectedServiceSelectionCacheKey: null,
        cleanup: null,
    };
    if (materializationAgentId) {
        try {
            connectedServiceProbeEnvironment = await resolveConnectedServiceProbeEnvironment({
                agentId: materializationAgentId,
                cwd,
                connectedServices,
                credentials: probeContext.credentials,
                accountSettings: probeContext.accountSettings,
                requiresMaterializedAuth,
                nativeCatalog: method === 'probeCatalogs',
                signal: requestContext.signal,
                cleanupScope: requestContext.cleanupScope,
                dependencies,
                processEnv: profileProcessEnv,
            });
        } catch (error) {
            const failure = buildConnectedServiceCredentialSpawnErrorResult({ agentId: materializationAgentId, error });
            if (failure && isConnectedServiceUxDiagnosticSpawnErrorDetail(failure.errorDetail)) {
                const diagnostic = failure.errorDetail.uxDiagnostic;
                return { ok: false, error: {
                    code: diagnostic.code,
                    message: diagnostic.code,
                    retryable: diagnostic.retryable,
                } };
            }
            // The capability service owns code-only projection. Never forward
            // credential-bearing messages, causes or arbitrary error metadata.
            if (error instanceof Error && 'code' in error && typeof error.code === 'string') throw error;
            return {
                ok: false,
                error: {
                    code: 'connected-service-preflight-failed',
                    message: 'Could not prepare the selected connected-service account for this probe.',
                },
            };
        }
    }
    let preparedLaunchEnvironment: Awaited<ReturnType<NonNullable<AgentCatalogEntry['preparePreflightLaunchEnvironment']>>> | undefined;
    const preparationLifetime = new AbortController();
    const preparationSignal = requestContext.signal
        ? AbortSignal.any([requestContext.signal, preparationLifetime.signal]) : preparationLifetime.signal;
    try {
    requestContext.signal?.throwIfAborted();
    const ambientEnv = stripUnsetEnvironmentVariables(processEnv, connectedServiceProbeEnvironment.unsetEnvKeys);
    let materializedEnv = buildScopedProcessEnv({
        baseEnv: {
            ...nativeLaunchEnvironment,
            ...explicitEnvironment,
            ...(profileProbeEnvironment?.env ?? {}),
        },
        explicitEnv: connectedServiceProbeEnvironment.materializedEnv ?? {},
        unsetEnvKeys: connectedServiceProbeEnvironment.unsetEnvKeys,
    });
    if (requiresMaterializedAuth && dependencies.agentCatalogEntry?.preparePreflightLaunchEnvironment) {
        const agent = dependencies.agentRegistrySnapshot?.agentDefinitionsById.get(agentId);
        const identity = agent?.identity;
        const target = dependencies.agentRegistrySnapshot?.activationTargets.find(target => target.pluginId === identity?.pluginId);
        if (!identity || !target || !dependencies.agentRuntimeCacheKey || !dependencies.createAgentInvocationServices
            || !connectedServiceProbeEnvironment.exactPurposeBindingSubjectId) {
            return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Native account preparation is unavailable for this probe.' } };
        }
        const environment = (await resolvePreflightSessionControlsProbeEnvironment({ agentId, registrySnapshot, catalogEntry: dependencies.agentCatalogEntry, modelConfig, processEnv: ambientEnv, materializedEnv })).env;
        const values = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const services = await dependencies.createAgentInvocationServices({
            pluginId: identity.pluginId, pluginVersion: target.manifest.version, agentId,
            occurrenceId: dependencies.agentRuntimeCacheKey, correlationId: randomUUID(), cwd,
            exactPurposeBindingSubjectId: connectedServiceProbeEnvironment.exactPurposeBindingSubjectId,
            connectedAccountsOwner: dependencies.connectedAccountsOwner,
            environment: values, signal: preparationSignal,
            isOccurrenceCurrent: dependencies.isAgentRegistryCurrent ?? (() => false),
        });
        try {
            preparedLaunchEnvironment = await dependencies.agentCatalogEntry.preparePreflightLaunchEnvironment({
                environment: values, modelId, connectedAccounts: services.connectedAccounts, signal: preparationSignal,
            });
        } catch (error) {
            const cause = isRecord(error) && isRecord(error.details)
                ? SessionRuntimeFailureCauseV1Schema.safeParse(error.details.failureCause) : null;
            if (method !== 'probeModels' || !cause?.success || cause.data.failureReason !== 'model_selection_required') throw error;
            // A known selection prerequisite is a typed refusal at the probe
            // boundary too; callers must not infer it from display text.
            return { ok: false, error: { code: cause.data.failureReason,
                message: 'Choose an explicit model; this Connected Account has no verified Agent catalog or default.',
                retryable: cause.data.retryable, details: { phase: cause.data.phase },
            } };
        }
        materializedEnv = { ...preparedLaunchEnvironment.environment };
        for (const key of preparedLaunchEnvironment.unset ?? []) delete materializedEnv[key];
    }
    const probeProcessEnv = (await resolvePreflightSessionControlsProbeEnvironment({
        agentId,
        modelConfig,
        registrySnapshot,
        catalogEntry: dependencies.agentCatalogEntry,
        // Preparation receives the complete cold launch environment. Do not
        // reintroduce an inherited native home/key that it explicitly removed.
        processEnv: preparedLaunchEnvironment ? {} : ambientEnv,
        materializedEnv,
    })).env;
    const acquireEnvironment = async (signal?: AbortSignal) => {
        const profile = await acquireProfileEnvironment(signal);
        const nativeMaterializedEnv = preparedLaunchEnvironment ? materializedEnv : buildScopedProcessEnv({
            baseEnv: { ...nativeLaunchEnvironment, ...explicitEnvironment, ...(profile?.env ?? {}) },
            explicitEnv: connectedServiceProbeEnvironment.materializedEnv ?? {},
            unsetEnvKeys: connectedServiceProbeEnvironment.unsetEnvKeys,
        });
        return (await resolvePreflightSessionControlsProbeEnvironment({
            agentId, modelConfig, registrySnapshot, catalogEntry: dependencies.agentCatalogEntry,
            processEnv: preparedLaunchEnvironment ? {} : ambientEnv, materializedEnv: nativeMaterializedEnv,
        })).env;
    };
    const commonProbeArgs = {
        agentId,
        catalogEntry: dependencies.agentCatalogEntry,
        registrySnapshot,
        runtimeCacheKey,
        savedSecretOperationContext: dependencies.savedSecretOperationContext,
        secretSources: dependencies.secretSources,
        machineAdmission: requestContext.machineAdmission,
        ...(requestContext.signal ? { signal: requestContext.signal } : {}),
        ...(requestContext.deadlineSignal ? { deadlineSignal: requestContext.deadlineSignal } : {}),
        ...(requestContext.cleanupScope ? { cleanupScope: requestContext.cleanupScope } : {}),
        backendTarget: probeContext.backendTarget,
        runtimeDescriptorV1: probeContext.runtimeDescriptorV1,
        runtimeKindOverride: probeContext.runtimeKindOverride,
        pluginSettings: probeContext.pluginSettings,
        configOptionOverrides,
        modelId,
        cwd,
        timeoutMs: requestContext.deadlineAtMs === undefined ? timeoutMs : Math.max(0, requestContext.deadlineAtMs - Date.now()),
        accountSettings: probeContext.accountSettings,
        credentials: probeContext.credentials,
        env: probeProcessEnv,
        acquireEnvironment,
        materializedEnv,
        commandArgsSuffix: preparedLaunchEnvironment?.commandArgsSuffix,
        profileCacheKey: profileProbeEnvironment?.cacheKey ?? null,
        connectedServiceSelectionCacheKey:
            connectedServiceProbeEnvironment.connectedServiceSelectionCacheKey,
    };

      const runProbe = async (): Promise<CapabilitiesInvokeResponse> => {
      requestContext.signal?.throwIfAborted();
      if (method === 'probeCatalogs') {
          return { ok: true, result: await probeAgentCatalogs({ ...commonProbeArgs, bypassCache: params?.bypassCache === true }) };
      }
      if (method === 'probePassiveRealtimeSetup') {
        const result = await withPreflightSessionControlsProbeEnvironment({
          agentId,
          modelConfig,
          registrySnapshot,
          catalogEntry: dependencies.agentCatalogEntry,
          processEnv: probeProcessEnv,
          materializedEnv: commonProbeArgs.materializedEnv,
          acquireEnvironment,
        }, async ({ env, acquireEnvironment }) => {
          if (!preflightAdapter?.probePassiveRealtimeSetupRaw) return { v: 1, status: 'unavailable' } as const;
          const raw = await preflightAdapter.probePassiveRealtimeSetupRaw({
            backendTarget: probeContext.backendTarget,
            runtimeDescriptorV1: probeContext.runtimeDescriptorV1,
            runtimeKindOverride: probeContext.runtimeKindOverride,
            pluginSettings: probeContext.pluginSettings,
            probeKind: 'passiveRealtimeSetup',
            cwd,
            timeoutMs,
            accountSettings: probeContext.accountSettings,
            env,
            acquireEnvironment,
            commandArgsSuffix: preparedLaunchEnvironment?.commandArgsSuffix,
            ...(requestContext.signal ? { signal: requestContext.signal } : {}),
            ...(requestContext.deadlineSignal ? { deadlineSignal: requestContext.deadlineSignal } : {}),
            ...(requestContext.cleanupScope ? { cleanupScope: requestContext.cleanupScope } : {}),
          });
          const parsed = AgentPassiveRealtimeSetupResultV1Schema.safeParse(raw);
          return parsed.success ? parsed.data : { v: 1, status: 'unavailable' } as const;
        }).catch(() => ({ v: 1, status: 'unavailable' } as const));
        if (dependencies.isAgentRegistryCurrent?.() === false) {
          return { ok: true, result: { v: 1, status: 'unavailable' } };
        }
        return { ok: true, result };
      }
      if (method === 'probeModels') {
        if (!isProviderSourceModelCatalogConfidenceUsable(preparedLaunchEnvironment?.catalogConfidence)) {
          return { ok: true, result: { agentId, availableModels: [],
            supportsFreeform: modelConfig?.supportsSelection === true && modelConfig.supportsFreeform === true,
            source: 'unavailable', refreshError: true, cacheable: false,
            refreshErrorMessage: 'account_unverified: The Agent cannot verify model membership for this Connected Account.',
          } };
        }
        const observation = modelConfig?.nativeCatalogObservation;
        const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(params?.connectedServices);
        const observationRuntime = dependencies.getAgentCatalogObservation?.() ?? null;
        if (observation && observationRuntime) {
            const registry = dependencies.agentRegistrySnapshot ?? readCurrentContributionRegistry();
            const resolveContributedCatalogParsers = dependencies.resolveContributedCatalogParsers;
            const isCurrent = (): boolean => requestContext.signal?.aborted !== true
                && (dependencies.isAgentRegistryCurrent?.() ?? true);
            const agent = registry.agentDefinitionsById.get(agentId);
            const consumer = agent?.identity;
            const snapshot = bindings.success ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId,
                bindings: bindings.data,
                contributions: registry,
                catalogEntry: dependencies.agentCatalogEntry,
            }) : null;
            const qualifiedPurpose = snapshot?.purposes.find((candidate) =>
                candidate.purpose === observation.purpose
                && candidate.consumer.pluginId === consumer?.pluginId
                && candidate.consumer.localId === consumer.localId);
            const purposeKey = qualifiedPurpose ? qualifiedPurposeKey(qualifiedPurpose) : null;
            const binding = purposeKey
                ? snapshot?.bindings.find((candidate) => qualifiedPurposeKey(candidate.purpose) === purposeKey) ?? null
                : null;
            const requestAuthUse = purposeKey
                ? snapshot?.requestAuthUses?.find((candidate) => qualifiedPurposeKey(candidate.purpose) === purposeKey) ?? null
                : null;
            const provider = consumer
                ? registry.providersByContributionKey?.get(`${consumer.pluginId}/${observation.providerLocalId}`)
                : null;
            if (consumer && qualifiedPurpose && binding && requestAuthUse && provider) {
                const result = await observationRuntime.service.observe({
                    machineId: observationRuntime.machineId,
                    operationId: randomUUID(),
                    consumer,
                    purpose: qualifiedPurpose,
                    binding,
                    requestAuthUse,
                    provider: provider.definition,
                    ...(resolveContributedCatalogParsers ? {
                        resolveContributedCatalogParsers: () => resolveContributedCatalogParsers(provider.identity),
                    } : {}),
                    trigger: params?.bypassCache === true ? 'manual_refresh' : 'picker_open',
                    currentOnly: params?.currentOnly === true,
                    isCurrent,
                    ...(requestContext.signal ? { signal: requestContext.signal } : {}),
                });
                if (!isCurrent()) throw new ProviderProbeCancelledError();
                return {
                    ok: true,
                    result: {
                        agentId,
                        availableModels: projectNativeCatalogModels(result.models, modelConfig),
                        supportsFreeform: modelConfig?.supportsSelection === true && modelConfig.supportsFreeform === true,
                        source: result.source,
                        observedAt: result.observedAt,
                        refreshError: result.refreshError ?? (result.source === 'static' || result.stale),
                    },
                };
            }
            const nativeContext = observation.nativeTarget
                ? resolveNativeCatalogObservationContext({ agentId, observation, registry, catalogEntry: dependencies.agentCatalogEntry })
                : null;
            if (nativeContext && observation.nativeTarget) {
                const signal = requestContext.signal && requestContext.deadlineSignal
                    ? AbortSignal.any([requestContext.signal, requestContext.deadlineSignal])
                    : requestContext.signal ?? requestContext.deadlineSignal;
                const catalog = nativeContext.provider.catalog;
                const probe = catalog.source === 'static+probe' ? catalog.probes[0] : undefined;
                const defaultEndpointUrl = nativeContext.provider.endpointTemplates.find(endpoint => endpoint.id === probe?.endpointTemplateId)?.baseUrl;
                const enabledSettingSources = await nativeContext.catalogEntry?.resolveNativeCatalogSettingSources?.({
                    pluginSettings: probeContext.pluginSettings ?? {},
                }) ?? [];
                const target = defaultEndpointUrl ? await (dependencies.resolveNativeCatalogTarget ?? resolveNativeCatalogTarget)({
                    observation,
                    catalogEntry: nativeContext.catalogEntry,
                    environment: await acquireEnvironment(signal),
                    cwd,
                    defaultEndpointUrl,
                    enabledSettingSources,
                    retainCleanup: requestContext.cleanupScope?.retain,
                    ...(signal ? { signal } : {}),
                    deadlineAtMs: probeDeadlineAtMs,
                }) : { status: 'unavailable' as const };
                if (target.status === 'unavailable') {
                    return { ok: true, result: {
                        agentId,
                        availableModels: projectNativeCatalogModels(modelConfig?.staticModels ?? [], modelConfig),
                        supportsFreeform: modelConfig?.supportsSelection === true && modelConfig.supportsFreeform === true,
                        source: 'static', refreshError: true,
                    } };
                }
                if (target.status === 'ready') {
                    const result = await observationRuntime.service.observeNative({
                        machineId: observationRuntime.machineId,
                        operationId: randomUUID(),
                        consumer: nativeContext.consumer,
                        purpose: nativeContext.purpose,
                        requestAuthUse: nativeContext.requestAuthUse,
                        provider: nativeContext.provider,
                        ...(resolveContributedCatalogParsers ? {
                            resolveContributedCatalogParsers: () => resolveContributedCatalogParsers(nativeContext.providerIdentity),
                        } : {}),
                        service: { pluginId: nativeContext.consumer.pluginId, localId: observation.connectedServiceId },
                        target,
                        wallDeadlineAtMs: probeDeadlineAtMs,
                        trigger: params?.bypassCache === true ? 'manual_refresh' : 'picker_open',
                        currentOnly: params?.currentOnly === true,
                        isCurrent,
                        ...(signal ? { signal } : {}),
                    });
                    if (!isCurrent()) throw new ProviderProbeCancelledError();
                    return {
                        ok: true,
                        result: {
                            agentId,
                            availableModels: projectNativeCatalogModels(result.models, modelConfig),
                            supportsFreeform: modelConfig?.supportsSelection === true && modelConfig.supportsFreeform === true,
                            source: result.source,
                        observedAt: result.observedAt,
                        refreshError: result.refreshError ?? (result.source === 'static' || result.stale),
                        },
                    };
                }
            }
        }
          return { ok: true, result: await probeAgentModelsBestEffort({ ...commonProbeArgs,
            bypassCache: params?.bypassCache === true, currentOnly: params?.currentOnly === true }) };
      }
      if (method === 'probeModes') {
          return { ok: true, result: await probeAgentModesBestEffort(commonProbeArgs) };
      }
      return { ok: true, result: await probeAgentConfigOptionsBestEffort(commonProbeArgs) };
      };
      try {
          const result = await runProbe();
          return profilePreparationFailed ? profileFailure() : result;
      } catch (error) {
          if (profilePreparationFailed) return profileFailure();
          throw error;
      }
    } finally {
      preparationLifetime.abort();
      try { await preparedLaunchEnvironment?.dispose(); }
      finally { await connectedServiceProbeEnvironment.cleanup?.(); }
    }
}


