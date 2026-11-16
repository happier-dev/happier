import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { createSuperservePreparationClient, PREPARATION_SCHEMAS } from './preparation.js';

const sourceId = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const seed = { sandboxId: 'sb-use-' + sourceId, name: 'happier-prepared-build-one', managedId: 'prepared-build-one' };
const operation = { name: seed.name, managedId: seed.managedId, seed, snapshotId: 'snapshot-one' };
const artifact = { ...operation, launch: { snapshot: 'snapshot-one' } };
const input = { operationId: 'build-one', input: {
  launch: { provider: { pluginId: 'happier.machine.superserve', localId: 'superserve' }, schemaVersion: 1, choices: { template: 'chosen/base' } },
  cli: { identity: 'fixture:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier', installScript: 'printf cli', files: [] },
} };

// Native REST 0.1.0 fixtures: a snapshot outlives its source; the source remains
// discoverable through status=deleted and its scoped snapshot list still works.
function vendor() {
  const calls: { url: URL; method: string; body?: Record<string, unknown> }[] = [];
  let seedStatus: string | undefined, snapshotStatus: string | undefined;
  let snapshotReadFailure = false, loseSnapshot = false, loseSeed = false, failSetup = false;
  let deletionPending = false, staleCapture = false, snapshotSource = sourceId;
  const seedDto = () => ({ id: seed.sandboxId, name: seed.name, status: seedStatus, metadata: { 'happier-managed-id': seed.managedId }, access_token: 'guest-only' });
  const snapshotDto = () => ({ id: 'snapshot-one', sandbox_id: snapshotSource, name: seed.name, status: snapshotStatus });
  const request: typeof fetch = async (url, init) => {
    const req = new Request(url, init), location = new URL(req.url), method = req.method;
    const body = req.headers.get('content-type') === 'application/json' && req.body ? await req.json() as Record<string, unknown> : undefined;
    calls.push({ url: location, method, body });
    req.signal.throwIfAborted();
    if (location.origin === 'https://sandbox.superserve.ai') {
      expect(req.headers.has('x-api-key')).toBe(false);
      return Response.json({ exit_code: 0, stdout: JSON.stringify({ exitCode: failSetup ? 1 : 0, stdoutBase64: '', stderrBase64: '' }), stderr: '' });
    }
    if (location.pathname === '/sandboxes' && method === 'POST') {
      seedStatus = 'active'; if (loseSeed) throw new Error('lost create');
      return Response.json(seedDto(), { status: 201 });
    }
    if (location.pathname === '/sandboxes') {
      expect(location.searchParams.get('metadata.happier-managed-id')).toBe(seed.managedId);
      return Response.json(seedStatus && (seedStatus !== 'deleted' || location.searchParams.get('status') === 'deleted') ? [seedDto()] : []);
    }
    if (location.pathname === '/sandboxes/' + seed.sandboxId + '/snapshot') {
      snapshotStatus ??= 'ready'; if (loseSnapshot) throw new Error('lost snapshot response');
      return Response.json(snapshotDto(), { status: snapshotStatus === 'creating' ? 202 : 201 });
    }
    if (location.pathname === '/sandboxes/' + seed.sandboxId + '/snapshots') return Response.json(snapshotStatus ? [snapshotDto()] : []);
    if (location.pathname === '/snapshots/snapshot-one') {
      if (snapshotReadFailure) return Response.json({ detail: 'private-vendor-error' }, { status: 503 });
      if (method === 'DELETE') {
        if (snapshotStatus === 'creating' && !staleCapture) return Response.json({ error: { code: 'snapshot_creating' } }, { status: 409 });
        snapshotStatus = deletionPending ? 'deleting' : undefined;
        return deletionPending ? Response.json({ status: 'deleting' }, { status: 202 }) : new Response(null, { status: 204 });
      }
      return snapshotStatus ? Response.json(snapshotDto()) : Response.json({}, { status: 404 });
    }
    if (location.pathname === '/sandboxes/' + seed.sandboxId + '/activate') return Response.json(seedDto());
    if (location.pathname === '/sandboxes/' + seed.sandboxId + '/pause') { seedStatus = 'paused'; return new Response(null, { status: 204 }); }
    if (location.pathname === '/sandboxes/' + seed.sandboxId && method === 'DELETE') { seedStatus = 'deleted'; return new Response(null, { status: 204 }); }
    if (location.pathname === '/sandboxes/' + seed.sandboxId) return seedStatus ? Response.json(seedDto()) : Response.json({}, { status: 404 });
    throw new Error('Uncharacterized native route: ' + location);
  };
  return { request, calls,
    setSeed(status: string) { seedStatus = status; }, setSnapshot(status: string | undefined) { snapshotStatus = status; },
    loseSnapshot() { loseSnapshot = true; }, loseSeed() { loseSeed = true; }, failSetup() { failSetup = true; },
    failRead() { snapshotReadFailure = true; }, deferDeletion() { deletionPending = true; }, foreignSnapshot() { snapshotSource = 'other-seed'; },
    settleStaleCapture() { staleCapture = true; },
  };
}

