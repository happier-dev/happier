import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { composeManagedMachinePresetPreparationBuildInputV1 } from '@happier-dev/cli-common/machines/managed';
import { describe, expect, it } from 'vitest';
import { PLUGIN, PLUGIN_MANIFEST } from './manifest.js';
import { reference } from './machine/schemas.js';

const scope = { teamId: 'team_one', projectId: 'prj_one' };
const launch = { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 1, timeoutMs: 300000, snapshotExpirationMs: 0 };
const operationId = 'build-one';
const acquisition = { kind: 'acquire' as const, ...scope, name: 'happier-prepared-' + operationId, managedId: 'prepared-' + operationId, createdAt: 1000 };
const preparedInput = {
  launch: { provider: { pluginId: 'happier.machine.vercel', localId: 'vercel' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'printf credential-free-cli', files: [{ path: 'payload/cli.tar', contentsBase64: 'AAECAw==' }] },
};
const buildInput = { operationId, ...composeManagedMachinePresetPreparationBuildInputV1({ operationId, ...preparedInput,
  setup: { preparation: { basis: { kind: 'preparation', operationId }, recipes: [] } } }) };
const operation = { acquisition, launch, snapshotId: 'snap_prepared' };
const artifact = { ...operation, launch: { ...launch, snapshotId: operation.snapshotId } };

// Redacted fixtures follow Vercel's OpenAPI v4 create and v2 Session,
// SessionCommand and Snapshot contracts, retrieved 2026-11-16.
function vendor() {
  const calls: { url: URL; method: string; body: unknown }[] = [];
  const commands = new Map<string, { command: string; args: string[] }>();
  let base = false, captured = false, stopped = false, snapshotStatus = 'created';
  let loseCreate = false, loseSnapshot = false, commandFailure: 'install' | 'setup' | undefined, holdDelete = false;
  let cancelSnapshot: AbortController | undefined;
  let wrongOwner = false, foreignSnapshot = false;
  const session = () => ({ id: 'sbx_build', sourceSandboxName: acquisition.name, projectId: scope.projectId, createdAt: 1000 });
  const named = () => ({ name: acquisition.name, tags: { 'happier-managed-id': wrongOwner ? 'other-person' : acquisition.managedId },
    createdAt: 1000, currentSessionId: 'sbx_build', status: stopped ? 'stopped' : 'running', persistent: false });
  const snapshot = () => ({ id: operation.snapshotId, sourceSessionId: foreignSnapshot ? 'sbx_other' : 'sbx_build', createdAt: 2000, lastUsedAt: 2000,
    sizeBytes: 1024, updatedAt: 2000, status: snapshotStatus === 'expired' ? 'created' : snapshotStatus,
    ...(snapshotStatus === 'expired' ? { expiresAt: 1 } : {}), architecture: 'amd64', region: launch.region, creationMethod: 'manual' });
  const response = (status: number, value: unknown) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
  const services = {
    connectedAccounts: { async materialize(_purpose: string, request: { kind: string }) {
      return request.kind === 'environment' ? { kind: 'environment', env: { VERCEL_TEAM_ID: scope.teamId, VERCEL_PROJECT_ID: scope.projectId } }
        : { kind: 'httpHeaders', headers: { authorization: 'Bearer private-controller' } };
    } },
    http: createPluginHttpFixture({ async request(request) {
      const url = new URL(request.url), method = request.method;
      const body: unknown = request.body?.length ? JSON.parse(new TextDecoder().decode(request.body)) : undefined;
      calls.push({ url, method, body });
      const path = url.pathname;
      if (path.startsWith('/v2/teams/')) return response(200, { id: scope.teamId, billing: { plan: 'hobby' } });
      if (path === '/v4/sandboxes') {
        base = true;
        if (loseCreate) throw new Error('private transport detail');
        return response(200, { sandbox: named(), session: session(), routes: [] });
      }
      if (path === '/v2/sandboxes/' + acquisition.name) {
        if (method === 'DELETE' && !holdDelete) base = false;
        return base ? response(200, { sandbox: named(), session: session() }) : response(404, {});
      }
      if (path === '/v2/sandboxes/snapshots') return response(200, { snapshots: captured ? [snapshot()] : [], pagination: { next: null, count: captured ? 1 : 0 } });
      if (path === '/v2/sandboxes/snapshots/' + operation.snapshotId) {
        if (method === 'DELETE' && !holdDelete) captured = false;
        return captured ? response(200, { snapshot: snapshot() }) : response(404, {});
      }
      if (path.endsWith('/snapshot')) {
        captured = true; stopped = true;
        if (cancelSnapshot) { cancelSnapshot.abort(); throw new DOMException('Cancelled', 'AbortError'); }
        if (loseSnapshot) throw new Error('private snapshot transport detail');
        return response(201, { snapshot: snapshot(), session: session() });
      }
      if (path.endsWith('/stop')) { stopped = true; return response(200, { session: session() }); }
      if (path === '/v2/sandboxes/sessions/sbx_build') return response(200, { session: session() });
      if (path === '/v2/sandboxes/sessions/sbx_other') return response(200, { session: { ...session(), id: 'sbx_other', sourceSandboxName: 'someone-elses-sandbox' } });
      if (path.endsWith('/cmd')) {
        const command = body as { command: string; args: string[] };
        const id = 'cmd_' + commands.size; commands.set(id, command);
        return response(200, { command: { id, sessionId: 'sbx_build', exitCode: null } });
      }
      const match = path.match(/\/cmd\/(cmd_\d+)(?:\/(stdin|logs))?$/);
      if (match) {
        const command = commands.get(match[1]!)!;
        if (match[2] === 'logs') {
          const stdout = command.args.some(arg => arg.includes('uname -s')) ? 'Linux\nx86_64\n/vercel/sandbox\n' : '';
          return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ stream: 'stdout', data: stdout }) + '\n') };
        }
        return response(200, { command: { id: match[1], sessionId: 'sbx_build', exitCode: match[2] === 'stdin' ? null
          : commandFailure === 'install' && command.args.includes(buildInput.input.cli.installScript)
            || command.args.includes(buildInput.input.setupScript!) && (commandFailure === 'setup'
              || !command.args.some(arg => arg.includes('sudo -n --'))) ? 1 : 0 } });
      }
      throw new Error('Unexpected Vercel fixture request ' + method + ' ' + path);
    } }),
  // These are the genuine host HTTP and connected-account boundaries only.
  } as unknown as PluginTestServicesFixture;
  return { services, calls, commands, seed() { base = true; captured = true; stopped = true; },
    loseCreate() { loseCreate = true; }, loseSnapshot() { loseSnapshot = true; },
    cancelSnapshot(controller: AbortController) { cancelSnapshot = controller; },
    failCommand(value: 'install' | 'setup') { commandFailure = value; }, setStatus(value: string) { snapshotStatus = value; },
    holdDelete() { holdDelete = true; }, wrongOwner() { wrongOwner = true; },
    foreignSnapshot() { foreignSnapshot = true; },
    get state() { return { base, captured }; } };
}

