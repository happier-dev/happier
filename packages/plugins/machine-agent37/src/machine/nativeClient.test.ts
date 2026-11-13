import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { createAgent37NativeClient } from './nativeClient.js';
import { MachineProvisionerNativeExecResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';

const launch = { kind: 'vm' as const, size: '2-4', region: 'us' as const };
const resource = { instanceId: 'ab12cd34ef', managedId: 'managed-one', ...launch };
// Constructed from Agent37's 2026-11-05 instance/exec API reference; HTTP only.
function vendor(options: { lostCreate?: boolean; startPending?: boolean; truncated?: boolean; status?: number } = {}) {
  const requests: Request[] = [];
  let status = 'running', present = true;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    const url = new URL(request.url);
    if (options.status) return Response.json({ error: { code: 'invalid_request' } }, { status: options.status });
    if (url.pathname.endsWith('/exec')) {
      expect(url.origin).toBe('https://sandbox.agent37.app');
      const body = await request.clone().json() as { command: string; user: string };
      expect(body.user).toBe('root');
      const stdout = body.command.includes('stdoutBase64')
        ? JSON.stringify({ exitCode: 0, stdoutBase64: encodeBase64(Uint8Array.of(0, 255, 128, 10)), stderrBase64: '' })
        : body.command.includes('uname') ? 'Linux\nx86_64\n/root\n' : body.command.includes('mktemp') ? '/tmp/agent37-fixture\n' : '';
      return Response.json({ exit_code: 0, stdout, stderr: '', truncated: options.truncated ?? false });
    }
    expect(url.origin).toBe('https://api.agent37.com');
    if (url.pathname === '/v1/instances' && request.method === 'POST') {
      if (options.lostCreate) throw new TypeError('connection lost after allocation');
      return Response.json({ id: resource.instanceId, status, url: `https://${resource.instanceId}.agent37.app` }, { status: 201 });
    }
    if (url.pathname === '/v1/instances') return Response.json({ data: [] });
    if (url.pathname.endsWith('/stop')) { status = 'stopped'; return Response.json({ id: resource.instanceId, status }); }
    if (url.pathname.endsWith('/start')) { status = options.startPending ? 'starting' : 'running'; return Response.json({ id: resource.instanceId, status }, { status: options.startPending ? 202 : 200 }); }
    if (request.method === 'DELETE') { present = false; return Response.json({ id: resource.instanceId, deleted: true }); }
    return Response.json(present ? { id: resource.instanceId, status, type: 'vm', auto_sleep: false } : { error: { code: 'not_found' } }, { status: present ? 200 : 404 });
  };
  return { requests, client: createAgent37NativeClient(fetch, new AbortController().signal, 1000) };
}

