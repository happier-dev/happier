import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentModelsProbeObservationSchema, AgentSessionModesProbeObservationSchema, AgentConfigOptionsProbeObservationSchema,
    readCapabilityInvokeFailure } from '@happier-dev/protocol/capabilities';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { MachineCapabilitiesInvokeResult } from '@/sync/ops/capabilities';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

/** Existing inventory Actions are the only public preflight transport front door. */
export async function invokeAgentInventoryProbeAction(params: Readonly<{
    agentId: string;
    machineId: string;
    serverId?: string | null;
    backendTarget?: BackendTargetRefV1 | BackendTargetRefV2 | null;
    capabilityParams: Readonly<Record<string, unknown>>;
    bypassCache?: boolean;
    transportTimeoutMs?: number;
    signal?: AbortSignal;
}>, method: 'probeModels' | 'probeModes' | 'probeConfigOptions'): Promise<MachineCapabilitiesInvokeResult> {
    try {
        const target = params.backendTarget ? readBackendTargetRefV2(params.backendTarget) : null;
        const configured = target?.configuredBackendId || target?.sourceKind === 'configured';
        const result = await createFrontDoorActionExecute()(method === 'probeModels' ? 'agents.models.list'
            : method === 'probeModes' ? 'agents.session_modes.list' : 'agents.config_options.list', {
            ...(!configured ? { agentId: params.agentId } : {}),
            ...(target ? { backendTargetKey: resolveBackendTargetKeyV2(target) } : {}),
            machineId: params.machineId,
            probe: { ...params.capabilityParams, ...(params.bypassCache ? { bypassCache: true } : {}),
                ...(params.transportTimeoutMs ? { transportTimeoutMs: params.transportTimeoutMs } : {}) },
        }, { surface: 'ui', ...(params.serverId ? { serverId: params.serverId } : {}), signal: params.signal });
        params.signal?.throwIfAborted();
        if (!result.ok) {
            const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details)
                ? result.details as Record<string, unknown> : null;
            return { supported: false,
                errorCode: result.errorCode,
                ...(typeof details?.retryable === 'boolean' ? { retryable: details.retryable } : {}),
                reason: result.errorCode === 'action_outcome_unknown' || details?.reason === 'outcomeUnknown' ? 'outcomeUnknown'
                    : details?.reason === 'not-supported' ? 'not-supported' : 'error',
                ...(details?.requestDisposition === 'outcomeUnknown' || details?.requestDisposition === 'notSent'
                    ? { requestDisposition: details.requestDisposition } : {}) };
        }
        if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result)) return { supported: false, reason: 'error' };
        const observation = (method === 'probeModels' ? AgentModelsProbeObservationSchema
            : method === 'probeModes' ? AgentSessionModesProbeObservationSchema : AgentConfigOptionsProbeObservationSchema)
            .safeParse((result.result as Record<string, unknown>).probeObservation);
        return observation.success ? { supported: true, response: { ok: true, result: observation.data } } : { supported: false, reason: 'error' };
    } catch (error) {
        if (params.signal?.aborted) throw error;
        return { supported: false, reason: 'error', ...readCapabilityInvokeFailure(error) };
    }
}