async function withKit(run: (kit: Awaited<ReturnType<typeof createPluginTestkit>>, v: ReturnType<typeof vendor>) => Promise<void>) {
  const v = vendor();
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN, services: v.services });
  try { await run(kit, v); } finally { await kit.dispose(); }
}

describe('Vercel preparation through public Actions', () => {
  it('builds a clean nonpersistent base, installs CLI and canonical Setup as root, then snapshots and maps a launch artifact', async () => withKit(async (kit, v) => {
    const result = await kit.invokeAction('prepare-build', buildInput, { surface: 'plugin' });
    expect(result).toEqual({ kind: 'ready', artifact: reference(artifact) });
    const create = v.calls.find(call => call.url.pathname === '/v4/sandboxes')!;
    expect(create.body).toMatchObject({ image: launch.image, architecture: 'amd64', persistent: false, networkPolicy: { mode: 'allow-all' }, tags: { 'happier-managed-id': acquisition.managedId } });
    const commands = [...v.commands.values()].flatMap(command => command.args).join('\n');
    expect(commands).toContain(buildInput.input.cli.installScript);
    expect(commands).toContain(buildInput.input.setupScript!);
    expect(commands).toContain('/payload/cli.tar');
    expect(v.calls.some(call => call.url.pathname.endsWith('/stdin') && JSON.stringify(call.body).includes('AAECAw=='))).toBe(true);
    expect(v.calls.filter(call => call.url.pathname.endsWith('/snapshot'))).toHaveLength(1);
    expect(JSON.stringify(v.calls.map(call => call.body))).not.toContain('private-controller');
    expect(v.calls.every(call => call.url.searchParams.get('teamId') === scope.teamId)).toBe(true);
  }));

  it('recovers a lost snapshot reply in a fresh invocation without another build or setup', async () => withKit(async (kit, v) => {
    v.loseSnapshot();
    expect(await kit.invokeAction('prepare-build', buildInput, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { acquisition, launch } } });
    const effects = v.calls.filter(call => call.method === 'POST').length;
    expect(await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toEqual({ kind: 'ready', artifact: reference(artifact) });
    expect(v.calls.filter(call => call.method === 'POST')).toHaveLength(effects);
  }));

  it('launches the supplied artifact through the existing acquire owner and native snapshot source', async () => withKit(async (kit, v) => {
    expect(await kit.invokeAction('acquire', { launch: artifact.launch, managedId: acquisition.managedId }, { surface: 'plugin' })).toMatchObject({ kind: 'bound' });
    const create = v.calls.find(call => call.url.pathname === '/v4/sandboxes')!;
    expect(create.body).toMatchObject({ source: { type: 'snapshot', snapshotId: artifact.snapshotId }, persistent: true, architecture: 'amd64' });
    expect(create.body).not.toHaveProperty('image');
  }));

  it('recovers and deletes a snapshot committed as its original admission is cancelled', async () => withKit(async (kit, v) => {
    const controller = new AbortController(); v.cancelSnapshot(controller);
    // Cancellation may close the caller before it receives the role result.
    await kit.invokeAction('prepare-build', buildInput, { surface: 'plugin', signal: controller.signal }).catch(() => undefined);
    const ready = await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
    expect(ready).toEqual({ kind: 'ready', artifact: reference(artifact) });
    expect(v.calls.filter(call => call.url.pathname === '/v4/sandboxes')).toHaveLength(1);
    expect(await kit.invokeAction('prepare-destroy', { artifact: reference(artifact) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    expect(v.state).toEqual({ base: false, captured: false });
  }));

  it('retains an unknown clean base creation and never calls that unfinished base ready', async () => withKit(async (kit, v) => {
    v.loseCreate();
    expect(await kit.invokeAction('prepare-build', buildInput, { surface: 'plugin' })).toMatchObject({ kind: 'unknown' });
    expect(await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toMatchObject({ kind: 'failed', code: 'vercel_preparation_incomplete' });
    expect(v.calls.filter(call => call.url.pathname.endsWith('/snapshot'))).toHaveLength(0);
  }));

  it.each(['install', 'setup'] as const)('keeps failed %s execution unsnapshotted and available for owned cleanup', async phase => withKit(async (kit, v) => {
    v.failCommand(phase);
    const result = await kit.invokeAction('prepare-build', buildInput, { surface: 'plugin' });
    expect(result).toMatchObject({ kind: 'unknown', code: phase === 'install' ? 'vercel_preparation_cli_install_failed' : 'vercel_preparation_setup_failed',
      nativeOperationRef: { value: { acquisition } } });
    expect(v.calls.filter(call => call.url.pathname.endsWith('/snapshot'))).toHaveLength(0);
    expect(await kit.invokeAction('prepare-destroy', { nativeOperation: reference({ acquisition, launch }) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
  }));

  it.each(['failed', 'deleted', 'expired'])('never advertises a %s snapshot as usable', async status => withKit(async (kit, v) => {
    v.seed(); v.setStatus(status);
    expect(await kit.invokeAction('prepare-inspect', { nativeOperation: reference(operation) }, { surface: 'plugin' })).toMatchObject({ kind: 'failed' });
  }));

  it('deletes only the owned snapshot and build base and confirms both absent', async () => withKit(async (kit, v) => {
    v.seed();
    expect(await kit.invokeAction('prepare-destroy', { artifact: reference(artifact) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    expect(v.state).toEqual({ base: false, captured: false });
    expect(v.calls.filter(call => call.method === 'DELETE').map(call => call.url.pathname)).toEqual([
      '/v2/sandboxes/snapshots/snap_prepared', '/v2/sandboxes/' + acquisition.name,
    ]);
  }));

  it('retains pending cleanup while the provider still reports the owned artifact', async () => withKit(async (kit, v) => {
    v.seed(); v.holdDelete();
    expect(await kit.invokeAction('prepare-destroy', { artifact: reference(artifact) }, { surface: 'plugin' })).toMatchObject({ kind: 'pending' });
  }));

  it('refuses different ownership before deleting anything', async () => withKit(async (kit, v) => {
    v.seed(); v.wrongOwner();
    expect(await kit.invokeAction('prepare-destroy', { artifact: reference(artifact) }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'vercel_identity_mismatch' });
    expect(v.calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  }));

  it('refuses a retained reference from a different account scope before any native request', async () => withKit(async (kit, v) => {
    const foreign = { ...artifact, acquisition: { ...acquisition, teamId: 'team_other' } };
    expect(await kit.invokeAction('prepare-destroy', { artifact: reference(foreign) }, { surface: 'plugin' })).toEqual({ kind: 'refused', code: 'vercel_scope_mismatch' });
    expect(v.calls).toHaveLength(0);
  }));

  it('leaves a snapshot from a different sandbox untouched', async () => withKit(async (kit, v) => {
    v.seed(); v.foreignSnapshot();
    expect(await kit.invokeAction('prepare-destroy', { artifact: reference(artifact) }, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', code: 'vercel_cleanup_unqualified' });
    expect(v.calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  }));

  it('preserves authored HTTP boundary failure instead of reclassifying it as success', async () => {
    const v = vendor();
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the selected account' });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN,
      services: { ...v.services, http: { request: async () => { throw refusal; } } } as unknown as PluginTestServicesFixture });
    try { await expect(kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data }); }
    finally { await kit.dispose(); }
  });
});
