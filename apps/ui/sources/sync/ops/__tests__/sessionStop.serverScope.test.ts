import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const { mockSessionRpcWithServerScope, mockMachineRpcWithServerScope, mockStorageState } = vi.hoisted(
  () => ({
    mockSessionRpcWithServerScope: vi.fn(),
    mockMachineRpcWithServerScope: vi.fn(),
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
import { log } from '@/log';

describe('sessionStopWithServerScope', () => {
  beforeEach(() => {
    mockSessionRpcWithServerScope.mockReset();
    mockMachineRpcWithServerScope.mockReset();
    mockStorageState.sessions = {};
    mockStorageState.machines = {};
    mockStorageState.applySessions.mockReset();
    mockStorageState.applySessionListRenderablePatches.mockReset();
  });

  it('treats the released machine Stop response as request acknowledgement without patching inactive', async () => {
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

    expect(res).toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockMachineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'stop-session',
      payload: { sessionId: 'sid-daemon' },
      authorization: {
        kind: 'session.write',
        sessionId: 'sid-daemon',
      },
      serverId: 'server-a',
    }));
    expect(mockSessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('marks daemon Stop as issued so transport fallback cannot replay it onto a resumed replacement', async () => {
    mockStorageState.sessions = {
      'sid-one-shot': {
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
    mockMachineRpcWithServerScope.mockImplementationOnce(async (input) => {
      expect(input.onIssued).toEqual(expect.any(Function));
      input.onIssued();
      return { status: 'requested' };
    });

    await expect(sessionStopWithServerScope('sid-one-shot', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockMachineRpcWithServerScope).toHaveBeenCalledTimes(1);
    expect(mockSessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
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
    mockSessionRpcWithServerScope.mockResolvedValue({
      success: true,
      message: 'Killing happier process',
    });

    const res = await sessionStopWithServerScope('sid-old-daemon', { serverId: 'server-a' });

    expect(res).toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
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
  });

  it('falls back to the live runner when the server reports missing exact machine control', async () => {
    mockStorageState.sessions = {
      'sid-missing-machine-control': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };
    mockMachineRpcWithServerScope.mockRejectedValue(Object.assign(
      new Error('Session machine control unavailable'),
      { rpcErrorCode: 'RPC_SESSION_MACHINE_CONTROL_UNAVAILABLE' },
    ));
    mockSessionRpcWithServerScope.mockResolvedValue({ success: true, message: 'Killing happier process' });

    await expect(sessionStopWithServerScope('sid-missing-machine-control', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith({
      method: 'killSession',
      payload: {},
      serverId: 'server-a',
      sessionId: 'sid-missing-machine-control',
    });
  });

  it('does not fall back through a genuine forbidden machine response', async () => {
    mockStorageState.sessions = {
      'sid-forbidden-machine-control': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };
    mockMachineRpcWithServerScope.mockRejectedValue(Object.assign(new Error('Forbidden'), {
      rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN,
    }));

    await expect(sessionStopWithServerScope('sid-forbidden-machine-control', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Forbidden',
      code: 'session_stop_failed',
    });
    expect(mockSessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('falls back to session kill RPC when daemon machine stop returns a method-not-found envelope', async () => {
    mockStorageState.sessions = {
      'sid-old-daemon-envelope': {
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
    mockMachineRpcWithServerScope.mockResolvedValue({
      error: 'Method not found',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
    });
    mockSessionRpcWithServerScope.mockResolvedValue({ success: true, message: 'Killing happier process' });

    const res = await sessionStopWithServerScope('sid-old-daemon-envelope', { serverId: 'server-a' });

    expect(res).toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith({
      method: 'killSession',
      payload: {},
      serverId: 'server-a',
      sessionId: 'sid-old-daemon-envelope',
    });
  });

  it('falls back to session kill RPC when daemon machine stop reports the session was not found', async () => {
    mockStorageState.sessions = {
      'sid-stale-machine-target': {
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
    mockMachineRpcWithServerScope.mockResolvedValue({
      error: 'Session not found or failed to stop',
    });
    mockSessionRpcWithServerScope.mockResolvedValue({ success: true, message: 'Killing happier process' });

    const res = await sessionStopWithServerScope('sid-stale-machine-target', { serverId: 'server-a' });

    expect(res).toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith({
      method: 'killSession',
      payload: {},
      serverId: 'server-a',
      sessionId: 'sid-stale-machine-target',
    });
  });

  it('treats the released runner Stop response as request acknowledgement without patching inactive', async () => {
    mockSessionRpcWithServerScope.mockResolvedValue({
      success: true,
      message: 'Killing happier process',
    });

    const res = await sessionStopWithServerScope('sid-killed', { serverId: 'server-a' });

    expect(res).toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('does not let the live runner prove its own physical exit', async () => {
    mockSessionRpcWithServerScope.mockResolvedValue({ status: 'stopped' });

    const res = await sessionStopWithServerScope('sid-runner-self-report', { serverId: 'server-a' });

    expect(res).toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('reports current strict stopped only when the daemon confirms physical exit and never owns reachability', async () => {
    mockStorageState.sessions = {
      'sid-strict': {
        active: true,
        runtimeActivity: { state: 'active', activeCount: 1, observedAt: 10, revision: 2 },
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };
    mockMachineRpcWithServerScope.mockResolvedValue({ status: 'stopped' });

    await expect(sessionStopWithServerScope('sid-strict', { serverId: 'server-a' })).resolves.toEqual({ success: true });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
    expect(mockStorageState.sessions['sid-strict']).toEqual(expect.objectContaining({
      active: true,
      runtimeActivity: { state: 'active', activeCount: 1, observedAt: 10, revision: 2 },
    }));
  });

  it('preserves current strict requested, not-found, and incomplete outcomes without false success', async () => {
    mockStorageState.sessions = {
      'sid-strict-outcomes': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };

    mockMachineRpcWithServerScope.mockResolvedValueOnce({ status: 'requested' });
    await expect(sessionStopWithServerScope('sid-strict-outcomes', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });

    mockMachineRpcWithServerScope.mockResolvedValueOnce({ status: 'not_found' });
    mockSessionRpcWithServerScope.mockResolvedValueOnce({ status: 'not_found' });
    await expect(sessionStopWithServerScope('sid-strict-outcomes', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Session not found',
      code: 'session_stop_not_found',
    });

    mockMachineRpcWithServerScope.mockResolvedValueOnce({
      status: 'incomplete',
      reason: 'runner_exit_timeout',
    });
    await expect(sessionStopWithServerScope('sid-strict-outcomes', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Session stop incomplete: runner_exit_timeout',
      code: 'session_stop_failed',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('falls back to the live runner when the daemon lost only its tracked-runner entry', async () => {
    mockStorageState.sessions = {
      'sid-untracked-runner': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };
    mockMachineRpcWithServerScope.mockResolvedValue({
      status: 'incomplete',
      reason: 'tracked_runner_absent',
    });
    mockSessionRpcWithServerScope.mockResolvedValue({ success: true, message: 'Killing happier process' });

    await expect(sessionStopWithServerScope('sid-untracked-runner', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Stop requested; waiting for the session to become inactive',
      code: 'session_stop_requested',
      recovery: 'wait_for_inactive',
    });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledWith({
      method: 'killSession',
      payload: {},
      serverId: 'server-a',
      sessionId: 'sid-untracked-runner',
    });
  });

  it('preserves tracked-runner evidence when the fallback runner route is also unavailable', async () => {
    mockStorageState.sessions = {
      'sid-untracked-runner-offline': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };
    mockMachineRpcWithServerScope.mockResolvedValue({
      status: 'incomplete',
      reason: 'tracked_runner_absent',
    });
    mockSessionRpcWithServerScope.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    }));

    await expect(sessionStopWithServerScope('sid-untracked-runner-offline', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Session stop incomplete: tracked_runner_absent',
      code: 'session_stop_failed',
    });
    expect(mockSessionRpcWithServerScope).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable control without claiming the runtime needs an upgrade', async () => {
    const err = Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    mockSessionRpcWithServerScope.mockRejectedValue(err);
    const res = await sessionStopWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({
      success: false,
      message: 'RPC method not available',
      code: 'session_stop_control_unavailable',
      recovery: 'retry_when_runtime_available',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('preserves daemon not-found evidence when the disconnected runner has no RPC route', async () => {
    mockStorageState.sessions = {
      'sid-stale-active': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };
    mockMachineRpcWithServerScope.mockResolvedValue({ status: 'not_found' });
    mockSessionRpcWithServerScope.mockRejectedValue(Object.assign(
      new Error('RPC method not available'),
      { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE },
    ));

    await expect(sessionStopWithServerScope('sid-stale-active', { serverId: 'server-a' })).resolves.toEqual({
      success: false,
      message: 'Session not found',
      code: 'session_stop_not_found',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('does not report success or patch inactive when the runner rejects the stop', async () => {
    mockSessionRpcWithServerScope.mockResolvedValue({
      success: false,
      message: 'runner refused stop',
    });

    await expect(sessionStopWithServerScope('sid-rejected', { serverId: 'server-b' })).resolves.toEqual({
      success: false,
      message: 'runner refused stop',
      code: 'session_stop_failed',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('uses Stop-specific fallback copy when a rejected runner response has no message', async () => {
    mockSessionRpcWithServerScope.mockResolvedValue({ success: false });

    await expect(sessionStopWithServerScope('sid-rejected-without-message', { serverId: 'server-b' })).resolves.toEqual({
      success: false,
      message: 'Failed to stop session',
      code: 'session_stop_failed',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('returns a typed failure for a malformed runner response', async () => {
    mockSessionRpcWithServerScope.mockResolvedValue(null);

    await expect(sessionStopWithServerScope('sid-malformed-runner', { serverId: 'server-b' })).resolves.toEqual({
      success: false,
      message: 'Failed to stop session',
      code: 'session_stop_failed',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it.each([
    ['auth', Object.assign(new Error('Not authenticated'), { rpcErrorCode: 'NOT_AUTHENTICATED' })],
    ['timeout', Object.assign(new Error('Stop request timed out'), { code: 'MACHINE_RPC_TIMEOUT' })],
    ['disconnect', new Error('Socket disconnected')],
  ])('fails closed for runner %s errors', async (_kind, error) => {
    mockSessionRpcWithServerScope.mockRejectedValue(error);

    await expect(sessionStopWithServerScope('sid-runner-error', { serverId: 'server-b' })).resolves.toEqual({
      success: false,
      message: error.message,
      code: 'session_stop_failed',
    });
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });

  it('fails closed for a current daemon response that violates the strict Stop protocol', async () => {
    mockStorageState.sessions = {
      'sid-protocol-mismatch': {
        active: true,
        metadata: { machineId: 'machine-1', path: '/repo' },
      },
    };
    mockStorageState.machines = {
      'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
    };
    const diagnosticLog = vi.spyOn(log, 'log').mockImplementation(() => {});
    mockMachineRpcWithServerScope.mockResolvedValue({
      status: 'stopped',
      reason: 'unknown_reason',
      unexpected: true,
      detail: 'private response detail must not be logged',
    });

    await expect(sessionStopWithServerScope('sid-protocol-mismatch', { serverId: 'server-b' })).resolves.toEqual({
      success: false,
      message: 'Unsupported response from machine RPC',
      code: 'session_stop_failed',
    });
    expect(mockSessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(diagnosticLog).toHaveBeenCalledWith(expect.stringContaining('"type":"object"'));
    expect(diagnosticLog).toHaveBeenCalledWith(expect.stringContaining('"keys":["detail","reason","status","unexpected"]'));
    expect(diagnosticLog).toHaveBeenCalledWith(expect.stringContaining('"status":"stopped"'));
    expect(diagnosticLog).toHaveBeenCalledWith(expect.stringContaining('"reason":"unknown_reason"'));
    expect(diagnosticLog.mock.calls.flat().join('\n')).not.toContain('private response detail must not be logged');
    expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
  });
});
