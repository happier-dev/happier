import { expect, it } from 'vitest';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';

import { isMachineDaemonRpcUnsupportedError } from './machineDaemonRpcErrors';

it('preserves the refusal correlation and no-effect marker from an RPC exception', async () => {
    const { projectMachineDaemonRpcFailure } = await import('./machineDaemonRpcErrors');
    const failureCause = { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: 'machine_unavailable', httpStatus: 403 };
    const refusal = { errorCode: RPC_ERROR_CODES.FORBIDDEN, requestId: 'rpc-request', effectAttempted: false, failureCause };
    const thrown = Object.assign(new RpcError('Forbidden', refusal.errorCode, failureCause), {
        requestId: refusal.requestId, effectAttempted: refusal.effectAttempted,
    });
    expect(projectMachineDaemonRpcFailure(thrown)).toMatchObject({ ok: false, reason: 'request_failed', ...refusal });
});

it('requires affirmative method absence before a resource adapter may latch an unsupported daemon', () => {
    expect(isMachineDaemonRpcUnsupportedError(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))).toBe(true);
    // Home target discovery can fail while the same daemon remains connected with this handler.
    expect(isMachineDaemonRpcUnsupportedError(new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE))).toBe(false);
    expect(isMachineDaemonRpcUnsupportedError(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN))).toBe(false);
    expect(isMachineDaemonRpcUnsupportedError(new Error('Socket disconnected'))).toBe(false);
});
