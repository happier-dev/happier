import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { AGENTS, type AgentCatalogEntry, type CatalogAgentId } from '@/backends/catalog';
import { checklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
import { windowsTerminalCapability } from '@/capabilities/registry/toolWindowsTerminal';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { systemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { ghDepCapability } from '@/capabilities/registry/depGh';
import { azDepCapability } from '@/capabilities/registry/depAz';
import { createInstallableCapabilitiesFromContributions } from '@/capabilities/registry/installables';
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
import { readCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { AgentId } from '@happier-dev/agents';
import { applyAgentRuntimeKindOverrideToAccountSettings } from '@happier-dev/agents';
import { BackendTargetRefSchema, type BackendTargetRefV1, type CapabilityId } from '@happier-dev/protocol';
import { invokeProviderCliInstall as invokeSharedProviderCliInstall } from '@/packagedRuntime/managedTools/invokeProviderCliInstall';
import {
    getResolvedContributionRegistry,
    primeResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { installMarketplacePlugin as installMarketplacePluginFromCatalog } from '@/plugins/store/marketplace/catalog';
import { readInstalledPluginCatalog, readInstalledPluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { setInstalledPluginEnabled } from '@/plugins/store/enabled';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PluginReloadResult } from '@/plugins/runtime/reload/controller';

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

async function resolveProbeBackendContext(params?: Record<string, unknown>): Promise<{
    backendTarget: BackendTargetRefV1 | undefined;
    credentials: Awaited<ReturnType<typeof readCredentials>> | null;
    accountSettings: Record<string, unknown> | null;
}> {
    const parsedBackendTarget = BackendTargetRefSchema.safeParse((params ?? {}).backendTarget);
    const backendTarget = parsedBackendTarget.success ? parsedBackendTarget.data : undefined;
    const runtimeKindOverride = (params ?? {}).runtimeKindOverride;

    const agentId = typeof params?.agentId === 'string' ? params.agentId : null;
    const needsAccountSettingsForProbes =
        agentId && (AGENTS[agentId as keyof typeof AGENTS] as AgentCatalogEntry | undefined)?.needsAccountSettingsForProbes === true;
    const shouldLoadAccountSettings = backendTarget?.kind === 'configuredAcpBackend' || needsAccountSettingsForProbes;
    if (!shouldLoadAccountSettings) {
      return { backendTarget, credentials: null, accountSettings: null };
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) return { backendTarget, credentials: null, accountSettings: null };

    const accountSettingsContext = await bootstrapAccountSettingsContext({
        credentials,
        ...(params?.agentId ? { agentId: params.agentId as AgentId } : {}),
        backendTarget,
        mode: 'blocking',
        refresh: 'auto',
    }).catch(() => null);

    const accountSettings = accountSettingsContext?.settings ?? null;
    const effectiveAccountSettings = params?.agentId
        ? applyAgentRuntimeKindOverrideToAccountSettings({
            agentId: params.agentId as AgentId,
            accountSettings,
            runtimeKindOverride,
        })
        : accountSettings;

    return {
      backendTarget,
      credentials,
      accountSettings: effectiveAccountSettings,
    };
}

async function invokeProviderCliInstall(
    agentId: AgentCatalogEntry['id'],
    params?: Record<string, unknown>,
): Promise<CapabilitiesInvokeResponse> {
    const dryRun = params?.dryRun === true;
    const allowVendorRecipeExecution = params?.allowVendorRecipeExecution === true;
    const sharedParams = {
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

function mapPluginDiagnosticsToInvokeError(diagnostics: readonly { code: string; message: string }[]): Readonly<{ message: string; code?: string }> {
    const firstDiagnostic = diagnostics[0];
    if (!firstDiagnostic) {
        return {
            message: 'Plugin operation failed',
            code: 'plugin_operation_failed',
        };
    }
    return {
        message: diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
        code: firstDiagnostic.code,
    };
}

function resolveMarketplaceActionMethod(method: string): 'install' | 'update' | 'enable' | 'disable' | 'reload' | null {
    if (method === 'install' || method === 'update' || method === 'enable' || method === 'disable' || method === 'reload') {
        return method;
    }
    return null;
}

async function reloadPluginIfNeeded(pluginId: string, shouldReload: boolean): Promise<PluginReloadResult | null> {
    if (!shouldReload) {
        return null;
    }
    return await pluginReloadController.reload({ pluginId });
}

async function invokePluginMarketplaceAction(method: string, params?: Record<string, unknown>): Promise<CapabilitiesInvokeResponse> {
    const action = resolveMarketplaceActionMethod(method);
    if (!action) {
        return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
    }

    if (action === 'reload') {
        const pluginId = typeof params?.pluginId === 'string' ? params.pluginId.trim() : '';
        const reload = await pluginReloadController.reload(pluginId ? { pluginId } : undefined);
        const entry = pluginId
            ? await readInstalledPluginCatalogEntry({
                pluginId,
                happyHomeDir: configuration.happyHomeDir,
            })
            : null;
        return {
            ok: true,
            result: {
                action,
                pluginId: pluginId || null,
                entry,
                reload,
            },
        };
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

        const entry = await readInstalledPluginCatalogEntry({
            pluginId,
            happyHomeDir: configuration.happyHomeDir,
        });
        const reload = await reloadPluginIfNeeded(pluginId, toggled.changed);
        return {
            ok: true,
            result: {
                action,
                pluginId,
                entry,
                reload,
            },
        };
    }

    const sourceUrl = typeof params?.sourceUrl === 'string' ? params.sourceUrl.trim() : '';
    const pluginId = typeof params?.pluginId === 'string' ? params.pluginId.trim() : '';
    if (!sourceUrl || !pluginId) {
        return { ok: false, error: { message: 'sourceUrl and pluginId are required', code: 'plugin_source_missing' } };
    }

    const existingEntry = await readInstalledPluginCatalogEntry({
        pluginId,
        happyHomeDir: configuration.happyHomeDir,
    });
    const existingEnabled = existingEntry?.enabled ?? true;
    const isDryRun = params?.dryRun === true;
    const installResult = await installMarketplacePluginFromCatalog({
        sourceUrl,
        pluginId,
        happyHomeDir: configuration.happyHomeDir,
        skipIfInstalled: action === 'install',
        dryRun: isDryRun,
    });

    if (!installResult.ok) {
        return { ok: false, error: mapPluginDiagnosticsToInvokeError(installResult.diagnostics) };
    }

    if (action === 'update' && existingEntry && existingEnabled === false && !isDryRun) {
        const disableResult = await setInstalledPluginEnabled({
            happyHomeDir: configuration.happyHomeDir,
            pluginId,
            enabled: false,
        });
        if (!disableResult.ok) {
            return { ok: false, error: { message: disableResult.errorMessage, code: disableResult.errorCode } };
        }
    }

    const entry = await readInstalledPluginCatalogEntry({
        pluginId,
        happyHomeDir: configuration.happyHomeDir,
    });
    const reload = await reloadPluginIfNeeded(
        pluginId,
        !isDryRun && (action === 'update' || !installResult.alreadyInstalled),
    );
    return {
        ok: true,
        result: {
            action,
            alreadyInstalled: installResult.alreadyInstalled,
            pluginId,
            entry,
            reload,
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
            if (method === 'install') {
                return invokeProviderCliInstall(agentId, params);
            }
            if (method === 'probeModels') {
                const probeContext = await resolveProbeBackendContext({ ...params, agentId });
                const timeoutMsRaw = (params ?? {}).timeoutMs;
                const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
                const cwdRaw = (params ?? {}).cwd;
                const cwd = typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? cwdRaw.trim() : process.cwd();
                const result = await probeAgentModelsBestEffort({
                    agentId,
                    backendTarget: probeContext.backendTarget,
                    cwd,
                    timeoutMs,
                    accountSettings: probeContext.accountSettings,
                    credentials: probeContext.credentials,
                });
                return { ok: true, result };
            }
            if (method === 'probeModes') {
                const probeContext = await resolveProbeBackendContext({ ...params, agentId });
                const timeoutMsRaw = (params ?? {}).timeoutMs;
                const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
                const cwdRaw = (params ?? {}).cwd;
                const cwd = typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? cwdRaw.trim() : process.cwd();
                const result = await probeAgentModesBestEffort({
                    agentId,
                    backendTarget: probeContext.backendTarget,
                    cwd,
                    timeoutMs,
                    accountSettings: probeContext.accountSettings,
                    credentials: probeContext.credentials,
                });
                return { ok: true, result };
            }
            if (method === 'probeConfigOptions') {
                const probeContext = await resolveProbeBackendContext({ ...params, agentId });
                const timeoutMsRaw = (params ?? {}).timeoutMs;
                const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
                const cwdRaw = (params ?? {}).cwd;
                const cwd = typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? cwdRaw.trim() : process.cwd();
                const result = await probeAgentConfigOptionsBestEffort({
                    agentId,
                    backendTarget: probeContext.backendTarget,
                    cwd,
                    timeoutMs,
                    accountSettings: probeContext.accountSettings,
                    credentials: probeContext.credentials,
                });
                return { ok: true, result };
            }
            return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
        },
    };
}

function createPluginMarketplaceCapability(): Capability {
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
                reload: { title: 'Reload' },
            },
        },
        detect: async () => {
            const installedPlugins = await readInstalledPluginCatalog({ happyHomeDir: configuration.happyHomeDir });
            return { installedPlugins };
        },
        invoke: async ({ method, params }) => invokePluginMarketplaceAction(method, params),
    };
}

function augmentCliCapabilityWithProbeModels(cap: Capability, agentId: AgentCatalogEntry['id']): Capability {
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
        if (method === 'install') {
            return invokeProviderCliInstall(agentId, params);
        }
        if (method === 'probeModels') {
            const probeContext = await resolveProbeBackendContext({ ...params, agentId });
            const timeoutMsRaw = (params ?? {}).timeoutMs;
            const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
            const cwdRaw = (params ?? {}).cwd;
            const cwd = typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? cwdRaw.trim() : process.cwd();
            const result = await probeAgentModelsBestEffort({
                agentId,
                backendTarget: probeContext.backendTarget,
                cwd,
                timeoutMs,
                accountSettings: probeContext.accountSettings,
                credentials: probeContext.credentials,
            });
            return { ok: true, result };
        }
        if (method === 'probeModes') {
            const probeContext = await resolveProbeBackendContext({ ...params, agentId });
            const timeoutMsRaw = (params ?? {}).timeoutMs;
            const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
            const cwdRaw = (params ?? {}).cwd;
            const cwd = typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? cwdRaw.trim() : process.cwd();
            const result = await probeAgentModesBestEffort({
                agentId,
                backendTarget: probeContext.backendTarget,
                cwd,
                timeoutMs,
                accountSettings: probeContext.accountSettings,
                credentials: probeContext.credentials,
            });
            return { ok: true, result };
        }
        if (method === 'probeConfigOptions') {
            const probeContext = await resolveProbeBackendContext({ ...params, agentId });
            const timeoutMsRaw = (params ?? {}).timeoutMs;
            const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
            const cwdRaw = (params ?? {}).cwd;
            const cwd = typeof cwdRaw === 'string' && cwdRaw.trim().length > 0 ? cwdRaw.trim() : process.cwd();
            const result = await probeAgentConfigOptionsBestEffort({
                agentId,
                backendTarget: probeContext.backendTarget,
                cwd,
                timeoutMs,
                accountSettings: probeContext.accountSettings,
                credentials: probeContext.credentials,
            });
            return { ok: true, result };
        }
        if (baseInvoke) return await baseInvoke({ method, params });
        return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
    };

    return {
        ...cap,
        descriptor: { ...cap.descriptor, methods },
        invoke,
    };
}

export async function createCliCapabilitiesService(): Promise<ReturnType<typeof createCapabilitiesService>> {
    const resolvedContributionRegistry = await primeResolvedContributionRegistry({ happyHomeDir: configuration.happyHomeDir })
        .catch(() => getResolvedContributionRegistry());

    const cliCapabilities = await Promise.all(
        (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
            if (entry.getCliCapabilityOverride) {
                const override = await entry.getCliCapabilityOverride();
                return augmentCliCapabilityWithProbeModels(override, entry.id);
            }
            const acpRuntimeDefinitionBridge = entry.getAcpRuntimeDefinitionBridge
                ? await entry.getAcpRuntimeDefinitionBridge()
                : null;
            if (acpRuntimeDefinitionBridge) {
                return createAcpCliCapability({
                    agentId: entry.id as CatalogAgentId,
                    title: resolvePublicCliCapabilityTitle(entry.id),
                    runtimeDefinitionBridge: acpRuntimeDefinitionBridge,
                });
            }
            return createGenericCliCapability(entry.id);
        }),
    );

    const explicitCapabilities: Capability[] = [
        tmuxCapability,
        windowsTerminalCapability,
        createPluginMarketplaceCapability(),
        ghDepCapability,
        azDepCapability,
        executionRunsCapability,
        systemTasksCapability,
    ];
    const existingCapabilityIds = new Set([
        ...cliCapabilities.map((capability) => capability.descriptor.id),
        ...explicitCapabilities.map((capability) => capability.descriptor.id),
    ]);
    const installableCapabilities = await createInstallableCapabilitiesFromContributions({
        installables: resolvedContributionRegistry.installables,
        existingCapabilityIds,
    });

    return createCapabilitiesService({
        capabilities: [
            ...cliCapabilities,
            ...installableCapabilities,
            ...explicitCapabilities,
        ],
        checklists,
        buildContext: buildDetectContext,
    });
}

export function registerCapabilitiesHandlers(rpcHandlerManager: RpcHandlerRegistrar): void {
    let servicePromise: Promise<ReturnType<typeof createCapabilitiesService>> | null = null;

    const getService = (): Promise<ReturnType<typeof createCapabilitiesService>> => {
        if (servicePromise) return servicePromise;
        const pending = createCliCapabilitiesService().catch((error) => {
            if (servicePromise === pending) {
                servicePromise = null;
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
