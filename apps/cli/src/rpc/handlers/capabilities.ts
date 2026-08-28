import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { AGENTS } from '@/agent/catalog/registry';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
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
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { probeAgentModesBestEffort } from '@/capabilities/probes/agentModesProbe';
import { probeAgentConfigOptionsBestEffort } from '@/capabilities/probes/agentConfigOptionsProbe';
import { configuration } from '@/configuration';
import { getAgentModelConfig, type AgentId } from '@happier-dev/agents';
import {
    CodexPassiveRealtimeSetupResultV1Schema,
    ConnectedServiceBindingsV1Schema,
    PluginScaffoldUiModeSchema,
    qualifiedPurposeKey,
    type CapabilityId,
} from '@happier-dev/protocol';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { ProviderProbeCancelledError } from '@/providers/probe/client';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProbeBackendContext } from './capabilitiesProbeContext';
import { resolvePreflightSessionControlsProbeAdapter } from '@/capabilities/probes/resolvePreflightSessionControlsProbeAdapter';
import { withPreflightSessionControlsProbeEnvironment } from '@/capabilities/probes/preflightSessionControlsProbeEnvironment';
import { resolveCatalogAgentConnectedServiceIds } from '@/agent/catalog/registry';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { invokeAgentCliInstall as invokeSharedProviderCliInstall } from '@/packagedRuntime/managedTools/invokeAgentCliInstall';
import {
    getResolvedContributionRegistry,
    primeResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
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
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import { setInstalledPluginEnabled } from '@/plugins/store/enabled';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { runPluginAuthorToolchain } from '@/plugins/authoring/toolchain';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 30_000;

type ConnectedServiceProbeCredentials = NonNullable<
    Awaited<ReturnType<typeof resolveProbeBackendContext>>['credentials']
>;
type ConnectedServiceProbeApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];

type CliProbeDependencies = Readonly<{
    createApiClient?: (credentials: ConnectedServiceProbeCredentials) => Promise<ConnectedServiceProbeApi>;
    getAgentCatalogObservation?: () => Readonly<{
        machineId: string;
        service: AgentProviderCatalogObservationService;
    }> | null;
    agentRegistrySnapshot?: ReturnType<typeof getResolvedContributionRegistry>;
    isAgentRegistryCurrent?: () => boolean;
}>;

type ConnectedServiceProbeEnvironment = Readonly<{
    materializedEnv: Readonly<Record<string, string>> | null;
    connectedServiceSelectionCacheKey: string | null;
    cleanup: (() => Promise<void>) | null;
}>;

