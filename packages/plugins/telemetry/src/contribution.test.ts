import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { PluginServiceLaunchEnvironmentInputV1 } from '@happier-dev/plugin-sdk';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createLocalCaptureContribution } from './contribution.js';
import { bindLocalCapture } from './launch.js';
import { createCaptureRuntime } from './runtime.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

function input(environment: Record<string, string>): PluginServiceLaunchEnvironmentInputV1 {
 return { workspace: { id: 'worktree', serverId: 'server', machineId: 'machine', rootPath: '/project' }, project: { serverId: 'server', projectId: 'project' },
  serviceId: 'api', physicalRootIdentity: '/physical/project', executionPlacement: { mode: 'native', machineId: 'machine' }, assignedPorts: {},
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
  expect(await on.prepare({ ...original, executionPlacement: { mode: 'spawn', machineId: 'remote' } })).toEqual({ kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'unsupported_execution_placement' });
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
   expect(reads).toBe(1); expect(demands[0]).toHaveLength(1); expect(JSON.stringify(demands)).not.toMatch(/p%40ss|encoded|other/);
   expect(partitions).toEqual([JSON.stringify(['server', 'machine', 'project', 'worktree'])]);
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
   expect(await contribution.prepare({ ...original, async requestListenerPorts(keys) { return { kind: 'ready', assignment: { ports: [], listenerPorts: Object.fromEntries(keys.map(key => [key, occupied.port])) } }; } })).toEqual({ kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'EADDRINUSE' });
   expect(await contribution.prepare({ ...original, async requestListenerPorts() { return { kind: 'unavailable', code: 'project_worktree_ports_unavailable', reason: 'port_selection_failed' }; } })).toEqual({ kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'port_selection_failed' });
  } finally { await occupied.close(); f.close(); }
 });
 it('uses the assigned OTLP listener only when no authored collector exists and supplies missing defaults', async () => {
  const f = createCaptureSqliteFixture();
  const runtime = createCaptureRuntime({ database: f.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
  const slot = await listener(); await slot.close();
  const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true, acquireLocalCapture: options => bindLocalCapture({ ...options, runtime }) });
  const result = await contribution.prepare({ ...input({ OTEL_SERVICE_NAME: 'authored', OTEL_RESOURCE_ATTRIBUTES: 'team=local' }),
   async requestListenerPorts(keys) { expect(keys).toEqual(['otlp']); return { kind: 'ready', assignment: { ports: [], listenerPorts: { otlp: slot.port } } }; } });
  try {
   expect(result.kind).toBe('replace'); if (result.kind !== 'replace') throw new Error('Expected OTLP listener');
   expect(result.defaults).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${slot.port}`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' });
   expect((await fetch(`${result.defaults!.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  } finally { if (result.kind === 'replace') await result.release(); f.close(); }
 });
 it('leaves explicit non-HTTP OTLP transport unchanged before requesting or binding a local listener', async () => {
  const unexpected = () => { throw new Error('Unsupported transport requested local capture'); };
  const contribution = createLocalCaptureContribution({ environmentNames: ['DATABASE_URL'], readEnabled: () => true, acquireLocalCapture: unexpected });
  for (const name of ['OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL']) {
   expect(await contribution.prepare(input({ [name]: 'grpc' }))).toEqual({ kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'unsupported_otlp_transport' });
  }
 });
});
