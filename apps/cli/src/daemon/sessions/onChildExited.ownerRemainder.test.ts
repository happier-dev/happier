import { once } from 'node:events';
import { expect, it, vi } from 'vitest';

import { readProcessCensus } from '@/processes/census/processCensus';
import { spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { createEndOwnerRemainder } from '../processes/endOwnerRemainder';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { createStopSession } from './stopSession';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it('records final runner-exit remainder cleanup for the canonical Stop owner', async () => {
  const tracked: TrackedSession = {
    trackingKey: legacyPidSessionTrackingKey(42), startedBy: 'daemon', pid: 42, happySessionId: 'requested-stop-remainder',
    stopRequestedAtMs: 1,
  };
  const ownerRemainder = {
    capture: vi.fn(),
    captureTree: vi.fn(),
    end: vi.fn(async () => ({ status: 'complete' as const, outcomes: [] })),
    observeEnd: vi.fn(async () => ({ status: 'complete' as const, outcomes: [] })),
  };
  const trackedByPid = new Map([[tracked.trackingKey, tracked]]);
  const onChildExited = createOnChildExited({
    trackedSessionsByKey: trackedByPid,
    ownerRemainder,
    spawnResourceCleanupByKey: new Map(),
    sessionAttachCleanupByKey: new Map(),
    getApiMachineForSessions: () => null,
  });

  await onChildExited(tracked.pid, { reason: 'process-exited', code: 0, signal: null });

  expect(ownerRemainder.end).toHaveBeenCalledOnce();
  expect(tracked.ownerRemainderResult).toEqual({ status: 'complete', outcomes: [] });
});

it.each([false, true])('ends a captured reparented child before staging exit or respawn (replacement=%s)', async replacement => {
  const { parent, childPid } = await spawnInlineNodeParentWithChild();
  try {
    const owner = { kind: 'session', sessionId: 'runner-remainder-lifecycle' } as const;
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid);
    if (!root) throw new Error('Owned runner missing from native census');
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(root.pid), startedBy: 'daemon', pid: root.pid, childProcess: parent,
      happySessionId: owner.sessionId, processStartTimeMs: root.start.startTimeMs };
    const trackedByPid = new Map([[legacyPidSessionTrackingKey(root.pid), tracked]]);
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [{
      owner, pid: root.pid, start: root.start, live: parent.exitCode === null && parent.signalCode === null,
      ownerCreatedAtMs: 0,
    }] });
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
      firstPass: () => {} });
    const phases: string[] = [];
    const assertChildGone = async (phase: string) => {
      const snapshot = await readProcessCensus({ freshness: 'fresh', pids: [childPid] });
      expect(snapshot.status).toBe('ok');
      expect(snapshot.status === 'ok' && snapshot.rows.some(row => row.pid === childPid && row.state !== 'zombie'))
        .toBe(false);
      phases.push(phase);
    };
    tracked.ownerRemainderCapture = await remainder.captureTree(owner, { pid: root.pid, start: root.start });
    expect(tracked.ownerRemainderCapture?.roots.some(row => row.pid === childPid)).toBe(true);
    const onChildExited = createOnChildExited({ trackedSessionsByKey: trackedByPid, ownerRemainder: remainder,
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null,
      removeSessionMarkerFn: async () => { await assertChildGone('stage'); },
      retireSessionRunnerOwnedManagedServices: async () => { await assertChildGone('retire'); },
      onUnexpectedExit: async () => { await assertChildGone('respawn'); },
    });
    const departed = once(parent, 'exit');
    parent.kill('SIGKILL');
    await departed;
    if (replacement) trackedByPid.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: owner.sessionId, startedBy: 'daemon' });
    await onChildExited(root.pid, { reason: 'process-exited', code: null, signal: 'SIGKILL' });
    await assertChildGone('completed');
    expect(phases).toEqual(replacement ? ['stage', 'completed'] : ['stage', 'retire', 'respawn', 'completed']);
    expect(trackedByPid.has(legacyPidSessionTrackingKey(root.pid))).toBe(false);
    expect(await waitForProcessExit(childPid, { timeoutMs: 2000 })).toBe(true);
  } finally {
    parent.kill('SIGKILL');
    try { process.kill(childPid, 'SIGKILL'); } catch { /* only this disposable fixture is cleaned up */ }
  }
}, 15_000);

it('captures the live runner chain and ends its reparented child before requested stop completes', async () => {
  const { parent, childPid } = await spawnInlineNodeParentWithChild();
  const owner = { kind: 'session', sessionId: 'requested-stop-remainder' } as const;
  try {
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid);
    if (!root) throw new Error('Owned runner missing from native census');
    const child = initial.rows.find(row => row.pid === childPid);
    if (!child) throw new Error('Owned child missing from native census');
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(root.pid), startedBy: 'daemon', pid: root.pid, childProcess: parent,
      happySessionId: owner.sessionId, processStartTimeMs: root.start.startTimeMs,
      spawnOptions: { directory: process.cwd(), terminal: { mode: 'plain' } } };
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [{
      owner, pid: root.pid, start: root.start, live: parent.exitCode === null && parent.signalCode === null,
      ownerCreatedAtMs: 0,
    }] });
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
      firstPass: () => {} });
    const departed = once(parent, 'exit');
    const stop = createStopSession({ trackedSessionsByKey: new Map([[legacyPidSessionTrackingKey(root.pid), tracked]]), ownerRemainder: remainder,
      readHostAttachmentState: async () => ({ status: 'absent' }),
      waitForTrackedRunnersExit: async () => { await departed; return true; },
    });
    expect(await stop(owner.sessionId)).toEqual({ status: 'stopped' });
    expect(tracked.ownerRemainderCapture?.scope).toBe('subtree');
    expect(tracked.ownerRemainderCapture?.roots).toContainEqual(expect.objectContaining({ pid: child.pid, start: child.start }));
    const final = await readProcessCensus({ freshness: 'fresh', pids: [childPid] });
    expect(final.status).toBe('ok');
    expect(final.status === 'ok' && final.rows.some(row => row.pid === childPid && row.state !== 'zombie')).toBe(false);
  } finally {
    parent.kill('SIGKILL');
    try { process.kill(childPid, 'SIGKILL'); } catch { /* only this disposable fixture is cleaned up */ }
  }
}, 15_000);
