import { describe, expect, it, vi } from 'vitest';

import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import { createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { hydrateInactiveUsageLimitRecoveryFromSessionMetadata } from './hydrateInactiveUsageLimitRecoveryFromSessionMetadata';

const credentials = {
  token: 'token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array(32),
  },
} as const;

describe('hydrateInactiveUsageLimitRecoveryFromSessionMetadata', () => {
  it('restores pending recovery through the current machine control instead of a captured session snapshot', async () => {
    const recovery = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'limit',
      armedAtMs: 100,
      resetAtMs: 2_000,
      nextCheckAtMs: 2_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native' as const },
    };
    const observe = vi.fn();
    let currentRecovery = recovery;
    const checkCurrentSession = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const fetchSessionsPage = vi.fn(async () => {
      const response = createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'session-1',
          active: false,
          metadata: JSON.stringify({ machineId: 'machine-1', [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: recovery }),
          encryptionMode: 'plain',
        }),
      ]);
      return {
        sessions: response.sessions,
        nextCursor: response.nextCursor ?? null,
        hasNext: response.hasNext ?? false,
      };
    });

    const result = await hydrateInactiveUsageLimitRecoveryFromSessionMetadata({
      credentials,
      currentMachineId: 'machine-1',
      currentMachineHost: 'host.local',
      currentMachineHomeDir: '/Users/example',
      fetchSessionsPage,
      observe,
      runCheckNow: checkCurrentSession,
      fetchSessionById: async () => createSessionRecordFixture({ id: 'session-1', active: false,
        encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1',
          [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: currentRecovery }) }),
    });

    expect(result).toEqual({ scanned: 1, observed: 1 });
    expect(observe).toHaveBeenCalledWith({
      sessionId: 'session-1',
      recovery: { ...recovery, resumePromptMode: 'standard' },
      runCheckNow: expect.any(Function),
    });

    const runCheckNow = observe.mock.calls[0]?.[0]?.runCheckNow as (() => Promise<unknown>) | undefined;
    await expect(runCheckNow?.()).resolves.toEqual({ ok: true, status: 'waiting' });
    currentRecovery = { ...recovery, armedAtMs: recovery.armedAtMs + 1 };
    await expect(runCheckNow?.()).resolves.toMatchObject({ status: 'cancelled' });
    expect(checkCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('skips persisted pending intents whose latest turn is no longer failed', async () => {
    const recovery = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'limit',
      armedAtMs: 100,
      resetAtMs: 2_000,
      nextCheckAtMs: 2_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native' as const },
    };
    const observe = vi.fn();
    const fetchSessionsPage = vi.fn(async () => {
      const response = createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'completed-session',
          active: false,
          metadata: 'completed',
          encryptionMode: 'plain',
          latestTurnStatus: 'completed',
        }),
        createSessionRecordFixture({
          id: 'failed-session',
          active: false,
          metadata: 'failed',
          encryptionMode: 'plain',
          latestTurnStatus: 'failed',
        }),
        createSessionRecordFixture({
          id: 'unknown-turn-session',
          active: false,
          metadata: 'unknown',
          encryptionMode: 'plain',
        }),
      ]);
      return {
        sessions: response.sessions,
        nextCursor: response.nextCursor ?? null,
        hasNext: response.hasNext ?? false,
      };
    });

    const result = await hydrateInactiveUsageLimitRecoveryFromSessionMetadata({
      credentials,
      currentMachineId: 'machine-1',
      currentMachineHost: 'host.local',
      currentMachineHomeDir: '/Users/example',
      fetchSessionsPage,
      decryptMetadata: () => ({
        machineId: 'machine-1',
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: recovery,
      }),
      observe,
      runCheckNow: async () => ({ ok: true, status: 'waiting' }),
    });

    expect(result).toEqual({ scanned: 3, observed: 2 });
    const observedSessionIds = observe.mock.calls.map((call) => call[0]?.sessionId);
    expect(observedSessionIds).toEqual(['failed-session', 'unknown-turn-session']);
  });

  it('skips active sessions and terminal recovery intents', async () => {
    const observe = vi.fn();
    const fetchSessionsPage = vi.fn(async () => {
      const response = createSessionListResponseFixture([
        createSessionRecordFixture({ id: 'active-session', active: true, metadata: 'active', encryptionMode: 'plain' }),
        createSessionRecordFixture({ id: 'cancelled-session', active: false, metadata: 'cancelled', encryptionMode: 'plain' }),
      ]);
      return {
        sessions: response.sessions,
        nextCursor: response.nextCursor ?? null,
        hasNext: response.hasNext ?? false,
      };
    });

    const result = await hydrateInactiveUsageLimitRecoveryFromSessionMetadata({
      credentials,
      currentMachineId: 'machine-1',
      currentMachineHost: 'host.local',
      currentMachineHomeDir: '/Users/example',
      fetchSessionsPage,
      decryptMetadata: ({ rawSession }) => ({
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          v: 1,
          status: rawSession.active ? 'waiting' : 'cancelled',
          issueFingerprint: 'limit',
          armedAtMs: 100,
          resetAtMs: 2_000,
          nextCheckAtMs: 2_000,
          attemptCount: 0,
          maxAttempts: 3,
          lastProbeError: null,
          selectedAuth: { kind: 'native' },
        },
      }),
      observe,
      runCheckNow: async () => ({ ok: true, status: 'waiting' }),
    });

    expect(result).toEqual({ scanned: 2, observed: 0 });
    expect(observe).not.toHaveBeenCalled();
  });

  it('restores an untimed generic wait but leaves account-owned recovery with its existing scheduler', async () => {
    const observed: string[] = [];
    const sessions = ['untimed', 'account-owned'].map((kind) => createSessionRecordFixture({
      id: kind,
      active: false,
      latestTurnStatus: 'failed',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          v: 1,
          status: 'waiting',
          issueFingerprint: 'limit',
          armedAtMs: 100,
          resetAtMs: null,
          nextCheckAtMs: null,
          attemptCount: 0,
          maxAttempts: 3,
          lastProbeError: null,
          selectedAuth: { kind: 'native' },
          ...(kind === 'account-owned' ? { runtimeAuthRecoveryAttemptId: 'auth-attempt' } : {}),
        },
      }),
    }));
    await hydrateInactiveUsageLimitRecoveryFromSessionMetadata({
      credentials,
      currentMachineId: 'machine-1',
      currentMachineHost: 'host.local',
      currentMachineHomeDir: '/Users/example',
      fetchSessionsPage: async () => ({ sessions, nextCursor: null, hasNext: false }),
      observe: ({ sessionId }) => { observed.push(sessionId); },
      runCheckNow: async () => ({ ok: true, status: 'waiting' }),
    });
    expect(observed).toEqual(['untimed']);
  });
});
