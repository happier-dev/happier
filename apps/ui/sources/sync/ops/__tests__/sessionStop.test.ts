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
  sessionRpcWithServerAccountScope: mockSessionRpcWithServerScope,
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

// Explicit Stop persists its hold through the Session metadata owner under the Home's
// Account authority (sessions.ts); those two Account/sync boundaries are stubbed here
// so these tests keep exercising the Stop transport strategy.
vi.mock('../actions/actionAccountContext', () => ({
  captureLazyActionAccountContext: async (serverId: string) => ({
    accountLifetime: { scope: { serverId, accountId: 'account-1' }, isCurrent: () => true },
    dispose: () => {},
  }),
}));

vi.mock('../../runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({ patchSessionMetadataWithRetry: async () => undefined }),
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', async importOriginal => ({
  ...(await importOriginal<typeof import('../../runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope')>()),
  runWithServerRequestAuthorityForServerAccountScope: async (_params: unknown, operation: (authority: unknown) => Promise<unknown>) => await operation({}),
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority', async importOriginal => ({
  ...(await importOriginal<typeof import('../../runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority')>()),
  // The Home Session read is a network boundary; these cases have no published Session snapshot.
  readSessionSnapshotForAuthority: async () => ({ session: null }),
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
    const res = await sessionStop('sid-1', 'explicit_stop');
    expect(res).toMatchObject({
      success: false,
      message: 'RPC method not available',
      code: 'session_stop_control_unavailable',
      recovery: 'retry_when_runtime_available',
    });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
      method: 'killSession',
      payload: {},
      scope: { serverId: 'server-a', accountId: 'account-1' },
      sessionId: 'sid-1',
    }));
  });

  it('does not fall back to session-end when the errorCode is missing (legacy message-only)', async () => {
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-b');
    mockSessionRpcWithServerScope.mockRejectedValue(new Error('RPC method not available'));
    const res = await sessionStop('sid-2', 'explicit_stop');
    expect(res).toMatchObject({
      success: false,
      message: 'RPC method not available',
      code: 'session_stop_failed',
    });
  });

  it('returns an error for non-RPC-method-unavailable failures', async () => {
    mockResolvePreferredServerIdForSessionId.mockReturnValue('server-c');
    mockSessionRpcWithServerScope.mockRejectedValue(new Error('boom'));

    const res = await sessionStop('sid-3', 'explicit_stop');
    expect(res).toMatchObject({ success: false, message: 'boom', code: 'session_stop_failed' });
  });
});
