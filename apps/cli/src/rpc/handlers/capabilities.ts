import { invokeCliPreflightMethod, resolveCliProbeInvokeParams, type CliProbeDependencies, type CliProbeRequestContext } from '@/capabilities/probes/agentPreflight';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { readStoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { InstalledPluginCapabilityEntryV1 } from '@happier-dev/protocol/capabilities';
import { createCapabilityChecklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
import { windowsTerminalCapability } from '@/capabilities/registry/toolWindowsTerminal';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { systemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { createAcpAgentInventoryCapability } from '@/capabilities/registry/machineAgentsInventory';
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
import { createPreflightCatalogCleanupScope } from '@/capabilities/probes/preflightCatalogCleanupScope';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { PluginScaffoldUiModeSchema, PluginScaffoldTemplateSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { CapabilityId } from '@happier-dev/protocol';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { resolvePreflightSessionControlsProbeAdapter } from '@/capabilities/probes/resolvePreflightSessionControlsProbeAdapter';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { invokeAgentCliInstallCapability } from '@/capabilities/cliUpdate/invokeAgentCliInstallCapability';
import { withAgentCliUpdateFacts } from '@/capabilities/cliUpdate/agentCliUpdates';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/merged';
import {
    readInstalledPluginCatalogEntry,
    type PluginCatalogEntry,
} from '@/plugins/projection/catalog/installed';
import {
    listUserPluginChanges,
    readUserPluginChangeStatus,
} from '@/plugins/daemon/changeClient';
import { controlDaemonPluginDevelopment } from '@/daemon/controlClient';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';

/** Installed inventory served to the Plugins UI; omit daemon-only catalog detail. */
function projectInstalledPluginCapabilityEntry(entry: PluginCatalogEntry): InstalledPluginCapabilityEntryV1 {
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
        ...(entry.accountEnabled === undefined ? {} : { accountEnabled: entry.accountEnabled }),
        ...(entry.machineEnabled === undefined ? {} : { machineEnabled: entry.machineEnabled }),
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

    const { timeoutMs } = resolveCliProbeInvokeParams(params);
    const deadline = new AbortController();
    const signal = requestContext.signal ? AbortSignal.any([requestContext.signal, deadline.signal]) : deadline.signal;
    requestContext = { signal, deadlineSignal: signal, deadlineAtMs: Date.now() + timeoutMs, cleanupScope: createPreflightCatalogCleanupScope() };
    const deadlineTimer = setTimeout(() => deadline.abort(new Error('Agent preflight timed out')), timeoutMs);
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
                createAgentInvocationServices: catalog.createAgentInvocationServices,
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

type PluginMarketplaceCapabilityMethod =
    | 'create'
    | 'edit'
    | 'changeStatus';

function resolveMarketplaceActionMethod(method: string): PluginMarketplaceCapabilityMethod | null {
    if (
        method === 'create'
        || method === 'edit'
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
async function invokePluginDevelopmentAction(
    action: Extract<PluginMarketplaceCapabilityMethod, 'create' | 'edit'>,
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

async function invokePluginMarketplaceAction(
    method: string,
    params: Record<string, unknown> | undefined,
): Promise<CapabilitiesInvokeResponse> {
    const action = resolveMarketplaceActionMethod(method);
    if (!action) {
        return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
    }
    if (action === 'changeStatus') return await invokePluginChangeStatusAction(params);
    return await invokePluginDevelopmentAction(action, params);
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
                create: { title: 'Create' },
                edit: { title: 'Edit' },
                changeStatus: { title: 'Plugin change status' },
            },
        },
        detect: async () => {
            const [installedPlugins, pendingChanges, developmentResult] = await Promise.all([
                readPluginCatalog(),
                listUserPluginChanges(),
                controlDaemonPluginDevelopment({ kind: 'status' }),
            ]);
            if (pendingChanges.kind === 'unavailable') {
                throw new Error(`plugin_change_list_unavailable:${pendingChanges.code}`);
            }
            // A change an Agent (or another client) prepared has no caller left
            // to hand its issued id to. Projecting the daemon's outstanding
            // decisions here makes it discoverable on the same plugin-truth
            // read the app already refreshes, instead of requiring the id to
            // travel out of band.
            return {
                installedPlugins: installedPlugins.map(projectInstalledPluginCapabilityEntry),
                developmentActions: { create: true },
                developmentStatus: developmentResult.status,
                pendingChanges: pendingChanges.changes,
            };
        },
        invoke: async ({ method, params }) => invokePluginMarketplaceAction(method, params),
    };
}

export async function createCliCapabilitiesService(dependencies: Readonly<{
    observeCliSnapshot?: (input: Readonly<{
        snapshot: NonNullable<Awaited<ReturnType<typeof buildDetectContext>>['cliSnapshot']>;
        observedAgentIds: readonly string[];
        checkedAt: number;
    }>) => Promise<void>;
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
        createAcpAgentInventoryCapability(),
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
        buildContext: async (requests) => {
            const context = await buildDetectContext(requests);
            if (context.cliSnapshot && dependencies.observeCliSnapshot) {
                const observedAgentIds = requests.filter(request => request.id.startsWith('cli.')).map(request => request.id.slice(4));
                if (observedAgentIds.length) await dependencies.observeCliSnapshot({
                    snapshot: context.cliSnapshot, observedAgentIds, checkedAt: Date.now(),
                }).catch(error => logger.warn('[CAPABILITIES] Failed to publish Machine Agent install facts', error));
            }
            return context;
        },
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

    rpcHandlerManager.registerHandler<CapabilitiesDetectRequest, CapabilitiesDetectResponse>(RPC_METHODS.CAPABILITIES_DETECT, async (data, ingress) => {
        let accountId: string | undefined;
        if (ingress?.machineAdmission) {
            if (ingress.verifyMachineAdmissionCurrent && !ingress.signal.aborted && await ingress.verifyMachineAdmissionCurrent()) {
                accountId = ingress.machineAdmission.actorAccountId;
            }
        } else {
            const credentials = await readStoredCredentials();
            accountId = credentials ? readAccountIdFromToken(credentials.token) ?? undefined : undefined;
        }
        return await (await getService()).detect(data, { accountId });
    });

    rpcHandlerManager.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>(RPC_METHODS.CAPABILITIES_INVOKE, async (data, context) => {
        return await (await getService()).invoke(
            data,
            context?.signal ? { signal: context.signal } : {},
        );
    });
}
