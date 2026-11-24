import { DatabaseSync } from 'node:sqlite';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { DaemonDatabase, DaemonDatabaseRow, DaemonDatabaseService, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

describe('local capture background lifecycle', () => {
 it('binds local OTLP while an earlier capture write is held and indexes subsequent records for removal', async () => {
  const { createCaptureBackgroundOwner } = await import('./background.js');
  const owner = createCaptureBackgroundOwner();
  const fixture = createCaptureSqliteFixture();
  const lifetime = new AbortController();
  const ready = Promise.withResolvers<void>();
  const settlement = owner.run({ signal: lifetime.signal, services: {
   storage: { daemon: { async database(_name, options) {
    for (const migration of options.migrations ?? []) await migration.up(fixture.db);
    return fixture.db;
   } } }, events: { host: { subscribe() { ready.resolve(); return { dispose() {} }; } } },
  } });
  let capture: ReturnType<typeof owner.acquireLocalCapture> | undefined;
  let held: ReturnType<typeof fixture.holdNextCommit> | undefined;
  try {
   await Promise.race([ready.promise, settlement]);
   const runtime = owner.readRuntime()!;
   held = fixture.holdNextCommit();
   runtime.ingest.offer([{ id: 'earlier', worktree: 'other', kind: 'log', source: 'otlp', at: 1 }]);
   await held.entered;
   capture = owner.acquireLocalCapture({ enabled: true, projectScope: { serverId: 'server', machineId: 'machine', projectId: 'project' },
    ownerAccountId: 'account', physicalRootIdentity: '/physical/first', partition: 'first', urls: [], signal: lifetime.signal, otlpPort: 0 });
   const bound = await Promise.race([capture, new Promise<null>(resolve => {
    // Allow actual loopback binding to finish while the transaction remains open.
    const boundary = setTimeout(() => resolve(null), 500);
    void capture!.then(() => clearTimeout(boundary), () => clearTimeout(boundary));
   })]);
   expect(bound, 'OTLP binds while SQLite commit is held').toEqual(expect.objectContaining({ endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) }));
   expect(fixture.statements.filter(sql => sql.startsWith('INSERT INTO captureWorktrees'))).toHaveLength(0);
   const exportLogs = (...messages: string[]) => fetch(`${bound!.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: messages.map(stringValue =>
     ({ timeUnixNano: '1700000000000000000', body: { stringValue } })) }] }] }) });
   expect((await exportLogs('busy writer')).status).toBe(503);
   expect(runtime.ingest.coverage('first')).toEqual({ lostObservations: 0, reason: null });
   held.release();
   await runtime.ingest.settled();
   runtime.ingest.offer([{ id: 'next', worktree: 'other', kind: 'log', source: 'otlp', at: 2 }]);
   await runtime.ingest.settled();
   await runtime.removeWorktree('/physical/first');
   expect(await runtime.store.list({ worktree: 'first', limit: 10 })).toEqual([]);
   expect(runtime.ingest.coverage('first')).toEqual({ lostObservations: 0, reason: null });
   const indexedBefore = fixture.statements.filter(sql => sql.startsWith('INSERT INTO captureWorktrees')).length;
   const response = await exportLogs('first', 'second');
   expect(response.status).toBe(200);
   await runtime.ingest.settled();
   expect(await runtime.store.list({ worktree: 'first', limit: 10 })).toHaveLength(2);
   expect(fixture.statements.filter(sql => sql.startsWith('INSERT INTO captureWorktrees'))).toHaveLength(indexedBefore + 1);
   await runtime.removeWorktree('/physical/first');
   expect(await runtime.store.list({ worktree: 'first', limit: 10 })).toEqual([]);
   expect(await runtime.store.list({ worktree: 'other', limit: 10 })).toHaveLength(2);
   held = fixture.holdNextCommit();
   runtime.ingest.offer([{ id: 'third', worktree: 'other', kind: 'log', source: 'otlp', at: 3 }]);
   await held.entered;
   runtime.observeWire({ kind: 'transaction', id: 'removed-before-flush', connectionId: 'wire',
    startedAt: 3, durationMs: 1, outcome: 'commit', executionIds: [] },
   { partition: 'first', physicalRootIdentity: '/physical/first' });
   expect(runtime.ingest.coverage('first')).toEqual({ lostObservations: 1, reason: 'store_busy' });
   const removed = runtime.removeWorktree('/physical/first');
   held.release();
   await removed;
   expect(runtime.ingest.coverage('first')).toEqual({ lostObservations: 0, reason: null });
   runtime.ingest.offer([{ id: 'fourth', worktree: 'other', kind: 'log', source: 'otlp', at: 4 }]);
   await runtime.ingest.settled();
   expect(await runtime.store.list({ worktree: 'first', limit: 10 })).toEqual([]);
  } finally {
   held?.release();
   if (capture) await capture.then(lease => lease.release(), () => {});
   lifetime.abort();
   await settlement;
   fixture.close();
  }
 });

 it('registers its executable background runner through the public entrypoint', async () => {
  const entrypoint = await import('./index.js');
  expect(entrypoint).toHaveProperty('activate', expect.any(Function));
  const host = await createPluginTestkit({ manifest: entrypoint.manifest, module: entrypoint });
  try { expect(host.registration('backgroundServices', 'local-capture')).toEqual(expect.any(Function)); }
  finally { await host.dispose(); }
 });
 it('stops recording at runner retirement and forwards until the managed service releases its lease', async () => {
  expect(DATABASE_CAPTURE_PLUGIN.manifest.contributes.backgroundServices ?? []).toContainEqual(expect.objectContaining({ id: 'local-capture' }));
  const { createCaptureBackgroundOwner } = await import('./background.js');
  const owner = createCaptureBackgroundOwner();
  const sqlite = new DatabaseSync(':memory:');
  const database: DaemonDatabase = {
   async query<T extends DaemonDatabaseRow>(sql: string, values: readonly DaemonDatabaseValue[] = []) {
    // Real SQLite is the persistence boundary; the public database returns scalar rows.
    return sqlite.prepare(sql).all(...values) as unknown as readonly T[];
   },
   async execute(sql, values = []) { const result = sqlite.prepare(sql).run(...values); return { changes: Number(result.changes) }; },
   async transaction(operation) { sqlite.exec('BEGIN'); try { const result = await operation(database); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  let initialized = false;
  const storage: DaemonDatabaseService = { async database(_name, options) {
   if (!initialized) { initialized = true; for (const migration of options.migrations ?? []) await migration.up(database); }
   await options.incumbentQueryFixture.run(database);
   return database;
  } };
  const lifetime = new AbortController();
  const projectScope = { serverId: 'server', machineId: 'machine', projectId: 'project' };
  const serviceLifetime = new AbortController();
  const upstream = createServer(socket => socket.on('data', bytes => socket.write(bytes)));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('upstream_address_unavailable');
  const upstreamAuthority = `127.0.0.1:${address.port}`;
  const original = `postgresql://${upstreamAuthority}/db`;
  let settlement: Promise<void> | undefined;
  let production: Awaited<ReturnType<typeof owner.acquireRuntime>> | undefined;
  let client: ReturnType<typeof connect> | undefined;
  try {
   expect(owner.readRuntime()).toBeNull();
   await expect(owner.acquireLocalCapture({ enabled: true, projectScope, ownerAccountId: 'account', physicalRootIdentity: '/physical/first', partition: 'first', urls: [], signal: lifetime.signal, otlpPort: 0 }))
    .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
   production = await owner.acquireRuntime({ signal: serviceLifetime.signal, services: { storage: { daemon: storage } } });
   expect(owner.readRuntime()).toBe(production.runtime);
   const ready = Promise.withResolvers<void>();
   settlement = owner.run({ signal: lifetime.signal, services: { storage: { daemon: storage }, events: { host: { subscribe() {
    ready.resolve();
    return { dispose() {} };
   } } } } });
   await Promise.race([ready.promise, settlement]);
   expect(owner.readRuntime()).toBe(production.runtime);
   let first = 0, other = 0;
   const offFirst = owner.subscribe(['first'], () => first++);
   const offOther = owner.subscribe(['other'], () => other++);
   const capture = await owner.acquireLocalCapture({ enabled: true, projectScope, ownerAccountId: 'account', physicalRootIdentity: '/physical/first', partition: 'first', urls: [{ name: 'DATABASE_URL', original,
    upstream: { host: '127.0.0.1', port: address.port }, hostSpan: { start: 'postgresql://'.length, end: 'postgresql://'.length + upstreamAuthority.length }, assignedPort: 0 }], signal: serviceLifetime.signal, otlpPort: 0 });
   const forwarded = new URL(capture.replacements.DATABASE_URL!);
   client = connect({ host: forwarded.hostname, port: Number(forwarded.port) });
   await once(client, 'connect');
   async function echo(value: string) {
    expect(client!.destroyed).toBe(false);
    const received = Promise.race([once(client!, 'data'), once(client!, 'close').then(() => { throw new Error('forwarding_closed'); })]);
    client!.write(value);
    expect((await received)[0].toString()).toBe(value);
   }
   expect(capture.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);
   const response = await fetch(`${capture.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1700000000000000000', body: { stringValue: 'captured' } }] }] }] }) });
   expect(response.status).toBe(200);
   await owner.readRuntime()?.ingest.settled();
   expect(first).toBe(1);
   expect(other).toBe(0);
   await owner.stopProjectCapture({ ...projectScope, projectId: 'other' }, 'account');
   await owner.stopProjectCapture(projectScope, 'another-account');
   expect((await fetch(`${capture.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
   await owner.stopProjectCapture(projectScope, 'account');
   await expect(fetch(`${capture.endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();
   await echo('disabled-recording');
   lifetime.abort();
   await settlement;
   expect(owner.readRuntime()).toBe(production.runtime);
   const secondProduction = await owner.acquireRuntime({ signal: serviceLifetime.signal, services: { storage: { daemon: storage } } });
   expect(secondProduction.runtime).toBe(production.runtime);
   await secondProduction.release();
   await expect(owner.acquireLocalCapture({ enabled: true, projectScope, ownerAccountId: 'account', physicalRootIdentity: '/physical/first', partition: 'first', urls: [], signal: serviceLifetime.signal }))
    .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
   await expect(fetch(`${capture.endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();
   await echo('after-retirement');
   const closed = once(client, 'close');
   await capture.release();
   await closed;
   offFirst(); offOther();
  } finally { serviceLifetime.abort(); lifetime.abort(); client?.destroy(); await settlement; await production?.release(); await new Promise<void>(resolve => upstream.close(() => resolve())); sqlite.close(); }
 });
});