async function resolveConnectedServiceProbeEnvironment(params: Readonly<{
    agentId: string;
    cwd: string;
    connectedServices: ReturnType<typeof ConnectedServiceBindingsV1Schema.parse> | null;
    credentials: Awaited<ReturnType<typeof resolveProbeBackendContext>>['credentials'];
    accountSettings: Record<string, unknown> | null;
    requiresMaterializedAuth: boolean;
    dependencies: CliProbeDependencies;
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
    const registry = params.dependencies.agentRegistrySnapshot ?? getResolvedContributionRegistry();
    const resolved = await resolveConnectedServiceAuthForSpawn({
        agentId: params.agentId,
        sessionDirectory: params.cwd,
        connectedServicesBindingsRaw: params.connectedServices,
        materializationKey: materializationIdentity.id,
        activeServerDir: configuration.activeServerDir,
        baseDir: materializationBaseDir,
        credentials: params.credentials,
        api: await params.dependencies.createApiClient(params.credentials),
        accountSettings: params.accountSettings,
        processEnv: process.env,
        resolveQualifiedPurposeBindingSnapshot: (bindings) =>
            resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: params.agentId,
                bindings,
                contributions: registry,
            }),
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
            resolved.cleanupOnExit?.();
            resolved.cleanupOnFailure?.();
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
    requestContext: Readonly<{ signal?: AbortSignal }> = {},
): Promise<CapabilitiesInvokeResponse | null> {
    if (method === 'install') {
        return invokeAgentCliInstall(agentId, params);
    }

    if (
        method !== 'probeModels'
        && method !== 'probeModes'
        && method !== 'probeConfigOptions'
        && method !== 'probePassiveRealtimeSetup'
    ) {
        return null;
    }

    const { cwd, timeoutMs } = resolveCliProbeInvokeParams(params);
    const parsedConnectedServices = ConnectedServiceBindingsV1Schema.safeParse(params?.connectedServices);
    const connectedServices = parsedConnectedServices.success ? parsedConnectedServices.data : null;
    const materializationAgentId =
        resolveCatalogAgentConnectedServiceIds(agentId).length > 0
            ? agentId
            : null;
    const preflightAdapter = await resolvePreflightSessionControlsProbeAdapter(agentId).catch(() => null);
    if (
        method === 'probePassiveRealtimeSetup'
        && (
            !materializationAgentId
            || !connectedServices
        )
    ) {
        return { ok: true, result: { v: 1, status: 'unavailable' } };
    }
    const requiresMaterializedAuth = Boolean(
        materializationAgentId
        && connectedServices,
    );
    const probeContext = await resolveProbeBackendContext(
        { ...params, agentId },
        { requireCredentials: requiresMaterializedAuth },
    );
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
                dependencies,
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
    const commonProbeArgs = {
        agentId,
        backendTarget: probeContext.backendTarget,
        cwd,
        timeoutMs,
        accountSettings: probeContext.accountSettings,
        credentials: probeContext.credentials,
        materializedEnv: connectedServiceProbeEnvironment.materializedEnv ?? undefined,
        connectedServiceSelectionCacheKey:
            connectedServiceProbeEnvironment.connectedServiceSelectionCacheKey,
    };

    try {
      if (method === 'probePassiveRealtimeSetup') {
        const result = await withPreflightSessionControlsProbeEnvironment({
          agentId,
          processEnv: process.env,
          materializedEnv: connectedServiceProbeEnvironment.materializedEnv ?? undefined,
        }, async ({ env }) => {
          if (!preflightAdapter?.probePassiveRealtimeSetupRaw) return { v: 1, status: 'unavailable' } as const;
          const raw = await preflightAdapter.probePassiveRealtimeSetupRaw({
            backendTarget: probeContext.backendTarget,
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
        const modelConfig = getAgentModelConfig(agentId);
        const observation = modelConfig?.nativeCatalogObservation;
        const bindings = ConnectedServiceBindingsV1Schema.safeParse(params?.connectedServices);
        const observationRuntime = dependencies.getAgentCatalogObservation?.() ?? null;
        if (observation && observationRuntime && bindings.success) {
            const registry = dependencies.agentRegistrySnapshot ?? getResolvedContributionRegistry();
            const isCurrent = (): boolean => requestContext.signal?.aborted !== true
                && (dependencies.isAgentRegistryCurrent?.()
                    ?? getResolvedContributionRegistry() === registry);
            const agent = registry.agentDefinitionsById.get(agentId);
            const consumer = agent?.identity;
            const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId,
                bindings: bindings.data,
                contributions: registry,
            });
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
                        supportsFreeform: modelConfig.supportsSelection === true && modelConfig.supportsFreeform === true,
                        source: result.source,
                    },
                };
            }
        }
          return { ok: true, result: await probeAgentModelsBestEffort(commonProbeArgs) };
      }
      if (method === 'probeModes') {
          return { ok: true, result: await probeAgentModesBestEffort(commonProbeArgs) };
      }
      return { ok: true, result: await probeAgentConfigOptionsBestEffort(commonProbeArgs) };
    } finally {
      await connectedServiceProbeEnvironment.cleanup?.();
    }
}

async function invokeAgentCliInstall(
    agentId: AgentCatalogEntry['id'],
    params?: Record<string, unknown>,
): Promise<CapabilitiesInvokeResponse> {
    const dryRun = params?.dryRun === true;
    const allowVendorRecipeExecution = params?.allowVendorRecipeExecution === true;
    const sharedParams = {
        ...(params?.intent === 'update' ? { intent: 'update' as const } : {}),
        ...(typeof params?.skipIfInstalled === 'boolean' ? { skipIfInstalled: params.skipIfInstalled } : {}),
        ...(typeof params?.platform === 'string' && params.platform.trim().length > 0 ? { platform: params.platform.trim() } : {}),
        ...(allowVendorRecipeExecution ? { allowVendorRecipeExecution: true } : {}),
    };

    if (!dryRun) {
        const preview = await invokeSharedProviderCliInstall({
            agentId: agentId as AgentId,
            params: { ...sharedParams, dryRun: true },
            env: process.env,
            nodePlatform: process.platform,
        });

        if (!preview.ok) {
            return {
                ok: false,
                error: { message: preview.errorMessage, code: preview.errorCode },
                ...(preview.logPath ? { logPath: preview.logPath } : {}),
            };
        }

        if (preview.plan.installMode === 'vendor_recipe' && !allowVendorRecipeExecution) {
            return {
                ok: false,
                error: {
                    message: `Installing ${preview.plan.title} requires explicit confirmation before running vendor install commands.`,
                    code: 'install-confirmation-required',
                },
            };
        }
    }

    const result = await invokeSharedProviderCliInstall({
        agentId: agentId as AgentId,
        params: {
            ...sharedParams,
            ...(dryRun ? { dryRun: true } : {}),
        },
        env: process.env,
        nodePlatform: process.platform,
    });

    if (!result.ok) {
        return {
            ok: false,
            error: { message: result.errorMessage, code: result.errorCode },
            ...(result.logPath ? { logPath: result.logPath } : {}),
        };
    }

    return { ok: true, result: { plan: result.plan, alreadyInstalled: result.alreadyInstalled, logPath: result.logPath ?? null } };
}

