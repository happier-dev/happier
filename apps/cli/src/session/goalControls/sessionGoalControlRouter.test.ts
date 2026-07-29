import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { buildCodexAgentRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptor } from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';

const mocks = vi.hoisted(() => ({
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ concurrent: 'preserved' }),
  })),
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
      providerSessionId: 'thread-1',
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

  // G-4: a transient live-RPC TRANSPORT failure on an ACTIVE session must NOT fall back to the
  // metadata adapter. Falling back would seed a decorative `status:'active'` goal the running
  // session never started pursuing (`/goal` never reached the provider) — a metadata↔runtime
  // split-brain. The typed transport error must surface to the caller instead.
  it('surfaces a transport-failure error on an active session WITHOUT seeding a metadata goal', async () => {
    const transportError = { ok: false, errorCode: 'session_rpc_failed', error: 'session_rpc_failed' };
    const callLiveSessionRpc = vi.fn(async () => transportError);
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
    })).resolves.toEqual(transportError);

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  // A DEFINITIVE capability signal (the runtime genuinely cannot serve the method) still falls back
  // to the inactive metadata adapter — only transport failures are excluded (G-4).
  it('still falls back to the adapter on an active session when the runtime cannot serve the method', async () => {
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
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(async () => ({
        ok: false,
        errorCode: 'unsupported_session_runtime_method',
        error: 'unsupported_session_runtime_method',
      })),
      resolveAdapter,
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({
        sessionWorkStateV1: nextMetadata.sessionWorkStateV1,
      }),
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalled();
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
});
