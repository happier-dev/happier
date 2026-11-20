import { PluginError } from '@happier-dev/plugin-sdk';
import { createUpstashBoxNativeClient } from './nativeClient.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const launch = { runtime: 'node', size: 'small' } as const;
const resource = { boxId: 'box-owned', name: 'happier-managed', managedId: 'managed' };
function vendor() {
  const home = mkdtempSync(join(tmpdir(), 'upstash-guest-'));
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let present = true, status = 'idle', lost = false, unavailable = false, deleting = false;
  const dto = () => ({ id: resource.boxId, name: resource.name, labels: ['happier-managed'], status, runtime: 'node', size: 'small', keep_alive: false, created_at: 1000, updated_at: 2000 });
  const request: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    if (unavailable) return Response.json({ error: 'private-vendor-detail' }, { status: 503 });
    if (url.pathname === '/v2/box' && method === 'GET') return Response.json(url.searchParams.get('label') === 'happier-access-check' ? [] : present ? [dto()] : []);
    if (url.pathname === '/v2/box' && method === 'POST') { present = true; if (lost) throw new Error('response lost'); return Response.json(dto()); }
    if (url.pathname.endsWith('/exec')) {
      if (status === 'paused') status = 'idle';
      const output = spawnSync(body.command[0], body.command.slice(1), { env: { ...process.env, HOME: home } });
      return Response.json({ exit_code: output.status, output: output.stdout.toString(), error: output.stderr.toString() });
    }
    if (url.pathname.endsWith('/files/write')) { mkdirSync(join(body.path, '..'), { recursive: true }); writeFileSync(body.path, Buffer.from(body.content, body.encoding)); return Response.json({}); }
    if (url.pathname.endsWith('/startup')) return Response.json({});
    if (url.pathname.endsWith('/pause')) { status = 'paused'; return Response.json({}); }
    if (url.pathname.endsWith('/resume')) { status = 'idle'; return Response.json({}); }
    if (method === 'DELETE') { if (!deleting) present = false; return Response.json({}); }
    if (url.pathname !== '/v2/box/box-owned' && url.pathname !== '/v2/box/happier-managed') throw new Error('Unexpected vendor path: ' + url.pathname);
    return present ? Response.json(dto()) : Response.json({ error: 'not found' }, { status: 404 });
  };
  return { home, calls, request, dto, loseCreate() { lost = true; }, deferDelete() { deleting = true; }, deleted() { present = false; }, fail() { unavailable = true; }, cleanup() { rmSync(home, { recursive: true, force: true }); } };
}
describe('Upstash Box HTTP qualification', () => {
  it('creates UUID-named resources within the vendor label length contract', async () => {
    const managedId = 'd01a3c52-a353-4ed8-9859-b8a2efc4bdcd';
    const request: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { name: string; labels: string[] };
      // @upstash/box 0.8.0 BoxConfig: at most 20 characters per label.
      if (body.labels.some(value => value.length > 20)) return Response.json({ error: 'label too long' }, { status: 400 });
      return Response.json({ id: 'box-uuid', name: body.name, labels: body.labels, status: 'idle' });
    };
    expect(await createUpstashBoxNativeClient(request).acquire(launch, managedId))
      .toMatchObject({ kind: 'bound', resource: { value: { name: 'happier-' + managedId, managedId } } });
  });
  it('restores prepared artifacts through the native snapshot route with the ordinary managed identity', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) as unknown });
      return Response.json({ id: resource.boxId, name: resource.name, labels: ['happier-managed'], status: 'idle' });
    };
    expect(await createUpstashBoxNativeClient(request).acquire({ ...launch, snapshotId: 'prepared-id' }, 'managed'))
      .toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(calls).toEqual([{ path: '/v2/box/from-snapshot', body: { ...launch, snapshot_id: 'prepared-id',
      name: resource.name, labels: ['happier-managed'], keep_alive: false } }]);
  });
  it('retains a completed allocation body after late cancellation', async () => {
    const abort = new AbortController();
    const bytes = new TextEncoder().encode(JSON.stringify({ id: resource.boxId, name: resource.name, labels: ['happier-managed'], status: 'idle' }));
    const request: typeof fetch = async () => new Response(new ReadableStream({ pull(body) {
      body.enqueue(bytes); body.close(); abort.abort();
    } }));
    expect(await createUpstashBoxNativeClient(request, abort.signal).acquire(launch, 'managed'))
      .toMatchObject({ kind: 'bound', resource: { value: resource } });
  });
  it('cancels before dispatch and keeps incomplete allocation bodies unconfirmed', async () => {
    const abort = new AbortController(); abort.abort(); let calls = 0;
    const request: typeof fetch = async () => { calls++; throw new Error('must not dispatch'); };
    expect(await createUpstashBoxNativeClient(request, abort.signal).acquire(launch, 'managed')).toMatchObject({ kind: 'pending' });
    expect(calls).toBe(0);
    const incomplete: typeof fetch = async () => new Response(new ReadableStream({ start(body) { body.error(new Error('body disconnected')); } }));
    expect(await createUpstashBoxNativeClient(incomplete).acquire(launch, 'managed')).toMatchObject({ kind: 'pending' });
  });

  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createUpstashBoxNativeClient(request, new AbortController().signal);
    await expect(client.check()).rejects.toBe(refusal);
  });
  it('enrolls the retained box through the shared portable native guest carrier', async () => {
    const v = vendor();
    try { expect(await createUpstashBoxNativeClient(v.request).bootstrap(resource)).toMatchObject({ kind: 'native', daemonStartup: 'native-process' }); }
    finally { v.cleanup(); }
  });
  it('preserves raw guest bytes, stdin, separate channels, nonzero status and host-built startup', async () => {
    const v = vendor();
    try {
      const client = createUpstashBoxNativeClient(v.request), path = join(v.home, "private '雪");
      expect(await client.putFile({ resource, guestPath: path, bytesBase64: 'AP+A', mode: 0o600 })).toEqual({ kind: 'confirmed' });
      expect(readFileSync(path)).toEqual(Buffer.from([0,255,128]));
      const input = Buffer.from('\uFEFF秘密\n').toString('base64');
      expect(await client.exec({ resource, argv: ['sh','-c','cat; printf err >&2; exit 17'], inputBase64: input })).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 17 } }, stdoutBase64: input, stderrBase64: 'ZXJy' });
      await client.exec({ resource, argv: ['mkdir','-p',join(v.home,'.happier')] });
      expect(await client.exec({ resource, argv: ['true'], processConfig: { environment: { HOME: v.home, HAPPIER_HOME_DIR: join(v.home,'.happier') }, detachedDaemonStartArgv: ['sh','-c','printf started >> "$HAPPIER_HOME_DIR/starts"'] } })).toEqual({ kind: 'process-configured' });
      expect(readFileSync(join(v.home,'.happier/starts'),'utf8')).toBe('started');
      expect(v.calls.find(c => c.path.endsWith('/startup'))?.body).toMatchObject({ init_command: expect.stringContaining('upstash-box-daemon-start') });
    } finally { v.cleanup(); }
  });
  it('retains paused storage and waits for observed deletion instead of claiming an accepted delete completed', async () => {
    const v = vendor();
    try {
      const client = createUpstashBoxNativeClient(v.request);
      expect(await client.power(resource,'stop')).toEqual({ kind: 'confirmed' });
      expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
      expect(await client.power(resource,'resume')).toEqual({ kind: 'confirmed' });
      v.deferDelete(); const result = await client.destroy({ resource });
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') throw new Error('No retained cleanup');
      expect(await client.cleanup(result.nativeOperationRef.value)).toMatchObject({ kind: 'unknown' });
      v.deleted(); expect(await client.cleanup(result.nativeOperationRef.value)).toEqual({ kind: 'confirmed' });
      expect(v.calls.filter(c=>c.method==='DELETE')).toHaveLength(1);
    } finally { v.cleanup(); }
  });
  it('recovers interrupted create by its captured name and no replacement allocation', async () => {
    const v = vendor();
    try {
      v.loseCreate();const client=createUpstashBoxNativeClient(v.request);const result=await client.acquire(launch,'managed');
      expect(result.kind).toBe('pending');if(result.kind!=='pending')throw new Error('No retained acquisition');
      expect(await client.recover(result.nativeOperationRef.value)).toMatchObject({kind:'bound',resource:{value:resource}});
      expect(v.calls.filter(c=>c.method==='POST'&&c.path==='/v2/box')).toHaveLength(1);
      expect(v.calls[0]?.body).toMatchObject({keep_alive:false,labels:['happier-managed']});
    } finally { v.cleanup(); }
  });
  it('settles vendor failures unavailable, redacts details and never converts uncertainty to absence', async()=>{
    const v=vendor();try {v.fail();const client=createUpstashBoxNativeClient(v.request);
      expect(await client.check()).toMatchObject({available:false});expect(await client.inspect(resource)).toMatchObject({availability:'unavailable'});
      expect(await client.destroy({resource})).not.toMatchObject({kind:'confirmed'});expect(JSON.stringify(await client.inspect(resource))).not.toContain('private-');
    }finally{v.cleanup();}
  });
  it('passes cancellation to fetch and retains an interrupted allocation without retry',async()=>{
    const controller=new AbortController();let calls=0;
    const request:typeof fetch=async(_url,init)=>{calls++;expect(init?.signal).toBe(controller.signal);controller.abort();throw controller.signal.reason;};
    expect(await createUpstashBoxNativeClient(request,controller.signal).acquire(launch,'managed')).toMatchObject({kind:'pending'});expect(calls).toBe(1);
  });
});
