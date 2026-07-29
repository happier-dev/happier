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
import type { AgentId } from '@happier-dev/agents';
import { type CapabilityId } from '@happier-dev/protocol';
import { resolveProbeBackendContext } from './capabilitiesProbeContext';
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
import { requestUserPluginChange } from '@/plugins/daemon/changeClient';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import { setInstalledPluginEnabled } from '@/plugins/store/enabled';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { runPluginAuthorToolchain } from '@/plugins/authoring/toolchain';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 30_000;

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
): Promise<CapabilitiesInvokeResponse | null> {
    if (method === 'install') {
        return invokeAgentCliInstall(agentId, params);
    }

    if (method !== 'probeModels' && method !== 'probeModes' && method !== 'probeConfigOptions') {
        return null;
    }

    const probeContext = await resolveProbeBackendContext({ ...params, agentId });
    const { cwd, timeoutMs } = resolveCliProbeInvokeParams(params);
    const connectedServices = params && Object.prototype.hasOwnProperty.call(params, 'connectedServices')
        ? params.connectedServices
        : undefined;
    const commonProbeArgs = {
        agentId,
        backendTarget: probeContext.backendTarget,
        cwd,
        timeoutMs,
        accountSettings: probeContext.accountSettings,
        credentials: probeContext.credentials,
        ...(connectedServices !== undefined ? { connectedServices } : {}),
    };

    if (method === 'probeModels') {
        return { ok: true, result: await probeAgentModelsBestEffort(commonProbeArgs) };
    }
    if (method === 'probeModes') {
        return { ok: true, result: await probeAgentModesBestEffort(commonProbeArgs) };
    }
    return { ok: true, result: await probeAgentConfigOptionsBestEffort(commonProbeArgs) };
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
    | 'test'
    | 'pack';

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
        || method === 'test'
        || method === 'pack'
    ) {
        return method;
    }
    return null;
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
        const result = await scaffoldLocalPlugin({ targetDir, pluginId, displayName });
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
                manifestPath: result.manifestPath,
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

    if (action === 'install' || action === 'update') {
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
        if (exactInstall.change.kind === 'reviewRequired' || (
            action === 'update' && exactInstall.change.kind === 'committed'
        )) {
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
                    message: `The daemon did not commit the exact marketplace ${action} (${exactInstall.change.kind}).`,
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

    const change = await requestUserPluginChange({
        request: action === 'uninstall'
            ? { kind: 'uninstall', pluginId }
            : { kind: action, pluginId },
        approval: 'none',
    });
    if (change.kind !== 'committed') {
        return {
            ok: false,
            error: {
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

function createGenericCliCapability(agentId: AgentCatalogEntry['id']): Capability {
    const publicAgentId = resolvePublicCliCapabilityAgentId(agentId);
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
            },
        },
        detect: async ({ request, context }) => {
            const entry = context.cliSnapshot?.clis?.[agentId];
            return buildCliCapabilityData({ request, entry });
        },
        invoke: async ({ method, params }) => {
            const sharedResult = await invokeCliProbeOrInstallMethod(agentId, method, params);
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
                test: { title: 'Test' },
                pack: { title: 'Pack' },
            },
        },
        detect: async () => {
            const installedPlugins = await readPluginCatalog();
            return {
                installedPlugins,
                developmentActions: { create: true },
                developmentSources: projectPluginDevelopmentSources(installedPlugins),
            };
        },
        invoke: async ({ method, params }) => invokePluginMarketplaceAction(method, params),
    };
}

function augmentCliCapabilityWithProviderCliMethods(cap: Capability, agentId: AgentCatalogEntry['id']): Capability {
    if (!cap.descriptor.id.startsWith('cli.')) return cap;

    const existingMethods = cap.descriptor.methods ?? {};
    const methods = {
        ...existingMethods,
        ...(existingMethods.probeModels ? {} : { probeModels: { title: 'Probe models' } }),
        ...(existingMethods.probeModes ? {} : { probeModes: { title: 'Probe modes' } }),
        ...(existingMethods.probeConfigOptions ? {} : { probeConfigOptions: { title: 'Probe config options' } }),
        ...(existingMethods.install ? {} : { install: { title: 'Install' } }),
    };

    const baseInvoke = cap.invoke;

    const invoke: Capability['invoke'] = async ({ method, params }) => {
        const sharedResult = await invokeCliProbeOrInstallMethod(agentId, method, params);
        if (sharedResult) return sharedResult;
        if (baseInvoke) return await baseInvoke({ method, params });
        return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
    };

    return {
        ...cap,
        descriptor: { ...cap.descriptor, methods },
        invoke,
    };
}

export async function createCliCapabilitiesService(dependencies: Readonly<{
    readPluginCatalog?: () => Promise<readonly PluginCatalogEntry[]>;
}> = {}): Promise<ReturnType<typeof createCapabilitiesService>> {
    const resolvedContributionRegistry = (
        await primeResolvedContributionRegistry({ happyHomeDir: configuration.happyHomeDir }).catch(() => undefined)
    ) ?? getResolvedContributionRegistry();

    const cliCapabilities = await Promise.all(
        (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
            if (entry.getCliCapabilityOverride) {
                const override = await entry.getCliCapabilityOverride();
                return augmentCliCapabilityWithProviderCliMethods(override, entry.id);
            }
            return createGenericCliCapability(entry.id);
        }),
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

export function registerCapabilitiesHandlers(rpcHandlerManager: RpcHandlerRegistrar): void {
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
        const pending = createCliCapabilitiesService().catch((error) => {
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

    rpcHandlerManager.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>(RPC_METHODS.CAPABILITIES_INVOKE, async (data) => {
        return await (await getService()).invoke(data);
    });
}
