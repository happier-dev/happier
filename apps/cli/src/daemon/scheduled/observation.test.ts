import { describe, expect, it } from 'vitest';
import { createScheduledObservation } from './observation';
import { createDeferred } from '@/testkit/async/deferred';
import type { ScheduledSource } from './native';

describe('shared Machine Scheduled observation', () => {
  it('reads on presentation, retains rows when push fails, and reattaches only on explicit refresh', async () => {
    let reads = 0;
    let attaches = 0;
    const observation = createScheduledObservation({
      read: async () => { reads++; return [{ source: 'systemd', kind: 'available', jobs: [{ id: 'a', name: 'a', schedule: '@daily' }] }]; },
      subscribe: (_changed, unavailable) => { attaches++; unavailable('systemd', 'watch_native_EACCES'); return () => {}; },
    });
    const request = { serverId: 'h', machineId: 'm', pageSize: 1 };
    try {
      expect(await observation.list(request)).toMatchObject({ sources: [{ kind: 'available', jobs: [{ id: 'a' }], observation: { kind: 'unavailable' } }] });
      await observation.list(request);
      expect(reads).toBe(2);
      expect(attaches).toBe(1);
      await observation.list({ ...request, refresh: true });
      expect(reads).toBe(3);
      expect(attaches).toBe(2);
    } finally { observation.dispose(); }
  });

  it('shares one native read, pages rows, preserves source failures, and reads only on relevant pushes', async () => {
    let reads = 0;
    let changed = () => {};
    let sources: ScheduledSource[] = [{ source: 'system_cron', kind: 'available', jobs: [
      { id: 'a', name: 'a', schedule: '@daily' }, { id: 'b', name: 'b', schedule: '@hourly' },
    ] }, { source: 'systemd', kind: 'unavailable', reason: 'command_missing' }];
    const observation = createScheduledObservation({ read: async () => { reads++; return sources; },
      subscribe: listener => { changed = listener; return () => {}; } });
    const request = { serverId: 'h', machineId: 'm', pageSize: 1 };
    try {
      const [first, concurrent] = await Promise.all([observation.list(request), observation.list(request)]);
      expect(first).toEqual(concurrent);
      expect(first).toMatchObject({ kind: 'snapshot', nextOffset: 1,
        sources: [{ jobs: [{ id: 'a' }] }, { kind: 'unavailable', reason: 'command_missing' }] });
      expect(reads).toBe(1);
      expect(await observation.list({ ...request, offset: 1 })).toMatchObject({ sources: [
        { jobs: [{ id: 'b' }] }, { kind: 'unavailable', reason: 'command_missing' },
      ], nextOffset: null });
      const waiting = observation.watch({ ...request, sinceRevision: first.kind === 'snapshot' ? first.revision : 0 });
      await Promise.resolve();
      sources = [{ source: 'system_cron', kind: 'available', jobs: [{ id: 'c', name: 'c', schedule: '@daily' }] }];
      changed();
      expect(await waiting).toMatchObject({ kind: 'snapshot', sources: [{ jobs: [{ id: 'c' }] }] });
      expect(reads).toBe(3);
      observation.dispose(); changed();
      expect(reads).toBe(3);
    } finally { observation.dispose(); }
  });

  it('cancels a parked read and never scans after disposal', async () => {
    const captured = createDeferred<ScheduledSource[]>();
    let reads = 0;
    let changed = () => {};
    const observation = createScheduledObservation({ read: () => { reads++; return captured.promise; },
      subscribe: listener => { changed = listener; return () => {}; } });
    const request = { serverId: 'h', machineId: 'm', pageSize: 1 };
    const first = observation.list(request);
    captured.resolve([]);
    const initial = await first;
    const cancel = new AbortController();
    const parked = observation.watch({ ...request, sinceRevision: initial.kind === 'snapshot' ? initial.revision : 0 }, cancel.signal);
    cancel.abort();
    expect(await parked).toEqual({ kind: 'unchanged' });
    observation.dispose(); changed();
    expect(reads).toBe(1);
  });
});
