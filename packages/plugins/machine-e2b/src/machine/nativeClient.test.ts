import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { createE2bNativeClient } from './nativeClient.js';
import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';

const launch = { templateId: 'base', timeoutSeconds: 300 };
const resource = { sandboxId: 'sandbox-one', managedId: 'managed-one', timeoutSeconds: 300 };
const token = 'private-envd-token';
const native = { sandboxID: resource.sandboxId, templateID: 'base', clientID: 'team', envdVersion: '0.5.3', envdAccessToken: token,
  state: 'running', endAt: '2026-11-03T12:00:00Z', metadata: { 'happier-managed-id': resource.managedId }, lifecycle: { onTimeout: 'pause', autoResume: false } };
function frame(value: unknown, flag = 0) {
  const json = new TextEncoder().encode(JSON.stringify(value)); const bytes = new Uint8Array(5 + json.length);
  bytes[0] = flag; new DataView(bytes.buffer).setUint32(1, json.length); bytes.set(json, 5); return bytes;
}
function output(stdout: string, exitCode = 0) {
  return new Uint8Array(Buffer.concat([frame({ event: { start: { pid: 42 } } }), frame({ event: { data: { stdout } } }), frame({ event: { end: { exited: true, exitCode } } }), frame({}, 2)]));
}
function vendor(options: { failCreate?: boolean; duplicate?: boolean; processBytes?: Uint8Array } = {}) {
  const requests: Request[] = [];
  let state = 'running', present = true;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request); const url = new URL(request.url);
    if (request.signal.aborted) throw request.signal.reason;
    if (url.pathname === '/process.Process/Start') return new Response(new Uint8Array(options.processBytes ?? output(Buffer.from('Linux\nx86_64\n/root\n').toString('base64'))), { headers: { 'content-type': 'application/connect+json' } });
    if (url.pathname === '/files') return new Response('[]');
    if (url.pathname.endsWith('/pause')) { state = 'paused'; return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith('/connect')) { state = 'running'; return Response.json(native, { status: 201 }); }
    if (request.method === 'DELETE') { present = false; return new Response(null, { status: 204 }); }
    if (url.pathname === '/v2/sandboxes' && request.method === 'POST') {
      if (options.failCreate) throw new TypeError('lost reply');
      return Response.json(native, { status: 201 });
    }
    if (url.pathname === '/v2/sandboxes') return Response.json(options.duplicate ? [native, { ...native, sandboxID: 'second' }] : [native]);
    return Response.json({ ...native, state }, { status: present ? 200 : 404 });
  };
  return { requests, client: createE2bNativeClient(fetch, new AbortController().signal, 1000) };
}

