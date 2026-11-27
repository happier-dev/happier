import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { bindLocalCapture } from './launch.js';
import { createCaptureRuntime } from './runtime.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { captureMigrations } from './store/capture.js';
import { createPostgresqlObservationNormalizer } from '../../../databases/src/postgresql/observation.js';
async function listener() {
 const server = createServer(socket => socket.pipe(socket)); server.listen(0,'127.0.0.1'); await once(server,'listening');
 const address=server.address(); if (!address || typeof address==='string') throw new Error('No listener address');
 return {server,port:address.port,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
describe('contribution-time local bindings',()=>{
 it('keeps PostgreSQL traffic addressed to a neighboring database out of the admitted Worktree database', async () => {
  const fixture = createCaptureSqliteFixture();
  for (const migration of captureMigrations) await migration.up(fixture.db);
  const runtime = createCaptureRuntime({ database: fixture.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
  const upstream = createServer(socket => {
   let buffered = Buffer.alloc(0);
   socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.at(-1) === 0 && buffered.includes('SELECT id FROM ')) {
     // CommandComplete followed by ReadyForQuery, as returned by PostgreSQL.
     socket.write(Buffer.from('430000000d53454c4543542031005a0000000549', 'hex'));
    }
   });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const { port } = upstream.address() as Exclude<ReturnType<typeof upstream.address>, string | null>;
  const databaseMember = {
   kind: 'worktree', accountId: 'alice', installationId: 'install', projectKey: 'project',
   workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/workspace' },
   source: { kind: 'service', serviceId: 'web', variable: 'DATABASE_URL' },
  } as const;
  const original = `postgres://user@127.0.0.1:${port}/selected`;
  const lease = await bindLocalCapture({
   enabled: true, partition: 'chosen', physicalRootIdentity: '/workspace', runtime, signal: new AbortController().signal,
   urls: [{ name: 'DATABASE_URL', original, upstream: { host: '127.0.0.1', port }, assignedPort: 0,
    databaseMember, hostSpan: { start: original.indexOf('127.'), end: original.lastIndexOf('/') } }],
  });
  try {
   const proxyPort = Number(new URL(lease.replacements.DATABASE_URL!).port);
   for (const scenario of [
    { database: 'selected', applicationName: 's'.repeat(9_949) },
    { database: 'neighbor' },
    { database: undefined },
    { database: 'oversized', applicationName: 'x'.repeat(9_949) },
   ]) {
    const socket = createConnection(proxyPort, '127.0.0.1');
    try {
     await once(socket, 'connect');
     const databaseParameter = scenario.database ? `database\0${scenario.database}\0` : '';
     const applicationParameter = scenario.applicationName ? `application_name\0${scenario.applicationName}\0` : '';
     const parameters = Buffer.from(`user\0user\0${databaseParameter}${applicationParameter}\0`);
     const startup = Buffer.alloc(8);
     startup.writeInt32BE(startup.length + parameters.length);
     startup.writeInt32BE(196608, 4);
     const query = Buffer.from(`SELECT id FROM ${scenario.database ?? 'unattributed'}_items\0`);
     const queryHeader = Buffer.alloc(5);
     queryHeader.write('Q');
     queryHeader.writeInt32BE(query.length + 4, 1);
     // The startup parameters may straddle the relay's first client chunk.
     socket.write(Buffer.concat([startup, parameters.subarray(0, 3)]));
     const response = once(socket, 'data');
     socket.write(Buffer.concat([parameters.subarray(3), queryHeader, query]));
     await response;
     await runtime.ingest.settled();
    } finally {
     socket.destroy();
    }
   }
   const read = { worktree: 'chosen', kind: 'query', limit: 10 } as const;
   expect((await runtime.store.list(read)).map(item => item.shape).sort())
    .toEqual(['select id from neighbor_items', 'select id from selected_items', 'select id from unattributed_items']);
   expect((await runtime.store.list({ ...read, databaseMember })).map(item => item.shape))
    .toEqual(['select id from selected_items']);
  } finally {
   await lease.release();
   await new Promise<void>(resolve => upstream.close(() => resolve()));
   fixture.close();
  }
 });
 it('shares one B-assigned listener across concurrent service leases and releases it only at actual last stop',async()=>{
  const f=createCaptureSqliteFixture();for(const migration of captureMigrations)await migration.up(f.db);
  const runtime=createCaptureRuntime({database:f.db,normalizeStatement:createPostgresqlObservationNormalizer(),publish:()=>{}});
  const upstream=await listener(),slot=await listener();await slot.close();
  const controller=new AbortController();
  const original=`postgres://user:p%40ss@127.0.0.1:${upstream.port}/db?sslmode=prefer`;
  const start=original.indexOf('127.0.0.1');const urls=[{name:'DATABASE_URL',original,hostSpan:{start,end:start+`127.0.0.1:${upstream.port}`.length},upstream:{host:'127.0.0.1',port:upstream.port},assignedPort:slot.port}];
  const [first,second]=await Promise.all([bindLocalCapture({enabled:true,partition:'chosen',physicalRootIdentity:'/physical/chosen',runtime,urls,signal:controller.signal}),bindLocalCapture({enabled:true,partition:'chosen',physicalRootIdentity:'/physical/chosen',runtime,urls,signal:controller.signal})]);
  try{
   expect(first.failures).toEqual([]);expect(second.failures).toEqual([]);
   expect(first.replacements).toEqual(second.replacements);
   expect(first.replacements.DATABASE_URL).toBe(original.replace(`127.0.0.1:${upstream.port}`,`127.0.0.1:${slot.port}`));
   await first.release();await second.stopRecording();
   const client=createConnection(slot.port,'127.0.0.1');await once(client,'connect');
   const response=once(client,'data');client.write('forwarding-only');expect((await response)[0].toString()).toBe('forwarding-only');client.destroy();
  }finally{await first.release();await second.release();await runtime.ingest.settled();await upstream.close();f.close();}
 });
 it('returns an unavailable bind without changing the original input and disabled capture binds nothing',async()=>{
  const f=createCaptureSqliteFixture();const runtime=createCaptureRuntime({database:f.db,normalizeStatement:createPostgresqlObservationNormalizer(),publish:()=>{}});
  const occupied=await listener();const signal=new AbortController().signal;
  const offer={name:'DATABASE_URL',original:'postgres://localhost/db',hostSpan:{start:11,end:20},upstream:{host:'localhost',port:5432},assignedPort:occupied.port};
  try{
   const failed=await bindLocalCapture({enabled:true,partition:'chosen',physicalRootIdentity:'/physical/chosen',runtime,urls:[offer],signal});expect(failed.replacements).toEqual({});expect(failed.failures).toMatchObject([{name:'DATABASE_URL',code:'EADDRINUSE'}]);await failed.release();
   const off=await bindLocalCapture({enabled:false,partition:'chosen',physicalRootIdentity:'/physical/chosen',runtime,urls:[offer],signal});expect(off.replacements).toEqual({});expect(off.failures).toEqual([]);await off.release();
  }finally{await occupied.close();f.close();}
 });
});
