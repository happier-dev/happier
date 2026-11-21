import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createCoderClient, coderWorkspaceName } from './nativeClient.js';
import { CoderLaunchSchema, RECONCILIATION, type CoderResource } from './schemas.js';

const launch = { organizationId: 'org', templateId: 'template', templateVersionId: 'version', agentName: 'main', parameterValues: [{ name: 'project', value: 'explicit project' }] };
const managedId = 'managed-machine-one';
const workspaceName = coderWorkspaceName(managedId);
const resource: CoderResource = { workspaceId: 'workspace', ownerId: 'user-a', ownerName: 'alice', workspaceName, organizationId: 'org', templateId: 'template', agentName: 'main', managedId };
const build = (status = 'running', transition = 'start', id = 'build-create') => ({ id, workspace_id: resource.workspaceId,
  template_version_id: 'version', transition, status, job: { status: 'succeeded' }, resources: [{ agents: [{ id: 'agent-main', name: 'main', status: 'connected', directory: '/home/coder' }] }] });
const workspace = (status = 'running', transition = 'start', id = 'build-create') => ({ id: resource.workspaceId,
  owner_id: resource.ownerId, owner_name: resource.ownerName, organization_id: 'org', template_id: 'template', name: workspaceName,
  dormant_at: null, latest_build: build(status, transition, id) });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(options: { preflightStatus?: number; lostCreate?: boolean; lostDelete?: boolean; owner?: string; missing?: boolean; readFails?: boolean; mismatchedVersion?: boolean; postResponse?: 'late-abort' | 'incomplete'; waitForObservation?: () => Promise<void> } = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let current = workspace(), deleted = false;
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString(); const body: unknown = raw ? JSON.parse(raw) : null;
    const path = new URL(req.url!, 'http://fixture').pathname;
    requests.push({ method: req.method!, path, body });
    res.setHeader('content-type', 'application/json');
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (path === '/api/v2/templateversions/version') {
      if (options.preflightStatus) return send({ message: 'upstream unavailable' }, options.preflightStatus);
      return send({ id: 'version', template_id: options.mismatchedVersion ? 'other-template' : 'template', organization_id: 'org' });
    }
    if (path === '/api/v2/users/me') return send({ id: options.owner ?? 'user-a', username: 'alice' });
    if (req.method === 'POST' && path.endsWith('/workspaces')) {
      current = { ...workspace('starting'), latest_build: { ...build('starting'), job: { status: 'pending' }, resources: [] } };
      if (options.lostCreate) return req.socket.destroy();
      return send(current, 201);
    }
    if (req.method === 'POST' && path.endsWith('/builds')) {
      const transition = (body as { transition: string }).transition;
      current = workspace(transition === 'stop' ? 'stopping' : transition === 'delete' ? 'deleting' : 'starting', transition, 'build-' + transition);
      if (transition === 'delete' && options.lostDelete) return req.socket.destroy();
      return send(current.latest_build, 201);
    }
    if (path.startsWith('/api/v2/workspacebuilds/')) return send({ ...current.latest_build,
      status: current.latest_build.transition === 'stop' ? 'stopped' : current.latest_build.status });
    if (path.startsWith('/api/v2/workspaces/') || path.includes('/workspace/')) {
      if (options.readFails) return send({ message: 'provider unavailable' }, 503);
      if (options.missing) return send({ message: 'not found' }, 404);
      return send(deleted ? workspace('deleted', 'delete', 'build-delete') : current);
    }
    return send({ message: 'unexpected route' }, 500);
  };
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const abort = new AbortController();
  let observations = 0;
  const createClient = (signal: AbortSignal) => createCoderClient({ request: async (path, init) => {
    const response = await fetch(origin + path, init);
    if (init?.method !== 'POST' || !options.postResponse) return response;
    if (options.postResponse === 'incomplete') return new Response(new ReadableStream({ start(body) { body.error(new Error('body disconnected')); } }));
    const bytes = await response.arrayBuffer();
    abort.abort();
    return new Response(bytes, { status: response.status });
  }, signal,
    observedAt: 1000, waitForObservation: async () => {
      observations++;
      await options.waitForObservation?.();
      current = workspace(current.latest_build.transition === 'stop' ? 'stopped' : 'running', current.latest_build.transition, current.latest_build.id);
    } });
  return { client: createClient(abort.signal), freshClient: () => createClient(new AbortController().signal), abort: () => abort.abort(), requests, resource,
    observations: () => observations, setCurrent(value: ReturnType<typeof workspace>) { current = value; }, remove() { deleted = true; } };
}

