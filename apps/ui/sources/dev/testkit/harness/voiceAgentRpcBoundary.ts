/**
 * A retained Run served by the external daemon transport. The UI initializer,
 * cache, metadata writer and recovery stay real; custom CLI dispatch still
 * exercises its actual execution owner instead of using this wire fixture.
 * This module has no platform or mock-registration side effects.
 */
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';

export async function createRetainedVoiceAgentRpcBoundary(params: Readonly<{
    /** Identity assigned by this synthetic daemon, parsed by the real public schema. */
    runId?: string;
    onRpc?: (method: string, input: unknown) => void;
    handleOtherRpc?: (method: string, input: unknown) => Promise<unknown>;
}> = {}) {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const {
        ExecutionRunEnsureOrStartRequestSchema, ExecutionRunEnsureOrStartResponseSchema,
        ExecutionRunGetRequestSchema, ExecutionRunGetResponseSchema,
        ExecutionRunListResponseSchema, ExecutionRunPublicStateSchema, ExecutionRunStopRequestSchema, ExecutionRunStopResponseSchema,
    } = await import('@happier-dev/protocol/execution/runs/index');
    const { ExecutionRunVoiceAgentIntentInputV1Schema } = await import('@happier-dev/protocol/execution/runs/startRequest');
    const { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } = await import('@happier-dev/protocol/backends/targets/backendTargetRefV2');
    let retainedRun: ReturnType<typeof ExecutionRunPublicStateSchema.parse> | null = null;
    const requests: Array<{ method: string; input: unknown }> = [];
    return {
        requests,
        readRetainedRun: (): ExecutionRunPublicState | null => retainedRun,
        async dispatch(method: string, input: unknown): Promise<unknown> {
            requests.push({ method, input });
            params.onRpc?.(method, input);
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) {
                return ExecutionRunListResponseSchema.parse({ runs: retainedRun ? [retainedRun] : [] });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
                const request = ExecutionRunGetRequestSchema.parse(input);
                return retainedRun?.runId === request.runId
                    ? ExecutionRunGetResponseSchema.parse({ run: retainedRun })
                    : { ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' };
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
                const request = ExecutionRunEnsureOrStartRequestSchema.parse(input);
                const created = retainedRun === null;
                if (request.runId) return retainedRun?.runId === request.runId
                    ? ExecutionRunEnsureOrStartResponseSchema.parse({ ok: true, runId: retainedRun.runId,
                        callId: retainedRun.callId, sidechainId: retainedRun.sidechainId, created: false })
                    : { ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' };
                if (!request.start || request.start.intent !== 'voice_agent') {
                    throw new Error('Voice boundary requires its actual launch admission');
                }
                retainedRun ??= ExecutionRunPublicStateSchema.parse({
                    runId: params.runId ?? 'local-agent-run', callId: 'local-call', sidechainId: 'local-sidechain',
                    intent: request.start.intent, backendTarget: convertBackendTargetRefV2ToV1(readBackendTargetRefV2(request.start.backendTarget)),
                    permissionMode: request.start.permissionMode, retentionPolicy: request.start.retentionPolicy,
                    runClass: request.start.runClass, ioMode: request.start.ioMode,
                    status: 'running', startedAtMs: 1,
                    voicePolicy: ExecutionRunVoiceAgentIntentInputV1Schema.parse(request.start.intentInput).voicePolicy,
                });
                return ExecutionRunEnsureOrStartResponseSchema.parse({ ok: true, runId: retainedRun.runId,
                    callId: retainedRun.callId, sidechainId: retainedRun.sidechainId, created });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
                const request = ExecutionRunStopRequestSchema.parse(input);
                if (retainedRun?.runId !== request.runId) {
                    return { ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' };
                }
                retainedRun = null;
                return ExecutionRunStopResponseSchema.parse({ ok: true });
            }
            if (params.handleOtherRpc) return params.handleOtherRpc(method, input);
            throw new Error(`Unexpected Voice daemon method: ${method}`);
        },
    };
}
