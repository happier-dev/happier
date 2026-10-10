import { describe, expect, it, vi } from 'vitest';

import { probeSessionRunnerPresence as readRunnerPresence } from '../sessions/isSessionRunnerActive';

import { readProcessIdentityByPid } from '../processIdentity';
import { resolveExistingSessionAttachContext } from '../sessionEncryption/resolveExistingSessionAttachContext';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { TrackedSession } from '../types';
import { serializeWindowsCommandLine } from '../platform/windows/windowsCommandLine';

vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionByIdCompat: vi.fn() }));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 })),
}));

import { resolveExistingSessionSpawnPreGate } from './resolveExistingSessionSpawnPreGate';

async function observeRunnerPresence(sessionId: string, present: boolean) {
  return await readRunnerPresence({
    sessionId, trackedSessions: [],
    readSessionRunnerLockStatus: async () => present
      ? { ok: true, lock: { sessionId, pid: 91234, acquiredAtMs: 1 } }
      : { ok: false, reason: 'not_found' },
    readProcessRunState: async () => 'servable',
  });
}

function serializeLogCalls(calls: readonly unknown[][]): string {
  return JSON.stringify(calls, (_key, value) => value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value);
}

describe('resolveExistingSessionSpawnPreGate', () => {
  it('fences a restart survivor before activity probing and admits one replacement after retirement', async () => {
    const probeSessionRunnerPresence = vi.fn(async (sessionId: string) => await observeRunnerPresence(sessionId, false));
    const onAlreadyRunning = vi.fn(async () => ({ action: 'use_existing' as const }));
    const pidToTrackedSession = new Map([[
      85855,
      {
        pid: 85855,
        startedBy: 'daemon' as const,
        happySessionId: 'sess-restart-unavailable',
        reattachedFromDiskMarker: true,
        agentRuntimeRunnerRestartDisposition: 'runner_authority_unavailable' as const,
      },
    ]]);

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-restart-unavailable',
      pidToTrackedSession,
      probeSessionRunnerPresence,
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug: vi.fn(), logWarn: vi.fn(),
      onAlreadyRunning,
    });

    expect(resolved.shortCircuitResult).toMatchObject({
      type: 'error',
      errorMessage: expect.stringContaining('restart'),
    });
    expect(probeSessionRunnerPresence).not.toHaveBeenCalled();
    expect(onAlreadyRunning).not.toHaveBeenCalled();

    pidToTrackedSession.delete(85855);
    await expect(resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-restart-unavailable',
      pidToTrackedSession,
      probeSessionRunnerPresence,
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug: vi.fn(), logWarn: vi.fn(),
      onAlreadyRunning,
    })).resolves.toEqual({ shortCircuitResult: null });
    expect(probeSessionRunnerPresence).toHaveBeenCalledWith('sess-restart-unavailable');
    expect(onAlreadyRunning).not.toHaveBeenCalled();
  });

  it('returns the already-running existing session before spawning a new attach process', async () => {
    const probeSessionRunnerPresence = vi.fn(async (sessionId: string) => await observeRunnerPresence(sessionId, true));
    const logDebug = vi.fn();
    const onAlreadyRunning = vi.fn(async () => {});
    const privateSessionId = 'private-existing-session-sentinel';

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: privateSessionId,
      pidToTrackedSession: new Map(),
      probeSessionRunnerPresence,
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug, logWarn: logDebug,
      onAlreadyRunning,
    });

    expect(resolved).toEqual({
      shortCircuitResult: {
        type: 'success',
        sessionId: privateSessionId,
      },
    });
    expect(probeSessionRunnerPresence).toHaveBeenCalledWith(privateSessionId);
    expect(onAlreadyRunning).toHaveBeenCalledWith(privateSessionId);
    expect(serializeLogCalls(logDebug.mock.calls)).not.toContain(privateSessionId);
  });

  it('fences unavailable process evidence without logging private probe details', async () => {
    const privateSessionId = 'private-probe-session-sentinel';
    const privateProbeError = 'private-probe-error-sentinel';
    const logDebug = vi.fn();

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: privateSessionId,
      pidToTrackedSession: new Map(),
      probeSessionRunnerPresence: async () => await readRunnerPresence({
        sessionId: privateSessionId, trackedSessions: [],
        readSessionRunnerLockStatus: async () => { throw new Error(privateProbeError); },
      }),
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug, logWarn: logDebug,
    });

    expect(resolved.shortCircuitResult).toMatchObject({ type: 'error' });
    const serializedLogs = serializeLogCalls(logDebug.mock.calls);
    expect(serializedLogs).not.toContain(privateSessionId);
    expect(serializedLogs).not.toContain(privateProbeError);
  });

  it('continues to replacement spawn when the already-running hook reports an unservable runner', async () => {
    const activeStates = [true, true, false];
    const probeSessionRunnerPresence = vi.fn(async (sessionId: string) => await observeRunnerPresence(sessionId, activeStates.shift() ?? false));
    const logDebug = vi.fn();
    const onAlreadyRunning = vi.fn(async () => ({
      action: 'wait_for_exit' as const,
      timeoutResult: {
        type: 'error' as const,
        errorCode: 'UNEXPECTED' as const,
        errorMessage: 'runner remained unresponsive',
      },
    }));

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-live',
      pidToTrackedSession: new Map(),
      probeSessionRunnerPresence,
      waitForExitTimeoutMs: 100,
      waitForExitPollIntervalMs: 1,
      logDebug, logWarn: logDebug,
      onAlreadyRunning,
    });

    expect(resolved).toEqual({ shortCircuitResult: null });
    expect(onAlreadyRunning).toHaveBeenCalledWith('sess-live');
    expect(probeSessionRunnerPresence).toHaveBeenCalledTimes(3);
  });

  it('keeps fencing when an unresponsive runner remains alive through the canonical wait budget', async () => {
    const timeoutResult = {
      type: 'error' as const,
      errorCode: 'UNEXPECTED' as const,
      errorMessage: 'runner remained unresponsive',
    };

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-live',
      pidToTrackedSession: new Map(),
      probeSessionRunnerPresence: vi.fn(async (sessionId: string) => await observeRunnerPresence(sessionId, true)),
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 1,
      logDebug: vi.fn(), logWarn: vi.fn(),
      onAlreadyRunning: vi.fn(async () => ({ action: 'wait_for_exit' as const, timeoutResult })),
    });

    expect(resolved).toEqual({ shortCircuitResult: timeoutResult });
  });
});


