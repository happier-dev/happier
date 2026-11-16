import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { lumeProcessResult, createLumeNativeClientForTest as createLumeNativeClient } from './nativeClient.testkit.js';
import { createLumeProvider } from './provider.js';
import { createLumePreparationClient, PREPARATION_SCHEMAS, type LumePreparationBuildExecution } from './preparation.js';

const operation = { storage: 'home', vmName: 'happier-prepared-operation-one' };
const launch = { image: { kind: 'native-image' as const, reference: 'ghcr.io/trycua/macos:26' },
  storage: 'home', cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 150 * 1024 ** 3 };
const buildInput = { operationId: 'operation-one', input: {
  launch: { provider: { pluginId: 'happier.machine.lume', localId: 'lume' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3', versionId: '0.3.0', binaryPath: '/Users/lume/.happier/cli/happier',
    installScript: 'install-public-cli', files: [{ path: 'cli/payload', contentsBase64: 'cHVibGlj' }] },
  setupScript: 'prepare-my-tools',
} };

// Only native HTTP and the remote guest process boundary are substituted.
// The real provider owns acquisition, sizing, power and exact native identity.
function vendor() {
  let present = false, status = 'stopped', holdDelete = false, losePull = false, stopWorks = true, sshReady = true;
  const effects: string[] = [], requests: string[] = [];
  const clones = new Map<string, string>();
  const facts = () => ({ name: operation.vmName, locationName: operation.storage, status, os: 'macos',
    cpuCount: launch.cpu, memorySize: launch.memoryBytes, diskSize: { total: launch.diskBytes, allocated: 1024 ** 3 },
    ipAddress: '192.168.64.7', sshAvailable: sshReady });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (method !== 'GET') effects.push(`${method} ${url.pathname}`);
    if (url.pathname === '/lume/host/status') return Response.json({ version: '0.6.1' });
    if (url.pathname === '/lume/config/locations') return Response.json([{ name: 'home' }]);
    if (url.pathname === '/lume/config') return Response.json({ cachingEnabled: true });
    if (url.pathname === '/token') return Response.json({ token: 'anonymous' });
    if (url.pathname.includes('/manifests/')) return Response.json({ annotations: { 'org.trycua.lume.disk-size': String(launch.diskBytes) } });
    if (url.pathname === '/lume/vms') return Response.json([
      ...(present ? [facts()] : []), ...[...clones].map(([name, state]) => ({ ...facts(), name, status: state })),
    ]);
    if (url.pathname === '/lume/vms/clone') {
      const body = JSON.parse(String(init?.body)) as { name: string; newName: string };
      if (!present || body.name !== operation.vmName || status !== 'stopped') return Response.json({}, { status: 400 });
      clones.set(body.newName, 'stopped');
      return Response.json({ source: body.name, destination: body.newName });
    }
    if (url.pathname === '/lume/pull') {
      present = true;
      if (losePull) throw new Error('private vendor failure');
      return Response.json({ name: operation.vmName, image: 'macos:26' });
    }
    if (url.pathname.endsWith('/run')) {
      const name = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      if (clones.has(name)) clones.set(name, 'running'); else status = 'running';
      return new Response(null, { status: 202 });
    }
    if (url.pathname.endsWith('/stop')) { if (stopWorks) status = 'stopped'; return Response.json({}); }
    const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    if (clones.has(name)) return Response.json({ ...facts(), name, status: clones.get(name) });
    return present ? Response.json(facts()) : Response.json({ message: `Virtual machine not found: ${operation.vmName}` }, { status: 400 });
  };
  const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: request, command: {
    executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } },
    exec: { run: async () => {
      effects.push('lume delete');
      if (!holdDelete) present = false;
      return lumeProcessResult();
    } },
  } });
  const executed: Parameters<LumePreparationBuildExecution>[0][] = [];
  const executeBuild: LumePreparationBuildExecution = async input => { effects.push('guest-build'); requests.push('guest-build'); executed.push(input); };
  return { native, effects, requests, executed, executeBuild, setPresent(value: string) { present = true; status = value; },
    holdDelete() { holdDelete = true; }, losePull() { losePull = true; }, failStop() { stopWorks = false; },
    setSshReady(value: boolean) { sshReady = value; } };
}
function client(v: ReturnType<typeof vendor>, executeBuild = v.executeBuild) {
  return createLumePreparationClient({ native: v.native, observedAt: 123,
    waitForNativeObservation: async () => {}, executeBuild });
}