describe('Superserve owned preparation recovery', () => {
  it('adopts an orphaned snapshot using only operationId after its seed was deleted, without reallocating', async () => {
    const v = vendor(); v.setSeed('deleted'); v.setSnapshot('ready');
    const result = await createSuperservePreparationClient(v.request).inspect({ operationId: 'build-one', launch: { template: 'chosen/base' } });
    expect(PREPARATION_SCHEMAS.inspectResult.parse(result)).toMatchObject({ kind: 'ready', artifact: { value: artifact } });
    expect(v.calls.some(call => call.url.searchParams.get('status') === 'deleted')).toBe(true);
    expect(v.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('recovers a lost snapshot response by the source list and retires both owned resources', async () => {
    const v = vendor(); v.loseSnapshot();
    const client = createSuperservePreparationClient(v.request), built = await client.build(input);
    expect(built).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { seed } } });
    if (built.kind !== 'unknown' || !built.nativeOperationRef) throw new Error('Missing recovery identity');
    const beforeInspect = v.calls.length;
    expect(await client.inspect({ nativeOperation: built.nativeOperationRef.value })).toMatchObject({ kind: 'ready', artifact: { value: artifact } });
    expect(v.calls.slice(beforeInspect).every(call => call.method === 'GET')).toBe(true);
    expect(await client.destroy({ artifact })).toEqual({ kind: 'confirmed' });
    expect(v.calls.filter(call => call.method === 'POST' && call.url.pathname === '/sandboxes')).toHaveLength(1);
    expect(v.calls.filter(call => call.method === 'POST' && call.url.pathname.endsWith('/snapshot'))).toHaveLength(1);
  });

  it.each(['lost-create', 'setup-failed'])('retains a paid seed for cleanup after %s without claiming it can complete by waiting', async failure => {
    const v = vendor(); failure === 'lost-create' ? v.loseSeed() : v.failSetup();
    const client = createSuperservePreparationClient(v.request);
    if (failure === 'lost-create') expect(await client.build(input)).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: seed.name } } });
    else expect(await client.build(input)).toMatchObject({ kind: 'unknown', code: 'superserve_preparation_setup_failed',
      nativeOperationRef: { value: { seed } }, nativeCause: { localCause: 'native_command_failed', exitCode: 1 } });
    const inspected = await client.inspect({ operationId: 'build-one', launch: { template: 'chosen/base' } });
    expect(inspected).toMatchObject({ kind: 'failed', code: 'superserve_preparation_interrupted', nativeOperationRef: { value: { seed } } });
    if (inspected.kind !== 'failed' || !inspected.nativeOperationRef) throw new Error('Missing cleanup identity');
    expect(await client.destroy({ nativeOperation: inspected.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
    expect(v.calls.filter(call => call.method === 'POST' && call.url.pathname === '/sandboxes')).toHaveLength(1);
    expect(v.calls.some(call => call.url.pathname.endsWith('/snapshot'))).toBe(false);
  });

  it('keeps native capture and asynchronous deletion pending until the provider confirms absence', async () => {
    const v = vendor(); v.setSnapshot('creating');
    const client = createSuperservePreparationClient(v.request);
    expect(await client.build(input)).toMatchObject({ kind: 'pending' });
    expect(await client.destroy({ nativeOperation: operation })).toMatchObject({ kind: 'pending' });
    expect(v.calls.filter(call => call.url.pathname === '/snapshots/snapshot-one' && call.method === 'DELETE')).toHaveLength(1);
    expect(v.calls.some(call => call.url.pathname === '/sandboxes/' + seed.sandboxId && call.method === 'DELETE')).toBe(false);
    v.setSnapshot('ready'); v.deferDeletion();
    expect(PREPARATION_SCHEMAS.destroyResult.parse(await client.destroy({ artifact }))).toMatchObject({ kind: 'pending', nativeOperationRef: { value: operation } });
    expect(v.calls.some(call => call.url.pathname === '/sandboxes/' + seed.sandboxId && call.method === 'DELETE')).toBe(false);
    v.setSnapshot(undefined);
    expect(await client.destroy({ nativeOperation: operation })).toEqual({ kind: 'confirmed' });
  });

  it('lets native deletion remove an eligible stale creating snapshot without a competing local timer', async () => {
    const v = vendor(); v.setSeed('active'); v.setSnapshot('creating'); v.settleStaleCapture();
    expect(await createSuperservePreparationClient(v.request).destroy({ nativeOperation: operation })).toEqual({ kind: 'confirmed' });
    expect(v.calls.filter(call => call.url.pathname === '/snapshots/snapshot-one').map(call => call.method)).toEqual(['GET', 'DELETE', 'GET']);
  });

  it('retains clean operation identity on an artifact read failure and never exposes vendor detail', async () => {
    const v = vendor(); v.setSeed('deleted'); v.setSnapshot('ready'); v.failRead();
    const result = PREPARATION_SCHEMAS.destroyResult.parse(await createSuperservePreparationClient(v.request).destroy({ artifact }));
    expect(result).toMatchObject({ kind: 'unknown', code: 'superserve_http_503', nativeOperationRef: { value: operation } });
    expect(JSON.stringify(result)).not.toContain('private-vendor-error');
    expect(v.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('retains the paid seed cleanup identity when its snapshot was removed independently', async () => {
    const v = vendor(); v.setSeed('paused');
    const client = createSuperservePreparationClient(v.request);
    expect(await client.inspect({ nativeOperation: operation })).toMatchObject({ kind: 'failed',
      code: 'superserve_snapshot_absent', nativeOperationRef: { value: operation } });
    expect(v.calls.every(call => call.method === 'GET')).toBe(true);
    expect(await client.destroy({ nativeOperation: operation })).toEqual({ kind: 'confirmed' });
    expect(await client.inspect({ nativeOperation: operation })).toEqual({ kind: 'absent' });
  });

  it('rejects a snapshot whose source does not match the owned seed before deletion', async () => {
    const v = vendor(); v.setSeed('deleted'); v.setSnapshot('ready'); v.foreignSnapshot();
    expect(await createSuperservePreparationClient(v.request).destroy({ nativeOperation: operation })).toMatchObject({ kind: 'unknown', code: 'superserve_identity_mismatch' });
    expect(v.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('refuses a secret-inheriting snapshot as a preparation base without affecting cold snapshot launch', async () => {
    const v = vendor();
    expect(await createSuperservePreparationClient(v.request).build({ ...input, input: { ...input.input,
      launch: { ...input.input.launch, choices: { snapshot: 'person-snapshot' } } } })).toEqual({ kind: 'refused', code: 'superserve_preparation_snapshot_base_unsupported' });
    expect(v.calls).toEqual([]);
  });

  it('retains cancellation correlation, and propagates typed host failures', async () => {
    const controller = new AbortController(); let calls = 0;
    const request: typeof fetch = async (_url, init) => { calls++; expect(init?.signal).toBe(controller.signal); controller.abort(); throw controller.signal.reason; };
    expect(await createSuperservePreparationClient(request, controller.signal).build(input)).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: seed.name, managedId: seed.managedId } } });
    expect(calls).toBe(1);
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Host refusal' });
    const refused: typeof fetch = async () => { throw refusal; };
    await expect(createSuperservePreparationClient(refused).build(input)).rejects.toBe(refusal);
  });
});
