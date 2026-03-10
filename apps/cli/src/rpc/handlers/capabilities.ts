import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';
import { checklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
import { windowsTerminalCapability } from '@/capabilities/registry/toolWindowsTerminal';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
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
import { readCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { AgentId } from '@happier-dev/agents';
import { BackendTargetRefSchema, type BackendTargetRefV1 } from '@happier-dev/protocol';
import { invokeProviderCliInstall as invokeSharedProviderCliInstall } from '@/runtime/managedTools/invokeProviderCliInstall';

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 15_000;

function titleCase(value: string): string {
    if (!value) return value;
    return `${value[0].toUpperCase()}${value.slice(1)}`;
}

async function resolveProbeBackendContext(params?: Record<string, unknown>): Promise<{
    backendTarget: BackendTargetRefV1 | undefined;
    credentials: Awaited<ReturnType<typeof readCredentials>> | null;
    accountSettings: Record<string, unknown> | null;
}> {
    const parsedBackendTarget = BackendTargetRefSchema.safeParse((params ?? {}).backendTarget);
    const backendTarget = parsedBackendTarget.success ? parsedBackendTarget.data : undefined;

    if (!backendTarget || backendTarget.kind !== 'configuredAcpBackend') {
        return { backendTarget, credentials: null, accountSettings: null };
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) return { backendTarget, credentials: null, accountSettings: null };

    const accountSettingsContext = await bootstrapAccountSettingsContext({
        credentials,
        backendTarget,
        mode: 'blocking',
        refresh: 'force',
    }).catch(() => null);

    return {
        backendTarget,
        credentials,
        accountSettings: accountSettingsContext?.settings ?? null,
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

function createGenericCliCapability(agentId: AgentCatalogEntry['id']): Capability {
    return {
        descriptor: {
            id: `cli.${agentId}`,
            kind: 'cli',
            title: `${titleCase(agentId)} CLI`,
            methods: {
                install: { title: 'Install' },
                probeModels: { title: 'Probe models' },
                probeModes: { title: 'Probe modes' },
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
                const probeContext = await resolveProbeBackendContext(params);
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
                const probeContext = await resolveProbeBackendContext(params);
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
            return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
        },
    };
}

function augmentCliCapabilityWithProbeModels(cap: Capability, agentId: AgentCatalogEntry['id']): Capability {
    if (!cap.descriptor.id.startsWith('cli.')) return cap;

    const existingMethods = cap.descriptor.methods ?? {};
    const methods = {
        ...existingMethods,
        ...(existingMethods.probeModels ? {} : { probeModels: { title: 'Probe models' } }),
        ...(existingMethods.probeModes ? {} : { probeModes: { title: 'Probe modes' } }),
        ...(existingMethods.install ? {} : { install: { title: 'Install' } }),
    };

    const baseInvoke = cap.invoke;

    const invoke: Capability['invoke'] = async ({ method, params }) => {
        if (method === 'install') {
            return invokeProviderCliInstall(agentId, params);
        }
        if (method === 'probeModels') {
            const probeContext = await resolveProbeBackendContext(params);
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
            const probeContext = await resolveProbeBackendContext(params);
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
        if (baseInvoke) return await baseInvoke({ method, params });
        return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
    };

    return {
        ...cap,
        descriptor: { ...cap.descriptor, methods },
        invoke,
    };
}

export function registerCapabilitiesHandlers(rpcHandlerManager: RpcHandlerRegistrar): void {
    let servicePromise: Promise<ReturnType<typeof createCapabilitiesService>> | null = null;

    const createService = async (): Promise<ReturnType<typeof createCapabilitiesService>> => {
        const cliCapabilities = await Promise.all(
            (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
                if (entry.getCliCapabilityOverride) {
                    const override = await entry.getCliCapabilityOverride();
                    return augmentCliCapabilityWithProbeModels(override, entry.id);
                }
                return createGenericCliCapability(entry.id);
            }),
        );

        const extraCapabilitiesNested = await Promise.all(
            (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
                if (!entry.getCapabilities) return [];
                return [...(await entry.getCapabilities())];
            }),
        );
        const extraCapabilities: Capability[] = extraCapabilitiesNested.flat();

        return createCapabilitiesService({
            capabilities: [
                ...cliCapabilities,
                ...extraCapabilities,
                tmuxCapability,
                windowsTerminalCapability,
                executionRunsCapability,
            ],
            checklists,
            buildContext: buildDetectContext,
        });
    };

    const getService = (): Promise<ReturnType<typeof createCapabilitiesService>> => {
        if (servicePromise) return servicePromise;
        const pending = createService().catch((error) => {
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
