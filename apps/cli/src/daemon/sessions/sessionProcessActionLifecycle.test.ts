import { describe, expect, it } from 'vitest';
import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { TrackedSession } from '../types';
import { createSessionProcessActionLifecycle } from './sessionProcessActionLifecycle';
import { createStopSession } from './stopSession';
import { createOnChildExited } from './onChildExited';
import { createSessionStopOperationBarrier } from './sessionStopOperationBarrier';

function fixture(prepareStopIntent: (sessionId: string) => Promise<void> = async () => {}) {
  const tracked: TrackedSession = { pid: 300, startedBy: 'daemon', happySessionId: 'session-a',
    processStartTimeMs: 100, vendorResumeId: 'vendor-a', spawnOptions: { directory: '/repo' } };
  const peer: TrackedSession = { ...tracked, pid: 301, happySessionId: 'session-b' };
  const sessions = new Map([[tracked.pid, tracked], [peer.pid, peer]]);
  let spawned = 0;
  const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
    baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, random: () => 0,
    isSessionAlreadyRunning: () => false, spawnSession: async () => { spawned++; return { type: 'success' }; },
    logDebug: () => {}, logWarn: () => {} });
  const lifecycle = createSessionProcessActionLifecycle({ pidToTrackedSession: sessions,
    markStopRequested: respawn.markStopRequested,
    registerPhysicalStopEffect: createSessionStopOperationBarrier().registerPhysicalStopEffect,
    prepareStopIntent,
    stopSession: createStopSession({ pidToTrackedSession: sessions }) });
  return { tracked, peer, sessions, lifecycle, respawn, spawned: () => spawned };
}

describe('Session process Action lifecycle', () => {
  it('keeps automatic Guard cleanup physical without authoring a person Stop hold', async () => {
    const f = fixture(async () => { throw new Error('Guard cleanup must not write person Stop custody'); });
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }],
      actionContext: { surface: 'rpc', authority: 'account_automation', actionCaller: { kind: 'host' } },
    });
    expect(await stamp?.()).toBe(true);
    expect(f.tracked.stopRequestedAtMs).toEqual(expect.any(Number));
    expect(f.tracked.stopRequestedReason).toBeUndefined();
    expect(f.respawn.handleUnexpectedExit(f.tracked, { reason: 'process-exited', code: null, signal: 'SIGKILL' })).toBe('ignored');
  });

  it('keeps custodian cleanup of a guest runner physical without borrowing the guest Account for Stop metadata', async () => {
    const f = fixture(async () => { throw new Error('Machine cleanup cannot borrow the guest Account'); });
    f.tracked.requesterWorkAttributionV1 = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installed' };
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }],
      actionContext: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
      rpcContext: { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId: 'machine',
          installationId: 'installed', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
      },
    });
    expect(await stamp?.()).toBe(true);
    expect(f.tracked.stopRequestedAtMs).toEqual(expect.any(Number));
    expect(f.tracked.stopRequestedReason).toBeUndefined();
    expect(f.respawn.handleUnexpectedExit(f.tracked, { reason: 'process-exited', code: null, signal: 'SIGKILL' })).toBe('ignored');
  });

  it('refuses a process kill when explicit Stop intent cannot be persisted', async () => {
    const f = fixture(async () => { throw new Error('metadata unavailable'); });
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }] });
    expect(await stamp?.()).toBe(false);
    expect(f.tracked.stopRequestedAtMs).toBeUndefined();
    expect(f.respawn.prepareAutomaticResumeAdmission('session-a')()).toBe(true);
  });

  it('stamps only the exact runner in a tree before kill and prevents its actual respawn owner restarting it', async () => {
    const f = fixture();
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 299, start: { startTimeMs: 99 } },
      { pid: 300, start: { startTimeMs: 100 } }] });
    expect(f.tracked.stopRequestedAtMs).toBeUndefined();
    expect(await stamp?.()).toBe(true);
    expect(f.tracked.stopRequestedAtMs).toEqual(expect.any(Number));
    expect(f.tracked.stopRequestedReason).toBe('user_process_kill');
    expect(f.peer.stopRequestedAtMs).toBeUndefined();
    expect(f.respawn.handleUnexpectedExit(f.tracked, { reason: 'process-exited', code: null, signal: 'SIGKILL' })).toBe('ignored');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.spawned()).toBe(0);
  });

  it('refuses a recycled PID, replacement tracked generation, or local cancellation without stamping either owner', async () => {
    const f = fixture();
    expect(await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 101 } }] })).toBeNull();
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }] });
    const replacement = { ...f.tracked };
    f.sessions.set(300, replacement);
    expect(await stamp?.()).toBe(false);
    expect(f.tracked.stopRequestedAtMs).toBeUndefined();
    expect(replacement.stopRequestedAtMs).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    expect(await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }],
      signal: controller.signal })).toBeNull();
  });

  it('retains local cancellation and preserves the first intentional-kill timestamp', async () => {
    const f = fixture();
    const controller = new AbortController();
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }],
      signal: controller.signal });
    expect(await stamp?.()).toBe(true);
    const first = f.tracked.stopRequestedAtMs;
    expect(await stamp?.()).toBe(true);
    expect(f.tracked.stopRequestedAtMs).toBe(first);
    controller.abort();
    expect(await stamp?.()).toBe(false);
  });

  it('does not lend an earlier kill preparation to a newly adopted runner', async () => {
    const f = fixture();
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 302, start: { startTimeMs: 100 } }] });
    const adopted = { ...f.peer, pid: 302 };
    f.sessions.set(302, adopted);
    expect(await stamp?.()).toBe(false);
    expect(adopted.stopRequestedAtMs).toBeUndefined();
  });

  it('refuses same-object PID promotion during the Stop metadata transport', async () => {
    const f = fixture(async () => {
      f.sessions.delete(300);
      f.tracked.pid = 302;
      f.sessions.set(302, f.tracked);
    });
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }] });
    expect(await stamp?.()).toBe(false);
    expect(f.tracked.stopRequestedAtMs).toBeUndefined();
  });

  it('keeps final verification valid after actual exit retirement, but refuses a resumed generation', async () => {
    const f = fixture();
    f.tracked.happySessionId = 'PID-300';
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }] });
    expect(await stamp?.()).toBe(true);
    const exit = createOnChildExited({ pidToTrackedSession: f.sessions,
      spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null, removeSessionMarkerFn: async () => undefined });
    await exit(300, { reason: 'process-exited', code: null, signal: 'SIGKILL' });
    expect(f.sessions.has(300)).toBe(false);
    expect(await stamp?.()).toBe(true);
    f.sessions.set(302, { ...f.tracked, pid: 302, processStartTimeMs: 101, stopRequestedAtMs: undefined,
      stopRequestedReason: undefined });
    expect(await stamp?.()).toBe(false);
  });

  it('refuses cancellation at the existing Action signal boundary without stamping intent', async () => {
    const f = fixture();
    const controller = new AbortController();
    const stamp = await f.lifecycle.prepareKill({ targets: [{ pid: 300, start: { startTimeMs: 100 } }], signal: controller.signal });
    controller.abort();
    expect(await stamp?.()).toBe(false);
    expect(f.tracked.stopRequestedAtMs).toBeUndefined();
  });
});
