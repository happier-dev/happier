import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { createMaritimeNativeClient } from './nativeClient.js';
import { MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerNativeExecResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';

// Constructed from Maritime OpenAPI 0.1.0 and docs/api, inspected 2026-11-05.
// Only vendor HTTP is substituted; all leaf lifecycle logic runs unchanged.
const managedId = 'managed-one';
const boxLaunch = { kind: 'agent-box' as const, memMb: 2048, diskGb: 5, alwaysOn: true, templateId: 'zeroclaw' };
const computerLaunch = { kind: 'linux-computer' as const, memMb: 4096, diskGb: 5, alwaysOn: false, templateId: 'zeroclaw' };
const box = { id: 'box-one', name: managedId, framework: 'zeroclaw', tier: 'always_on', externalId: managedId,
  status: 'active', invocationCount: 0, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' };
const computer = { id: 'computer-one', externalUserId: managedId, os: 'linux', arch: 'x86_64', status: 'ready',
  screen: { width: 1280, height: 800, modelWidth: 1200, modelHeight: 750 }, mode: 'agent', createdAt: '2026-11-05T00:00:00Z' };
const boxResource = { machineId: box.id, managedId, kind: boxLaunch.kind };
const computerResource = { machineId: computer.id, managedId, kind: computerLaunch.kind };
function vendor(options: { lostCreate?: boolean; duplicate?: boolean; asleep?: boolean; runningExec?: boolean; keepAwakeRefused?: boolean } = {}) {
  const requests: Request[] = [];
  let status = options.asleep ? 'sleeping' : 'active';
  let present = true;
  let submitted = false;
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init); requests.push(req);
    const url = new URL(req.url); const path = url.pathname;
    req.signal.throwIfAborted();
    if (path.endsWith('/files/upload') || path.endsWith('/files')) return new Response(null, { status: 204 });
    if (path.endsWith('/exec/execution-one')) return Response.json({ executionId: 'execution-one', status: 'completed', exitCode: 0, stdout: 'done', stderr: '' });
    if (path.endsWith('/exec')) {
      const body = await req.clone().json();
      if (options.runningExec && body.detached) return Response.json({ executionId: 'execution-one', status: 'running' }, { status: 202 });
      const result = { exitCode: 0, stdout: 'Linux\nx86_64\n/home/desk\n', stderr: '' };
      return Response.json(path.startsWith('/api/agents/') ? { ...result, executionId: 'execution-one', status: 'completed' } : result);
    }
    if (path.endsWith('/resize')) return Response.json({ ok: true, alwaysOn: !options.keepAwakeRefused,
      memMb: null, diskGb: null, appliesOn: 'immediate', billingPreview: null });
    if (path.endsWith('/wake') || path.endsWith('/start')) { status = 'active'; return Response.json(path.endsWith('/wake') ? { ...computer, status: 'ready' } : { ...box, status }); }
    if (path.endsWith('/sleep')) { status = 'sleeping'; return Response.json({ ...computer, status }); }
    if (path.endsWith('/stop')) { status = 'stopped'; return Response.json({ ...box, status }); }
    if (req.method === 'DELETE') { present = false; return new Response(null, { status: 204 }); }
    if (req.method === 'POST' && (path === '/api/agents' || path.endsWith('/agents') || path === '/api/v1/computers')) {
      submitted = true;
      if (options.lostCreate) throw new TypeError('lost create response');
      return Response.json(path === '/api/v1/computers' ? computer : box, { status: 201 });
    }
    if (path === '/api/agents' || path.endsWith('/agents') || path === '/api/v1/computers') {
      const entry = path === '/api/v1/computers' ? computer : box;
      const entries = submitted || options.duplicate ? (options.duplicate ? [entry, { ...entry, id: 'other' }] : [entry]) : [];
      return Response.json(path === '/api/v1/computers' ? { computers: entries } : entries);
    }
    return present ? Response.json(path.startsWith('/api/v1/computers') ? { ...computer, status: status === 'active' ? 'ready' : status } : { ...box, status }) : new Response(null, { status: 404 });
  };
  return { requests, client: createMaritimeNativeClient(request, new AbortController().signal, 1000) };
}

