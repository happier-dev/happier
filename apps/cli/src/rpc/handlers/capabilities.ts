import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';
import { checklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
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

function titleCase(value: string): string {
    if (!value) return value;
    return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function createGenericCliCapability(agentId: AgentCatalogEntry['id']): Capability {
    return {
        descriptor: {
            id: `cli.${agentId}`,
            kind: 'cli',
            title: `${titleCase(agentId)} CLI`,
            methods: {
                probeModels: { title: 'Probe models' },
            },
        },
        detect: async ({ request, context }) => {
            const entry = context.cliSnapshot?.clis?.[agentId];
            return buildCliCapabilityData({ request, entry });
        },
        invoke: async ({ method, params }) => {
            if (method !== 'probeModels') {
                return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
            }
            const timeoutMsRaw = (params ?? {}).timeoutMs;
            const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : 3500;
            const result = await probeAgentModelsBestEffort({ agentId, cwd: process.cwd(), timeoutMs });
            return { ok: true, result };
        },
    };
}

function augmentCliCapabilityWithProbeModels(cap: Capability, agentId: AgentCatalogEntry['id']): Capability {
    if (!cap.descriptor.id.startsWith('cli.')) return cap;

    const existingMethods = cap.descriptor.methods ?? {};
    const methods = existingMethods.probeModels
        ? existingMethods
        : { ...existingMethods, probeModels: { title: 'Probe models' } };

    const baseInvoke = cap.invoke;

    const invoke: Capability['invoke'] = async ({ method, params }) => {
        if (method === 'probeModels') {
            const timeoutMsRaw = (params ?? {}).timeoutMs;
            const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : 3500;
            const result = await probeAgentModelsBestEffort({ agentId, cwd: process.cwd(), timeoutMs });
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

export function registerCapabilitiesHandlers(rpcHandlerManager: RpcHandlerManager): void {
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
