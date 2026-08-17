import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockResolvePreferredServerIdForSessionId,
  mockSessionRpcWithServerScope,
} = vi.hoisted(() => ({
  mockResolvePreferredServerIdForSessionId: vi.fn(),
  mockSessionRpcWithServerScope: vi.fn(),
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: mockResolvePreferredServerIdForSessionId,
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: mockSessionRpcWithServerScope,
}));

// ops.ts imports ./sync, which pulls in Expo-native modules in node/vitest.
// sessionStop doesn't use sync, so we provide a lightweight mock.
vi.mock('../../sync', () => ({
  sync: {
    encryption: {
      getSessionEncryption: () => null,
      getMachineEncryption: () => null,
    },
  },
}));

import { sessionStop } from '../../ops';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

describe('sessionStop', () => {
  beforeEach(() => {
    mockResolvePreferredServerIdForSessionId.mockReset();
    mockSessionRpcWithServerScope.mockReset();
  });

  it('reports unavailable control without claiming the runtime needs an upgrade', async () => {
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-a');
    mockSessionRpcWithServerScope.mockRejectedValue(new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));
    const res = await sessionStop('sid-1');
    expect(res).toEqual({
      success: false,
      message: 'RPC method not available',
      code: 'session_stop_control_unavailable',
      recovery: 'retry_when_runtime_available',
    });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith({
      method: 'killSession',
      payload: {},
      serverId: 'server-a',
      sessionId: 'sid-1',
    });
  });

  it('does not fall back to session-end when the errorCode is missing (legacy message-only)', async () => {
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-b');
    mockSessionRpcWithServerScope.mockRejectedValue(new Error('RPC method not available'));
    const res = await sessionStop('sid-2');
    expect(res).toEqual({
      success: false,
      message: 'RPC method not available',
      code: 'session_stop_failed',
    });
  });

  it('returns an error for non-RPC-method-unavailable failures', async () => {
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-c');
    mockSessionRpcWithServerScope.mockRejectedValue(new Error('boom'));

    const res = await sessionStop('sid-3');
    expect(res).toEqual({ success: false, message: 'boom', code: 'session_stop_failed' });
  });
});
