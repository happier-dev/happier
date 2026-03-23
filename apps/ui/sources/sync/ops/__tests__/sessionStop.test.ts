import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSend,
  mockResolvePreferredServerIdForSessionId,
  mockResolveServerScopedSessionContext,
  mockSessionRpcWithServerScope,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockResolvePreferredServerIdForSessionId: vi.fn(),
  mockResolveServerScopedSessionContext: vi.fn(),
  mockSessionRpcWithServerScope: vi.fn(),
}));

vi.mock('../../api/session/apiSocket', () => ({
  apiSocket: {
    send: mockSend,
  },
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: mockResolvePreferredServerIdForSessionId,
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext', () => ({
  resolveServerScopedSessionContext: mockResolveServerScopedSessionContext,
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

describe('sessionStop', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockResolvePreferredServerIdForSessionId.mockReset();
    mockResolveServerScopedSessionContext.mockReset();
    mockSessionRpcWithServerScope.mockReset();
  });

  it('falls back to session-end when RPC method is unavailable (errorCode)', async () => {
    const err: any = new Error('RPC method not available');
    err.rpcErrorCode = RPC_ERROR_CODES.METHOD_NOT_AVAILABLE;
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-a');
    mockSessionRpcWithServerScope.mockRejectedValue(err);
    mockResolveServerScopedSessionContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });

    const res = await sessionStop('sid-1');
    expect(res).toEqual({ success: true });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith({
      method: 'killSession',
      payload: {},
      serverId: 'server-a',
      sessionId: 'sid-1',
    });
    expect(mockSend).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 'sid-1', time: expect.any(Number) }),
    );
  });

  it('keeps backward compatibility by falling back to the legacy error message', async () => {
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-b');
    mockSessionRpcWithServerScope.mockRejectedValue(new Error('RPC method not available'));
    mockResolveServerScopedSessionContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-b',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });

    const res = await sessionStop('sid-2');
    expect(res).toEqual({ success: true });
    expect(mockSend).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 'sid-2', time: expect.any(Number) }),
    );
  });

  it('returns an error for non-RPC-method-unavailable failures', async () => {
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-c');
    mockSessionRpcWithServerScope.mockRejectedValue(new Error('boom'));

    const res = await sessionStop('sid-3');
    expect(res).toEqual({ success: false, message: 'boom' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
