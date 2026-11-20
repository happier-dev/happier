import { PluginError } from '@happier-dev/plugin-sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaytonaNativeClient } from './nativeClient.js';

function vendor() {
  const home = mkdtempSync(join(tmpdir(), 'daytona-guest-'));
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let present = false, state = 'started', loseCreate = false, failure = false, pendingDelete = false, execFailure = false;
  const dto = () => ({ id: 'sandbox-owned', name: 'happier-managed', state,
    organizationId: 'org-one', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox',
    labels: { 'happier-managed-id': 'managed' }, autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1 });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    if (init?.signal?.aborted) throw init.signal.reason;
    if (failure) return Response.json({ message: 'private-vendor-secret' }, { status: 503 });
    if (url.pathname === '/api/api-keys/current') return Response.json({ name: 'test', organizationId: 'org-one', permissions: ['write:sandboxes', 'delete:sandboxes'] });
    if (url.pathname === '/api/sandbox' && method === 'POST') {
      present = true;
      if (loseCreate) throw new Error('response lost');
      return Response.json(dto());
    }
    if (url.pathname.endsWith('/start')) { state = 'started'; return Response.json(dto()); }
    if (url.pathname.endsWith('/stop')) { state = 'stopped'; return Response.json(dto()); }
    if (method === 'DELETE') {
      if (pendingDelete) { state = 'destroying'; return Response.json(dto()); }
      present = false; return Response.json({ ...dto(), state: 'destroyed' });
    }
    if (url.pathname.endsWith('/files/upload-v2')) {
      writeFileSync(url.searchParams.get('path')!, new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return Response.json({ path: url.searchParams.get('path') });
    }
    if (url.pathname.endsWith('/process/execute')) {
      if (execFailure) return Response.json({}, { status: 503 });
      const output = spawnSync('sh', ['-c', body.command], { env: { ...process.env, HOME: home } });
      return Response.json({ exitCode: output.status, result: output.stdout.toString() + output.stderr.toString() });
    }
    return present ? Response.json(dto()) : Response.json({ message: 'not found' }, { status: 404 });
  };
  return { home, calls, request, dto, setState(value: string) { state = value; }, loseCreate() { loseCreate = true; }, deferDelete() { pendingDelete = true; }, failExec() { execFailure = true; }, fail() { failure = true; }, cleanup() { rmSync(home, { recursive: true, force: true }); } };
}
const launch = { snapshot: 'daytona-small' };
describe('Daytona HTTP leaf qualification', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createDaytonaNativeClient(request, new AbortController().signal);
    await expect(client.check()).rejects.toBe(refusal);
  });
  it('retains an interrupted create identity and forwards cancellation without retrying', async () => {
    const controller = new AbortController();
    let calls = 0;
    const request: typeof fetch = async (_url, init) => {
      calls++;
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw controller.signal.reason;
    };
    const result = await createDaytonaNativeClient(request, controller.signal).acquire(launch, 'managed');
    expect(result).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { name: 'happier-managed', managedId: 'managed' } } });
    expect(calls).toBe(1);
  });
  it('enrolls an existing paid identity through the portable native guest carrier and recovers a lost create without repurchase', async () => {
    const v = vendor();
    try {
      const client = createDaytonaNativeClient(v.request);
      v.loseCreate();
      const acquired = await client.acquire(launch, 'managed');
      expect(acquired.kind).toBe('pending');
      if (acquired.kind !== 'pending') throw new Error('Missing retained operation');
      const recovered = await client.recover(acquired.nativeOperationRef.value);
      expect(recovered.kind).toBe('bound');
      if (recovered.kind !== 'bound') throw new Error('Missing native resource');
      expect(await client.bootstrap(recovered.resource.value)).toMatchObject({ kind: 'native', daemonStartup: 'native-process' });
      expect(v.calls.filter(call => call.path === '/api/sandbox' && call.method === 'POST')).toHaveLength(1);
    } finally { v.cleanup(); }
  });
  it('runs arbitrary guest bytes, stdin, separate output channels and nonzero status through real shell execution', async () => {
    const v = vendor();
    try {
      const client = createDaytonaNativeClient(v.request);
      const acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing native resource');
      const resource = acquired.resource.value;
      const path = join(v.home, "private '雪");
      expect(await client.putFile({ resource, guestPath: path, bytesBase64: 'AP+A', mode: 0o600 })).toEqual({ kind: 'confirmed' });
      expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
      const output = await client.exec({ resource, argv: ['sh', '-c', 'cat; printf err >&2; exit 17'], inputBase64: Buffer.from('\uFEFF秘密\n').toString('base64') });
      expect(output).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 17 } }, stdoutBase64: Buffer.from('\uFEFF秘密\n').toString('base64'), stderrBase64: Buffer.from('err').toString('base64') });
      expect(v.calls.filter(call => call.path.endsWith('/process/execute')).every(call => (call.body as { timeout: number }).timeout === 0)).toBe(true);
    } finally { v.cleanup(); }
  });
  it('preserves stopped storage and confirms power/deletion only from native state; failures stay unavailable', async () => {
    const v = vendor();
    try {
      const client = createDaytonaNativeClient(v.request);
      const acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing native resource');
      const resource = acquired.resource.value;
      expect(v.calls.find(call => call.method === 'POST' && call.path === '/api/sandbox')?.body).toMatchObject({ autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1 });
      const retained = join(v.home, 'retained');
      expect(await client.putFile({ resource, guestPath: retained, bytesBase64: 'AP+A' })).toEqual({ kind: 'confirmed' });
      const daemonHome = join(v.home, '.happier');
      await client.exec({ resource, argv: ['mkdir', '-p', daemonHome] });
      expect(await client.exec({ resource, argv: ['true'], processConfig: {
        environment: { HOME: v.home, HAPPIER_HOME_DIR: daemonHome },
        detachedDaemonStartArgv: ['sh', '-c', 'printf started >> "$HAPPIER_HOME_DIR/starts"'],
      } })).toEqual({ kind: 'process-configured' });
      expect(await client.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
      expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
      expect(await client.power(resource, 'start')).toEqual({ kind: 'confirmed' });
      expect(readFileSync(retained)).toEqual(Buffer.from([0, 255, 128]));
      // FIX73: shared managed power owns enrolled guest startup after vendor Running.
      expect(readFileSync(join(daemonHome, 'starts'), 'utf8')).toBe('started');
      expect(v.calls.filter(call => call.method === 'POST' && call.path === '/api/sandbox')).toHaveLength(1);
      v.setState('destroying');
      expect(await client.inspect(resource)).not.toMatchObject({ availability: 'absent' });
      v.fail();
      expect(await client.inspect(resource)).toMatchObject({ availability: 'unavailable' });
      expect(await client.destroy({ resource })).not.toMatchObject({ kind: 'confirmed' });
      expect(JSON.stringify(await client.inspect(resource))).not.toContain('private-vendor-secret');
    } finally { v.cleanup(); }
  });
  it.each(['start', 'resume'])('confirms native %s without relying on guest execution', async intent => {
    const v = vendor();
    try {
      const client = createDaytonaNativeClient(v.request);
      const acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing native resource');
      v.setState('stopped');
      v.failExec();
      const before = v.calls.length;
      expect(await client.power(acquired.resource.value, intent)).toEqual({ kind: 'confirmed' });
      expect(await client.inspect(acquired.resource.value)).toMatchObject({ power: 'running', storage: 'retained' });
      expect(v.calls.slice(before).some(call => call.path.endsWith('/process/execute'))).toBe(false);
    } finally { v.cleanup(); }
  });
  it('retains accepted deletion until a demanded read confirms absence, without resubmitting deletion', async () => {
    const v = vendor();
    try {
      const client = createDaytonaNativeClient(v.request);
      const acquired = await client.acquire(launch, 'managed');
      if (acquired.kind !== 'bound') throw new Error('Missing native resource');
      v.deferDelete();
      const result = await client.destroy({ resource: acquired.resource.value });
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') throw new Error('Missing retained cleanup identity');
      expect(await client.cleanup(result.nativeOperationRef.value)).toMatchObject({ kind: 'unknown' });
      v.setState('destroyed');
      expect(await client.cleanup(result.nativeOperationRef.value)).toEqual({ kind: 'confirmed' });
      expect(v.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    } finally { v.cleanup(); }
  });
});
