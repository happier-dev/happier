import { describe, expect, it, vi } from 'vitest';
import { MACHINE_WORKTREE_REMOVED_HOST_EVENT_V1, type HostEventEnvelope, type HostEvents } from '@happier-dev/plugin-sdk/events';
import { createCaptureBackgroundOwner } from './background.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureStore } from './store/capture.js';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits, type DaemonDatabase, type DaemonDatabaseRow, type DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

describe('settled worktree removal identity', () => {
 it('keeps every retained partition when a valid root association exceeds one host result page', async () => {
  const f = createCaptureSqliteFixture();
  // Real SQLite rows cross the host's public byte limit before returning to the store.
  const bounded: DaemonDatabase = { ...f.db, async query<T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[] = []) {
   const rows = await f.db.query<T>(statement, params);
   if (Buffer.byteLength(JSON.stringify(rows)) > limits.maximumResultBytes) throw Object.assign(new Error('host result byte limit'), { code: 'daemon_database_result_too_large' });
   return rows;
  } };
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const store = createCaptureStore(bounded, () => {});
   const partitions = Array.from({ length: limits.maximumResultRows + 1 }, (_, index) => `${String(index).padStart(4, '0')}:${'workspace'.repeat(32)}`);
   await store.write(partitions.map(worktree => ({ id: 'event', worktree, physicalRootIdentity: '/physical/project', kind: 'log' as const, source: 'otlp' as const, at: 1 })));
   expect(await store.worktreePartitions('/physical/project')).toEqual(partitions);
   expect(await store.listPartitions()).toEqual(partitions);
  } finally { f.close(); }
 });
 it('consumes unassociated removal after runtime recreation, clearing exact retained roots and preserving siblings', async () => {
  const f = createCaptureSqliteFixture();
  const removalReads: (readonly DaemonDatabaseValue[])[] = [];
  const database: DaemonDatabase = { ...f.db, query<T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[] = []) {
   if (statement.includes('FROM captureWorktrees')) removalReads.push(params);
   return f.db.query<T>(statement, params);
  } };
  type RemovalEvent = HostEventEnvelope<typeof MACHINE_WORKTREE_REMOVED_HOST_EVENT_V1>;
  let receive: ((event: RemovalEvent) => void | Promise<void>) | undefined;
  // Authenticated host-event delivery is the boundary; the background owner and SQLite remain real.
  const host = { subscribe(_target: unknown, listener: typeof receive) { receive = listener; return { dispose() { receive = undefined; } }; } } as HostEvents;
  const first = createCaptureBackgroundOwner(), restarted = createCaptureBackgroundOwner();
  const lifetime = new AbortController(), secondLifetime = new AbortController();
  const services = { storage: { daemon: { async database() { return database; } } }, events: { host } };
  let running: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
   for (const migration of captureMigrations.filter(migration => migration.version <= 2)) await migration.up(f.db);
   await f.db.execute('INSERT INTO captureSummaries(id,worktree,kind,source,at) VALUES (?,?,?,?,?)', ['legacy', 'unmapped', 'log', 'otlp', 1]);
   await f.db.execute('INSERT INTO captureDetails(id,worktree,at,body) VALUES (?,?,?,?)', ['legacy', 'unmapped', 1, JSON.stringify({ body: 'retained before physical-root capture' })]);
   for (const migration of captureMigrations.filter(migration => migration.version > 2)) await migration.up(f.db);
   running = first.run({ signal: lifetime.signal, services });
   await vi.waitFor(() => expect(first.readRuntime()).not.toBeNull());
   const runtime = first.readRuntime()!;
   await runtime.store.write(['selected', 'alias', 'sibling'].map(worktree => ({ id: 'event', worktree,
    physicalRootIdentity: worktree === 'sibling' ? '/physical/project-other' : '/physical/project',
    kind: 'log' as const, source: 'otlp' as const, at: 1, detail: { body: worktree } })));
   lifetime.abort(); await running;
   expect(receive).toBeUndefined();
   second = restarted.run({ signal: secondLifetime.signal, services });
   await vi.waitFor(() => expect(receive).toBeTypeOf('function'));
   const event: RemovalEvent = { eventId: MACHINE_WORKTREE_REMOVED_HOST_EVENT_V1,
    scope: { kind: 'machine' }, payload: { physicalRoot: '/physical/project' } };
   await receive!(event);
   expect(removalReads).toHaveLength(1);
   expect(removalReads[0]).toContain('/physical/project');
   expect(await restarted.readRuntime()!.store.detail('selected', 'event')).toBeNull();
   expect(await restarted.readRuntime()!.store.detail('alias', 'event')).toBeNull();
   expect(await restarted.readRuntime()!.store.detail('sibling', 'event')).toEqual({ body: 'sibling' });
   expect(await restarted.readRuntime()!.store.detail('unmapped', 'legacy')).toEqual({ body: 'retained before physical-root capture' });
   await receive!(event);
   expect(await restarted.readRuntime()!.store.list({ worktree: 'sibling', limit: 10 })).toHaveLength(1);
  } finally { lifetime.abort(); secondLifetime.abort(); await running; await second; f.close(); }
 });
});
