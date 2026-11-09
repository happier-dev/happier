import { expect, it, vi } from 'vitest';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';

const { callSessionRpc } = vi.hoisted(() => ({ callSessionRpc: vi.fn() }));
// This adapter is the socket transport boundary; run services remain real.
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc }));

import { startExecutionRun, stopExecutionRun, waitForExecutionRun } from './executionRuns';

it.each(['throw', 'response'] as const)('reports unavailable run hosts through start and stop (%s)', async kind => {
    for (const operation of [startExecutionRun, stopExecutionRun,
        (params: Parameters<typeof startExecutionRun>[0]) => waitForExecutionRun({ ...params, runId: 'run', timeoutMs: null, condition: 'terminal' })]) {
        callSessionRpc.mockReset();
        if (kind === 'throw') callSessionRpc.mockRejectedValueOnce(markRpcRequestDisposition(
            new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE), 'notSent'));
        else callSessionRpc.mockResolvedValueOnce({ ok: false, error: 'RPC method not available',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        const result = await operation({ sessionId: 'unavailable-host', mode: 'plain', request: { runId: 'run' } });
        expect(result).toMatchObject({ ok: false, code: 'execution_run_target_unavailable' });
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
    }
});

it('keeps a positively missing method distinct from an unavailable target', async () => {
    callSessionRpc.mockReset();
    callSessionRpc.mockRejectedValueOnce(markRpcRequestDisposition(
        new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND), 'notSent'));
    expect(await startExecutionRun({ sessionId: 'old-host', mode: 'plain', request: {} }))
        .toMatchObject({ ok: false, code: 'execution_run_protocol_unsupported' });
});
