import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { CreateAgentInvocationServices } from '@/plugins/runtime/invocation/services/types';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { projectNativeCatalogModels } from './nativeCatalogModels';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { CapabilitiesInvokeResponse } from '@/capabilities/types';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';
import { ConnectedServicesProviderStateSharingSettingsV1Schema } from '@happier-dev/protocol/account/settings/connected-services';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { CodexPassiveRealtimeSetupResultV1Schema } from '@happier-dev/protocol/capabilities/codexPassiveRealtimeSetup';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { getAgentModelConfig } from '@happier-dev/agents';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { readDeclaredCatalogConnectedServiceIds, resolveCatalogAgentConnectedServiceIds, readDeclaredCatalogConnectedAccountServiceIds, resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { resolveProbeBackendContext } from '@/rpc/handlers/capabilitiesProbeContext';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { parseConnectedServiceBindingSelections } from '@/daemon/connectedServices/parseConnectedServicesBindings';
import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { sanitizeEnvVarRecord } from '@/terminal/runtime/envVarSanitization';
import { stripSessionControlEnvOverrides } from '@/session/runtime/control/sessionControlEnvironment';
import { isDynamicModelProbeEnabled, resolveNativeCatalogBearer, type NativeCatalogBearer } from '@/providers/probe/nativeCatalogCredential';
import { resolveNativeCatalogObservationContext } from '@/providers/probe/resolveNativeCatalogObservationContext';
import { ProviderProbeCancelledError } from '@/providers/probe/client';
import { probeAgentModelsBestEffort } from './agentModelsProbe';
import { probeAgentModesBestEffort } from './agentModesProbe';
import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';
import { probeAgentCatalogs } from './agentCatalogsProbe';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { resolveProfileProbeEnvironment } from './resolveProfileProbeEnvironment';
import { resolvePreflightSessionControlsProbeEnvironment, withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 30_000;

type ConnectedServiceProbeCredentials = NonNullable<
    Awaited<ReturnType<typeof resolveProbeBackendContext>>['credentials']
>;
type ConnectedServiceProbeApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];

export type CliProbeDependencies = Readonly<{
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
    activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
    connectedAccountsOwner?: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['connectedAccountsOwner'];
    isAgentRegistryCurrent?: () => boolean;
    resolveNativeCatalogBearer?: (input: Parameters<typeof resolveNativeCatalogBearer>[0]) => Promise<NativeCatalogBearer | null>;
}>;

export type CliProbeRequestContext = Readonly<{
    signal?: AbortSignal;
    deadlineSignal?: AbortSignal;
    deadlineAtMs?: number;
    cleanupScope?: PreflightCatalogCleanupScope;
}>;

type ConnectedServiceProbeEnvironment = Readonly<{
    exactPurposeBindingSubjectId?: string;
    materializedEnv: Readonly<Record<string, string>> | null;
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
                // Admit only the launch destinations consumed by the existing materializer.
                for (const binding of snapshot.bindings) {
                    const key = qualifiedPurposeKey(binding.purpose);
                    const hasEnvironment = snapshot.environmentUses?.some(use => qualifiedPurposeKey(use.purpose) === key);
                    const hasFileEnvironment = snapshot.fileEnvironmentUses?.some(use => qualifiedPurposeKey(use.purpose) === key);
                    const hasNativeHome = stateSharing?.providerSupportStatus === 'supported'
                        && stateSharing.nativeHome
                        && stateSharing.authIsolation.secretEntries.length > 0
                        && snapshot.fileMaterializationPurposes?.some(scope => qualifiedPurposeKey(scope.purpose) === key);
                    if (!hasEnvironment && !hasFileEnvironment && !hasNativeHome) {
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
        cwd: typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? cwdRaw.trim() : process.cwd(),
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
    const { cwd, timeoutMs } = resolveCliProbeInvokeParams(params);
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
    const modelConfig = method === 'probeModels' ? getAgentModelConfig(agentId) : null;
    if (method === 'probeModels' && !isDynamicModelProbeEnabled({
        modelConfig,
        accountSettings: probeContext.accountSettings,
        environment: process.env,
    })) {
        return { ok: true, result: await probeAgentModelsBestEffort({
            agentId,
            catalogEntry: dependencies.agentCatalogEntry,
            registrySnapshot: dependencies.agentRegistrySnapshot,
            runtimeCacheKey: dependencies.agentRuntimeCacheKey,
            ...(requestContext.signal ? { signal: requestContext.signal } : {}),
            backendTarget: probeContext.backendTarget,
            runtimeDescriptorV1: probeContext.runtimeDescriptorV1,
            runtimeKindOverride: probeContext.runtimeKindOverride,
            pluginSettings: probeContext.pluginSettings,
            cwd,
            timeoutMs,
            accountSettings: probeContext.accountSettings,
            credentials: probeContext.credentials,
            env: process.env,
        }) };
    }
    let profileProbeEnvironment: Awaited<ReturnType<typeof resolveProfileProbeEnvironment>> = null;
    try {
        const secretReferenceOverlay = params?.secretReferenceOverlay == null
            ? undefined : SecretReferenceOverlayV1Schema.parse(params.secretReferenceOverlay);
        profileProbeEnvironment = await resolveProfileProbeEnvironment({
            agentId,
            profileId: params?.profileId,
            secretReferenceOverlay,
            accountSettings: probeContext.accountSettings,
            credentials: probeContext.credentials,
            processEnv: { ...process.env, ...explicitEnvironment },
        });
    } catch {
        return {
            ok: false,
            error: {
                code: 'profile-preflight-failed',
                message: 'Could not prepare the selected backend profile for this probe.',
            },
        };
    }
    const nativeLaunchPreferences = method === 'probeCatalogs'
        ? await dependencies.agentCatalogEntry?.resolveSessionRuntimePreferences?.({
            isExplicitCliSubcommand: false,
            parsed: { agentArgs: [] },
            settings: probeContext.accountSettings ?? {},
            pluginSettings: probeContext.pluginSettings ?? {},
            environment: { ...process.env, ...explicitEnvironment, ...(profileProbeEnvironment?.env ?? {}) },
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
        ...process.env,
        ...nativeLaunchEnvironment,
        ...explicitEnvironment,
        ...(profileProbeEnvironment?.env ?? {}),
    };
    let connectedServiceProbeEnvironment: ConnectedServiceProbeEnvironment = {
        materializedEnv: null,
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
        } catch {
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
    let materializedEnv = {
        ...nativeLaunchEnvironment,
        ...explicitEnvironment,
        ...(profileProbeEnvironment?.env ?? {}),
        ...(connectedServiceProbeEnvironment.materializedEnv ?? {}),
    };
    if (requiresMaterializedAuth && dependencies.agentCatalogEntry?.preparePreflightLaunchEnvironment) {
        const agent = dependencies.agentRegistrySnapshot?.agentDefinitionsById.get(agentId);
        const identity = agent?.identity;
        const target = dependencies.agentRegistrySnapshot?.activationTargets.find(target => target.pluginId === identity?.pluginId);
        if (!identity || !target || !dependencies.agentRuntimeCacheKey || !dependencies.createAgentInvocationServices
            || !connectedServiceProbeEnvironment.exactPurposeBindingSubjectId) {
            return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Native account preparation is unavailable for this probe.' } };
        }
        const environment = (await resolvePreflightSessionControlsProbeEnvironment({ agentId, processEnv: process.env, materializedEnv })).env;
        const values = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const services = await dependencies.createAgentInvocationServices({
            pluginId: identity.pluginId, pluginVersion: target.manifest.version, agentId,
            occurrenceId: dependencies.agentRuntimeCacheKey, correlationId: randomUUID(), cwd,
            exactPurposeBindingSubjectId: connectedServiceProbeEnvironment.exactPurposeBindingSubjectId,
            environment: values, signal: preparationSignal,
            isOccurrenceCurrent: dependencies.isAgentRegistryCurrent ?? (() => false),
        });
        preparedLaunchEnvironment = await dependencies.agentCatalogEntry.preparePreflightLaunchEnvironment({
            environment: values, connectedAccounts: services.connectedAccounts, signal: preparationSignal,
        });
        materializedEnv = { ...preparedLaunchEnvironment.environment };
        for (const key of preparedLaunchEnvironment.unset ?? []) delete materializedEnv[key];
    }
    const probeProcessEnv = (await resolvePreflightSessionControlsProbeEnvironment({
        agentId,
        // Preparation receives the complete cold launch environment. Do not
        // reintroduce an inherited native home/key that it explicitly removed.
        processEnv: preparedLaunchEnvironment ? {} : process.env,
        materializedEnv,
    })).env;
    const commonProbeArgs = {
        agentId,
        catalogEntry: dependencies.agentCatalogEntry,
        registrySnapshot: dependencies.agentRegistrySnapshot,
        runtimeCacheKey: dependencies.agentRuntimeCacheKey,
        ...(requestContext.signal ? { signal: requestContext.signal } : {}),
        ...(requestContext.deadlineSignal ? { deadlineSignal: requestContext.deadlineSignal } : {}),
        ...(requestContext.cleanupScope ? { cleanupScope: requestContext.cleanupScope } : {}),
        backendTarget: probeContext.backendTarget,
        runtimeDescriptorV1: probeContext.runtimeDescriptorV1,
        runtimeKindOverride: probeContext.runtimeKindOverride,
        pluginSettings: probeContext.pluginSettings,
        cwd,
        timeoutMs: requestContext.deadlineAtMs === undefined ? timeoutMs : Math.max(0, requestContext.deadlineAtMs - Date.now()),
        accountSettings: probeContext.accountSettings,
        credentials: probeContext.credentials,
        env: probeProcessEnv,
        materializedEnv,
        profileCacheKey: profileProbeEnvironment?.cacheKey ?? null,
        connectedServiceSelectionCacheKey:
            connectedServiceProbeEnvironment.connectedServiceSelectionCacheKey,
    };

      requestContext.signal?.throwIfAborted();
      if (method === 'probeCatalogs') {
          return { ok: true, result: await probeAgentCatalogs({ ...commonProbeArgs, bypassCache: params?.bypassCache === true }) };
      }
      if (method === 'probePassiveRealtimeSetup') {
        const result = await withPreflightSessionControlsProbeEnvironment({
          agentId,
          processEnv: probeProcessEnv,
          materializedEnv: commonProbeArgs.materializedEnv,
        }, async ({ env }) => {
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
            ...(requestContext.signal ? { signal: requestContext.signal } : {}),
            ...(requestContext.deadlineSignal ? { deadlineSignal: requestContext.deadlineSignal } : {}),
            ...(requestContext.cleanupScope ? { cleanupScope: requestContext.cleanupScope } : {}),
          });
          const parsed = CodexPassiveRealtimeSetupResultV1Schema.safeParse(raw);
          return parsed.success ? parsed.data : { v: 1, status: 'unavailable' } as const;
        }).catch(() => ({ v: 1, status: 'unavailable' } as const));
        if (dependencies.isAgentRegistryCurrent?.() === false) {
          return { ok: true, result: { v: 1, status: 'unavailable' } };
        }
        return { ok: true, result };
      }
      if (method === 'probeModels') {
        const observation = modelConfig?.nativeCatalogObservation;
        const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(params?.connectedServices);
        const observationRuntime = dependencies.getAgentCatalogObservation?.() ?? null;
        if (observation && observationRuntime) {
            const registry = dependencies.agentRegistrySnapshot ?? readCurrentContributionRegistry();
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
                    trigger: params?.bypassCache === true ? 'manual_refresh' : 'picker_open',
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
            const nativeContext = observation.nativeBearer
                ? resolveNativeCatalogObservationContext({ agentId, observation, registry, catalogEntry: dependencies.agentCatalogEntry })
                : null;
            if (nativeContext && observation.nativeBearer) {
                const credential = await (dependencies.resolveNativeCatalogBearer ?? resolveNativeCatalogBearer)({
                    observation,
                    catalogEntry: nativeContext.catalogEntry,
                    environment: probeProcessEnv,
                }).catch(() => null);
                if (credential) {
                    const result = await observationRuntime.service.observeNative({
                        machineId: observationRuntime.machineId,
                        operationId: randomUUID(),
                        consumer: nativeContext.consumer,
                        purpose: nativeContext.purpose,
                        requestAuthUse: nativeContext.requestAuthUse,
                        provider: nativeContext.provider,
                        service: { pluginId: nativeContext.consumer.pluginId, localId: observation.connectedServiceId },
                        credential,
                        trigger: params?.bypassCache === true ? 'manual_refresh' : 'picker_open',
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
            }
        }
          return { ok: true, result: await probeAgentModelsBestEffort({ ...commonProbeArgs, bypassCache: params?.bypassCache === true }) };
      }
      if (method === 'probeModes') {
          return { ok: true, result: await probeAgentModesBestEffort(commonProbeArgs) };
      }
      return { ok: true, result: await probeAgentConfigOptionsBestEffort(commonProbeArgs) };
    } finally {
      preparationLifetime.abort();
      try { await preparedLaunchEnvironment?.dispose(); }
      finally { await connectedServiceProbeEnvironment.cleanup?.(); }
    }
}