describe('Coder finite lifecycle through its REST boundary', () => {
  it('requires an explicit Start for a stopped workspace, while a starting guest is unavailable', async () => {
    const h = await fixture();
    h.setCurrent(workspace('stopped', 'stop'));
    await expect(h.client.guest(resource)).rejects.toMatchObject({ code: 'managed_power_required' });
    h.setCurrent(workspace('starting'));
    await expect(h.client.guest(resource)).rejects.toMatchObject({ code: 'coder_agent_unavailable' });
    expect(h.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('keeps a gateway failure during acquisition preflight typed after a successful acquisition', async () => {
    const options: { preflightStatus?: number } = {};
    const h = await fixture(options);
    expect(await h.client.acquire(launch, managedId)).toMatchObject({ kind: 'bound' });
    options.preflightStatus = 502;
    const error: unknown = await h.client.acquire(launch, managedId).catch(error => error);
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('retains completed workspace and build correlation after late cancellation', async () => {
    const create = await fixture({ postResponse: 'late-abort' });
    expect(await create.client.acquire(launch, managedId)).toMatchObject({ kind: 'pending',
      nativeOperationRef: { value: { workspaceId: 'workspace', buildId: 'build-create' } } });
    const deletion = await fixture({ postResponse: 'late-abort' });
    expect(await deletion.client.destroy({ resource })).toMatchObject({ kind: 'accepted',
      nativeOperationRef: { value: { buildId: 'build-delete' } } });
  });
  it('keeps an incomplete allocation body pending without fabricating native identity', async () => {
    const h = await fixture({ postResponse: 'incomplete' });
    const result = await h.client.acquire(launch, managedId);
    expect(result).toMatchObject({ kind: 'pending' });
    if (result.kind !== 'pending') throw new Error('Missing acquisition handle');
    expect(result.nativeOperationRef.value).not.toHaveProperty('workspaceId');
    expect(result.nativeOperationRef.value).not.toHaveProperty('buildId');
  });

  it.each([undefined, 'native-prebuild-preset'])('retains qualified create correlation with preset %s after a lost reply and recovers without another POST', async presetId => {
    const h = await fixture({ lostCreate: true });
    const created = RECONCILIATION.result.parse(await h.client.acquire({ ...launch, ...(presetId ? { presetId } : {}) }, managedId));
    expect(created.kind).toBe('pending'); if (created.kind !== 'pending') throw new Error('Missing native correlation');
    expect(created.nativeOperationRef.value).toMatchObject({ ownerId: 'user-a', workspaceName, managedId });
    h.setCurrent(workspace());
    const recovered = await h.client.recover(created.nativeOperationRef.value);
    expect(recovered).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(h.requests.find(request => request.method === 'POST')?.body).toMatchObject({ template_version_id: 'version', rich_parameter_values: launch.parameterValues });
    if (presetId) expect(h.requests.find(request => request.method === 'POST')?.body).toMatchObject({ template_version_preset_id: presetId });
    else expect(h.requests.find(request => request.method === 'POST')?.body).not.toHaveProperty('template_version_preset_id');
  });
  it('qualifies the selected template version before any create effect even when options are bypassed', async () => {
    const h = await fixture({ mismatchedVersion: true });
    await expect(h.client.acquire(launch, managedId)).rejects.toMatchObject({ code: 'resource_mismatch' });
    expect(h.requests.some(request => request.method === 'POST')).toBe(false);
  });
  it('keeps acquisition open until the accepted native build settles', async () => {
    let observing!: () => void, release!: () => void;
    const observationStarted = new Promise<void>(resolve => { observing = resolve; });
    const observationGate = new Promise<void>(resolve => { release = resolve; });
    const h = await fixture({ waitForObservation: async () => { observing(); await observationGate; } });
    const work = h.client.acquire(launch, managedId);
    const first = await Promise.race([observationStarted.then(() => 'observing'), work.then(() => 'settled')]);
    release();
    expect(first).toBe('observing');
    expect(RECONCILIATION.result.parse(await work)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('retains an accepted acquisition on cancellation while waiting and recovers the same workspace without another create', async () => {
    let observing!: () => void, release!: () => void;
    const observationStarted = new Promise<void>(resolve => { observing = resolve; });
    const observationGate = new Promise<void>(resolve => { release = resolve; });
    const h = await fixture({ waitForObservation: async () => { observing(); await observationGate; } });
    const work = h.client.acquire(launch, managedId);
    const first = await Promise.race([observationStarted.then(() => 'observing'), work.then(() => 'settled')]);
    h.abort(); release();
    expect(first).toBe('observing');
    const created = RECONCILIATION.result.parse(await work);
    expect(created).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { workspaceId: 'workspace', buildId: 'build-create' } } });
    if (created.kind !== 'pending') throw new Error('Missing retained acquisition');
    expect(await h.freshClient().recover(created.nativeOperationRef.value)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('retains accepted workspace identity when observation is unavailable and recovers without another create', async () => {
    const options = { readFails: true };
    const h = await fixture(options);
    const created = RECONCILIATION.result.parse(await h.client.acquire(launch, managedId));
    expect(created).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { workspaceId: 'workspace', buildId: 'build-create' } } });
    if (created.kind !== 'pending') throw new Error('Missing retained acquisition');
    options.readFails = false;
    expect(await h.client.recover(created.nativeOperationRef.value)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('qualifies recovered resources by the owner, organization, template, version and name', async () => {
    const h = await fixture(); h.setCurrent({ ...workspace(), template_id: 'another-template' });
    const recovered = await h.client.recover({ kind: 'acquire', launch, managedId, ownerId: 'user-a', ownerName: 'alice', workspaceName });
    expect(recovered).toMatchObject({ kind: 'unknown' });
    expect(h.requests.some(request => request.method === 'POST')).toBe(false);
  });
  it('confirms Stop only after its exact build and workspace observation agree on stopped power', async () => {
    const h = await fixture();
    expect(await h.client.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
    expect(h.observations()).toBe(1);
    expect(h.requests.some(request => request.path === '/api/v2/workspacebuilds/build-stop')).toBe(true);
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped', storage: 'unknown' });
  });
  it('observes an externally stopped or disconnected workspace without presence writes or wake effects', async () => {
    const h = await fixture(); h.setCurrent(workspace('stopped', 'stop', 'external-stop'));
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped' });
    h.setCurrent({ ...workspace(), latest_build: { ...build(), resources: [{ agents: [{ id: 'agent-main', name: 'main', status: 'disconnected', directory: '/home/coder' }] }] } });
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'present', power: 'running' });
    expect(h.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('retains a lost Delete and observes its cleanup without submitting Delete twice', async () => {
    const h = await fixture({ lostDelete: true });
    const destroyed = RECONCILIATION.destroyResult.parse(await h.client.destroy({ resource }));
    expect(destroyed.kind).toBe('accepted'); if (destroyed.kind !== 'accepted') throw new Error('Missing Delete handle');
    expect(await h.client.cleanup(destroyed.nativeOperationRef.value)).toEqual({ kind: 'unknown', code: 'coder_delete_pending' });
    h.remove();
    expect(await h.client.cleanup(destroyed.nativeOperationRef.value)).toEqual({ kind: 'confirmed' });
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('exposes a failed native Delete build without replaying its effect', async () => {
    const h = await fixture(); const destroyed = await h.client.destroy({ resource });
    if (destroyed.kind !== 'accepted') throw new Error('Missing Delete handle');
    h.setCurrent(workspace('failed', 'delete', 'build-delete'));
    expect(await h.client.cleanup(destroyed.nativeOperationRef.value)).toEqual({ kind: 'unknown', code: 'coder_build_failed' });
    expect(await h.client.destroy({ nativeOperation: destroyed.nativeOperationRef.value })).toEqual({ kind: 'unknown', code: 'coder_build_failed' });
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('recovers may-exist create before Delete, and never destroys an unqualified or unreadable allocation', async () => {
    const h = await fixture({ lostCreate: true }); const created = await h.client.acquire(launch, managedId);
    if (created.kind !== 'pending') throw new Error('Missing create handle');
    h.setCurrent(workspace('starting'));
    expect(await h.client.destroy({ nativeOperation: created.nativeOperationRef.value })).toMatchObject({ kind: 'accepted' });
    expect(h.observations()).toBe(0);
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    const unavailable = await fixture({ readFails: true });
    expect(await unavailable.client.destroy({ nativeOperation: created.nativeOperationRef.value })).toMatchObject({ kind: 'unknown' });
    expect(unavailable.requests.some(request => request.method === 'POST')).toBe(false);
  });
  it('keeps failed reads unknown and refuses another principal instead of treating hidden resources as deleted', async () => {
    const h = await fixture({ readFails: true });
    expect(await h.client.inspect(resource)).toMatchObject({ availability: 'unavailable', power: 'unknown' });
    const other = await fixture({ owner: 'user-b', missing: true });
    await expect(other.client.destroy({ resource })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(other.requests.some(request => request.method === 'POST')).toBe(false);
  });
  it('does not submit a second native effect after invocation cancellation', async () => {
    const abort = new AbortController(); abort.abort(); let requests = 0;
    const client = createCoderClient({ request: async () => { requests++; throw new Error('must not request'); }, signal: abort.signal,
      observedAt: 1000, waitForObservation: async () => {} });
    await expect(client.power(resource, 'stop')).rejects.toBeDefined(); expect(requests).toBe(0);
  });
  it('requires explicit template version, agent and rich values in the closed launch contract', () => {
    expect(CoderLaunchSchema.safeParse(launch).success).toBe(true);
    const { agentName: _agent, ...withoutAgent } = launch;
    expect(CoderLaunchSchema.safeParse(withoutAgent).success).toBe(false);
    expect(CoderLaunchSchema.safeParse({ ...launch, secretToken: 'not-a-launch-parameter' }).success).toBe(false);
  });
});