describe('Maritime managed-machine REST leaf', () => {
  it.each([boxResource, computerResource].flatMap(resource => (['stdin', 'bootstrap'] as const).map(phase => ({ resource, phase }))))(
    'classifies a failed $phase guest prerequisite for $resource.kind as a command failure', async ({ resource, phase }) => {
      const request: typeof fetch = async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/resize')) return Response.json({ ok: true, alwaysOn: true });
        if (path.endsWith('/exec')) return Response.json({ executionId: 'execution-one', status: 'completed', exitCode: 28, stdout: '', stderr: 'Bearer private-token; No space left on device' });
        return Response.json(resource.kind === 'agent-box' ? box : computer);
      };
      const client = createMaritimeNativeClient(request, new AbortController().signal, 1000);
      const operation = phase === 'stdin' ? client.exec({ resource, argv: ['cat'], inputBase64: 'YQ==' }) : client.bootstrap(resource);
      const failure: unknown = await operation.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'maritime_guest_command_failed', details: { exitCode: 28,
        nativeCause: { localCause: 'native_command_failed', command: 'run', exitCode: 28, stderr: expect.stringContaining('No space left on device') } } });
      expect(JSON.stringify(failure)).not.toContain('private-token');
    });
  it('retains a completed delete acknowledgement after late cancellation', async () => {
    const abort = new AbortController();
    const request: typeof fetch = async () => { abort.abort(); return new Response(null, { status: 204 }); };
    expect(await createMaritimeNativeClient(request, abort.signal, 1000).destroy({ resource: boxResource })).toEqual({ kind: 'confirmed' });
  });
  it.each([boxResource, computerResource])('preserves completed upload failures after late cancellation (%j)', async resource => {
    const abort = new AbortController();
    const request: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/files/upload') || path.endsWith('/files')) { abort.abort(); return new Response(null, { status: 503 }); }
      if (path.endsWith('/exec')) return Response.json({ executionId: 'execution-one', status: 'completed', exitCode: 0,
        stdout: resource.kind === 'agent-box' ? '/data/input\n' : '/home/desk/input\n', stderr: '' });
      return Response.json(resource.kind === 'agent-box' ? box : computer);
    };
    await expect(createMaritimeNativeClient(request, abort.signal, 1000).exec({ resource, argv: ['cat'], inputBase64: 'YQ==' }))
      .rejects.toMatchObject({ code: 'maritime_http_503' });
  });
  it('cancels before dispatch and rejects incomplete execution bodies', async () => {
    const abort = new AbortController(); const reason = new Error('cancelled'); abort.abort(reason);
    let calls = 0;
    const request: typeof fetch = async () => { calls++; return Response.json(box); };
    await expect(createMaritimeNativeClient(request, abort.signal, 1000).destroy({ resource: boxResource })).rejects.toBe(reason);
    expect(calls).toBe(0);
    const incomplete: typeof fetch = async input => String(input).endsWith('/exec')
      ? new Response(new ReadableStream({ start(body) { body.error(new Error('body disconnected')); } })) : Response.json(box);
    await expect(createMaritimeNativeClient(incomplete, new AbortController().signal, 1000).exec({ resource: boxResource, argv: ['true'], allowWake: false }))
      .rejects.toMatchObject({ code: 'maritime_invalid_response' });
  });

  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createMaritimeNativeClient(request, new AbortController().signal);
    await expect(client.check()).rejects.toBe(refusal);
  });
  it('recognizes the account limits response before reporting provider access', async () => {
    let limits: unknown = {};
    const client = createMaritimeNativeClient(async () => Response.json(limits), new AbortController().signal, 1000);
    expect(await client.check()).toMatchObject({ available: false, code: 'provider_unavailable' });
    limits = { plan: 'growth', machines: 0, awakeMachines: 0 };
    expect(await client.check()).toMatchObject({ available: true });
  });
  it.each([boxResource, computerResource])('refuses a sleeping diagnostic exec without waking the guest (%j)', async resource => {
    const h = vendor({ asleep: true });
    const request = { resource, argv: ['true'], allowWake: false as const };
    await expect(h.client.exec(request)).rejects.toThrow();
    expect(h.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each([boxResource, computerResource])('executes an already running diagnostic guest without lifecycle effects (%j)', async resource => {
    const h = vendor();
    const request = { resource, argv: ['true'], allowWake: false as const };
    expect(await h.client.exec(request)).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
    expect(h.requests.filter(request => request.method !== 'GET').map(request => new URL(request.url).pathname))
      .toEqual([resource.kind === 'agent-box' ? '/api/agents/box-one/exec' : '/api/v1/computers/computer-one/exec']);
  });
  it.each([[boxLaunch, boxResource], [computerLaunch, computerResource]] as const)('binds the selected kind to its managed identity (%j)', async (launch, resource) => {
    const h = vendor();
    expect(await h.client.acquire(launch, managedId)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    const creates = h.requests.filter(r => r.method === 'POST' && !r.url.endsWith('/resize'));
    expect(await creates[0]!.json()).toMatchObject(launch.kind === 'agent-box' ? { externalId: managedId, name: managedId, memMb: 2048, diskGb: 5 } : { externalUserId: managedId, os: 'linux' });
  });
  it.each([boxLaunch, computerLaunch])('recovers a lost create response by external identity without allocating again (%j)', async launch => {
    const h = vendor({ lostCreate: true });
    expect(await h.client.acquire(launch, managedId)).toMatchObject({ kind: 'pending' });
    const before = h.requests.filter(r => r.method === 'POST').length;
    expect(await h.client.recover({ kind: 'acquire', managedId, launch })).toMatchObject({ kind: 'bound', resource: { value: { managedId, kind: launch.kind } } });
    expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(before);
    expect(h.requests.at(-1)!.url).toContain(launch.kind === 'agent-box' ? 'externalId=managed-one' : 'externalUserId=managed-one');
  });
  it('keeps ambiguous recovery visible rather than binding an arbitrary billed machine', async () => {
    expect(await vendor({ lostCreate: true, duplicate: true }).client.recover({ kind: 'acquire', managedId, launch: boxLaunch })).toMatchObject({ kind: 'unknown' });
  });
  it('keeps a creating computer pending until a read confirms native readiness', async () => {
    let status = 'creating';
    const requests: Request[] = [];
    const request: typeof fetch = async (input, init) => {
      const req = new Request(input, init); requests.push(req);
      const native = { ...computer, status };
      return Response.json(req.method === 'POST' ? native : { computers: [native] }, { status: req.method === 'POST' ? 201 : 200 });
    };
    const client = createMaritimeNativeClient(request, new AbortController().signal, 1000);
    expect(await client.acquire(computerLaunch, managedId)).toMatchObject({ kind: 'pending' });
    const operation = { kind: 'acquire' as const, launch: computerLaunch, managedId };
    expect(await client.recover(operation)).toMatchObject({ kind: 'pending' });
    status = 'ready';
    expect(await client.recover(operation)).toMatchObject({ kind: 'bound', resource: { value: computerResource } });
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
  });
  it.each([boxResource, computerResource])('reports suspended state and wakes through the power path before guest work (%j)', async resource => {
    const h = vendor({ asleep: true });
    expect(await h.client.inspect(resource)).toMatchObject({ power: 'suspended', storage: 'retained', billing: {
      stoppedBilling: resource.kind === 'agent-box' ? 'billed' : 'not-billed', storageCharges: [{ amount: '0.08', unit: 'GB-month' }],
    } });
    await h.client.exec({ resource, argv: ['true'] });
    const effectPaths = h.requests.filter(r => r.method === 'POST').map(r => new URL(r.url).pathname);
    expect(effectPaths).toEqual([resource.kind === 'agent-box' ? '/api/agents/box-one/start' : '/api/v1/computers/computer-one/wake', resource.kind === 'agent-box' ? '/api/agents/box-one/exec' : '/api/v1/computers/computer-one/exec']);
    expect(await h.client.power(resource, 'suspend')).toEqual({ kind: 'confirmed' });
    expect(await h.client.power(resource, 'resume')).toEqual({ kind: 'confirmed' });
  });
  it('uses detached box execution, retrieves the same execution, and returns its terminal output', async () => {
    const h = vendor({ runningExec: true });
    const result = await h.client.exec({ resource: boxResource, argv: ['sh', '-c', 'long install'], timeoutMs: 240000 });
    expect(await h.requests.find(r => r.url.endsWith('/exec'))!.json()).toMatchObject({ detached: true, timeout: 240 });
    expect(result).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
    if (typeof result === 'object' && result && 'stdoutBase64' in result) expect(new TextDecoder().decode(decodeBase64(String(result.stdoutBase64)))).toBe('done');
    expect(h.requests.filter(r => r.method === 'POST' && r.url.endsWith('/exec'))).toHaveLength(1);
  });
  it.each([boxResource, computerResource])('hands the guest to canonical native binary bootstrap (%j)', async resource => {
    const h = vendor();
    const carrier = MachineProvisionerBootstrapCarrierV1Schema.parse(await h.client.bootstrap(resource));
    expect(carrier).toMatchObject({ kind: 'native', guestHome: { homeDir: resource.kind === 'agent-box' ? '/data' : '/home/desk', daemonStartup: 'native-process' } });
    if (resource.kind === 'agent-box') expect(await h.requests.find(r => r.url.endsWith('/resize'))!.json()).toEqual({ always_on: true });
    else expect(h.requests.some(r => r.url.endsWith('/resize'))).toBe(false);
  });
  it('does not claim bootstrap readiness when the vendor refuses default keep-awake', async () => {
    const h = vendor({ keepAwakeRefused: true });
    await expect(h.client.bootstrap(boxResource)).rejects.toThrow('maritime_keep_awake_unconfirmed');
    expect(h.requests.some(r => r.url.endsWith('/exec'))).toBe(false);
  });
  it.each([boxResource, computerResource])('installs native process configuration and transfers guest files (%j)', async resource => {
    const h = vendor();
    const process = await h.client.exec({ resource, argv: ['unused-foreground-command'], processConfig: {
      environment: { HOME: '/data', HAPPIER_HOME_DIR: '/data/.happier' }, detachedDaemonStartArgv: ['/data/happier', 'daemon', 'start'],
    } });
    expect(MachineProvisionerNativeExecResultV1Schema.parse(process)).toEqual({ kind: 'process-configured' });
    expect(await h.client.putFile({ resource, guestPath: (resource.kind === 'agent-box' ? '/data' : '/home/desk') + '/test', bytesBase64: 'cGF5bG9hZA==' })).toEqual({ kind: 'confirmed' });
    const transfer = h.requests.find(r => new URL(r.url).pathname.endsWith(resource.kind === 'agent-box' ? '/files/upload' : '/files'))!;
    if (resource.kind === 'agent-box') {
      const form = await transfer.formData();
      expect(form.get('dest_dir')).toBe('/data');
      const file = form.get('file');
      expect(file instanceof Blob && await file.text()).toBe('payload');
    } else expect(await transfer.text()).toBe('payload');
  });
  it.each([boxResource, computerResource])('deletes the native machine and confirms subsequent absence (%j)', async resource => {
    const h = vendor();
    expect(await h.client.destroy({ resource })).toEqual({ kind: 'confirmed' });
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'absent', storage: 'lost' });
    expect(await h.client.destroy({ resource })).toEqual({ kind: 'confirmed' });
  });
});
