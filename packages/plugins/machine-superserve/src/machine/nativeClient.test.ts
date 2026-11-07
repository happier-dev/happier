import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSuperserveNativeClient } from './nativeClient.js';

// Superserve OpenAPI 0.1.0, sandbox ee91ea60f1e18e4f09c3a57104582308a1636366.
function vendor(options: { readAccessToken?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'superserve-guest-'));
  const calls: { url: URL; method: string; headers: Headers; body?: Record<string, unknown> }[] = [];
  let present = false, status = 'active', loseCreate = false, failure = false, truncated = false, asyncPause = false;
  let autoDeleteAt: string | undefined;
  const dto = () => ({ id: 'ssb_owned', name: 'happier-managed', status, vcpu_count: 1, memory_mib: 1024,
    created_at: '2026-11-01T00:00:00Z', metadata: { 'happier-managed-id': 'managed' },
    access_token: 'private-guest-token', routing_hint: 'private-route-hint', ...(autoDeleteAt ? { auto_delete_at: autoDeleteAt, auto_delete_seconds: 86400 } : {}) });
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url), method = req.method;
    const bytes = new Uint8Array(await req.arrayBuffer());
    const body = req.headers.get('content-type') === 'application/json' && bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> : undefined;
    calls.push({ url, method, headers: req.headers, body });
    req.signal.throwIfAborted();
    if (failure) return Response.json({ error: { message: 'private-vendor-detail' } }, { status: 503 });
    if (url.origin === 'https://sandbox.superserve.ai') {
      expect(req.headers.get('x-access-token')).toBe('private-guest-token');
      expect(req.headers.get('x-superserve-sandbox-id')).toBe('ssb_owned');
      expect(req.headers.get('x-superserve-routing-hint')).toBe('private-route-hint');
      expect(req.headers.has('x-api-key')).toBe(false);
      if (url.pathname === '/files') {
        const path = url.searchParams.get('path')!;
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
        return Response.json({ path, size: bytes.length });
      }
      if (url.pathname === '/exec') {
        const output = spawnSync(String(body!.command), body!.args as string[], { env: { ...process.env, HOME: home, ...(body!.env as Record<string, string> ?? {}) } });
        return Response.json({ stdout: output.stdout.toString(), stderr: output.stderr.toString(), exit_code: output.status, ...(truncated ? { truncated: true } : {}) });
      }
      throw new Error('Unexpected guest route');
    }
    if (url.pathname === '/sandboxes' && method === 'POST') {
      present = true;
      if (loseCreate) throw new Error('response lost');
      return Response.json(dto(), { status: 201 });
    }
    if (url.pathname === '/sandboxes') return Response.json(present ? [dto()] : []);
    if (url.pathname.endsWith('/activate')) { status = 'active'; return Response.json(dto()); }
    if (url.pathname.endsWith('/resume')) { status = 'active'; return Response.json({ id: 'ssb_owned', status, access_token: 'private-guest-token', routing_hint: 'private-route-hint' }); }
    if (url.pathname.endsWith('/pause')) { status = asyncPause ? 'pausing' : 'paused'; return asyncPause ? Response.json({ status }, { status: 202 }) : new Response(null, { status: 204 }); }
    if (method === 'DELETE') { present = false; return new Response(null, { status: 204 }); }
    return present ? Response.json(options.readAccessToken === false ? { ...dto(), access_token: undefined } : dto()) : Response.json({ error: { code: 'not_found' } }, { status: 404 });
  };
  return { request, calls, home, loseCreate() { loseCreate = true; }, fail() { failure = true; }, truncate() { truncated = true; },
    deferPause() { asyncPause = true; }, setStatus(value: string) { status = value; }, setDeletion(value: string) { autoDeleteAt = value; },
    cleanup() { rmSync(home, { recursive: true, force: true }); } };
}
const launch = { template: 'superserve/base' };
describe('Superserve thin HTTP qualification', () => {
  it.each([true, false])('reads an active diagnostic guest without activating it (read token: %s)', async readAccessToken => {
    const v = vendor({ readAccessToken });
    try {
      const client = createSuperserveNativeClient(v.request), acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing resource');
      const before = v.calls.length;
      const request = { resource: acquired.resource.value, argv: ['true'], allowWake: false as const };
      if (readAccessToken) expect(await client.exec(request)).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
      else await expect(client.exec(request)).rejects.toThrow('superserve_guest_unavailable');
      expect(v.calls.slice(before).some(call => call.url.pathname.endsWith('/activate') || call.url.pathname.endsWith('/resume'))).toBe(false);
      if (!readAccessToken) expect(v.calls.slice(before).every(call => call.method === 'GET')).toBe(true);
    } finally { v.cleanup(); }
  });
  it('recovers the paid identity without repurchase and supplies the shared enrollment carrier', async () => {
    const v = vendor();
    try {
      const client = createSuperserveNativeClient(v.request); v.loseCreate();
      const acquired = await client.acquire(launch, 'managed');
      expect(acquired.kind).toBe('pending');
      if (acquired.kind !== 'pending') throw new Error('Missing retained create');
      const recovered = await client.recover(acquired.nativeOperationRef.value);
      expect(recovered.kind).toBe('bound');
      if (recovered.kind !== 'bound') throw new Error('Missing retained resource');
      expect(await client.bootstrap(recovered.resource.value)).toMatchObject({ kind: 'native', guestHome: { homeDir: v.home, daemonStartup: 'native-process' } });
      expect(v.calls.filter(c => c.method === 'POST' && c.url.pathname === '/sandboxes')).toHaveLength(1);
      expect(v.calls.find(c => c.method === 'POST' && c.url.pathname === '/sandboxes')?.body).toEqual({ name: 'happier-managed', from_template: 'superserve/base', metadata: { 'happier-managed-id': 'managed' }, preview_access: 'private' });
      expect(v.calls.some(c => c.url.searchParams.get('metadata.happier-managed-id') === 'managed')).toBe(true);
      expect(JSON.stringify(recovered)).not.toContain('private-');
    } finally { v.cleanup(); }
  });
  it('preserves bytes, stdin, separate output and nonzero exits and starts the ordinary guest daemon', async () => {
    const v = vendor();
    try {
      const client = createSuperserveNativeClient(v.request), acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing resource');
      const resource = acquired.resource.value, path = join(v.home, "private '雪");
      expect(await client.putFile({ resource, guestPath: path, bytesBase64: 'AP+A', mode: 0o600 })).toEqual({ kind: 'confirmed' });
      expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const output = await client.exec({ resource, argv: ['sh', '-c', 'cat; printf err >&2; exit 17'], inputBase64: Buffer.from('\uFEFF秘密\n').toString('base64'), timeoutMs: 120000 });
      expect(output).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 17 } }, stdoutBase64: Buffer.from('\uFEFF秘密\n').toString('base64'), stderrBase64: Buffer.from('err').toString('base64') });
      expect(v.calls.some(c => c.body?.timeout_s === 120)).toBe(true);
      expect(await client.exec({ resource, argv: ['true'], processConfig: { environment: { HOME: v.home, HAPPIER_HOME_DIR: join(v.home, '.happier') }, detachedDaemonStartArgv: ['sh', '-c', 'printf started > "$HOME/daemon-started"'] } })).toEqual({ kind: 'process-configured' });
      expect(readFileSync(join(v.home, 'daemon-started'), 'utf8')).toBe('started');
    } finally { v.cleanup(); }
  });
  it('retains paused memory/disk, never wakes on inspect, and deletes only on confirmed native evidence', async () => {
    const v = vendor();
    try {
      const client = createSuperserveNativeClient(v.request), acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing resource');
      const resource = acquired.resource.value;
      expect(await client.power(resource, 'suspend')).toEqual({ kind: 'confirmed' });
      const before = v.calls.length;
      expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'suspended', storage: 'retained' });
      expect(v.calls.slice(before).every(c => c.method === 'GET')).toBe(true);
      v.setDeletion('2026-11-03T12:00:00Z');
      expect(await client.inspect(resource)).toMatchObject({ nativeExpiry: Date.parse('2026-11-03T12:00:00Z'), deletionNotices: [{ kind: 'stopped-storage', at: Date.parse('2026-11-03T12:00:00Z'), rule: { kind: 'after-stop', afterMs: 86400000 }, consequence: 'disk-deleted' }] });
      expect(await client.power(resource, 'resume')).toEqual({ kind: 'confirmed' });
      v.deferPause();
      expect(await client.power(resource, 'suspend')).toMatchObject({ kind: 'unknown' });
      expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'unknown', storage: 'unknown' });
      v.setStatus('failed');
      expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'unknown', storage: 'unknown' });
      expect(await client.destroy({ resource })).toEqual({ kind: 'confirmed' });
      expect(await client.inspect(resource)).toMatchObject({ availability: 'absent' });
    } finally { v.cleanup(); }
  });
  it('keeps provider/credential failures unavailable and rejects truncated command envelopes', async () => {
    const v = vendor();
    try {
      const client = createSuperserveNativeClient(v.request), acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing resource');
      v.truncate();
      await expect(client.exec({ resource: acquired.resource.value, argv: ['true'] })).rejects.toThrow('superserve_exec_unconfirmed');
      v.fail();
      expect(await client.check()).toMatchObject({ available: false });
      expect(await client.inspect(acquired.resource.value)).toMatchObject({ availability: 'unavailable' });
      expect(await client.destroy({ resource: acquired.resource.value })).toMatchObject({ kind: 'unknown' });
      expect(JSON.stringify(await client.inspect(acquired.resource.value))).not.toContain('private-');
    } finally { v.cleanup(); }
  });
  it('forwards cancellation, retains uncertain create correlation and submits no retry', async () => {
    const controller = new AbortController(); let calls = 0;
    const request: typeof fetch = async (_url, init) => { calls++; expect(init?.signal).toBe(controller.signal); controller.abort(); throw controller.signal.reason; };
    expect(await createSuperserveNativeClient(request, controller.signal).acquire(launch, 'managed')).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { managedId: 'managed' } } });
    expect(calls).toBe(1);
  });
});
