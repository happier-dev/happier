import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSessionRpcWithPreferredSessionScope } = vi.hoisted(() => ({
  mockSessionRpcWithPreferredSessionScope: vi.fn(),
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
  sessionRpcWithPreferredSessionScope: (...args: unknown[]) => mockSessionRpcWithPreferredSessionScope(...args),
}));

// ops.ts imports ./sync, which pulls in Expo-native modules in node/vitest.
// sessionAbort doesn't use sync, so we provide a lightweight mock.
vi.mock('../../sync', () => ({
  sync: {
    encryption: {
      getSessionEncryption: () => null,
      getMachineEncryption: () => null,
    },
  },
}));

import { sessionAbort } from '../../ops';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

const initialStorageState = storage.getState();

function buildSession(sessionId: string): Session {
  return {
    id: sessionId,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: null,
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: true,
    thinkingAt: 1,
    presence: 'online',
  };
}

describe('sessionAbort', () => {
  beforeEach(() => {
    storage.setState(initialStorageState, true);
    mockSessionRpcWithPreferredSessionScope.mockReset();
  });

  it('clears local thinking markers after a successful abort', async () => {
    const sessionId = 'sid_clear_markers';
    storage.getState().applySessions([buildSession(sessionId)]);
    storage.getState().markSessionOptimisticThinking(sessionId);

    const before = storage.getState().sessions[sessionId];
    expect(before).toBeDefined();
    expect(before?.thinking).toBe(true);
    expect(before?.optimisticThinkingAt ?? null).not.toBeNull();
    expect(before?.thinkingGraceUntil ?? null).toBeNull();

    mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);

    await sessionAbort(sessionId);

    const after = storage.getState().sessions[sessionId];
    expect(after?.thinking).toBe(false);
    expect(after?.optimisticThinkingAt ?? null).toBeNull();
    expect(typeof after?.thinkingGraceUntil).toBe('number');
  });

  it('does not throw when RPC method is unavailable (errorCode)', async () => {
    mockSessionRpcWithPreferredSessionScope.mockRejectedValue(new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));

    await expect(sessionAbort('sid-1')).resolves.toBeUndefined();
  });

  it('does not throw when scoped session encryption is unavailable', async () => {
    const sessionId = 'sid-encryption-missing';
    storage.getState().applySessions([buildSession(sessionId)]);
    storage.getState().markSessionOptimisticThinking(sessionId);

    mockSessionRpcWithPreferredSessionScope.mockRejectedValue(
      new RpcError('Unable to resolve session encryption for scoped RPC', 'scoped_session_encryption_unavailable'),
    );

    await expect(sessionAbort(sessionId)).resolves.toBeUndefined();

    const after = storage.getState().sessions[sessionId];
    expect(after?.thinking).toBe(false);
    expect(after?.optimisticThinkingAt ?? null).toBeNull();
    expect(typeof after?.thinkingGraceUntil).toBe('number');
  });

  it('does not treat legacy message-only errors as method-not-available', async () => {
    mockSessionRpcWithPreferredSessionScope.mockRejectedValue(new Error('RPC method not available'));

    await expect(sessionAbort('sid-2')).rejects.toThrow('RPC method not available');
  });

  it('rethrows non-RPC-method-unavailable failures', async () => {
    mockSessionRpcWithPreferredSessionScope.mockRejectedValue(new Error('boom'));

    await expect(sessionAbort('sid-3')).rejects.toThrow('boom');
  });
});
