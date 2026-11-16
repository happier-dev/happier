import { afterEach, describe, expect, it } from 'vitest';
import { rm, stat } from 'node:fs/promises';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult, ExecService } from '@happier-dev/plugin-sdk/exec';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { CRABBOX_PLUGIN } from '../manifest.js';
import { CRABBOX_CLOUD_PREPARATION, createCrabboxCloudPreparation } from './cloudPreparation.js';
import type { CrabboxHttp } from './nativeClient.js';

const launch = { backendId: 'aws' as const, transport: 'coordinator' as const, namespace: 'test', target: 'linux' as const,
  nativeImageId: 'ami-base', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
const contributionRef = { pluginId: 'happier.machine.crabbox', localId: 'crabbox-coordinator' };
const testNativeRoots = new Set<string>();
afterEach(async () => {
  await Promise.all([...testNativeRoots].map(root => rm(root, { recursive: true, force: true })));
  testNativeRoots.clear();
});
const input = { launch: { provider: contributionRef, schemaVersion: 1, choices: launch },
  cli: { identity: 'public:test', versionId: 'v1', binaryPath: '/opt/happier/bin/happier',
    installScript: 'mkdir -p /opt/happier/bin && cp payload /opt/happier/bin/happier', files: [{ path: 'payload', contentsBase64: Buffer.from('public-cli').toString('base64') }] },
  setupScript: 'printf setup > /opt/setup-complete' };
function result(): PluginProcessResult {
  return { stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } };
}
function fixture(options: { loseCheckpointReply?: boolean; loseScriptReply?: boolean; loseWarmupBeforeLease?: boolean; foreign?: boolean; pending?: boolean; imagePending?: boolean; releasePending?: boolean } = {}) {
  let lease: Record<string, unknown> | undefined;
  let checkpoint: Record<string, unknown> | undefined;
  let target = 'linux';
  let imageState = options.imagePending ? 'pending' : 'available';
  const processes: Parameters<ExecService['run']>[0][] = [];
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const http: CrabboxHttp = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, method, body });
    if (new URL(url).origin !== 'https://coordinator.test') return Response.json({}, { status: 404 });
    if (url.endsWith('/v1/checkpoints') && method === 'POST') {
      const imageId = lease?.provider === 'gcp' ? 'projects/test/global/machineImages/built' : 'ami-built';
      checkpoint = { ...body, ...(options.foreign ? { leaseID: 'cbx_ffffffffffff' } : {}), provider: lease?.provider, target, state: options.pending ? 'creating' : 'ready',
        image: { id: imageId, resourceID: imageId, immutableID: imageId, kind: lease?.provider === 'gcp' ? 'gcp-machine-image' : 'aws-ami', state: imageState, architecture: 'amd64' } };
      if (options.loseCheckpointReply) throw new Error('reply lost after native capture');
    } else if (url.includes('/v1/checkpoints/')) {
      if (!checkpoint) return Response.json({}, { status: 404 });
      if (checkpoint.state === 'deleted' && method === 'GET') return Response.json({}, { status: 404 });
      if (options.foreign) checkpoint = { ...checkpoint, leaseID: 'cbx_ffffffffffff' };
      if (method === 'DELETE') { checkpoint = { ...checkpoint, state: 'deleted' }; return Response.json({ checkpointID: checkpoint.id, deleted: true }); }
      if (url.endsWith('?verify=true')) return Response.json({ checkpoint, image: { ...checkpoint.image as Record<string, unknown>, state: imageState } });
    } else if (url.endsWith('/release')) {
      lease = { ...lease, state: 'released', cleanupStatus: options.releasePending ? 'pending' : 'complete',
        ...(options.releasePending ? {} : { cleanupCompletedAt: '2026-11-16T12:00:00Z' }), releaseDeletesServer: true };
      return Response.json({ lease });
    } else if (url.includes('/v1/leases/')) {
      return lease ? Response.json({ lease }) : Response.json({}, { status: 404 });
    } else throw new Error('Unexpected native request');
    return Response.json({ checkpoint });
  };
  // Only native process/dependency and external HTTP boundaries are substituted.
  const context = { signal: new AbortController().signal, services: {
    managedServices: { dependencies: { status: async () => ({ state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: contributionRef.pluginId, localId: 'crabbox-cli' } } }) } },
    exec: { run: async (request: Parameters<ExecService['run']>[0]) => {
      processes.push(request);
      if (request.cwd) testNativeRoots.add(request.cwd);
      if (request.args?.[0] === 'warmup') {
        if (options.loseWarmupBeforeLease) throw new Error('warmup reply lost before lease publication');
        const leaseID = request.args[request.args.indexOf('--lease-id') + 1];
        target = request.args[request.args.indexOf('--target') + 1];
        lease = { id: leaseID, provider: request.args[request.args.indexOf('--provider') + 1], org: 'test', state: 'active', cloudID: 'i-builder', keep: true };
      }
      if (request.args?.[0] === 'run' && options.loseScriptReply) throw new Error('script completion unknown');
      return result();
    } },
  } } as unknown as PluginInvocationContext;
  const clientAt = (endpoint: string) => createCrabboxCloudPreparation(context, { connection: { endpoint, namespace: 'test', token: 'private-token' }, http });
  const client = clientAt('https://coordinator.test');
  const admissions = { bindings: 0, materializations: 0 };
  const services = { ...context.services, connectedAccounts: {
    getBinding: async () => { admissions.bindings++; return { account: { service: { pluginId: contributionRef.pluginId, localId: 'coordinator' }, accountId: 'selected' } }; },
    materialize: async () => { admissions.materializations++; return { kind: 'environment', env: {
      CRABBOX_COORDINATOR_URL: 'https://coordinator.test', CRABBOX_COORDINATOR_TOKEN: 'private-token', CRABBOX_ORG: 'test' } }; },
  }, http: { request: async (request: Parameters<PluginInvocationContext['services']['http']['request']>[0]) => {
    const response = await http(request.url, { method: request.method, headers: request.headers,
      ...(request.body ? { body: new TextDecoder().decode(request.body) } : {}) });
    return { finalUrl: request.url, status: response.status, headers: Object.fromEntries(response.headers.entries()), body: new Uint8Array(await response.arrayBuffer()) };
  } } } as unknown as PluginTestServicesFixture;
  return { client, clientAt, processes, requests, services, admissions, setImageState: (state: string) => { imageState = state; },
    endSource: () => { lease = { ...lease, state: 'released', cleanupStatus: 'complete', cleanupCompletedAt: '2026-11-16T12:00:00Z', releaseDeletesServer: true }; } };
}
describe('Crabbox native clean cloud preparation', () => {
  it.each(['coordinator', 'legacy'] as const)('builds and deletes a clean cloud artifact through the public %s actions', async surface => {
    const h = fixture();
    const kit = await createPluginTestkit({ manifest: CRABBOX_PLUGIN.manifest, module: CRABBOX_PLUGIN, services: h.services });
    const selectedRef = surface === 'coordinator' ? contributionRef : { ...contributionRef, localId: 'crabbox' };
    const prefix = surface === 'coordinator' ? 'coordinator-prepare-' : 'prepare-';
    const id = 'cloud-clean-' + surface;
    try {
    const ready = CRABBOX_CLOUD_PREPARATION.buildResult.parse(await kit.invokeAction(prefix + 'build', { operationId: id,
      input: { ...input, launch: { ...input.launch, provider: selectedRef } } }, { surface: 'plugin' }));
    expect(ready).toMatchObject({ kind: 'ready', artifact: { contributionRef: selectedRef, value: { launch: { nativeImageId: 'ami-built', nativeCheckpointId: expect.stringMatching(/^chk_/) } } } });
    expect(h.admissions).toEqual({ bindings: 1, materializations: 1 });
    const warmup = h.processes.find(p => p.args?.[0] === 'warmup')!;
    expect(warmup.args).toEqual(expect.arrayContaining(['--lease-id', '--arch', 'amd64']));
    expect(warmup.env?.CRABBOX_COORDINATOR_TOKEN).toBe('private-token');
    const run = h.processes.find(p => p.args?.[0] === 'run')!;
    expect(run.args).toEqual(expect.arrayContaining(['--no-sync', '--no-hydrate', '--script-stdin']));
    const script = new TextDecoder().decode(run.stdin);
    expect(script).toContain(input.cli.installScript);
    expect(script).toContain(input.setupScript);
    expect(script).toContain(input.cli.files[0].contentsBase64);
    expect(script).not.toContain('private-token');
    expect(script).toContain('cloud-init clean --logs');
    expect(h.requests.some(r => r.url.endsWith('/release'))).toBe(true);
    expect((await stat(warmup.cwd!)).isDirectory()).toBe(true);
    if (ready.kind !== 'ready') throw new Error('Expected ready artifact');
    expect(await kit.invokeAction(prefix + 'destroy', { artifact: ready.artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    await expect(stat(warmup.cwd!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await kit.invokeAction(prefix + 'inspect', { operationId: id, launch }, { surface: 'plugin' })).toEqual({ kind: 'absent' });
    expect(h.requests.filter(r => r.method === 'DELETE').map(r => r.url)).toEqual([expect.stringMatching(/\/v1\/checkpoints\/chk_/) ]);
    } finally { await kit.dispose(); }
  });
  it('recovers a committed capture after a lost reply without allocating another source', async () => {
    const h = fixture({ loseCheckpointReply: true });
    expect(await h.client.build('cloud-lost-capture', input)).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId: 'cloud-lost-capture', leaseId: expect.stringMatching(/^cbx_/), checkpointId: expect.stringMatching(/^chk_/) } } });
    const before = h.requests.length;
    expect(await h.client.inspect({ operationId: 'cloud-lost-capture', launch })).toMatchObject({ kind: 'pending' });
    expect(h.requests.slice(before).every(request => request.method === 'GET')).toBe(true);
    expect(await h.client.build('cloud-lost-capture', input)).toMatchObject({ kind: 'ready' });
    expect(h.processes.filter(p => p.args?.[0] === 'warmup')).toHaveLength(1);
  });
  it('keeps a source with unknown script completion visible and never repeats its installer', async () => {
    const h = fixture({ loseScriptReply: true });
    expect(await h.client.build('cloud-lost-script', input)).toMatchObject({ kind: 'unknown' });
    expect(await h.client.inspect({ operationId: 'cloud-lost-script', launch })).toMatchObject({ kind: 'unknown', code: 'native_build_source_retained' });
    expect(await h.client.build('cloud-lost-script', input)).toMatchObject({ kind: 'unknown', code: 'native_build_source_retained' });
    expect(h.processes.filter(p => p.args?.[0] === 'run')).toHaveLength(1);
    const pending = await h.client.inspect({ operationId: 'cloud-lost-script', launch });
    if (pending.kind !== 'unknown') throw new Error('Expected retained source');
    expect(await h.client.destroy(pending.nativeOperationRef.value)).toEqual({ kind: 'confirmed' });
  });
  it('retains native state when an interrupted warmup has not yet published its lease', async () => {
    const h = fixture({ loseWarmupBeforeLease: true });
    const interrupted = await h.client.build('cloud-prepublication', input);
    expect(interrupted).toMatchObject({ kind: 'unknown' });
    if (interrupted.kind !== 'unknown') throw new Error('Expected interrupted operation');
    expect(await h.client.inspect({ operationId: 'cloud-prepublication', launch })).toMatchObject({ kind: 'unknown' });
    expect(await h.client.destroy(interrupted.nativeOperationRef.value)).toMatchObject({ kind: 'pending' });
    expect((await stat(h.processes[0].cwd!)).isDirectory()).toBe(true);
  });
  it('recovers cleanup scope from an ended source after losing the build response', async () => {
    const h = fixture({ loseScriptReply: true });
    expect(await h.client.build('cloud-ended-source', input)).toMatchObject({ kind: 'unknown' });
    h.endSource();
    const recovered = await h.client.inspect({ operationId: 'cloud-ended-source', launch });
    expect(recovered).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { coordinatorScope: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    if (recovered.kind !== 'unknown') throw new Error('Expected retained native state');
    expect(await h.client.destroy(recovered.nativeOperationRef.value)).toEqual({ kind: 'confirmed' });
    await expect(stat(h.processes[0].cwd!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not delete a checkpoint whose source identity disagrees', async () => {
    const h = fixture({ foreign: true });
    expect(await h.client.build('cloud-foreign', input)).toMatchObject({ kind: 'unknown' });
    expect(await h.client.destroy({ operationId: 'cloud-foreign', launch })).toMatchObject({ kind: 'unknown', code: 'native_checkpoint_identity_mismatch' });
    expect(h.requests.some(r => r.method === 'DELETE' || r.url.endsWith('/release'))).toBe(false);
  });
  it('retains a creating checkpoint and its source until native capture becomes ready', async () => {
    const h = fixture({ pending: true });
    expect(await h.client.build('cloud-pending', input)).toMatchObject({ kind: 'pending' });
    expect(h.requests.some(r => r.url.endsWith('/release'))).toBe(false);
  });
  it('releases its captured source in build and observes image and source readiness without writing in inspect', async () => {
    const h = fixture({ imagePending: true, releasePending: true });
    expect(await h.client.build('cloud-image-pending', input)).toMatchObject({ kind: 'pending' });
    expect(h.requests.some(r => r.url.endsWith('/release'))).toBe(true);
    const before = h.requests.length;
    h.setImageState('available');
    expect(await h.client.inspect({ operationId: 'cloud-image-pending', launch })).toMatchObject({ kind: 'pending' });
    h.endSource();
    expect(await h.client.inspect({ operationId: 'cloud-image-pending', launch })).toMatchObject({ kind: 'ready' });
    expect(h.requests.slice(before).every(request => request.method === 'GET')).toBe(true);
    expect(h.requests.some(r => r.url.endsWith('?verify=true'))).toBe(true);
    expect(h.processes.filter(p => p.args?.[0] === 'warmup')).toHaveLength(1);
  });
  it('keeps artifact cleanup and lost-ready recovery bound to the original coordinator', async () => {
    const h = fixture();
    const ready = await h.client.build('cloud-reconnected', input);
    if (ready.kind !== 'ready') throw new Error('Expected ready artifact');
    const other = h.clientAt('https://other-coordinator.test');
    const before = h.requests.length;
    expect(await other.destroy(ready.artifact.value)).toMatchObject({ kind: 'unknown', code: 'native_checkpoint_scope_mismatch' });
    expect(h.requests).toHaveLength(before);
    expect(await other.inspect({ operationId: 'cloud-reconnected', launch })).toMatchObject({ kind: 'unknown' });
    expect(await h.client.inspect({ operationId: 'cloud-reconnected', launch })).toMatchObject({ kind: 'ready' });
  });
  it.each(['macos', 'gcp'] as const)('preserves the selected native %s launch and explicitly requests the supplier architecture', async variant => {
    const h = fixture();
    const selected = variant === 'macos' ? { ...launch, target: 'macos' as const }
      : { ...launch, backendId: 'gcp' as const, gcpProject: 'test', gcpZone: 'europe-west2-a', nativeImageId: 'projects/test/global/images/base' };
    const ready = await h.client.build('cloud-variant-' + variant, { ...input, launch: { ...input.launch, choices: selected } });
    expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { launch: { ...selected, nativeImageId: variant === 'gcp' ? 'projects/test/global/machineImages/built' : 'ami-built', nativeCheckpointId: expect.stringMatching(/^chk_/) } } } });
    const warmup = h.processes.find(p => p.args?.[0] === 'warmup')!;
    expect(warmup.args).toEqual(expect.arrayContaining(['--target', selected.target, '--arch', 'amd64']));
    if (variant === 'gcp') expect(warmup.env).toMatchObject({ CRABBOX_GCP_PROJECT: 'test', CRABBOX_GCP_ZONE: 'europe-west2-a', CRABBOX_GCP_IMAGE: selected.nativeImageId });
    expect(new TextDecoder().decode(h.processes.find(p => p.args?.[0] === 'run')!.stdin)).toContain('base64 -D');
  });
  it('refuses Hetzner native image capture before acquiring a source', async () => {
    const h = fixture();
    const hetzner = { ...launch, backendId: 'hetzner' as const, location: 'fsn1' };
    expect(await h.client.build('cloud-hetzner', { ...input, launch: { ...input.launch, choices: hetzner } })).toMatchObject({ kind: 'refused', code: 'crabbox_preparation_not_supported' });
    expect(h.processes).toHaveLength(0);
  });
});