describe('Lume credential-free image preparation', () => {
  it('stops the authenticated and scrubbed base without a new SSH-triggering native inspection', async () => {
    const v = vendor();
    expect(await client(v).build(buildInput)).toMatchObject({ kind: 'ready' });
    expect(v.requests.slice(v.requests.indexOf('guest-build') + 1)).toEqual([
      `POST /lume/vms/${operation.vmName}/stop`, `GET /lume/vms/${operation.vmName}`,
    ]);
  });
  it('runs the published CLI and setup against a fresh owned VM and returns a full launch only after verified stop', async () => {
    const v = vendor();
    const result = PREPARATION_SCHEMAS.buildResult.parse(await client(v).build(buildInput));
    expect(result).toMatchObject({ kind: 'ready', artifact: { value: { ...operation,
      launch: { ...launch, image: { kind: 'prepared', ...operation } } } } });
    expect(v.executed).toEqual([{ resource: operation, cli: buildInput.input.cli, setupScript: buildInput.input.setupScript }]);
    expect(v.effects).toEqual(['POST /lume/pull', `POST /lume/vms/${operation.vmName}/run`, 'guest-build', `POST /lume/vms/${operation.vmName}/stop`]);
  });
  it('uses its actual artifact launch for fresh clones without repeating baked installation or setup', async () => {
    const v = vendor();
    // The prepared-clone ruling requires password-off after per-clone key
    // setup, including presets whose ordinary cold launch keeps passwords.
    const selected = { ...buildInput, input: { ...buildInput.input,
      launch: { ...buildInput.input.launch, choices: { ...launch, keepPasswordLogin: true } } } };
    const built = PREPARATION_SCHEMAS.buildResult.parse(await client(v).build(selected));
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('Expected a prepared artifact');
    expect(built.artifact.value.launch.keepPasswordLogin).toBe(false);
    const provider = createLumeProvider({ native: v.native, observedAt: 123 });
    for (const id of ['first-session', 'second-session']) {
      expect(await provider.acquire(built.artifact.value.launch, id)).toMatchObject({ kind: 'bound', startPending: true,
        resource: { value: { storage: 'home', vmName: `happier-${id}`, keepPasswordLogin: false } } });
    }
    expect(v.executed).toHaveLength(1);
    expect(v.effects.filter(effect => effect === 'POST /lume/pull')).toHaveLength(1);
    expect(v.effects.filter(effect => effect === 'POST /lume/vms/clone')).toHaveLength(2);
  });
  it.each(['running', 'stopped', 'provisioning'])('never adopts an interrupted %s VM as a completed build or writes during recovery inspection', async status => {
    const v = vendor(); v.setPresent(status);
    const result = PREPARATION_SCHEMAS.inspectResult.parse(await client(v).inspect({ operationId: buildInput.operationId, launch }));
    expect(result).toMatchObject({ kind: 'failed', code: 'lume_preparation_incomplete', nativeOperationRef: { value: operation } });
    expect(v.effects).toEqual([]);
  });
  it('retains an existing operation VM without pulling or replaying its setup', async () => {
    const v = vendor(); v.setPresent('stopped');
    expect(await client(v).build(buildInput)).toMatchObject({ kind: 'unknown', code: 'lume_preparation_incomplete', nativeOperationRef: { value: operation } });
    expect(v.effects).toEqual([]);
    expect(v.executed).toEqual([]);
  });
  it('waits for native SSH readiness on the host cadence before the one guest build', async () => {
    const v = vendor(); v.setSshReady(false);
    let waits = 0;
    const preparation = createLumePreparationClient({ native: v.native, observedAt: 123, executeBuild: v.executeBuild,
      waitForNativeObservation: async () => { waits++; v.setSshReady(true); } });
    expect(await preparation.build(buildInput)).toMatchObject({ kind: 'ready' });
    expect(waits).toBe(1);
    expect(v.executed).toHaveLength(1);
    expect(v.effects.filter(effect => effect === 'POST /lume/pull')).toHaveLength(1);
  });
  it('cancels the native readiness wait without running setup or losing cleanup identity', async () => {
    const v = vendor(); v.setSshReady(false);
    const controller = new AbortController(), cancellation = new Error('cancelled');
    const preparation = createLumePreparationClient({ native: v.native, observedAt: 123, signal: controller.signal,
      executeBuild: v.executeBuild, waitForNativeObservation: async () => { controller.abort(cancellation); } });
    await expect(preparation.build(buildInput)).rejects.toBe(cancellation);
    expect(v.executed).toEqual([]);
    expect(await client(v).destroy({ nativeOperation: operation })).toEqual({ kind: 'confirmed' });
  });
  it('retains native custody when the pull response is lost and allows explicit cleanup recovery', async () => {
    const v = vendor(); v.losePull();
    const result = await client(v).build(buildInput);
    expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: operation } });
    expect(JSON.stringify(result)).not.toContain('private vendor failure');
    expect(v.executed).toEqual([]);
    expect(await client(v).destroy({ nativeOperation: operation })).toEqual({ kind: 'confirmed' });
    expect(await client(v).inspect({ operationId: buildInput.operationId, launch })).toEqual({ kind: 'absent' });
  });
  it('never returns a ready artifact for a failed guest build', async () => {
    const v = vendor();
    expect(await client(v, async () => { throw new Error('private guest failure'); }).build(buildInput))
      .toMatchObject({ kind: 'unknown', code: 'lume_preparation_build_unconfirmed', nativeOperationRef: { value: operation } });
    expect(await client(v).inspect({ operationId: buildInput.operationId, launch }))
      .toMatchObject({ kind: 'failed', code: 'lume_preparation_incomplete' });
  });
  it('preserves the authored guest refusal and leaves interrupted native work inspectable for cleanup', async () => {
    const v = vendor();
    const refusal = new PluginError({ code: 'native_ssh_host_trust_refused' });
    await expect(client(v, async () => { throw refusal; }).build(buildInput)).rejects.toBe(refusal);
    expect(await client(v).inspect({ operationId: buildInput.operationId, launch }))
      .toMatchObject({ kind: 'failed', nativeOperationRef: { value: operation } });
  });
  it('does not publish a completed guest as ready when stopping remains unconfirmed', async () => {
    const v = vendor(); v.failStop();
    expect(await client(v).build(buildInput)).toMatchObject({ kind: 'unknown', code: 'lume_preparation_stop_unconfirmed' });
  });
  it('confirms destruction only after the exact owned VM is absent', async () => {
    const v = vendor(); v.setPresent('stopped'); v.holdDelete();
    expect(await client(v).destroy({ nativeOperation: operation })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: operation } });
  });
  it('rejects a non-preparation resource before native cleanup', async () => {
    const v = vendor();
    await expect(client(v).destroy({ nativeOperation: { storage: 'home', vmName: 'personal-vm' } })).rejects.toBeDefined();
    expect(v.effects).toEqual([]);
  });
});
