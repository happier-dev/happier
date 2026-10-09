import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { ConnectedServicesProviderStateSharingSettingsV1Schema } from '@happier-dev/protocol';
import { createCapabilityChecklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
import { windowsTerminalCapability } from '@/capabilities/registry/toolWindowsTerminal';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { systemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { ghDepCapability } from '@/capabilities/registry/depGh';
import { azDepCapability } from '@/capabilities/registry/depAz';
import {
    createInstallableCapabilities,
    createInstallablesRegistryFromResolvedContributions,
} from '@/capabilities/registry/installables';
import { createCapabilitiesService } from '@/capabilities/service';
import type { Capability } from '@/capabilities/service';
import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '@/capabilities/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { probeAgentModesBestEffort } from '@/capabilities/probes/agentModesProbe';
import { probeAgentConfigOptionsBestEffort } from '@/capabilities/probes/agentConfigOptionsProbe';
import { probeAgentCatalogs } from '@/capabilities/probes/agentCatalogsProbe';
import { createPreflightCatalogCleanupScope, type PreflightCatalogCleanupScope } from '@/capabilities/probes/preflightCatalogCleanupScope';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { sanitizeEnvVarRecord } from '@/terminal/runtime/envVarSanitization';
import { stripSessionControlEnvOverrides } from '@/session/runtime/control/sessionControlEnvironment';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { getAgentModelConfig } from '@happier-dev/agents';
import { CodexPassiveRealtimeSetupResultV1Schema } from '@happier-dev/protocol/capabilities/codexPassiveRealtimeSetup';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { PluginScaffoldUiModeSchema, PluginScaffoldTemplateSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { CapabilityId } from '@happier-dev/protocol';
import { PluginUpdatePolicyV1Schema } from '@happier-dev/protocol/marketplace/pluginUpdatePolicyV1';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import {
    isDynamicModelProbeEnabled,
    resolveNativeCatalogBearer,
    type NativeCatalogBearer,
} from '@/providers/probe/nativeCatalogCredential';
import { ProviderProbeCancelledError } from '@/providers/probe/client';
import { resolveNativeCatalogObservationContext } from '@/providers/probe/resolveNativeCatalogObservationContext';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProbeBackendContext } from './capabilitiesProbeContext';
import { resolvePreflightSessionControlsProbeAdapter } from '@/capabilities/probes/resolvePreflightSessionControlsProbeAdapter';
import {
    resolvePreflightSessionControlsProbeEnvironment,
    withPreflightSessionControlsProbeEnvironment,
} from '@/capabilities/probes/preflightSessionControlsProbeEnvironment';
import { resolveProfileProbeEnvironment } from '@/capabilities/probes/resolveProfileProbeEnvironment';
import { readDeclaredCatalogConnectedServiceIds, resolveCatalogAgentConnectedServiceIds, readDeclaredCatalogConnectedAccountServiceIds, resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { parseConnectedServiceBindingSelections } from '@/daemon/connectedServices/parseConnectedServicesBindings';
import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { invokeAgentCliInstallCapability } from '@/capabilities/cliUpdate/invokeAgentCliInstallCapability';
import { withAgentCliUpdateFacts } from '@/capabilities/cliUpdate/agentCliUpdates';
import {
    getResolvedContributionRegistry,
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { requestExactMarketplaceInstall } from '@/plugins/store/marketplace/exactInstall';
import {
    readInstalledPluginCatalogEntry,
    type PluginCatalogEntry,
} from '@/plugins/projection/catalog/installed';
import {
    listUserPluginChanges,
    readUserPluginChangeStatus,
    requestUserPluginChange,
} from '@/plugins/daemon/changeClient';
import { controlDaemonPluginDevelopment } from '@/daemon/controlClient';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import { setInstalledPluginEnabled } from '@/plugins/store/enabled';
import { ManagedResourceDispositionV1Schema, type ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { runPluginAuthorToolchain } from '@/plugins/authoring/toolchain';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 30_000;

/** Installed inventory served to the Plugins UI; omit daemon-only catalog detail. */
type InstalledPluginCapabilityEntry = Omit<
    PluginCatalogEntry,
    'manifest' | 'manifestPath' | 'contributionIntrospection'
>;

function projectInstalledPluginCapabilityEntry(entry: PluginCatalogEntry): InstalledPluginCapabilityEntry {
    return {
        pluginId: entry.pluginId,
        desiredGeneration: entry.desiredGeneration,
        appliedGeneration: entry.appliedGeneration,
        admittedIntegrity: entry.admittedIntegrity,
        rollbackAvailability: entry.rollbackAvailability,
        title: entry.title,
        description: entry.description,
        version: entry.version,
        enabled: entry.enabled,
        source: entry.source,
        install: entry.install,
        compatibility: entry.compatibility,
        diagnostics: entry.diagnostics,
    };
}

/** Plugin reload generation of this process; fences registry snapshots against in-process reloads. */
function readPluginReloadGeneration(): number {
    try {
        return pluginReloadController.getState().generation;
    } catch {
        return 0;
    }
}

type ConnectedServiceProbeCredentials = NonNullable<
    Awaited<ReturnType<typeof resolveProbeBackendContext>>['credentials']
>;
type ConnectedServiceProbeApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];

type CliProbeDependencies = Readonly<{
    agentCatalogEntry?: AgentCatalogEntry | null;
    agentRuntimeCacheKey?: string;
    createApiClient?: (credentials: ConnectedServiceProbeCredentials) => Promise<ConnectedServiceProbeApi>;
    getAgentCatalogObservation?: () => Readonly<{
        machineId: string;
        service: AgentProviderCatalogObservationService;
    }> | null;
    agentRegistrySnapshot?: ReturnType<typeof getResolvedContributionRegistry>;
    activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
    isAgentRegistryCurrent?: () => boolean;
    resolveNativeCatalogBearer?: (input: Parameters<typeof resolveNativeCatalogBearer>[0]) => Promise<NativeCatalogBearer | null>;
}>;

type CliProbeRequestContext = Readonly<{
    signal?: AbortSignal;
    deadlineSignal?: AbortSignal;
    deadlineAtMs?: number;
    cleanupScope?: PreflightCatalogCleanupScope;
}>;

type ConnectedServiceProbeEnvironment = Readonly<{
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
        activeServerDir: configuration.activeServerDir,
        baseDir: materializationBaseDir,
        credentials: params.credentials,
        api: await params.dependencies.createApiClient(params.credentials),
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

function buildCapabilityId(kind: 'cli' | 'tool' | 'dep', suffix: string): CapabilityId {
    // `CapabilityId` is intentionally a namespaced string type (`cli.${string}` / etc). TS does not
    // infer template-literal types for dynamic template strings, so we assert at this boundary.
    return `${kind}.${suffix}` as CapabilityId;
}

function titleCase(value: string): string {
    if (!value) return value;
    return `${value[0].toUpperCase()}${value.slice(1)}`;
}

const CONFIGURED_ACP_CLI_CAPABILITY_ID = 'configuredAcp';

function resolvePublicCliCapabilityAgentId(agentId: string): string {
    // `customAcp` is legacy/compat only. Expose a stable capability id that does not
    // leak the legacy sentinel into active runtime selection surfaces.
    return agentId === 'customAcp' ? CONFIGURED_ACP_CLI_CAPABILITY_ID : agentId;
}

function resolvePublicCliCapabilityTitle(agentId: string): string {
    if (agentId === 'customAcp') return 'Configured ACP CLI';
    return `${titleCase(agentId)} CLI`;
}

function resolveCliProbeInvokeParams(params?: Record<string, unknown>): Readonly<{
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

async function invokeCliProbeOrInstallMethod(
    agentId: AgentCatalogEntry['id'],
    method: string,
    params?: Record<string, unknown>,
    dependencies: CliProbeDependencies = {},
    requestContext: CliProbeRequestContext = {},
): Promise<CapabilitiesInvokeResponse | null> {
    if (method === 'install') {
        return invokeAgentCliInstallCapability(
            agentId,
            params,
            dependencies.agentRegistrySnapshot?.agents.find((entry) => entry.id === agentId)?.runtimeSpec ?? undefined,
        );
    }

    if (
        method !== 'probeModels'
        && method !== 'probeModes'
        && method !== 'probeConfigOptions'
        && method !== 'probeCatalogs'
        && method !== 'probePassiveRealtimeSetup'
    ) {
        return null;
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (method === 'probeCatalogs') {
        const { timeoutMs } = resolveCliProbeInvokeParams(params);
        const deadline = new AbortController();
        const signal = requestContext.signal ? AbortSignal.any([requestContext.signal, deadline.signal]) : deadline.signal;
        requestContext = { signal, deadlineSignal: signal, deadlineAtMs: Date.now() + timeoutMs, cleanupScope: createPreflightCatalogCleanupScope() };
        deadlineTimer = setTimeout(() => deadline.abort(new Error('Agent catalog preflight timed out')), timeoutMs);
    }
    try {
      return await withAgentPreflightCatalog({
        agentId,
        signal: requestContext.signal,
        isCurrent: dependencies.isAgentRegistryCurrent,
        cleanupScope: requestContext.cleanupScope,
    }, async (catalog) => {
        const result = await invokeCliPreflightMethod(agentId, method, params, {
            ...dependencies,
            ...(catalog.registrySnapshot ? {
                agentCatalogEntry: catalog.catalogEntry,
                agentRuntimeCacheKey: catalog.runtimeCacheKey,
                agentRegistrySnapshot: catalog.registrySnapshot,
            } : {}),
            isAgentRegistryCurrent: catalog.isCurrent,
        }, requestContext);
        if (method === 'probeModels' && params?.runtimeDescriptorV1 != null && result.ok
            && result.result !== null && typeof result.result === 'object' && !Array.isArray(result.result)) {
            // A successful model response has validated the requested descriptor
            // and used that context. Predecessor daemons omit this acknowledgement.
            return { ...result, result: { ...result.result, runtimeDescriptorV1Accepted: true } };
        }
        return result;
      });
    } catch (error) {
        if (method !== 'probeCatalogs') throw error;
        logger.infoFile('[capabilities] Native preflight catalog probe unavailable');
        return { ok: false, error: { code: 'preflight-catalog-unavailable', message: 'Could not discover the selected backend catalogs.' } };
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        await requestContext.cleanupScope?.dispose();
    }
}

async function invokeCliPreflightMethod(
    agentId: AgentCatalogEntry['id'],
    method: string,
    params: Record<string, unknown> | undefined,
    dependencies: CliProbeDependencies,
    requestContext: CliProbeRequestContext,
): Promise<CapabilitiesInvokeResponse> {
    const { cwd, timeoutMs } = resolveCliProbeInvokeParams(params);
    const parsedConnectedServices = ConnectedServiceBindingsV2IngressSchema.safeParse(params?.connectedServices);
    const connectedServices = parsedConnectedServices.success ? parsedConnectedServices.data : null;
    if (method === 'probeCatalogs' && params?.connectedServices != null && !parsedConnectedServices.success) {
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
    if (method === 'probeCatalogs' && hasConnectedServiceSelection && !materializationAgentId) {
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
        { requireCredentials: requiresMaterializedAuth, catalogEntry: dependencies.agentCatalogEntry, signal: requestContext.signal },
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
    try {
    requestContext.signal?.throwIfAborted();
    const materializedEnv = {
        ...nativeLaunchEnvironment,
        ...explicitEnvironment,
        ...(profileProbeEnvironment?.env ?? {}),
        ...(connectedServiceProbeEnvironment.materializedEnv ?? {}),
    };
    const probeProcessEnv = (await resolvePreflightSessionControlsProbeEnvironment({
        agentId,
        processEnv: process.env,
        materializedEnv,
    })).env;
    const commonProbeArgs = {
        agentId,
        catalogEntry: dependencies.agentCatalogEntry,
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
          processEnv: profileProcessEnv,
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
                        availableModels: [
                            { id: 'default', name: 'Default' },
                            ...result.models.filter((model) => model.id !== 'default'),
                        ],
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
                            availableModels: [
                                { id: 'default', name: 'Default' },
                                ...result.models.filter((model) => model.id !== 'default'),
                            ],
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
      await connectedServiceProbeEnvironment.cleanup?.();
    }
}

type PluginMarketplaceCapabilityMethod =
    | 'install'
    | 'update'
    | 'setUpdatePolicy'
    | 'enable'
    | 'disable'
    | 'rollback'
    | 'uninstall'
    | 'forgetTrust'
    | 'create'
    | 'develop'
    | 'unregisterDevelopment'
    | 'edit'
    | 'test'
    | 'pack'
    | 'changeStatus';

function resolveMarketplaceActionMethod(method: string): PluginMarketplaceCapabilityMethod | null {
    if (
        method === 'install'
        || method === 'update'
        || method === 'setUpdatePolicy'
        || method === 'enable'
        || method === 'disable'
        || method === 'rollback'
        || method === 'uninstall'
        || method === 'forgetTrust'
        || method === 'create'
        || method === 'develop'
        || method === 'unregisterDevelopment'
        || method === 'edit'
        || method === 'test'
        || method === 'pack'
        || method === 'changeStatus'
    ) {
        return method;
    }
    return null;
}

/**
 * Rejoins one daemon-issued pending change by its id, without creating or
 * deciding anything.
 *
 * This is the read a present user needs before answering a change some other
 * client prepared: the snapshot listing can be minutes old, and the honest
 * arms — still applying, already expired, daemon gone — are only knowable from
 * the change owner at decision time. It travels verbatim so the caller renders
 * exactly what `happier plugins change status` renders.
 */
async function invokePluginChangeStatusAction(
    params: Record<string, unknown> | undefined,
): Promise<CapabilitiesInvokeResponse> {
    const pendingChangeId = typeof params?.pendingChangeId === 'string' ? params.pendingChangeId.trim() : '';
    if (!pendingChangeId) {
        return { ok: false, error: { message: 'pendingChangeId is required', code: 'plugin_change_missing' } };
    }
    const status = await readUserPluginChangeStatus({ pendingChangeId });
    return { ok: true, result: { action: 'changeStatus', pendingChangeId, status } };
}

/** Registers an explicit trusted development root through the daemon owner. */
async function invokePluginDevelopAction(
    params: Record<string, unknown> | undefined,
): Promise<CapabilitiesInvokeResponse> {
    const sourceRootPath = typeof params?.sourceRootPath === 'string' ? params.sourceRootPath.trim() : '';
    if (!sourceRootPath) {
        return { ok: false, error: { message: 'sourceRootPath is required', code: 'plugin_source_missing' } };
    }
    const sdkRegistryOrigin = typeof params?.sdkRegistryOrigin === 'string'
        ? params.sdkRegistryOrigin.trim()
        : '';
    const result = await controlDaemonPluginDevelopment({
        kind: 'registerExplicit',
        rootPath: sourceRootPath,
        ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
    });
    if (result.kind !== 'failed') {
        return { ok: true, result: { action: 'develop', sourceRootPath, status: result.status } };
    }
    return {
        ok: false,
        error: {
            message: result.message,
            code: result.code,
        },
    };
}

/** Forgets one exact explicit development root through the daemon owner. */
async function invokePluginDevelopmentUnregisterAction(
    params: Record<string, unknown> | undefined,
): Promise<CapabilitiesInvokeResponse> {
    const sourceRootPath = typeof params?.sourceRootPath === 'string' ? params.sourceRootPath.trim() : '';
    if (!sourceRootPath) {
        return { ok: false, error: { message: 'sourceRootPath is required', code: 'plugin_source_missing' } };
    }
    const result = await controlDaemonPluginDevelopment({
        kind: 'unregisterExplicit',
        rootPath: sourceRootPath,
    });
    if (result.kind === 'failed') {
        return { ok: false, error: { message: result.message, code: result.code } };
    }
    return {
        ok: true,
        result: { action: 'unregisterDevelopment', sourceRootPath, status: result.status },
    };
}

async function invokePluginDevelopmentAction(
    action: Extract<PluginMarketplaceCapabilityMethod, 'create' | 'edit' | 'test' | 'pack'>,
    params: Record<string, unknown> | undefined,
): Promise<CapabilitiesInvokeResponse> {
    if (action === 'create') {
        const targetDir = typeof params?.targetDir === 'string' ? params.targetDir.trim() : '';
        const pluginId = typeof params?.pluginId === 'string' ? params.pluginId.trim() : '';
        const displayName = typeof params?.displayName === 'string' ? params.displayName.trim() : '';
        // The scaffold UI mode has one vocabulary owner. Resolving it here
        // through the same schema the CLI flag and the `plugins.scaffold`
        // action input use keeps this third caller from silently scaffolding a
        // non-UI plugin when the client asked for a UI surface.
        const requestedUi = params?.ui;
        const ui = requestedUi === undefined || requestedUi === null
            ? undefined
            : PluginScaffoldUiModeSchema.safeParse(requestedUi);
        if (ui && !ui.success) {
            return {
                ok: false,
                error: {
                    message: `Unsupported plugin scaffold UI mode: ${String(requestedUi)}`,
                    code: 'plugin_scaffold_invalid_input',
                },
            };
        }
        const requestedTemplate = params?.template;
        const template = requestedTemplate === undefined || requestedTemplate === null
            ? undefined
            : PluginScaffoldTemplateSchema.safeParse(requestedTemplate);
        if (template && !template.success) {
            return {
                ok: false,
                error: {
                    message: `Unsupported plugin scaffold template: ${String(requestedTemplate)}`,
                    code: 'plugin_scaffold_invalid_input',
                },
            };
        }
        const result = await scaffoldLocalPlugin({
            targetDir,
            pluginId,
            displayName,
            invokerName: resolveInvokerName() ?? 'happier',
            ...(ui ? { ui: ui.data } : {}),
            ...(template ? { template: template.data } : {}),
        });
        if (!result.ok) {
            return {
                ok: false,
                error: {
                    message: result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
                    code: result.diagnostics[0]?.code ?? 'plugin-scaffold-failed',
                },
            };
        }
        return {
            ok: true,
            result: {
                action,
                pluginId: result.pluginId,
                sourceRootPath: result.targetDir,
                sourceEntryPath: result.sourceEntryPath,
                ...(result.uiEntryPath ? { uiEntryPath: result.uiEntryPath } : {}),
            },
        };
    }

    const pluginId = typeof params?.pluginId === 'string' ? params.pluginId.trim() : '';
    if (!pluginId) {
        return { ok: false, error: { message: 'pluginId is required', code: 'plugin-not-found' } };
    }

    const entry = await readInstalledPluginCatalogEntry({
        pluginId,
        happyHomeDir: configuration.happyHomeDir,
    });
    if (!entry) {
        return { ok: false, error: { message: `Installed plugin '${pluginId}' was not found`, code: 'plugin-not-found' } };
    }
    if (entry.source.kind !== 'path' || entry.source.devWatch !== true) {
        return {
            ok: false,
            error: {
                message: `Plugin '${pluginId}' is not an approved local development source`,
                code: 'plugin-development-source-unavailable',
            },
        };
    }

    const sourceRootPath = entry.source.locator;
    if (action === 'edit') {
        return {
            ok: true,
            result: {
                action,
                pluginId,
                sourceRootPath,
                sessionDirectory: entry.source.resolvedPath,
            },
        };
    }
    if (action === 'test') {
        const result = await runPluginAuthorToolchain({
            operation: 'test',
            projectRoot: sourceRootPath,
        });
        if (!result.ok) {
            return {
                ok: false,
                error: {
                    message: result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
                    code: result.diagnostics[0]?.code ?? 'plugin-author-test-failed',
                },
            };
        }
        return { ok: true, result: { action, pluginId, sourceRootPath } };
    }

    const result = await packLocalPlugin({ locator: sourceRootPath });
    if (!result.ok) {
        return {
            ok: false,
            error: {
                message: result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
                code: 'plugin-pack-failed',
            },
        };
    }
    return {
        ok: true,
        result: {
            action,
            pluginId,
            sourceRootPath,
            archivePath: result.archivePath,
            archiveDigest: result.archiveDigest,
            digestPath: result.digestPath,
        },
    };
}

async function invokePluginMarketplaceAction(
    method: string,
    params: Record<string, unknown> | undefined,
): Promise<CapabilitiesInvokeResponse> {
    const action = resolveMarketplaceActionMethod(method);
    if (!action) {
        return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
    }

    if (action === 'develop') {
        return await invokePluginDevelopAction(params);
    }

    if (action === 'unregisterDevelopment') {
        return await invokePluginDevelopmentUnregisterAction(params);
    }

    if (action === 'changeStatus') {
        return await invokePluginChangeStatusAction(params);
    }

    if (action === 'create' || action === 'edit' || action === 'test' || action === 'pack') {
        return await invokePluginDevelopmentAction(action, params);
    }

    let managedResourceDispositions: readonly ManagedResourceDispositionV1[] | undefined;
    if ((action === 'disable' || action === 'uninstall') && params?.managedResourceDispositions !== undefined) {
        const parsed = ManagedResourceDispositionV1Schema.array().safeParse(params.managedResourceDispositions);
        if (!parsed.success) {
            return { ok: false, error: { code: 'invalid-request', message: 'Invalid reviewed managed-resource dispositions' } };
        }
        managedResourceDispositions = parsed.data;
    }

    if (action === 'enable' || action === 'disable') {
        const pluginId = typeof params?.pluginId === 'string' ? params.pluginId.trim() : '';
        if (!pluginId) {
            return { ok: false, error: { message: 'pluginId is required', code: 'plugin-not-found' } };
        }

        const toggled = await setInstalledPluginEnabled({
            happyHomeDir: configuration.happyHomeDir,
            pluginId,
            enabled: action === 'enable',
            ...(managedResourceDispositions !== undefined ? { managedResourceDispositions } : {}),
        });
        if (!toggled.ok) {
            if (action === 'disable' && toggled.change
                && toggled.change.kind !== 'reviewRequired'
                && toggled.change.kind !== 'registryProfileRequired'
                && toggled.change.kind !== 'projectTrustAccepted') {
                return { ok: true, result: { action, pluginId, change: toggled.change } };
            }
            return { ok: false, error: { message: toggled.errorMessage, code: toggled.errorCode } };
        }

        const entry = (await readCurrentDaemonPluginCatalog({
            happyHomeDir: configuration.happyHomeDir,
            reloadController: pluginReloadController,
        })).find((candidate) => candidate.pluginId === pluginId) ?? null;
        return {
            ok: true,
            result: {
                action,
                pluginId,
                entry,
                change: toggled.change ?? null,
            },
        };
    }

    const pluginId = typeof params?.pluginId === 'string' ? params.pluginId.trim() : '';
    if (!pluginId) {
        return { ok: false, error: { message: 'pluginId is required', code: 'plugin-not-found' } };
    }

    if (action === 'setUpdatePolicy') {
        const parsedPolicy = PluginUpdatePolicyV1Schema.safeParse(params?.policy);
        if (!parsedPolicy.success) {
            return {
                ok: false,
                error: { message: 'policy must be a supported plugin update policy', code: 'plugin_update_policy_invalid' },
            };
        }
        const change = await requestUserPluginChange({
            request: { kind: 'setUpdatePolicy', pluginId, policy: parsedPolicy.data },
            approval: 'none',
        });
        if (change.kind !== 'committed') {
            return {
                ok: false,
                error: change.kind === 'failed'
                    ? {
                        message: change.message ?? `Plugin update policy change failed (${change.code}).`,
                        code: change.code,
                    }
                    : {
                        message: `The daemon did not commit the plugin update policy (${change.kind}).`,
                        code: change.kind,
                    },
            };
        }
        return { ok: true, result: { action, pluginId, policy: parsedPolicy.data, change } };
    }

    // Installing an exact catalog listing is its own explicit action: the caller
    // names a marketplace source and gets exactly that published version.
    // Updating is not that action — see the canonical `update` dispatch below.
    if (action === 'install') {
        const sourceId = typeof params?.sourceId === 'string' ? params.sourceId.trim() : '';
        if (!sourceId) {
            return { ok: false, error: { message: 'sourceId is required', code: 'plugin_source_missing' } };
        }
        // The caller may carry the package name of the listing it showed. It
        // only targets the source before acquisition — the exact origin,
        // version, SRI and manifest facts still come from the source's own
        // answer and are revalidated by the daemon staging owner.
        const packageName = typeof params?.packageName === 'string' ? params.packageName.trim() : '';
        const exactInstall = await requestExactMarketplaceInstall({
            happyHomeDir: configuration.happyHomeDir,
            sourceId,
            pluginId,
            ...(packageName ? { packageName } : {}),
        });
        // A registry selection, like a review, is the present user's to answer:
        // it travels back typed whether the listing named it before any
        // registry access or the daemon's preparer named it at download.
        if (!exactInstall.ok && exactInstall.code === 'registry_profile_required') {
            return {
                ok: true,
                result: {
                    action,
                    pluginId,
                    change: { kind: 'registryProfileRequired', ...exactInstall.requirement },
                },
            };
        }
        if (!exactInstall.ok) {
            return { ok: false, error: { message: exactInstall.message, code: exactInstall.code } };
        }
        if (exactInstall.change.kind === 'registryProfileRequired') {
            const { kind, registryOrigin, packageName, registryProfileId } = exactInstall.change;
            return {
                ok: true,
                result: { action, pluginId, change: { kind, registryOrigin, packageName, registryProfileId } },
            };
        }
        if (exactInstall.change.kind === 'reviewRequired') {
            return {
                ok: true,
                result: {
                    action,
                    pluginId,
                    listing: exactInstall.listing,
                    change: exactInstall.change,
                },
            };
        }
        if (exactInstall.change.kind !== 'committed') {
            return {
                ok: false,
                error: {
                    message: `The daemon did not commit the exact marketplace install (${exactInstall.change.kind}).`,
                    code: exactInstall.change.kind,
                },
            };
        }
        return {
            ok: false,
            error: {
                message: 'Generic plugin installation cannot approve or commit new package trust.',
                code: 'plugin_install_human_decision_required',
            },
        };
    }

    // `update` carries only the plugin id on purpose. The installed record is the
    // update authority: it owns the pinned/manual/automatic policy, the trusted
    // distribution channel, and the newest-compatible selection. A marketplace
    // listing is a discovery fact, never a second update resolver.
    const change = await requestUserPluginChange({
        request: action === 'uninstall'
            ? { kind: 'uninstall', pluginId,
                ...(managedResourceDispositions !== undefined ? { managedResourceDispositions } : {}) }
            : { kind: action, pluginId },
        approval: 'none',
    });
    // Removal reviews and partial/uncertain outcomes are semantic daemon results.
    // Installation trust/registry reviews cannot settle a removal request.
    if (action === 'uninstall' && change.kind !== 'reviewRequired'
        && change.kind !== 'registryProfileRequired' && change.kind !== 'projectTrustAccepted') {
        return { ok: true, result: { action, pluginId, change } };
    }
    // An update the installed policy still owes a present user travels back
    // verbatim, exactly like an install review: only a present user can decide it.
    if (action === 'update' && change.kind === 'reviewRequired') {
        return { ok: true, result: { action, pluginId, change } };
    }
    // So is a registry selection the installed channel's registry now needs.
    if (action === 'update' && change.kind === 'registryProfileRequired') {
        const { kind, registryOrigin, packageName, registryProfileId } = change;
        return { ok: true, result: { action, pluginId, change: { kind, registryOrigin, packageName, registryProfileId } } };
    }
    if (change.kind !== 'committed') {
        return {
            ok: false,
            // A refusal the change owner explained — a pinned installation, an
            // unavailable trusted channel — reaches the caller with that owner's
            // own code and words, the same ones `happier plugins update`
            // prints.
            error: change.kind === 'failed'
                ? {
                    message: change.message ?? `Plugin change failed (${change.code}).`,
                    code: change.code,
                }
                : {
                    message: `The daemon did not commit the plugin ${action} (${change.kind}).`,
                    code: change.kind,
                },
        };
    }
    return {
        ok: true,
        result: {
            action,
            pluginId,
            change,
        },
    };
}

async function resolveCliPassiveRealtimeSetupProbeSupport(
    agentId: AgentCatalogEntry['id'],
): Promise<boolean> {
    const adapter = await resolvePreflightSessionControlsProbeAdapter(agentId).catch(() => null);
    return Boolean(adapter?.probePassiveRealtimeSetupRaw);
}

async function createGenericCliCapability(
    agentId: AgentCatalogEntry['id'],
    dependencies: CliProbeDependencies,
): Promise<Capability> {
    const publicAgentId = resolvePublicCliCapabilityAgentId(agentId);
    const supportsPassiveRealtimeSetup = await resolveCliPassiveRealtimeSetupProbeSupport(agentId);
    return {
        descriptor: {
            id: buildCapabilityId('cli', publicAgentId),
            kind: 'cli',
            title: resolvePublicCliCapabilityTitle(agentId),
            methods: {
                install: { title: 'Install' },
                probeModels: { title: 'Probe models' },
                probeModes: { title: 'Probe modes' },
                probeConfigOptions: { title: 'Probe config options' },
                probeCatalogs: { title: 'Probe commands and skills' },
                ...(supportsPassiveRealtimeSetup
                    ? { probePassiveRealtimeSetup: { title: 'Probe passive realtime setup' } }
                    : {}),
            },
        },
        detect: async ({ request, context }) => {
            const entry = context.cliSnapshot?.clis?.[agentId];
            return buildCliCapabilityData({ request, entry });
        },
        invoke: async ({ method, params, signal }) => {
            const sharedResult = await invokeCliProbeOrInstallMethod(
                agentId,
                method,
                params,
                dependencies,
                signal ? { signal } : {},
            );
            if (sharedResult) return sharedResult;
            return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
        },
    };
}

function createPluginMarketplaceCapability(
    readPluginCatalog: () => Promise<readonly PluginCatalogEntry[]>,
): Capability {
    return {
        descriptor: {
            id: 'tool.plugins',
            kind: 'tool',
            title: 'Plugins',
            methods: {
                install: { title: 'Install' },
                update: { title: 'Update' },
                setUpdatePolicy: { title: 'Set update policy' },
                enable: { title: 'Enable' },
                disable: { title: 'Disable' },
                rollback: { title: 'Rollback' },
                uninstall: { title: 'Uninstall' },
                forgetTrust: { title: 'Forget trust' },
                create: { title: 'Create' },
                develop: { title: 'Develop' },
                unregisterDevelopment: { title: 'Stop development' },
                edit: { title: 'Edit' },
                test: { title: 'Test' },
                pack: { title: 'Pack' },
                changeStatus: { title: 'Plugin change status' },
            },
        },
        detect: async () => {
            const [installedPlugins, pendingChanges, developmentResult] = await Promise.all([
                readPluginCatalog(),
                listUserPluginChanges(),
                controlDaemonPluginDevelopment({ kind: 'status' }),
            ]);
            // A change an Agent (or another client) prepared has no caller left
            // to hand its issued id to. Projecting the daemon's outstanding
            // decisions here makes it discoverable on the same plugin-truth
            // read the app already refreshes, instead of requiring the id to
            // travel out of band.
            return {
                installedPlugins: installedPlugins.map(projectInstalledPluginCapabilityEntry),
                developmentActions: { create: true, develop: true, unregister: true },
                developmentStatus: developmentResult.status,
                pendingChanges: pendingChanges.changes,
            };
        },
        invoke: async ({ method, params }) => invokePluginMarketplaceAction(method, params),
    };
}

export async function createCliCapabilitiesService(dependencies: Readonly<{
    createApiClient?: CliProbeDependencies['createApiClient'];
    readPluginCatalog?: () => Promise<readonly PluginCatalogEntry[]>;
    getAgentCatalogObservation?: () => Readonly<{
        machineId: string;
        service: AgentProviderCatalogObservationService;
    }> | null;
    activatePurposeBindings?: CliProbeDependencies['activatePurposeBindings'];
    isAgentRegistryCurrent?: () => boolean;
    resolveNativeCatalogBearer?: CliProbeDependencies['resolveNativeCatalogBearer'];
    hasSessionAgentTransition?: () => boolean;
}> = {}): Promise<ReturnType<typeof createCapabilitiesService>> {
    // Explicit ephemeral merged snapshot for this service's probes only. It is
    // never written back into a shared registry authority; currentness is
    // generation-fenced against in-process plugin reloads (the daemon path
    // injects its own currentness check).
    const resolvedContributionRegistry = (
        await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir }).catch(() => undefined)
    ) ?? getResolvedContributionRegistry();
    const snapshotReloadGeneration = readPluginReloadGeneration();
    const cliProbeDependencies: CliProbeDependencies = {
        ...dependencies,
        agentRegistrySnapshot: resolvedContributionRegistry,
        isAgentRegistryCurrent: dependencies.isAgentRegistryCurrent
            ?? (() => readPluginReloadGeneration() === snapshotReloadGeneration),
    };

    // Every `cli.<agentId>` capability carries K6 update facts, not a software mutation;
    // the variation lives in each agent's manifest `cli.install` facts.
    const cliCapabilities = await Promise.all(
        resolvedContributionRegistry.agents.map(async (entry) =>
            withAgentCliUpdateFacts(await createGenericCliCapability(entry.id, cliProbeDependencies), entry.id, {
                resolveRuntimeSpec: () => {
                    if (!entry.runtimeSpec) throw new Error('Agent CLI runtime is unavailable.');
                    return entry.runtimeSpec;
                },
            })),
    );

    const hasSessionAgentTransition = dependencies.hasSessionAgentTransition;
    const daemonCapabilities: Capability[] = hasSessionAgentTransition ? [{
        descriptor: { id: 'tool.sessionAgentTransition', kind: 'tool', title: 'Agent transitions' },
        detect: async () => ({ supportsInputPermissionIntent: hasSessionAgentTransition() }),
    }] : [];
    const explicitCapabilities: Capability[] = [
        ...daemonCapabilities,
        tmuxCapability,
        windowsTerminalCapability,
        createPluginMarketplaceCapability(
            dependencies.readPluginCatalog ?? (async () => await readCurrentDaemonPluginCatalog({
                happyHomeDir: configuration.happyHomeDir,
                reloadController: pluginReloadController,
            })),
        ),
        ghDepCapability,
        azDepCapability,
        executionRunsCapability,
        systemTasksCapability,
    ];
    const existingCapabilityIds = new Set([
        ...cliCapabilities.map((capability) => capability.descriptor.id),
        ...explicitCapabilities.map((capability) => capability.descriptor.id),
    ]);
    const installablesRegistry = createInstallablesRegistryFromResolvedContributions(
        resolvedContributionRegistry.managedDependencies ?? [],
    );
    const installableCapabilities = await createInstallableCapabilities({
        installablesRegistry,
        existingCapabilityIds,
    });

    return createCapabilitiesService({
        capabilities: [
            ...cliCapabilities,
            ...installableCapabilities,
            ...explicitCapabilities,
        ],
        checklists: createCapabilityChecklists(
            installablesRegistry,
            resolvedContributionRegistry,
        ),
        buildContext: buildDetectContext,
    });
}

export function registerCapabilitiesHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    dependencies: Parameters<typeof createCliCapabilitiesService>[0] = {},
): void {
    let servicePromise: Promise<ReturnType<typeof createCapabilitiesService>> | null = null;
    let servicePluginReloadGeneration: number | null = null;

    const getService = (): Promise<ReturnType<typeof createCapabilitiesService>> => {
        const currentGeneration = readPluginReloadGeneration();
        if (servicePromise && servicePluginReloadGeneration === currentGeneration) return servicePromise;
        servicePromise = null;
        servicePluginReloadGeneration = currentGeneration;
        const pending = createCliCapabilitiesService({
            ...dependencies,
            isAgentRegistryCurrent: () => readPluginReloadGeneration() === currentGeneration,
        }).catch((error) => {
            if (servicePromise === pending) {
                servicePromise = null;
                if (servicePluginReloadGeneration === currentGeneration) {
                    servicePluginReloadGeneration = null;
                }
            }
            throw error;
        });
        servicePromise = pending;
        return pending;
    };

    // Warm capability loaders at daemon boot to avoid late dynamic-import failures
    // if the local CLI dist is rebuilt while the daemon process is already running.
    void getService().catch(() => undefined);

    rpcHandlerManager.registerHandler<{}, CapabilitiesDescribeResponse>(RPC_METHODS.CAPABILITIES_DESCRIBE, async () => {
        return (await getService()).describe();
    });

    rpcHandlerManager.registerHandler<CapabilitiesDetectRequest, CapabilitiesDetectResponse>(RPC_METHODS.CAPABILITIES_DETECT, async (data) => {
        return await (await getService()).detect(data);
    });

    rpcHandlerManager.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>(RPC_METHODS.CAPABILITIES_INVOKE, async (data, context) => {
        return await (await getService()).invoke(
            data,
            context?.signal ? { signal: context.signal } : {},
        );
    });
}
