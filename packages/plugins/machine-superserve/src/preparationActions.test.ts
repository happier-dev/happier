import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerPreparationBuildResultV1Schema, MachineProvisionerPreparationInspectResultV1Schema, MachineProvisionerPreparationDestroyResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';

const ref = <T>(value: T) => ({ contributionRef: { pluginId: 'happier.machine.superserve', localId: 'superserve' }, schemaVersion: 1, value });
const seed = { sandboxId: 'seed-one', name: 'happier-prepared-build-one', managedId: 'prepared-build-one' };
const operation = { name: seed.name, managedId: seed.managedId, seed, snapshotId: 'snapshot-one' };
const artifact = { ...operation, launch: { snapshot: 'snapshot-one' } };
const build = { operationId: 'build-one', input: {
  launch: { provider: ref({}).contributionRef, schemaVersion: 1, choices: { template: 'superserve/base' } },
  cli: { identity: 'fixture:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'printf cli', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAECAw==' }] }, setupScript: 'printf setup',
} };

it('builds, restores and retires a credential-free snapshot through public preparation Actions', async () => {
  const calls: { path: string; method: string; body?: unknown; credential: boolean }[] = [];
  let seedPresent = false, snapshotPresent = false;
  // Substitute the connected credential store and actual vendor HTTP boundary only.
  const services = { connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { 'x-api-key': 'fixture-account-key' } }) },
    http: { request: async (input: { url: string; method: string; headers?: Record<string, string>; body?: Uint8Array }) => {
      const response = (status: number, value?: unknown) => ({ status, finalUrl: input.url, headers: {},
        body: new TextEncoder().encode(value === undefined ? '' : JSON.stringify(value)) });
      const url = new URL(input.url), headers = new Headers(input.headers);
      const body: unknown = input.body?.length && headers.get('content-type') === 'application/json' ? JSON.parse(new TextDecoder().decode(input.body)) : undefined;
      calls.push({ path: url.pathname, method: input.method, body, credential: headers.has('x-api-key') });
      const dto = { id: seed.sandboxId, name: seed.name, status: 'active', metadata: { 'happier-managed-id': seed.managedId }, access_token: 'fixture-guest-key' };
      const snapshot = { id: 'snapshot-one', sandbox_id: seed.sandboxId, name: seed.name, status: 'ready' };
      if (url.origin === 'https://sandbox.superserve.ai') {
        expect(headers.has('x-api-key')).toBe(false);
        if (url.pathname === '/files') return response(200, { path: url.searchParams.get('path'), size: input.body?.length });
        return response(200, { exit_code: 0, stdout: JSON.stringify({ exitCode: 0, stdoutBase64: '', stderrBase64: '' }), stderr: '' });
      }
      if (url.pathname === '/sandboxes' && input.method === 'POST') {
        if (body && typeof body === 'object' && 'from_snapshot' in body) return response(201, {
          ...dto, id: 'restored-one', name: 'happier-restored', metadata: { 'happier-managed-id': 'restored' },
        });
        seedPresent = true; return response(201, dto);
      }
      if (url.pathname === '/sandboxes/seed-one/snapshot') { snapshotPresent = true; return response(201, snapshot); }
      if (url.pathname === '/sandboxes/seed-one/pause') return response(204);
      if (url.pathname === '/snapshots/snapshot-one') {
        if (input.method === 'DELETE') { snapshotPresent = false; return response(204); }
        return snapshotPresent ? response(200, snapshot) : response(404, {});
      }
      if (url.pathname === '/sandboxes/seed-one' && input.method === 'DELETE') { seedPresent = false; return response(204); }
      return seedPresent ? response(200, dto) : response(404, {});
    } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', build, { surface: 'plugin' }));
    expect(result).toEqual({ kind: 'ready', artifact: ref(artifact) });
    expect(seedPresent).toBe(true);
    expect(calls.find(call => call.path === '/sandboxes' && call.method === 'POST')?.body).toEqual({
      name: seed.name, from_template: 'superserve/base', metadata: { 'happier-managed-id': seed.managedId }, preview_access: 'private',
    });
    expect(calls.filter(call => call.path === '/sandboxes/seed-one/snapshot').map(call => call.body)).toEqual([{ name: seed.name, idempotency_key: seed.managedId }]);
    expect(JSON.stringify(calls.filter(call => call.body))).not.toContain('fixture-account-key');
    const beforeInspect = calls.length;
    const inspected = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { nativeOperation: ref(operation) }, { surface: 'plugin' }));
    expect(inspected).toEqual(result);
    expect(calls.slice(beforeInspect).every(call => call.method === 'GET')).toBe(true);
    expect(await kit.invokeAction('acquire', { launch: artifact.launch, managedId: 'restored' }, { surface: 'plugin' })).toMatchObject({
      kind: 'bound', resource: { value: { sandboxId: 'restored-one', managedId: 'restored' } },
    });
    expect(calls.filter(call => call.path === '/sandboxes' && call.method === 'POST').at(-1)?.body).toMatchObject({ from_snapshot: 'snapshot-one' });
    const destroyed = MachineProvisionerPreparationDestroyResultV1Schema.parse(await kit.invokeAction('prepare-destroy', { artifact: ref(artifact) }, { surface: 'plugin' }));
    expect(destroyed).toEqual({ kind: 'confirmed' });
    expect(snapshotPresent).toBe(false);
    expect(seedPresent).toBe(false);
    const deletion = calls.findIndex(call => call.path === '/snapshots/snapshot-one' && call.method === 'DELETE');
    expect(calls.slice(deletion + 1)).toContainEqual(expect.objectContaining({ path: '/snapshots/snapshot-one', method: 'GET' }));
  } finally { await kit.dispose(); }
});
