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
 it('shares one B-assigned listener across concurrent service leases and releases it only at actual last stop',async()=>{
  const f=createCaptureSqliteFixture();for(const migration of captureMigrations)await migration.up(f.db);
  const runtime=createCaptureRuntime({database:f.db,normalizeStatement:createPostgresqlObservationNormalizer(),publish:()=>{}});
  const upstream=await listener(),slot=await listener();await slot.close();
  const controller=new AbortController();
  const original=`postgres://user:p%40ss@127.0.0.1:${upstream.port}/db?sslmode=prefer`;
  const start=original.indexOf('127.0.0.1');const urls=[{name:'DATABASE_URL',original,hostSpan:{start,end:start+`127.0.0.1:${upstream.port}`.length},upstream:{host:'127.0.0.1',port:upstream.port},assignedPort:slot.port}];
  const [first,second]=await Promise.all([bindLocalCapture({enabled:true,partition:'chosen',runtime,urls,signal:controller.signal}),bindLocalCapture({enabled:true,partition:'chosen',runtime,urls,signal:controller.signal})]);
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
   const failed=await bindLocalCapture({enabled:true,partition:'chosen',runtime,urls:[offer],signal});expect(failed.replacements).toEqual({});expect(failed.failures).toMatchObject([{name:'DATABASE_URL',code:'EADDRINUSE'}]);await failed.release();
   const off=await bindLocalCapture({enabled:false,partition:'chosen',runtime,urls:[offer],signal});expect(off.replacements).toEqual({});expect(off.failures).toEqual([]);await off.release();
  }finally{await occupied.close();f.close();}
 });
});
