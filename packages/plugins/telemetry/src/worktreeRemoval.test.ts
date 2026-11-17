import { describe, expect, it, vi } from 'vitest';
import type { HostEventEnvelope, HostEvents } from '@happier-dev/plugin-sdk/events';
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
   for (const partition of partitions) await store.rememberWorktree(partition, '/physical/project');
   await store.write(partitions.map(worktree => ({ id: 'event', worktree, kind: 'log' as const, source: 'otlp' as const, at: 1 })));
   expect(await store.worktreePartitions('/physical/project')).toEqual(partitions);
   expect(await store.listPartitions()).toEqual(partitions);
  } finally { f.close(); }
 });
 it('consumes unassociated removal after runtime recreation, clearing exact retained roots and preserving siblings', async () => {
  const f = createCaptureSqliteFixture();
  let receive: ((event: HostEventEnvelope<'@happier/machine/service-observed'>) => void | Promise<void>) | undefined;
  // Authenticated host-event delivery is the boundary; the background owner and SQLite remain real.
  const host = { subscribe(_target: unknown, listener: typeof receive) { receive = listener; return { dispose() { receive = undefined; } }; } } as HostEvents;
  const first = createCaptureBackgroundOwner(), restarted = createCaptureBackgroundOwner();
  const lifetime = new AbortController(), secondLifetime = new AbortController();
  const services = { storage: { daemon: { async database() { return f.db; } } }, events: { host } };
  let running: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
   for (const migration of captureMigrations.filter(migration => migration.version <= 2)) await migration.up(f.db);
   await f.db.execute('INSERT INTO captureSummaries(id,worktree,kind,source,at) VALUES (?,?,?,?,?)', ['legacy', 'unmapped', 'log', 'otlp', 1]);
   await f.db.execute('INSERT INTO captureDetails(id,worktree,at,body) VALUES (?,?,?,?)', ['legacy', 'unmapped', 1, JSON.stringify({ body: 'retained before physical-root capture' })]);
   for (const migration of captureMigrations.filter(migration => migration.version > 2)) await migration.up(f.db);
   running = first.run({ signal: lifetime.signal, services });
   await vi.waitFor(() => expect(first.readRuntime()).not.toBeNull());
   const runtime = first.readRuntime()!;
   for (const partition of ['selected', 'alias', 'sibling']) await first.acquireLocalCapture({
    enabled: true, projectScope: { serverId: 'server', machineId: 'machine', projectId: 'project' }, ownerAccountId: 'account',
    partition, physicalRootIdentity: partition === 'sibling' ? '/physical/project-other' : '/physical/project',
    urls: [], signal: lifetime.signal,
   });
   await runtime.store.write(['selected', 'alias', 'sibling'].map(worktree => ({ id: 'event', worktree, kind: 'log' as const, source: 'otlp' as const, at: 1, detail: { body: worktree } })));
   lifetime.abort(); await running;
   expect(receive).toBeUndefined();
   second = restarted.run({ signal: secondLifetime.signal, services });
   await vi.waitFor(() => expect(receive).toBeTypeOf('function'));
   const event: HostEventEnvelope<'@happier/machine/service-observed'> = { eventId: '@happier/machine/service-observed', scope: { kind: 'account' }, payload: {
    kind: 'worktreeRemoved', serverId: 'server', occurredAt: 1, removal: { workspace: null, project: null, machineId: 'machine', operationId: 'remove', worktreePath: '/physical/project', outcome: 'removed', removalKind: 'retired' },
   } };
   await receive!(event);
   expect(await restarted.readRuntime()!.store.detail('selected', 'event')).toBeNull();
   expect(await restarted.readRuntime()!.store.detail('alias', 'event')).toBeNull();
   expect(await restarted.readRuntime()!.store.detail('sibling', 'event')).toEqual({ body: 'sibling' });
   expect(await restarted.readRuntime()!.store.detail('unmapped', 'legacy')).toEqual({ body: 'retained before physical-root capture' });
   await receive!(event);
   expect(await restarted.readRuntime()!.store.list({ worktree: 'sibling', limit: 10 })).toHaveLength(1);
  } finally { lifetime.abort(); secondLifetime.abort(); await running; await second; f.close(); }
 });
});
