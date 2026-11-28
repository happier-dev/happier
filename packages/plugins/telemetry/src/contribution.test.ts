import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { PluginServiceLaunchEnvironmentInputV1 } from '@happier-dev/plugin-sdk';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createLocalCaptureContribution } from './contribution.js';
import { bindLocalCapture } from './launch.js';
import { createCaptureRuntime } from './runtime.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

function input(environment: Record<string, string>): PluginServiceLaunchEnvironmentInputV1 {
 return { workspace: { id: 'worktree', serverId: 'server', machineId: 'machine', rootPath: '/project' }, project: { serverId: 'server', projectId: 'project' },
  serviceId: 'api', requester: { accountId: 'account', installationId: 'install' }, physicalRootIdentity: '/physical/project', executionPlacement: { mode: 'native', machineId: 'machine' }, assignedPorts: {},
  async readEnvironment() { return { projectedEnvironment: environment, provenance: {} }; } };
}
async function listener() {
 const server = createServer(socket => socket.pipe(socket)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener address');
 return { port: address.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
describe('local capture SDK launch contribution', () => {
 it('reads no private environment or listener assignments while off, and rejects another execution machine before reading', async () => {
  const unexpected = () => { throw new Error('Unexpected private environment or listener access'); };
  const original = { ...input({}), readEnvironment: unexpected, requestListenerPorts: unexpected };
  const off = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => false, acquireLocalCapture: unexpected });
  expect(await off.prepare(original)).toEqual({ kind: 'unchanged' });
  const on = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true, acquireLocalCapture: unexpected });
  // A launch with no admitted requester has no owner, so nothing is recorded for anyone.
  expect(await on.prepare({ ...original, requester: undefined })).toEqual({ kind: 'unchanged' });
  expect(await on.prepare({ ...original, executionPlacement: { mode: 'spawn', machineId: 'remote' } })).toMatchObject({ kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'unsupported_execution_placement' });
 });
 it('groups credential-distinct URLs by upstream, binds B assignments, preserves authored OTLP and releases real sockets', async () => {
  const f = createCaptureSqliteFixture();
  const runtime = createCaptureRuntime({ database: f.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
  const upstream = await listener(), slot = await listener(); await slot.close();
  const first = `postgres://u:p%40ss@127.0.0.1:${upstream.port}/db?sslmode=prefer#fragment`;
  const second = `postgres://other:encoded%2F@127.0.0.1:${upstream.port}/other`;
  const environment = { DATABASE_URL: first, READ_URL: second, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector/v1/traces', OTEL_SERVICE_NAME: 'authored', OTEL_RESOURCE_ATTRIBUTES: 'team=local' };
  let reads = 0; const demands: string[][] = [], partitions: string[] = [];
  const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL', 'READ_URL'], readEnabled: scope => { expect(scope).toEqual({ serverId: 'server', machineId: 'machine', projectId: 'project' }); return true; },
   acquireLocalCapture: options => { partitions.push(options.partition); return bindLocalCapture({ ...options, runtime }); } });
  const result = await contribution.prepare({ ...input(environment), async readEnvironment() { reads++; return { projectedEnvironment: environment, provenance: {} }; },
   async requestListenerPorts(keys) { demands.push([...keys]); return { kind: 'ready', assignment: { ports: [], listenerPorts: Object.fromEntries(keys.map(key => [key, slot.port])) } }; } });
  try {
   expect(result.kind).toBe('replace'); if (result.kind !== 'replace') throw new Error('Expected local capture binding');
   expect(reads).toBe(1);
   expect(demands).toEqual([[expect.any(String)]]);
   expect(JSON.stringify(demands)).not.toMatch(/p%40ss|encoded|other/);
   expect(partitions).toEqual([JSON.stringify(['account', 'server', 'machine', 'project', 'worktree'])]);
   expect(result.replacements).toEqual({ DATABASE_URL: first.replace(`127.0.0.1:${upstream.port}`, `127.0.0.1:${slot.port}`), READ_URL: second.replace(`127.0.0.1:${upstream.port}`, `127.0.0.1:${slot.port}`) });
   expect(result.defaults).toEqual({});
   const client = createConnection(slot.port, '127.0.0.1'); await once(client, 'connect'); const response = once(client, 'data'); client.write('relay-ok'); expect((await response)[0].toString()).toBe('relay-ok'); client.destroy();
  } finally { if (result.kind === 'replace') await result.release(); await upstream.close(); f.close(); }
 });
 it('preserves original values on bind and port-owner failures with their native reason', async () => {
  const f = createCaptureSqliteFixture();
  const runtime = createCaptureRuntime({ database: f.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
  const occupied = await listener();
  const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true, acquireLocalCapture: options => bindLocalCapture({ ...options, runtime }) });
  const original = input({ DATABASE_URL: 'postgres://localhost/db', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector' });
  try {
   expect(await contribution.prepare({ ...original, async requestListenerPorts(keys) { return { kind: 'ready', assignment: { ports: [], listenerPorts: Object.fromEntries(keys.map(key => [key, occupied.port])) } }; } })).toMatchObject({
    kind: 'unavailable', reason: 'EADDRINUSE', diagnostic: {
     code: 'telemetry_capture_unavailable', message: expect.stringContaining('listener port is already in use'),
    },
   });
   expect(await contribution.prepare({ ...original, async requestListenerPorts() { return { kind: 'unavailable', code: 'project_worktree_ports_unavailable', reason: 'port_selection_failed' }; } })).toMatchObject({ kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'port_selection_failed' });
  } finally { await occupied.close(); f.close(); }
 });
 it('keeps PostgreSQL forwarding with a typed warning when the OTLP listener cannot bind', async () => {
  const f = createCaptureSqliteFixture();
  const runtime = createCaptureRuntime({ database: f.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
  const upstream = await listener();
  const slot = await listener();
  const occupied = await listener();
  await slot.close();
  const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true,
   acquireLocalCapture: options => bindLocalCapture({ ...options, runtime }) });
  const rebound = createServer();
  let release: (() => Promise<void>) | undefined;
  try {
   const result = await contribution.prepare({ ...input({ DATABASE_URL: `postgres://127.0.0.1:${upstream.port}/db` }),
    async requestListenerPorts(keys) {
     return { kind: 'ready', assignment: { ports: [], listenerPorts: Object.fromEntries(keys.map(key =>
      [key, key === 'otlp' ? occupied.port : slot.port])) } };
    } });
   expect(result.kind).toBe('replace');
   if (result.kind !== 'replace') throw new Error('Expected the working PostgreSQL listener');
   release = result.release;
   expect(result).toMatchObject({ replacements: { DATABASE_URL: `postgres://127.0.0.1:${slot.port}/db` },
    defaults: {}, warning: { kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'EADDRINUSE' } });
   const client = createConnection(slot.port, '127.0.0.1');
   try {
    await once(client, 'connect');
    const response = once(client, 'data');
    client.write('relay-ok');
    expect((await response)[0].toString()).toBe('relay-ok');
   } finally { client.destroy(); }
   await release();
   rebound.listen(slot.port, '127.0.0.1');
   await once(rebound, 'listening');
  } finally {
   if (rebound.listening) await new Promise<void>(resolve => rebound.close(() => resolve()));
   await release?.();
   await occupied.close();
   await upstream.close();
   f.close();
  }
 });
 it.each(['declared', 'authored'] as const)('opens the Worktree OTLP listener with a %s service name', async nameSource => {
  const f = createCaptureSqliteFixture();
  const runtime = createCaptureRuntime({ database: f.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
  const slot = await listener(); await slot.close();
  const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true, acquireLocalCapture: options => bindLocalCapture({ ...options, runtime }) });
  const supplied = { ...input({ OTEL_RESOURCE_ATTRIBUTES: 'team=local', ...(nameSource === 'authored' ? { OTEL_SERVICE_NAME: 'custom' } : {}) }), serviceName: 'web' };
  const result = await contribution.prepare({ ...supplied,
   async requestListenerPorts(keys) { expect(keys).toEqual(['otlp']); return { kind: 'ready', assignment: { ports: [], listenerPorts: { otlp: slot.port } } }; } });
  try {
   expect(result.kind).toBe('replace'); if (result.kind !== 'replace') throw new Error('Expected OTLP listener');
   expect(result.defaults).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${slot.port}`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf', ...(nameSource === 'declared' ? { OTEL_SERVICE_NAME: 'web' } : {}) });
   expect((await fetch(`${result.defaults!.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  } finally { if (result.kind === 'replace') await result.release(); f.close(); }
 });
 it.each([true, false])('retains the Worktree trace when the host admits database findings = %s', async admitted => {
  const f = createCaptureSqliteFixture();
  const upstream = await listener(), postgres = await listener(), otlp = await listener();
  await postgres.close();
  await otlp.close();
  const published: string[] = [];
  let release: (() => Promise<void>) | undefined;
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const runtime = createCaptureRuntime({ database: f.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
   const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true,
    acquireLocalCapture: options => bindLocalCapture({ ...options, runtime, onWorktreeTracesCommitted(traceIds) {
     published.push(...traceIds);
    } }) });
   const result = await contribution.prepare({
    ...input({ DATABASE_URL: `postgres://127.0.0.1:${upstream.port}/db` }),
    async requestListenerPorts(keys) {
     return { kind: 'ready', assignment: { ports: [], listenerPorts: Object.fromEntries(keys.map(key =>
      [key, key === 'otlp' ? otlp.port : postgres.port])) } };
    },
    async readWorktreeDatabaseMembers() {
     return [{ kind: 'worktree', accountId: 'account', installationId: 'install', projectKey: 'project',
      workspace: { serverId: 'server', machineId: 'machine', workspaceId: 'worktree', rootPath: '/project' },
      source: { kind: 'service', serviceId: 'api', variable: 'DATABASE_URL' } }];
    },
    async admitWorktreeDatabaseAutomation() { return admitted; },
   });
   if (result.kind !== 'replace') throw new Error('Expected working Worktree listeners');
   release = result.release;
   expect(result.replacements.DATABASE_URL).toBe(`postgres://127.0.0.1:${postgres.port}/db`);
   const traceId = '0123456789abcdef0123456789abcdef';
   const at = BigInt(Date.now()) * 1_000_000n;
   const response = await fetch(`${result.defaults?.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
     traceId, spanId: '0123456789abcdef', kind: 2, name: 'GET /orders',
     startTimeUnixNano: at.toString(), endTimeUnixNano: (at + 1_000_000n).toString(),
    }] }] }] }),
   });
   expect(response.status).toBe(200);
   const observations = await runtime.store.list({ worktree: JSON.stringify(['account', 'server', 'machine', 'project', 'worktree']),
    traceId, limit: 10 });
   expect(observations).toEqual([expect.objectContaining({ kind: 'span', traceId })]);
   expect(published).toEqual(admitted ? [traceId] : []);
  } finally {
   await release?.();
   await upstream.close();
   f.close();
  }
 });
 it('leaves explicit non-HTTP OTLP transport unchanged before requesting or binding a local listener', async () => {
  const unexpected = () => { throw new Error('Unsupported transport requested local capture'); };
  const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true, acquireLocalCapture: unexpected });
  for (const name of ['OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL']) {
   expect(await contribution.prepare(input({ [name]: 'grpc' }))).toMatchObject({ kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'unsupported_otlp_transport' });
  }
 });
});
