import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from '../types';
import { adoptTrackedSessionRunnerIdentity, bindTrackedSessionIdentity, resolveSessionReportTrackedCorrelation } from './sessionReportCorrelation';
import { serializeWindowsCommandLine } from '../platform/windows/windowsCommandLine';
import type { ChildProcess } from 'node:child_process';
import { legacyPidSessionTrackingKey } from './sessionTrackingKey';

describe('session report parent correlation', () => {
  it('awaits the process-table parent witness before adopting a wrapper child', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(410), pid: 410, startedBy: 'daemon' };
    const result = await resolveSessionReportTrackedCorrelation({
      metadata: { startedBy: 'daemon' } as Metadata,
      pid: 411,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map([[tracked.trackingKey, () => undefined]]),
      // The OS census boundary is asynchronous; the caller must await its witness.
      getParentPidFn: async () => 410,
    });
    expect(result).toEqual({ kind: 'matched', tracked });
  });

  it('does not adopt a wrapper child when the parent witness is unavailable', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(410), pid: 410, startedBy: 'daemon' };
    const result = await resolveSessionReportTrackedCorrelation({
      metadata: { startedBy: 'daemon' } as Metadata,
      pid: 411,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map([[tracked.trackingKey, () => undefined]]),
      getParentPidFn: async () => null,
    });
    expect(result).toEqual({ kind: 'none' });
  });

  it('correlates a tracked wrapper child handle without a readiness waiter', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(410), pid: 410, startedBy: 'daemon',
      // A minimal OS ChildProcess boundary fixture supplies only its captured PID.
      childProcess: { pid: 410 } as ChildProcess };
    const result = await resolveSessionReportTrackedCorrelation({
      metadata: { startedBy: 'daemon' } as Metadata, pid: 411,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: new Map(),
      getParentPidFn: async () => 410,
    });
    expect(result).toEqual({ kind: 'matched', tracked });
  });

  it('binds an exact Windows startup identity without settling readiness', async () => {
    const executablePath = 'C:\\Program Files\\Happier\\happier.exe';
    const argv = ['codex', '--happy-terminal-mode', 'windows_terminal',
      '--happy-terminal-launch-correlation', 'ab'.repeat(16)];
    const terminal: NonNullable<Metadata['terminal']> = { mode: 'windows_terminal', requested: 'windows_terminal',
      windows: { host: 'windows_terminal', windowId: 'happier-cli', title: 'startup' } };
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(8888), pid: 8888, startedBy: 'daemon', happySessionId: 'PID-8888',
      hostedTerminal: terminal, windowsTerminalLaunchCustody: { executablePath, argv, correlation: 'ab'.repeat(16) } };
    const processFact = { pid: 9999, processStartTimeMs: 2000, executablePath,
      command: serializeWindowsCommandLine([executablePath, ...argv]) };
    const readiness = new Map([[tracked.trackingKey, () => { throw new Error('Identity must not wake readiness'); }]]);
    const result = await resolveSessionReportTrackedCorrelation({
      metadata: { startedBy: 'daemon', terminal } as Metadata, pid: 9999,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: readiness,
      // The Windows process table and instance revalidation are real OS boundaries.
      getParentPidFn: async () => null,
      readAllWindowsProcessFactsFn: async () => new Map([[9999, processFact]]),
      readProcessIdentityByPidFn: async () => processFact,
    });
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched' || !('cancellationIdentity' in result)) throw new Error('Missing exact Windows identity');
    expect(bindTrackedSessionIdentity(result.tracked, 'fresh-session')).toBe(true);
    adoptTrackedSessionRunnerIdentity(result.tracked, result.cancellationIdentity);
    expect(tracked.happySessionId).toBe('fresh-session');
    expect(tracked.sessionRunnerPid).toBe(9999);
    expect(tracked.spawnStartupCanonicalSessionId).toBeUndefined();
    expect(readiness.has(tracked.trackingKey)).toBe(true);
    const refused = await resolveSessionReportTrackedCorrelation({
      metadata: { startedBy: 'daemon', terminal } as Metadata, pid: 9999,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: readiness,
      getParentPidFn: async () => null,
      readAllWindowsProcessFactsFn: async () => new Map([[9999, { ...processFact, command: serializeWindowsCommandLine([executablePath, 'codex']) }]]),
      readProcessIdentityByPidFn: async () => processFact,
    });
    expect(refused.kind).toBe('refused');
  });
});