describe('E2B native REST leaf', () => {
  it.each(['headers', 'body'] as const)('retains completed native execution output after late cancellation at %s', async phase => {
    const abort = new AbortController();
    const bytes = output(Buffer.from('completed').toString('base64'), 17);
    const request: typeof fetch = async input => {
      if (!String(input).includes('/process.Process/Start')) return Response.json(native);
      if (phase === 'headers') { abort.abort(); return new Response(bytes); }
      return new Response(new ReadableStream({ pull(body) { body.enqueue(bytes); body.close(); abort.abort(); } }));
    };
    expect(await createE2bNativeClient(request, abort.signal, 1000).exec({ resource, argv: ['true'] }))
      .toMatchObject({ stdoutBase64: Buffer.from('completed').toString('base64'), termination: { observed: { kind: 'exit', exitCode: 17 } } });
  });

  it('rejects cancellation while a native execution body is still incomplete', async () => {
    const abort = new AbortController(); const reason = new Error('body cancelled');
    const request: typeof fetch = async input => {
      if (!String(input).includes('/process.Process/Start')) return Response.json(native);
      return new Response(new ReadableStream({ start(body) {
        body.enqueue(frame({ event: { start: { pid: 42 } } }));
        abort.signal.addEventListener('abort', () => body.error(reason), { once: true });
      }, pull() { abort.abort(reason); } }));
    };
    await expect(createE2bNativeClient(request, abort.signal, 1000).exec({ resource, argv: ['true'] })).rejects.toBe(reason);
  });
  it('retains a completed delete acknowledgement after late cancellation', async () => {
    const abort = new AbortController();
    const request: typeof fetch = async (_input, init) => {
      if (init?.method === 'DELETE') { abort.abort(); return new Response(null, { status: 204 }); }
      return Response.json(native);
    };
    expect(await createE2bNativeClient(request, abort.signal, 1000).destroy({ resource })).toEqual({ kind: 'confirmed' });
  });
  it('preserves completed upload failures instead of replacing them with late cancellation', async () => {
    const abort = new AbortController();
    const request: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/files') { abort.abort(); return new Response(null, { status: 503 }); }
      if (path === '/process.Process/Start') return new Response(output(Buffer.from('/tmp/input\n').toString('base64')));
      return Response.json(native);
    };
    await expect(createE2bNativeClient(request, abort.signal, 1000).exec({ resource, argv: ['cat'], inputBase64: 'YQ==' }))
      .rejects.toMatchObject({ code: 'e2b_http_503' });
  });
  it('cancels before dispatch and keeps incomplete allocation bodies unconfirmed', async () => {
    const abort = new AbortController(); const reason = new Error('cancelled'); abort.abort(reason);
    let calls = 0;
    const request: typeof fetch = async () => { calls++; return Response.json(native); };
    await expect(createE2bNativeClient(request, abort.signal, 1000).destroy({ resource })).rejects.toBe(reason);
    expect(calls).toBe(0);
    const incomplete: typeof fetch = async () => new Response(new ReadableStream({ start(body) { body.error(new Error('body disconnected')); } }));
    expect(await createE2bNativeClient(incomplete, new AbortController().signal, 1000).acquire(launch, resource.managedId)).toMatchObject({ kind: 'pending' });
  });

  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createE2bNativeClient(request, new AbortController().signal);
    await expect(client.check()).rejects.toBe(refusal);
  });
  it('reports an unavailable Check as a typed contract result', async () => {
    const client = createE2bNativeClient(async () => { throw new TypeError('offline'); }, new AbortController().signal, 1000);
    expect(await client.check()).toMatchObject({ available: false, code: 'provider_unavailable' });
  });
  it('enrollment binds the allocated sandbox without persisting its guest credential', async () => {
    const h = vendor(); const result = await h.client.acquire(launch, resource.managedId);
    expect(result).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(await h.requests[0]!.json()).toMatchObject({ templateID: 'base', timeout: 300, autoPause: true, autoPauseMemory: true, autoResume: { enabled: false } });
    expect(h.requests[0]!.headers.get('idempotency-key')).toBe(resource.managedId);
    expect(await h.client.bootstrap(resource)).toMatchObject({ kind: 'native', guestHome: { homeDir: '/root', daemonStartup: 'native-process' } });
  });
  it('guest runtime decodes Connect frames as bytes including BOM, nonzero exit and sliced binary uploads', async () => {
    const bytes = Buffer.from('\uFEFF秘密\n'); const h = vendor({ processBytes: output(bytes.toString('base64'), 17) });
    const result = await h.client.exec({ resource, argv: ['sh', '-c', 'exit 17'] });
    if (!('stdoutBase64' in result)) throw new Error('Missing command result');
    expect(decodeBase64(result.stdoutBase64)).toEqual(new Uint8Array(bytes));
    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 17 });
    expect(h.requests.find(r => r.url.includes('/process.'))?.headers.get('x-access-token')).toBe(token);
    const upload = vendor({ processBytes: output('') });
    expect(await upload.client.putFile({ resource, guestPath: '/tmp/private file', bytesBase64: 'AP+A', mode: 0o600 })).toEqual({ kind: 'confirmed' });
    expect(new Uint8Array(await upload.requests.find(r => r.url.includes('/files'))!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  });
  it('retention pauses memory and disk, passively observes the native expiry, resumes and deletes the same sandbox', async () => {
    const h = vendor();
    expect(await h.client.power(resource, 'suspend')).toEqual({ kind: 'confirmed' });
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'present', power: 'suspended', storage: 'retained', nativeExpiry: Date.parse(native.endAt) });
    expect(await h.client.power(resource, 'resume')).toEqual({ kind: 'confirmed' });
    expect(await h.client.destroy({ resource })).toEqual({ kind: 'confirmed' });
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'absent', storage: 'lost' });
    expect(h.requests.filter(r => r.method === 'POST').map(r => new URL(r.url).pathname)).toEqual(['/sandboxes/sandbox-one/pause', '/v2/sandboxes/sandbox-one/connect']);
  });
  it('recovers an uncertain create from metadata without another allocation; ambiguity stays unknown', async () => {
    const h = vendor({ failCreate: true }); const result = await h.client.acquire(launch, resource.managedId);
    expect(result.kind).toBe('pending');
    expect(await h.client.recover({ kind: 'acquire', launch, managedId: resource.managedId })).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(1);
    expect(await vendor({ duplicate: true }).client.recover({ kind: 'acquire', launch, managedId: resource.managedId })).toMatchObject({ kind: 'unknown' });
  });
  it('does not report a truncated process stream as a successful command', async () => {
    await expect(vendor({ processBytes: frame({ event: { start: { pid: 42 } } }) }).client.exec({ resource, argv: ['true'] })).rejects.toThrow('e2b_invalid_response');
  });
});