describe('existing-session process evidence admission', () => {
  it('fences Resume when an existing runner lock cannot establish process presence', async () => {
    const sessionId = 'sess-unproven-runner';
    const processEvidence = {
      sessionId, trackedSessions: [],
      readSessionRunnerLockStatus: async () => ({
        ok: true as const, lock: { sessionId, pid: 91234, acquiredAtMs: 1 },
      }),
      readProcessRunState: async () => { throw new Error('OS process evidence unavailable'); },
    };
    const admission = {
      existingSessionId: sessionId, pidToTrackedSession: new Map(),
      probeSessionRunnerPresence: async () => await readRunnerPresence(processEvidence),
      waitForExitTimeoutMs: 0, waitForExitPollIntervalMs: 1, logDebug: vi.fn(), logWarn: vi.fn(),
    };
    const result = await resolveExistingSessionSpawnPreGate(admission);
    expect(result.shortCircuitResult).toMatchObject({ type: 'error' });
  });
});


describe('pending fresh runner admission before its webhook', () => {
  it.each(['current', 'stale', 'legacy', 'other_machine', 'other_home', 'unknown', 'stopped', 'dead', 'retired'] as const)('uses %s generation evidence without completing startup readiness', async (generation) => {
    const sessionId = 'sess-published-before-webhook';
    const identity = await readProcessIdentityByPid(process.pid);
    if (identity?.processStartTimeMs === undefined) throw new Error('Test requires OS generation evidence');
    const tracked: TrackedSession = {
      pid: process.pid, startedBy: 'daemon',
      processStartTimeMs: identity.processStartTimeMs,
      spawnOptions: { directory: '/tmp' },
    };
    const trackedSessions = new Map([[process.pid, tracked]]);
    const waiter = vi.fn();
    const awaiters = new Map([[process.pid, waiter]]);
    const readProcessRunState = async () => {
      if (generation === 'unknown') throw new Error('OS evidence unavailable');
      if (generation === 'stopped') return 'stopped' as const;
      if (generation === 'dead') return 'dead' as const;
      return 'servable' as const;
    };
    const evidence = {
      sessionId, trackedSessions: trackedSessions.values(), readProcessRunState,
      readSessionRunnerLockStatus: async () => ({ ok: false as const, reason: 'not_found' as const }),
    };
    const metadata = {
      path: '/tmp', hostPid: process.pid, machineId: generation === 'other_machine' ? 'other-machine' : 'machine-startup',
      startedBy: 'daemon', happyHomeDir: generation === 'other_home' ? '/other-home' : '/tmp/startup-home',
      ...(generation === 'legacy' ? {} : {
        hostProcessStartTimeMs: identity.processStartTimeMs + (generation === 'stale' ? 1 : 0),
      }),
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify(metadata), dataEncryptionKey: null,
    }));
    const admission = {
      existingSessionId: sessionId, pidToTrackedSession: trackedSessions,
      probeSessionRunnerPresence: async () => await readRunnerPresence({ ...evidence, trackedSessions: trackedSessions.values() }),
      waitForExitTimeoutMs: 0, waitForExitPollIntervalMs: 1, logDebug: vi.fn(), logWarn: vi.fn(),
      pendingSessionStartup: {
        pidToAwaiter: awaiters, machineId: 'machine-startup', happyHomeDir: '/tmp/startup-home',
        readProcessRunState, readProcessIdentityByPid,
        readSessionMetadata: async (id: string) => {
          const context = await resolveExistingSessionAttachContext({ token: 'test', sessionId: id, credentials: null });
          if (!context.ok) throw new Error(context.reason);
          if (generation === 'retired') trackedSessions.delete(process.pid);
          return context.metadata;
        },
      },
    };
    const result = await resolveExistingSessionSpawnPreGate(admission);
    if (generation === 'current') {
      expect(result.shortCircuitResult).toMatchObject({ type: 'success', sessionId });
      expect(tracked.happySessionId).toBe(sessionId);
    } else if (generation === 'legacy' || generation === 'unknown' || generation === 'stopped') {
      expect(result.shortCircuitResult).toMatchObject({ type: 'error' });
      expect(tracked.happySessionId).toBeUndefined();
    } else {
      expect(result.shortCircuitResult).toBeNull();
      expect(tracked.happySessionId).toBeUndefined();
    }
    expect(awaiters.has(process.pid)).toBe(true);
    expect(waiter).not.toHaveBeenCalled();
    expect(tracked.spawnStartupCanonicalSessionId).toBeUndefined();
  });
});