type PluginMarketplaceCapabilityMethod =
    | 'install'
    | 'update'
    | 'enable'
    | 'disable'
    | 'rollback'
    | 'uninstall'
    | 'forgetTrust'
    | 'create'
    | 'develop'
    | 'test'
    | 'pack'
    | 'changeStatus';

function resolveMarketplaceActionMethod(method: string): PluginMarketplaceCapabilityMethod | null {
    if (
        method === 'install'
        || method === 'update'
        || method === 'enable'
        || method === 'disable'
        || method === 'rollback'
        || method === 'uninstall'
        || method === 'forgetTrust'
        || method === 'create'
        || method === 'develop'
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

/**
 * Starts a local development source through the canonical daemon change owner
 * and hands the pending review back to the caller.
 *
 * `approval: 'none'` is deliberate and load-bearing. A local development source
 * is executable code the daemon will evaluate, and the terminal prompt owner
 * (`changeClient`) is not present for a remote client. Approving here would be
 * exactly the trust bypass §2 forbids, so the daemon's `sourceRootReviewRequired`
 * and `reviewRequired` results travel back verbatim and a present user decides
 * them through `daemon.plugins.install.review.decide`.
 */
async function invokePluginDevelopAction(
    params: Record<string, unknown> | undefined,
): Promise<CapabilitiesInvokeResponse> {
    const sourceRootPath = typeof params?.sourceRootPath === 'string' ? params.sourceRootPath.trim() : '';
    if (!sourceRootPath) {
        return { ok: false, error: { message: 'sourceRootPath is required', code: 'plugin_source_missing' } };
    }
    const requestedPluginId = typeof params?.pluginId === 'string' ? params.pluginId.trim() : '';
    const sdkRegistryOrigin = typeof params?.sdkRegistryOrigin === 'string'
        ? params.sdkRegistryOrigin.trim()
        : '';
    const change = await requestUserPluginChange({
        request: {
            kind: 'development',
            sourceRootPath,
            ...(requestedPluginId ? { pluginId: requestedPluginId } : {}),
            ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
        },
        approval: 'none',
    });
    if (
        change.kind === 'sourceRootReviewRequired'
        || change.kind === 'reviewRequired'
        || change.kind === 'committed'
    ) {
        return { ok: true, result: { action: 'develop', sourceRootPath, change } };
    }
    return {
        ok: false,
        error: {
            message: `The daemon did not start the development source (${change.kind}).`,
            code: change.kind,
        },
    };
}

function projectPluginDevelopmentSources(
    installedPlugins: readonly PluginCatalogEntry[],
): readonly Readonly<{
    pluginId: string;
    sourceRootPath: string;
    watch: Readonly<{ state: 'configured' }>;
    reload: Readonly<{
        state: 'clear' | 'attention';
        diagnostics: typeof installedPlugins[number]['diagnostics'];
    }>;
    actions: Readonly<{ test: true; pack: true }>;
}>[] {
    return installedPlugins
        .filter((entry) => entry.source.kind === 'path' && entry.source.devWatch === true)
        .map((entry) => {
            const diagnostics = [...entry.diagnostics, ...entry.compatibility.diagnostics];
            return Object.freeze({
                pluginId: entry.pluginId,
                sourceRootPath: entry.source.locator,
                watch: Object.freeze({ state: 'configured' as const }),
                reload: Object.freeze({
                    state: diagnostics.length === 0 ? 'clear' as const : 'attention' as const,
                    diagnostics,
                }),
                actions: Object.freeze({ test: true as const, pack: true as const }),
            });
        });
}

async function invokePluginDevelopmentAction(
    action: Extract<PluginMarketplaceCapabilityMethod, 'create' | 'test' | 'pack'>,
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
        const result = await scaffoldLocalPlugin({
            targetDir,
            pluginId,
            displayName,
            ...(ui ? { ui: ui.data } : {}),
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

    if (action === 'changeStatus') {
        return await invokePluginChangeStatusAction(params);
    }

    if (action === 'create' || action === 'test' || action === 'pack') {
        return await invokePluginDevelopmentAction(action, params);
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
        });
        if (!toggled.ok) {
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

    // Installing an exact catalog listing is its own explicit action: the caller
    // names a marketplace source and gets exactly that published version.
    // Updating is not that action — see the canonical `update` dispatch below.
    if (action === 'install') {
        const sourceId = typeof params?.sourceId === 'string' ? params.sourceId.trim() : '';
        if (!sourceId) {
            return { ok: false, error: { message: 'sourceId is required', code: 'plugin_source_missing' } };
        }
        const exactInstall = await requestExactMarketplaceInstall({
            happyHomeDir: configuration.happyHomeDir,
            sourceId,
            pluginId,
        });
        if (!exactInstall.ok) {
            return { ok: false, error: { message: exactInstall.message, code: exactInstall.code } };
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
            ? { kind: 'uninstall', pluginId }
            : { kind: action, pluginId },
        approval: 'none',
    });
    // An update the installed policy still owes a present user travels back
    // verbatim, exactly like an install review: only a present user can decide it.
    if (action === 'update' && change.kind === 'reviewRequired') {
        return { ok: true, result: { action, pluginId, change } };
    }
    if (change.kind !== 'committed') {
        return {
            ok: false,
            // A refusal the change owner explained — a pinned installation, an
            // unavailable trusted channel — reaches the caller with that owner's
            // own code and words, the same ones `happier install plugin update`
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
                enable: { title: 'Enable' },
                disable: { title: 'Disable' },
                rollback: { title: 'Rollback' },
                uninstall: { title: 'Uninstall' },
                forgetTrust: { title: 'Forget trust' },
                create: { title: 'Create' },
                develop: { title: 'Develop' },
                test: { title: 'Test' },
                pack: { title: 'Pack' },
                changeStatus: { title: 'Plugin change status' },
            },
        },
        detect: async () => {
            const installedPlugins = await readPluginCatalog();
            // A change an Agent (or another client) prepared has no caller left
            // to hand its issued id to. Projecting the daemon's outstanding
            // decisions here makes it discoverable on the same plugin-truth
            // read the app already refreshes, instead of requiring the id to
            // travel out of band.
            const pendingChanges = await listUserPluginChanges();
            return {
                installedPlugins,
                developmentActions: { create: true, develop: true },
                developmentSources: projectPluginDevelopmentSources(installedPlugins),
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
    isAgentRegistryCurrent?: () => boolean;
}> = {}): Promise<ReturnType<typeof createCapabilitiesService>> {
    const resolvedContributionRegistry = (
        await primeResolvedContributionRegistry({ happyHomeDir: configuration.happyHomeDir }).catch(() => undefined)
    ) ?? getResolvedContributionRegistry();
    const cliProbeDependencies: CliProbeDependencies = {
        ...dependencies,
        agentRegistrySnapshot: resolvedContributionRegistry,
        isAgentRegistryCurrent: dependencies.isAgentRegistryCurrent
            ?? (() => getResolvedContributionRegistry() === resolvedContributionRegistry),
    };

    const cliCapabilities = await Promise.all(
        (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) =>
            await createGenericCliCapability(entry.id, cliProbeDependencies)),
    );

    const explicitCapabilities: Capability[] = [
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
        checklists: createCapabilityChecklists(installablesRegistry),
        buildContext: buildDetectContext,
    });
}

export function registerCapabilitiesHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    dependencies: Parameters<typeof createCliCapabilitiesService>[0] = {},
): void {
    let servicePromise: Promise<ReturnType<typeof createCapabilitiesService>> | null = null;
    let servicePluginReloadGeneration: number | null = null;

    const readPluginReloadGeneration = (): number => {
        try {
            return pluginReloadController.getState().generation;
        } catch {
            return 0;
        }
    };

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
