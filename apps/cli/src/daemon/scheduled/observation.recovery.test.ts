import { describe, expect, it } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';
import { createScheduledObservation } from './observation';
import type { ScheduledSource } from './native';

const input = { serverId: 'h', machineId: 'm', pageSize: 1 };
const rows: ScheduledSource[] = [{ source: 'cron', kind: 'available', jobs: [] }];

describe('Scheduled native observation recovery', () => {
  it('never attaches or scans when disposed before the scheduled read starts', async () => {
    let calls = 0;
    const observation = createScheduledObservation({
      read: async () => { calls++; return rows; },
      subscribe: () => { calls++; return () => {}; },
    });
    const pending = observation.list(input);
    observation.dispose();
    await pending;
    expect(calls).toBe(0);
  });

  it('preserves explicit producer reattachment and a fresh read behind an active read', async () => {
    const captured = createDeferred<ScheduledSource[]>();
    const started = createDeferred<void>();
    let reads = 0;
    let attaches = 0;
    const observation = createScheduledObservation({
      read: () => { reads++; started.resolve(); return reads === 1 ? captured.promise : Promise.resolve(rows); },
      subscribe: () => { attaches++; return () => {}; },
    });
    try {
      const first = observation.list(input);
      await started.promise;
      const retry = observation.list({ ...input, refresh: true });
      captured.resolve([]);
      await Promise.all([first, retry]);
      expect(reads).toBe(2);
      expect(attaches).toBe(2);
    } finally { observation.dispose(); }
  });

  it('does not attach recursively when a native producer reports unavailable synchronously', async () => {
    let attaches = 0;
    const observation = createScheduledObservation({
      read: async () => rows,
      subscribe: (_changed, unavailable) => {
        attaches++;
        // The OS watcher can report stat/attachment failure before returning its disposer.
        if (attaches === 2) unavailable('cron', 'watch_native_EACCES');
        return () => {};
      },
    });
    try {
      const first = await observation.list(input);
      const parked = observation.watch({ ...input, sinceRevision: first.kind === 'snapshot' ? first.revision : 0 });
      await Promise.resolve();
      const refreshed = await observation.list({ ...input, refresh: true });
      expect(refreshed).toMatchObject({ sources: [{ observation: { kind: 'unavailable', reason: 'watch_native_EACCES' } }] });
      expect(attaches).toBe(2);
      observation.dispose();
      await parked;
    } finally { observation.dispose(); }
  });
});