describe('pending Windows Terminal runner admission after dispatcher exit', () => {
  it.each(['current', 'stale', 'unknown', 'stopped', 'dead'] as const)('uses exact %s runner evidence rather than the closed dispatcher', async (caseName) => {
    const sessionId = 'sess-windows-before-webhook';
    const hostPid = 681001;
    const runnerPid = 681002;
    const executablePath = 'C:\\Program Files\\Happier\\happier.exe';
    const correlation = 'ab'.repeat(16);
    const argv = ['codex', '--happy-terminal-mode', 'windows_terminal', '--happy-terminal-launch-correlation', correlation];
    const terminal = {
      mode: 'windows_terminal' as const, requested: 'windows_terminal' as const,
      windows: { host: 'windows_terminal' as const, pid: hostPid, windowId: 'happier-test', title: 'Happier test' },
    };
    const tracked: TrackedSession = {
      pid: hostPid, startedBy: 'daemon', happySessionId: 'PID-' + hostPid,
      spawnOptions: { directory: '/tmp' }, hostedTerminal: terminal,
      windowsTerminalLaunchCustody: { executablePath, argv, correlation },
    };
    const sessions = new Map([[hostPid, tracked]]);
    const waiter = vi.fn();
    const awaiters = new Map([[hostPid, waiter]]);
    const fact = {
      pid: runnerPid, executablePath, command: serializeWindowsCommandLine([executablePath, ...argv]),
      processStartTimeMs: caseName === 'stale' ? 3_000 : 2_000,
    };
    const readIdentity = async (pid: number) => pid === runnerPid ? fact : null;
    const readState = async (pid: number) => {
      if (pid === hostPid || caseName === 'dead') return 'dead' as const;
      if (caseName === 'unknown') throw new Error('OS unavailable');
      if (caseName === 'stopped') return 'stopped' as const;
      return 'servable' as const;
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({
        path: '/tmp', hostPid: runnerPid, hostProcessStartTimeMs: 2_000,
        machineId: 'machine-windows', happyHomeDir: '/tmp/windows-home', startedBy: 'daemon', terminal,
      }),
    }));
    const result = await resolveExistingSessionSpawnPreGate({
      existingSessionId: sessionId, pidToTrackedSession: sessions,
      probeSessionRunnerPresence: async () => await readRunnerPresence({
        sessionId, trackedSessions: sessions.values(), readProcessRunState: readState,
        readProcessIdentityByPid: readIdentity,
        readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      }),
      waitForExitTimeoutMs: 0, waitForExitPollIntervalMs: 1, logDebug: vi.fn(), logWarn: vi.fn(),
      pendingSessionStartup: {
        pidToAwaiter: awaiters, machineId: 'machine-windows', happyHomeDir: '/tmp/windows-home',
        readProcessRunState: readState, readProcessIdentityByPid: readIdentity,
        readAllWindowsProcessFactsFn: async () => new Map([[runnerPid, fact]]),
        readSessionMetadata: async (id) => {
          const context = await resolveExistingSessionAttachContext({ token: 'test', sessionId: id, credentials: null });
          if (!context.ok) throw new Error(context.reason);
          return context.metadata;
        },
      },
    });
    if (caseName === 'current') {
      expect(result.shortCircuitResult).toMatchObject({ type: 'success', sessionId });
      expect(tracked.happySessionId).toBe(sessionId);
    } else if (caseName === 'unknown' || caseName === 'stopped') {
      expect(result.shortCircuitResult).toMatchObject({ type: 'error' });
      expect(tracked.happySessionId).toBe('PID-' + hostPid);
    } else {
      expect(result.shortCircuitResult).toBeNull();
      expect(tracked.happySessionId).toBe('PID-' + hostPid);
    }
    expect(tracked.pid).toBe(hostPid);
    expect(sessions.get(hostPid)).toBe(tracked);
    expect(waiter).not.toHaveBeenCalled();
    expect(awaiters.has(hostPid)).toBe(true);
    expect(tracked.spawnStartupCanonicalSessionId).toBeUndefined();
  });
});


