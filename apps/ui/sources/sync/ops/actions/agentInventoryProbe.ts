import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentInventoryProbeInput } from '@happier-dev/protocol/actions/actionSpecs';
import { projectUnexpectedActionFailureV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    AgentConfigOptionsProbeObservationSchema,
    AgentModelsProbeObservationSchema,
    AgentSessionModesProbeObservationSchema,
    type AgentModelsProbeObservation,
    readCapabilityInvokeFailure,
} from '@happier-dev/protocol/capabilities';

import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';

export type AgentInventoryProbeTarget = Readonly<{
    /** The runtime Agent id that names the machine capability (`cli.<id>`). */
    agentId: string;
    /**
     * The V1 backend target carried to the probe, when the target can be
     * expressed in that vocabulary at all. An external qualified Agent target
     * (`agent:<pluginId>/<localId>`) has no V1 carrier form — the daemon
     * resolves it from the capability id — so omitting the param is the
     * contract, not a lost fact.
     */
    backendTargetParam: BackendTargetRefV1 | BackendTargetRefV2 | null;
}>;

function normalizeId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

/** Admitted capability transport below inventory Actions; never imports their executor. */
export async function probeAgentInventory(
    machineId: string,
    target: AgentInventoryProbeTarget,
    method: 'probeModels' | 'probeModes' | 'probeConfigOptions',
    requestedServerId?: string,
    probe?: AgentInventoryProbeInput,
    signal?: AbortSignal,
): Promise<Readonly<{ ok: true; result: Record<string, unknown> }> | Readonly<{ ok: false; failure: ActionExecuteFailure }>> {
    const serverId = normalizeId(requestedServerId) || normalizeId(getActiveServerSnapshot()?.serverId);
    const { transportTimeoutMs, ...capabilityParams } = probe ?? {};
    const res = await machineCapabilitiesInvoke(
        machineId,
        {
            id: buildProviderCliCapabilityId(target.agentId),
            method,
            params: {
                timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                ...capabilityParams,
                ...(target.backendTargetParam ? { backendTarget: target.backendTargetParam } : {}),
            },
        },
        { ...(serverId ? { serverId } : {}), ...(transportTimeoutMs ? { timeoutMs: transportTimeoutMs } : {}), signal },
    );
    if (!res.supported) return { ok: false, failure: {
        ...(res.reason === 'outcomeUnknown' && !res.errorCode ? projectUnexpectedActionFailureV1(true) : {
            ok: false as const,
            errorCode: res.errorCode ?? (res.reason === 'not-supported' ? 'unsupported_method' : 'agent_inventory_probe_failed'),
            error: res.errorCode ?? (res.reason === 'not-supported' ? 'unsupported_method' : 'agent_inventory_probe_failed'),
        }),
        details: { reason: res.reason, ...(res.retryable === undefined ? {} : { retryable: res.retryable }),
            ...(res.failureCause ? { failureCause: res.failureCause } : {}),
            ...(res.requestDisposition ? { requestDisposition: res.requestDisposition } : {}) },
    } };
    const failed = (errorCode = 'agent_inventory_probe_failed'): Readonly<{ ok: false; failure: ActionExecuteFailure }> => ({ ok: false,
        failure: { ok: false, errorCode, error: errorCode } });
    if (!res.response.ok) {
        const failure = readCapabilityInvokeFailure({ ...res.response.error, errorCode: res.response.error.code });
        const result = failed(failure?.errorCode);
        return failure?.retryable === undefined && !failure?.failureCause ? result : { ok: false, failure: {
            ...result.failure, details: {
                ...(failure?.retryable === undefined ? {} : { retryable: failure.retryable }),
                ...(failure?.failureCause ? { failureCause: failure.failureCause } : {}),
            },
        } };
    }
    const result = res.response.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return failed();
    if (probe) {
        const parsed = (method === 'probeModels' ? AgentModelsProbeObservationSchema
            : method === 'probeModes' ? AgentSessionModesProbeObservationSchema : AgentConfigOptionsProbeObservationSchema).safeParse(result);
        return parsed.success ? { ok: true, result: parsed.data } : failed();
    }
    return { ok: true, result: result as Record<string, unknown> };
}

/** Admitted native model transport, below the Action executor and shared cache. */
export async function probeAgentModelsForActions(args: Readonly<{ machineId: string; serverId?: string; signal?: AbortSignal; probe: AgentInventoryProbeInput }>, target: AgentInventoryProbeTarget): Promise<Readonly<{
    agentId: string;
    items: readonly Readonly<{ modelId: string; label: string; description?: string }>[];
    supportsFreeform?: boolean;
    source: 'dynamic' | 'static' | 'unavailable' | 'preflight';
    probeObservation?: AgentModelsProbeObservation;
}> | ActionExecuteFailure> {
    const probe = await probeAgentInventory(args.machineId, target, 'probeModels', args.serverId, args.probe, args.signal);
    if (!probe.ok) return probe.failure;
    const parsed = AgentModelsProbeObservationSchema.parse(probe.result);
    return {
        agentId: target.agentId,
        items: parsed.availableModels.map(model => ({ modelId: model.id, label: model.name, ...(model.description ? { description: model.description } : {}) })),
        supportsFreeform: parsed.supportsFreeform,
        source: parsed.source ?? 'preflight',
        probeObservation: parsed,
    };
}
