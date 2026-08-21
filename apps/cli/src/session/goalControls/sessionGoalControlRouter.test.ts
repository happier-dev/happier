import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ concurrent: 'preserved' }),
  })),
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));

import { routeSessionGoalControl } from './sessionGoalControlRouter';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function createRawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return {
    id: 'sess_1',
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
    ...overrides,
  } as RawSessionRecord;
}

function createMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machineId: 'machine-local',
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      vendorSessionId: 'thread-1',
    }),
    ...overrides,
  };
}

const ctx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

describe('routeSessionGoalControl', () => {
  beforeEach(() => {
    mocks.updateSessionMetadataWithRetry.mockClear();
    mocks.fetchAccountMachineReplacements.mockReset();
    // The Account genuinely knows both machines and neither replaced the other,
    // so a refusal below is the guard deciding, not an empty chain.
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-local' },
      { id: 'machine-remote' },
    ]);
  });

  it('delegates inactive local set mutations to the provider adapter and persists returned metadata', async () => {
    const rawSession = createRawSession();
    const nextMetadata = {
      machineId: 'machine-local',
      sessionWorkStateV1: { v: 1, items: [], primaryItemId: null, updatedAt: 1 },
    };
    const setGoal = vi.fn(async () => ({
      metadata: nextMetadata,
      workState: nextMetadata.sessionWorkStateV1,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession,
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({
        concurrent: 'preserved',
        sessionWorkStateV1: nextMetadata.sessionWorkStateV1,
      }),
      workState: nextMetadata.sessionWorkStateV1,
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      request: { status: 'paused' },
      cwd: '/repo',
    }));
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      credentials: expect.any(Object),
      sessionId: 'sess_1',
      rawSession,
      updater: expect.any(Function),
    }));
  });

  it('persists only returned goal work-state metadata without clobbering concurrent metadata keys', async () => {
    const rawSession = createRawSession();
    const nextWorkState = { v: 1, items: [], primaryItemId: null, updatedAt: 7 };
    mocks.updateSessionMetadataWithRetry.mockImplementationOnce(async (params: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 3,
      metadata: params.updater({
        concurrent: 'latest',
        unrelatedKey: 'fresh-value',
      }),
    }));
    const setGoal = vi.fn(async () => ({
      metadata: {
        machineId: 'machine-local',
        sessionWorkStateV1: nextWorkState,
        unrelatedKey: 'stale-value',
      },
      workState: nextWorkState,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession,
      metadata: createMetadata({ unrelatedKey: 'original-value' }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toMatchObject({
      metadata: {
        concurrent: 'latest',
        unrelatedKey: 'fresh-value',
        sessionWorkStateV1: nextWorkState,
      },
    });
  });

  it('uses live session RPC without provider delegation when the session is active', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({ ok: true, live: true }));
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc,
      resolveAdapter,
    })).resolves.toEqual({ ok: true, live: true });

    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('falls back to local provider control when an active session live RPC is unavailable', async () => {
    const nextWorkState = { v: 1, items: [], primaryItemId: null, updatedAt: 9 };
    const callLiveSessionRpc = vi.fn(async () => ({
      ok: false,
      errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      error: 'RPC_METHOD_NOT_AVAILABLE',
    }));
    const setGoal = vi.fn(async () => ({
      metadata: createMetadata({ sessionWorkStateV1: nextWorkState }),
      workState: nextWorkState,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc,
      resolveAdapter,
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({ sessionWorkStateV1: nextWorkState }),
      workState: nextWorkState,
    });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      request: { status: 'paused' },
    }));
  });

  // G-4: a transient live-RPC TRANSPORT failure on an ACTIVE session must NOT fall back to the
  // metadata adapter (which would seed a decorative `status:'active'` goal the running session never
  // started pursuing — split-brain). The typed transport error must surface to the caller instead.
  it('surfaces a transport-failure error on an active session WITHOUT seeding a metadata goal', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({
      ok: false,
      errorCode: 'session_rpc_failed',
      error: 'session_rpc_failed',
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { objective: 'pursue the goal' },
      callLiveSessionRpc,
      resolveAdapter,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_rpc_failed',
      error: 'session_rpc_failed',
    });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  // A typed inject failure (`session_goal_control_inject_failed`) is likewise NON-fallback: the
  // running session must own delivery; the router surfaces the failure rather than seeding metadata.
  it('surfaces a typed inject failure on an active session WITHOUT falling back to the adapter', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({
      ok: false,
      errorCode: 'session_goal_control_inject_failed',
      error: 'session_goal_control_inject_failed',
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { objective: 'pursue the goal' },
      callLiveSessionRpc,
      resolveAdapter,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_goal_control_inject_failed',
      error: 'session_goal_control_inject_failed',
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  // Definitive CAPABILITY signals still fall back to the inactive adapter (the live runtime genuinely
  // cannot serve the method), so a stale/no-runtime session can still seed metadata.
  it('still falls back on the unsupported_session_runtime_method capability signal', async () => {
    const nextWorkState = { v: 1, items: [], primaryItemId: null, updatedAt: 13 };
    const callLiveSessionRpc = vi.fn(async () => ({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method',
    }));
    const setGoal = vi.fn(async () => ({
      metadata: createMetadata({ sessionWorkStateV1: nextWorkState }),
      workState: nextWorkState,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { objective: 'pursue the goal' },
      callLiveSessionRpc,
      resolveAdapter,
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalledTimes(1);
  });

  it('returns stable errors without persisting when inactive control lacks local metadata', async () => {
    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: null,
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_goal_control_metadata_unavailable',
      error: 'session_goal_control_metadata_unavailable',
    });

    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('does not delegate or persist remote inactive goal controls', async () => {
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ machineId: 'machine-remote' }),
      metadata: createMetadata({ machineId: 'machine-remote' }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_goal_control_remote_unavailable',
      error: 'session_goal_control_remote_unavailable',
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('delegates inactive goal controls from a stale machine id when the current daemon proves same host and home', async () => {
    const nextWorkState = { v: 1, items: [], primaryItemId: null, updatedAt: 11 };
    const setGoal = vi.fn(async () => ({
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        sessionWorkStateV1: nextWorkState,
      }),
      workState: nextWorkState,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_goal',
      rawSession: createRawSession({
        id: 'sess_stale_goal',
        machineId: 'machine-before-restart',
      }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'LEEROY-MBP.local',
        homeDir: 'C:\\Users\\Leeroy\\',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: 'c:/users/leeroy',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({
        sessionWorkStateV1: nextWorkState,
      }),
      workState: nextWorkState,
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_stale_goal',
      currentMachineId: 'machine-after-restart',
      sessionMachineId: 'machine-before-restart',
    }));
  });

  it('returns stable unsupported results for providers without inactive adapters', async () => {
    const resolveAdapter = vi.fn(async () => null);

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_goal_control_unsupported',
      error: 'session_goal_control_unsupported',
    });

    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('routes inactive get and clear operations through matching adapter methods', async () => {
    const getGoal = vi.fn(async () => ({ metadata: createMetadata({ got: true }) }));
    const clearGoal = vi.fn(async () => ({ metadata: createMetadata({ cleared: true }) }));
    const resolveAdapter = vi.fn(async () => ({ getGoal, clearGoal }));
    const baseParams = {
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain' as const,
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    };

    await routeSessionGoalControl({ ...baseParams, operation: 'get' });
    await routeSessionGoalControl({ ...baseParams, operation: 'clear' });

    expect(getGoal).toHaveBeenCalledTimes(1);
    expect(clearGoal).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });
  /**
   * The user's ruling: replacing a machine must not strand the Sessions the
   * previous one hosted. Nothing re-homes a Session row, so its recorded host
   * stays the PREDECESSOR forever, and the client already picks this daemon as
   * the RPC target by walking the same replacement chain. A replacement is a
   * genuinely new host, so it cannot earn the same-host-home proof.
   */
  it('delegates inactive goal controls for a session whose recorded machine this one replaced', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-new' },
      { id: 'machine-new' },
    ]);
    const setGoal = vi.fn(async () => ({ ok: true }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_replaced_goal',
      rawSession: createRawSession({ id: 'sess_replaced_goal', machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old', host: 'old-laptop', homeDir: '/Users/leeroy' }),
      currentMachineId: 'machine-new',
      currentMachineHost: 'new-laptop',
      currentMachineHomeDir: '/Users/leeroy',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    });

    expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({
      currentMachineId: 'machine-new',
      sessionMachineId: 'machine-old',
    }));
  });

  it('still refuses inactive goal controls when the replacement chain is unreadable', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue(null);
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old' }),
      currentMachineId: 'machine-new',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_goal_control_remote_unavailable',
      error: 'session_goal_control_remote_unavailable',
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
  });
});
