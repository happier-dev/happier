import { expect, it } from 'vitest';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { TrackedSession } from '../types';
import { resolveSessionReportTrackedCorrelation } from './sessionReportCorrelation';
import { mintSessionTrackingKey } from './sessionTrackingKey';

it.each([3725397, 3725396])('correlates the addressed Session rather than its sibling sharing a runner PID (host %s)', async hostPid => {
  const sessions: TrackedSession[] = ['earlier-session', 'target-session'].map(happySessionId => ({
    trackingKey: mintSessionTrackingKey(), pid: hostPid, sessionRunnerPid: 3725397,
    startedBy: 'daemon', happySessionId,
  }));
  const result = await resolveSessionReportTrackedCorrelation({
    pid: 3725397, sessionId: 'target-session', metadata: createTestMetadata({ startedBy: 'daemon' }),
    trackedSessionsByKey: new Map(sessions.map(item => [item.trackingKey, item])), spawnAwaiterByKey: new Map(),
  });
  expect(result).toEqual({ kind: 'matched', tracked: sessions[1] });
});