describe('pending ordinary wrapper runner admission', () => {
  it.each(['current', 'stale', 'legacy', 'unknown'] as const)('keeps %s runner generation separate from the dead wrapper', async (caseName) => {
    const identity = await readProcessIdentityByPid(process.pid);
    if (identity?.processStartTimeMs === undefined) throw new Error('Test requires OS generation evidence');
    const wrapperPid = 683001;
    const sessionId = 'sess-wrapper-before-webhook';
    const tracked: TrackedSession = {
      pid: wrapperPid, sessionRunnerPid: process.pid, processStartTimeMs: 1_000,
      startedBy: 'daemon', spawnOptions: { directory: '/tmp' },
    };
    const sessions = new Map([[wrapperPid, tracked]]);
    const waiter = vi.fn();
    const awaiters = new Map([[wrapperPid, waiter]]);
    const readState = async (pid: number) => {
      if (pid === wrapperPid) return 'dead' as const;
      if (caseName === 'unknown') throw new Error('OS evidence unavailable');
      return 'servable' as const;
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({
        path: '/tmp', hostPid: process.pid, startedBy: 'daemon', machineId: 'machine-wrapper', happyHomeDir: '/tmp/wrapper-home',
        ...(caseName === 'legacy' ? {} : { hostProcessStartTimeMs: identity.processStartTimeMs + (caseName === 'stale' ? 1 : 0) }),
      }),
    }));
    const result = await resolveExistingSessionSpawnPreGate({
      existingSessionId: sessionId, pidToTrackedSession: sessions,
      probeSessionRunnerPresence: async () => await readRunnerPresence({
        sessionId, trackedSessions: sessions.values(), readProcessRunState: readState, readProcessIdentityByPid,
        readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      }),
      waitForExitTimeoutMs: 0, waitForExitPollIntervalMs: 1, logDebug: vi.fn(), logWarn: vi.fn(),
      pendingSessionStartup: {
        pidToAwaiter: awaiters, machineId: 'machine-wrapper', happyHomeDir: '/tmp/wrapper-home',
        readProcessRunState: readState, readProcessIdentityByPid,
        readSessionMetadata: async (id) => {
          const context = await resolveExistingSessionAttachContext({ token: 'test', sessionId: id, credentials: null });
          if (!context.ok) throw new Error(context.reason);
          return context.metadata;
        },
      },
    });
    if (caseName === 'current') {
      expect(result.shortCircuitResult).toMatchObject({ type: 'success', sessionId });
      expect(tracked.happySessionId).toBe(sessionId);
    } else if (caseName === 'legacy' || caseName === 'unknown') {
      expect(result.shortCircuitResult).toMatchObject({ type: 'error' });
      expect(tracked.happySessionId).toBeUndefined();
    } else {
      expect(result.shortCircuitResult).toBeNull();
      expect(tracked.happySessionId).toBeUndefined();
    }
    expect(tracked.pid).toBe(wrapperPid);
    expect(tracked.processStartTimeMs).toBe(1_000);
    expect(awaiters.has(wrapperPid)).toBe(true);
    expect(waiter).not.toHaveBeenCalled();
    expect(tracked.spawnStartupCanonicalSessionId).toBeUndefined();
  });
});
