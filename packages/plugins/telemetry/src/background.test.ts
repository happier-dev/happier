import { DatabaseSync } from 'node:sqlite';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { DaemonDatabase, DaemonDatabaseRow, DaemonDatabaseService, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';

describe('local capture background lifecycle', () => {
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
   await expect(owner.acquireLocalCapture({ enabled: true, partition: 'first', urls: [], signal: lifetime.signal, otlpPort: 0 }))
    .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
   production = await owner.acquireRuntime({ signal: serviceLifetime.signal, services: { storage: { daemon: storage } } });
   expect(owner.readRuntime()).toBe(production.runtime);
   settlement = owner.run({ signal: lifetime.signal, services: { storage: { daemon: storage } } });
   await vi.waitFor(() => expect(owner.readRuntime()).toBe(production!.runtime));
   expect(owner.readRuntime()).toBe(production.runtime);
   const first: string[][] = [], other: string[][] = [];
   const offFirst = owner.subscribe('first', keys => first.push([...keys]));
   const offOther = owner.subscribe('other', keys => other.push([...keys]));
   const capture = await vi.waitFor(() => owner.acquireLocalCapture({ enabled: true, projectScope, partition: 'first', urls: [{ name: 'DATABASE_URL', original,
    upstream: { host: '127.0.0.1', port: address.port }, hostSpan: { start: 'postgresql://'.length, end: 'postgresql://'.length + upstreamAuthority.length }, assignedPort: 0 }], signal: serviceLifetime.signal, otlpPort: 0 }));
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
   expect([...new Set(first.flat())]).toEqual(['first']);
   expect(other).toEqual([]);
   await owner.stopProjectCapture({ ...projectScope, projectId: 'other' });
   expect((await fetch(`${capture.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
   await owner.stopProjectCapture(projectScope);
   await expect(fetch(`${capture.endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();
   await echo('disabled-recording');
   lifetime.abort();
   await settlement;
   expect(owner.readRuntime()).toBe(production.runtime);
   const secondProduction = await owner.acquireRuntime({ signal: serviceLifetime.signal, services: { storage: { daemon: storage } } });
   expect(secondProduction.runtime).toBe(production.runtime);
   await secondProduction.release();
   await expect(owner.acquireLocalCapture({ enabled: true, partition: 'first', urls: [], signal: serviceLifetime.signal }))
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
