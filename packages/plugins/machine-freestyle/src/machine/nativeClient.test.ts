import { PluginError } from '@happier-dev/plugin-sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MachineProvisionerObservationV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createFreestyleNativeClient } from './nativeClient.js';

function vendor() {
  const home = mkdtempSync(join(tmpdir(), 'freestyle-guest-'));
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let present = false, state = 'running', loseCreate = false, failure = false, execFailure = false;
  let autoDeleteSeconds: number | null = null, ttlSeconds: number | null = null;
  const dto = () => ({ id: 'vm-owned', slug: 'happier-managed', state, resources: { cpu: 4, memory: 8192, storage: 32768 },
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', autoDeleteSeconds, ttlSeconds,
    metadata: { 'happier-managed-id': 'managed' } });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body: Record<string, unknown> | undefined = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    init?.signal?.throwIfAborted();
    if (failure) return Response.json({ message: 'private-vendor-secret' }, { status: 503 });
    if (url.pathname === '/v5/vms' && method === 'GET') return Response.json({ vms: [], totalCount: 0, runningCount: 0, startingCount: 0, stoppedCount: 0, pausedCount: 0 });
    if (url.pathname === '/v5/vms' && method === 'POST') {
      present = true;
      if (loseCreate) throw new Error('response lost');
      return Response.json(dto(), { status: 201 });
    }
    if (url.pathname.endsWith('/start')) { state = 'running'; return Response.json(dto()); }
    if (url.pathname.endsWith('/pause')) { state = 'paused'; return Response.json(dto()); }
    if (method === 'DELETE') { present = false; return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith('/fs/write')) {
      writeFileSync(url.searchParams.get('path')!, new Uint8Array(await new Response(init?.body).arrayBuffer()), { mode: Number(url.searchParams.get('mode') ?? 0o600) });
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/exec-await')) {
      if (execFailure) return Response.json({}, { status: 503 });
      const output = spawnSync('sh', ['-c', String(body?.command)], { env: { ...process.env, HOME: home },
        input: typeof body?.stdin === 'string' ? Buffer.from(body.stdin, 'base64') : undefined });
      return Response.json({ statusCode: output.status, stdout: output.stdout.toString(), stderr: output.stderr.toString() });
    }
    return present ? Response.json(dto()) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  };
  return { home, calls, request, setState(value: string) { state = value; }, loseCreate() { loseCreate = true; },
    retention(window: number | null, ttl: number | null = null) { autoDeleteSeconds = window; ttlSeconds = ttl; },
    failExec() { execFailure = true; }, fail() { failure = true; }, cleanup() { rmSync(home, { recursive: true, force: true }); } };
}
const launch = { snapshotId: 'freestyle/ubuntu' };
describe('Freestyle HTTP leaf qualification', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createFreestyleNativeClient(request, new AbortController().signal);
    await expect(client.check()).rejects.toBe(refusal);
  });
  it.each(['start', 'resume'])('confirms native %s without relying on guest execution', async intent => {
    const v = vendor();
    try {
      const client = createFreestyleNativeClient(v.request);
      const acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing native resource');
      v.setState('paused');
      v.failExec();
      const before = v.calls.length;
      expect(await client.power(acquired.resource.value, intent)).toEqual({ kind: 'confirmed' });
      expect(await client.inspect(acquired.resource.value)).toMatchObject({ power: 'running', storage: 'retained' });
      expect(v.calls.slice(before).some(call => call.path.endsWith('/exec-await'))).toBe(false);
    } finally { v.cleanup(); }
  });
  it('enrolls the retained paid identity through the shared guest carrier; lost create recovers without repurchase', async () => {
    const v = vendor();
    try {
      const c = createFreestyleNativeClient(v.request);
      v.loseCreate();
      const a = await c.acquire(launch, 'managed');
      expect(a.kind).toBe('pending');
      if (a.kind !== 'pending') throw new Error('Missing operation');
      const bound = await c.recover(a.nativeOperationRef.value);
      expect(bound.kind).toBe('bound');
      if (bound.kind !== 'bound') throw new Error('Missing resource');
      expect(await c.bootstrap(bound.resource.value)).toMatchObject({ kind: 'native', daemonStartup: 'native-process' });
      expect(v.calls.filter(x => x.path === '/v5/vms' && x.method === 'POST')).toHaveLength(1);
    } finally { v.cleanup(); }
  });
  it('preserves binary guest files/stdin, distinct channels, nonzero status, and host-provided daemon startup', async () => {
    const v = vendor();
    try {
      const c = createFreestyleNativeClient(v.request), a = await c.acquire(launch, 'managed');
      if (a.kind !== 'bound') throw new Error('Missing resource');
      const resource = a.resource.value, path = join(v.home, "private '雪");
      expect(await c.putFile({ resource, guestPath: path, bytesBase64: 'AP+A', mode: 0o600 })).toEqual({ kind: 'confirmed' });
      expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
      expect(await c.exec({ resource, argv: ['sh', '-c', 'cat; printf err >&2; exit 17'], inputBase64: 'AP+A', timeoutMs: 120000 })).toMatchObject({
        termination: { observed: { kind: 'exit', exitCode: 17 } }, stdoutBase64: 'AP+A', stderrBase64: Buffer.from('err').toString('base64') });
      expect(v.calls.find(x => x.path.endsWith('/exec-await'))?.body).toMatchObject({ linuxUser: 'root', timeoutMs: 120000 });
      const daemonHome = join(v.home, '.happier');
      await c.exec({ resource, argv: ['mkdir', '-p', daemonHome] });
      expect(await c.exec({ resource, argv: ['true'], processConfig: { environment: { HOME: v.home, HAPPIER_HOME_DIR: daemonHome },
        detachedDaemonStartArgv: ['sh', '-c', 'printf started >> "$HAPPIER_HOME_DIR/starts"'] } })).toEqual({ kind: 'process-configured' });
      expect(readFileSync(join(daemonHome, 'starts'), 'utf8')).toBe('started');
    } finally { v.cleanup(); }
  });
  it('lets Freestyle apply its documented exec timeout when none is supplied', async () => {
    const v = vendor();
    try {
      const c = createFreestyleNativeClient(v.request), a = await c.acquire(launch, 'managed');
      if (a.kind !== 'bound') throw new Error('Missing resource');
      await c.exec({ resource: a.resource.value, argv: ['true'] });
      expect(v.calls.find(call => call.path.endsWith('/exec-await'))?.body).not.toHaveProperty('timeoutMs');
    } finally { v.cleanup(); }
  });
  it('keeps paused memory/disk and truthful plan deletion rules; start/delete use the same identity', async () => {
    const v = vendor();
    try {
      const c = createFreestyleNativeClient(v.request), a = await c.acquire(launch, 'managed');
      if (a.kind !== 'bound') throw new Error('Missing resource');
      const resource = a.resource.value;
      expect(v.calls.find(x => x.path === '/v5/vms' && x.method === 'POST')?.body).toMatchObject({ autoDeleteSeconds: -1, idleTimeoutSeconds: -1,
        slug: 'happier-managed', firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] } });
      expect(await c.power(resource, 'suspend')).toEqual({ kind: 'confirmed' });
      expect(await c.inspect(resource)).toMatchObject({ availability: 'present', power: 'suspended', storage: 'retained' });
      v.retention(3600);
      const observation = await c.inspect(resource);
      expect(observation).toMatchObject({ deletionNotices: [{ kind: 'stopped-storage', rule: { kind: 'after-stop', afterMs: 3600000 }, consequence: 'disk-deleted' }] });
      expect(observation.deletionNotices?.[0]).not.toHaveProperty('at');
      v.retention(0);
      expect(MachineProvisionerObservationV1Schema.parse(await c.inspect(resource))).toMatchObject({ deletionNotices: [{ rule: { kind: 'after-stop', afterMs: 0 }, consequence: 'disk-deleted' }] });
      expect(await c.power(resource, 'resume')).toEqual({ kind: 'confirmed' });
      expect(await c.destroy({ resource })).toEqual({ kind: 'confirmed' });
      expect(await c.inspect(resource)).toMatchObject({ availability: 'absent' });
      expect(v.calls.filter(x => x.path === '/v5/vms' && x.method === 'POST')).toHaveLength(1);
    } finally { v.cleanup(); }
  });
  it('keeps outages unknown and private vendor details out of outputs; transitional state is not confirmed power', async () => {
    const v = vendor();
    try {
      const c = createFreestyleNativeClient(v.request), a = await c.acquire(launch, 'managed');
      if (a.kind !== 'bound') throw new Error('Missing resource');
      v.setState('starting');
      expect(await c.inspect(a.resource.value)).toMatchObject({ availability: 'present', power: 'unknown' });
      v.fail();
      const check = await c.check(), observation = await c.inspect(a.resource.value), destroyed = await c.destroy({ resource: a.resource.value });
      expect(check).toMatchObject({ available: false }); expect(observation).toMatchObject({ availability: 'unavailable' });
      expect(destroyed).toMatchObject({ kind: 'unknown' });
      expect(JSON.stringify({ check, observation, destroyed })).not.toContain('private-vendor-secret');
    } finally { v.cleanup(); }
  });
  it('forwards cancellation and retains uncertain create without blind retry', async () => {
    const cancel = new AbortController(); let calls = 0;
    const request: typeof fetch = async (_url, init) => { calls++; expect(init?.signal).toBe(cancel.signal); cancel.abort(); throw cancel.signal.reason; };
    expect(await createFreestyleNativeClient(request, cancel.signal).acquire(launch, 'managed')).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { name: 'happier-managed', managedId: 'managed' } } });
    expect(calls).toBe(1);
  });
});