describe('Agent37 native HTTP lifecycle', () => {
  it.each(['stdin', 'bootstrap'] as const)('retains the failed %s prerequisite exit separately from response validation', async phase => {
    const request: typeof fetch = async () => Response.json({ exit_code: 28, stdout: '', stderr: 'No space left on device', truncated: false });
    const client = createAgent37NativeClient(request, new AbortController().signal, 1000);
    const operation = phase === 'stdin' ? client.exec({ resource, argv: ['cat'], inputBase64: 'YQ==' }) : client.bootstrap(resource);
    await expect(operation).rejects.toMatchObject({ code: 'agent37_guest_command_failed', details: { exitCode: 28 } });
  });
  it('retains completed power and delete bodies after late cancellation', async () => {
    for (const effect of ['stop', 'delete'] as const) {
      const abort = new AbortController();
      const request: typeof fetch = async () => { abort.abort(); return Response.json(effect === 'stop'
        ? { id: resource.instanceId, status: 'stopped' } : { id: resource.instanceId, deleted: true }); };
      const client = createAgent37NativeClient(request, abort.signal, 1000);
      expect(await (effect === 'stop' ? client.power(resource, effect) : client.destroy({ resource }))).toEqual({ kind: 'confirmed' });
    }
  });
  it('cancels before dispatch and rejects incomplete mutation bodies', async () => {
    const abort = new AbortController(); const reason = new Error('cancelled'); abort.abort(reason);
    let calls = 0;
    const request: typeof fetch = async () => { calls++; return Response.json({ id: resource.instanceId, deleted: true }); };
    await expect(createAgent37NativeClient(request, abort.signal, 1000).destroy({ resource })).rejects.toBe(reason);
    expect(calls).toBe(0);
    const incomplete: typeof fetch = async () => new Response(new ReadableStream({ start(body) { body.error(new Error('body disconnected')); } }));
    await expect(createAgent37NativeClient(incomplete, new AbortController().signal, 1000).destroy({ resource }))
      .rejects.toMatchObject({ code: 'agent37_invalid_response' });
  });

  it.each(['vm', 'default', 'performance'] as const)('creates %s with persistent daemon home and sleep disabled', async kind => {
    const h = vendor();
    expect(await h.client.acquire({ ...launch, kind }, resource.managedId)).toMatchObject({ kind: 'bound', resource: { value: { ...resource, kind } } });
    expect(await h.requests[0]!.json()).toEqual({ template: kind === 'vm' ? 'agent37-ubuntu' : 'agent37-base', type: kind,
      region: 'us', resources: { cpu: 2, memory: 4, disk: 12 }, mount_path: '/root', auto_sleep: false });
    expect(h.requests[0]!.headers.has('idempotency-key')).toBe(false);
    expect(await h.client.bootstrap({ ...resource, kind })).toMatchObject({ kind: 'native', guestHome: { homeDir: '/root', daemonStartup: 'native-process' } });
  });
  it('stops, inspects retained billed storage, starts and deletes the same instance', async () => {
    const h = vendor();
    expect(await h.client.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
    expect(await h.client.inspect(resource)).toMatchObject({ power: 'stopped', storage: 'retained', billing: {
      stoppedBilling: 'not-billed', storageCharges: [{ amount: '0.09', unit: 'GB-month' }],
    } });
    expect(await h.client.power(resource, 'start')).toEqual({ kind: 'confirmed' });
    expect(await h.client.inspect(resource)).toMatchObject({ power: 'running' });
    expect(await h.client.destroy({ resource })).toEqual({ kind: 'confirmed' });
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'absent', storage: 'lost' });
    expect(await h.client.destroy({ resource })).toEqual({ kind: 'confirmed' });
  });
  it('does not report an asynchronous cold start as confirmed', async () => {
    expect(await vendor({ startPending: true }).client.power(resource, 'start')).toMatchObject({ kind: 'unknown' });
  });
  it('lost create remains unknown with console recovery, without replay or guessed binding', async () => {
    const h = vendor({ lostCreate: true });
    const acquired = await h.client.acquire(launch, resource.managedId);
    expect(acquired).toMatchObject({ kind: 'unknown', recovery: { reference: resource.managedId, consoleUrl: 'https://www.agent37.com/dashboard' } });
    expect(await h.client.recover({ kind: 'acquire', launch, managedId: resource.managedId })).toEqual(acquired);
    expect(await h.client.destroy({ nativeOperation: { kind: 'acquire', launch, managedId: resource.managedId } })).toMatchObject({ kind: 'unknown' });
    expect(h.requests).toHaveLength(1);
  });
  it('rejects unavailable credentials before binding an allocation', async () => {
    expect(await vendor({ status: 401 }).client.acquire(launch, resource.managedId)).toEqual({ kind: 'rejected', code: 'credential_unavailable' });
  });
  it('restarts the daemon through the supplied process configuration after a cold boot', async () => {
    const h = vendor();
    expect(await h.client.exec({ resource, argv: ['unused'], processConfig: {
      detachedDaemonStartArgv: ['/root/.local/bin/happier', 'daemon', 'start'], environment: { HOME: '/root', HAPPIER_HOME_DIR: '/root/.happier' },
    } })).toEqual({ kind: 'process-configured' });
    expect(await h.requests[0]!.json()).toMatchObject({ command: expect.stringContaining("'/root/.local/bin/happier' 'daemon' 'start'") });
  });
  it('delivers binary files larger than one documented exec body with no truncation', async () => {
    const h = vendor(); const bytes = Uint8Array.from({ length: 200000 }, (_, i) => i % 256);
    expect(await h.client.putFile({ resource, guestPath: "/root/private file's.bin", bytesBase64: encodeBase64(bytes), mode: 0o700 })).toEqual({ kind: 'confirmed' });
    const chunks: string[] = [];
    for (const request of h.requests) {
      const body = await request.clone().text(); expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(128 * 1024);
      const command = (JSON.parse(body) as { command: string }).command;
      const chunk = /printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d >>/u.exec(command);
      if (chunk) chunks.push(chunk[1]!);
    }
    expect(decodeBase64(chunks.join(''))).toEqual(bytes);
  });
  it('preserves binary command output through the SDK text-only transport envelope', async () => {
    const result = await vendor().client.exec({ resource, argv: ['printf', '\\000\\377\\200\\n'] });
    expect(result).toMatchObject({ stdoutBase64: encodeBase64(Uint8Array.of(0, 255, 128, 10)), stdoutTruncated: false });
  });
  it.each([126, 127])('preserves native shell failure %s without requiring a binary envelope', async exitCode => {
    // Agent37 documents runtime failures outside the wrapped command (exec.md).
    const request: typeof fetch = async () => Response.json({ exit_code: exitCode,
      stdout: '', stderr: 'sh: cannot execute guest command\n', truncated: false });
    const client = createAgent37NativeClient(request, new AbortController().signal, 1000);
    const result = MachineProvisionerNativeExecResultV1Schema.parse(await client.exec({ resource, argv: ['sh', '-c', 'true'] }));
    expect(result).toMatchObject({ termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
      stderrBase64: encodeBase64(new TextEncoder().encode('sh: cannot execute guest command\n')),
      stdoutTruncated: false, stderrTruncated: false });
  });
  it('preserves a failed wrapped command rather than treating its status as an invalid response', async () => {
    const request: typeof fetch = async () => Response.json({ exit_code: 0, stdout: JSON.stringify({
      exitCode: 13, stdoutBase64: '', stderrBase64: encodeBase64(new TextEncoder().encode('promotion: Permission denied\n')),
    }), stderr: '', truncated: false });
    const result = await createAgent37NativeClient(request, new AbortController().signal, 1000).exec({ resource, argv: ['false'] });
    expect(result).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 13 } },
      stderrBase64: encodeBase64(new TextEncoder().encode('promotion: Permission denied\n')) });
  });
  it.each([{}, { exit_code: 0, stdout: 'not an envelope', stderr: '', truncated: false }])('rejects malformed native output', async body => {
    const request: typeof fetch = async () => Response.json(body);
    await expect(createAgent37NativeClient(request, new AbortController().signal, 1000).exec({ resource, argv: ['true'] }))
      .rejects.toMatchObject({ code: 'agent37_invalid_response' });
  });
  it('refuses a truncated binary envelope instead of reporting corrupted bytes as successful output', async () => {
    await expect(vendor({ truncated: true }).client.exec({ resource, argv: ['true'] }))
      .rejects.toMatchObject({ code: 'agent37_guest_command_failed', details: { exitCode: 0, truncated: true } });
  });
});
