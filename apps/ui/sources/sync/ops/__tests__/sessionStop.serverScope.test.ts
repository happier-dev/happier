import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const { mockSessionRpcWithServerScope, mockMachineRpcWithServerScope, mockResolveContext, mockApiSend, mockCreateEphemeralClient, mockStorageState } = vi.hoisted(
  () => ({
    mockSessionRpcWithServerScope: vi.fn(),
    mockMachineRpcWithServerScope: vi.fn(),
    mockResolveContext: vi.fn(),
    mockApiSend: vi.fn(),
    mockCreateEphemeralClient: vi.fn(),
    mockStorageState: {
      sessions: {} as Record<string, unknown>,
      machines: {} as Record<string, unknown>,
      applySessions: vi.fn(),
      applySessionListRenderablePatches: vi.fn(),
    },
  }),
);

vi.mock('../../runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: mockSessionRpcWithServerScope,
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: mockMachineRpcWithServerScope,
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext', () => ({
  resolveServerScopedSessionContext: mockResolveContext,
}));

vi.mock('../../api/session/apiSocket', () => ({
  apiSocket: {
    send: mockApiSend,
  },
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
  createEphemeralServerSocketClient: mockCreateEphemeralClient,
}));

vi.mock('../../domains/state/storage', () => ({
  storage: {
    getState: () => mockStorageState,
  },
}));

// ops.ts imports ./sync, which pulls in Expo-native modules in node/vitest.
// sessionStopWithServerScope doesn't need real encryption in these tests.
vi.mock('../../sync', () => ({
  sync: {
    encryption: {
      getSessionEncryption: () => null,
      getMachineEncryption: () => null,
    },
  },
}));

import { sessionStopWithServerScope } from '../../ops';

describe('sessionStopWithServerScope', () => {
  beforeEach(() => {
    mockSessionRpcWithServerScope.mockReset();
    mockMachineRpcWithServerScope.mockReset();
    mockResolveContext.mockReset();
    mockApiSend.mockReset();
    mockCreateEphemeralClient.mockReset();
    mockStorageState.sessions = {};
    mockStorageState.machines = {};
    mockStorageState.applySessions.mockReset();
    mockStorageState.applySessionListRenderablePatches.mockReset();
  });

  it('uses daemon machine stop before session RPC when the hosting machine is reachable', async () => {
    mockStorageState.sessions = {
      'sid-daemon': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': {
        id: 'machine-1',
        active: true,
        activeAt: Date.now(),
      },
    };
    mockMachineRpcWithServerScope.mockResolvedValue({ message: 'Session stopped' });

    const res = await sessionStopWithServerScope('sid-daemon', { serverId: 'server-a' });

    expect(res).toEqual({ success: true });
    expect(mockMachineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'stop-session',
      payload: { sessionId: 'sid-daemon' },
      serverId: 'server-a',
    }));
    expect(mockSessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
      {
        sessionId: 'sid-daemon',
        patch: expect.objectContaining({
          active: false,
          thinking: false,
          activeAt: expect.any(Number),
          presence: expect.any(Number),
        }),
      },
    ]);
  });

  it('falls back to session kill RPC when daemon machine stop is unavailable', async () => {
    mockStorageState.sessions = {
      'sid-old-daemon': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': {
        id: 'machine-1',
        active: true,
        activeAt: Date.now(),
      },
    };
    const err = Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    mockMachineRpcWithServerScope.mockRejectedValue(err);
    mockSessionRpcWithServerScope.mockResolvedValue({ success: true });

    const res = await sessionStopWithServerScope('sid-old-daemon', { serverId: 'server-a' });

    expect(res).toEqual({ success: true });
    expect(mockMachineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'stop-session',
      payload: { sessionId: 'sid-old-daemon' },
      serverId: 'server-a',
    }));
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith({
      method: 'killSession',
      payload: {},
      serverId: 'server-a',
      sessionId: 'sid-old-daemon',
    });
    expect(mockApiSend).not.toHaveBeenCalled();
  });

  it('marks the local cache-only list row inactive after a successful kill RPC', async () => {
    mockSessionRpcWithServerScope.mockResolvedValue({ success: true });

    const res = await sessionStopWithServerScope('sid-killed', { serverId: 'server-a' });

    expect(res).toEqual({ success: true });
    expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
      {
        sessionId: 'sid-killed',
        patch: expect.objectContaining({
          active: false,
          thinking: false,
          activeAt: expect.any(Number),
          thinkingAt: expect.any(Number),
          presence: expect.any(Number),
          updatedAt: expect.any(Number),
        }),
      },
    ]);
  });

  it('falls back to session-end on the active socket when scope is active and RPC method is unavailable', async () => {
    const err = Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    mockSessionRpcWithServerScope.mockRejectedValue(err);
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });

    const res = await sessionStopWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({ success: true });
    expect(mockApiSend).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 'sid-1', time: expect.any(Number) }),
    );
    expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
      {
        sessionId: 'sid-1',
        patch: expect.objectContaining({
          active: false,
          thinking: false,
          activeAt: expect.any(Number),
          presence: expect.any(Number),
        }),
      },
    ]);
  });

  it('falls back to session-end on an ephemeral socket when scope is not active and RPC method is unavailable', async () => {
    const err = Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    mockSessionRpcWithServerScope.mockRejectedValue(err);
    mockResolveContext.mockResolvedValue({
      scope: 'scoped',
      targetServerUrl: 'https://scoped.example',
      targetServerId: 'server-b',
      token: 'tok_scoped',
      timeoutMs: 1000,
      encryption: null,
    });
    const send = vi.fn();
    const disconnect = vi.fn();
    mockCreateEphemeralClient.mockResolvedValue({ emit: send, disconnect, timeout: () => ({ emitWithAck: vi.fn() }) });

    const res = await sessionStopWithServerScope('sid-2', { serverId: 'server-b' });
    expect(res).toEqual({ success: true });
    expect(mockCreateEphemeralClient).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://scoped.example', token: 'tok_scoped' }),
    );
    expect(send).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 'sid-2', time: expect.any(Number) }),
    );
    expect(disconnect).toHaveBeenCalled();
  });

  it('returns a structured failure when inactive-state fallback cannot resolve server scope', async () => {
    const err = Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    mockSessionRpcWithServerScope.mockRejectedValue(err);
    mockResolveContext.mockRejectedValue(new Error('server scope unavailable'));

    await expect(sessionStopWithServerScope('sid-no-scope', { serverId: 'server-b' })).resolves.toEqual({
      success: false,
      message: 'server scope unavailable',
    });
    expect(mockApiSend).not.toHaveBeenCalled();
    expect(mockCreateEphemeralClient).not.toHaveBeenCalled();
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
  });
});
