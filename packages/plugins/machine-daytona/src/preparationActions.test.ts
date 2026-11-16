import { PluginError } from '@happier-dev/plugin-sdk';
import {
  MachineProvisionerPreparationBuildResultV1Schema,
  MachineProvisionerPreparationInspectResultV1Schema,
  MachineProvisionerPreparationDestroyResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import * as entry from './index.js';

const value = { name: 'happier-prepared-build-one', organizationId: 'org-one', snapshotId: 'snapshot-one' };
const nativeOperation = { contributionRef: { pluginId: 'happier.machine.daytona', localId: 'daytona' }, schemaVersion: 1, value };
const artifact = { ...nativeOperation, value: { ...value, launch: { snapshot: value.snapshotId } } };
const input = { operationId: 'build-one', input: {
  launch: { provider: { pluginId: 'happier.machine.daytona', localId: 'daytona' }, schemaVersion: 1, choices: { snapshot: 'selected-base' } },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier', installScript: 'set -eu\nprintf prepared\n', files: [] },
} };

function services(request: (request: { url: string; method: string; body?: Uint8Array }) => Promise<{ status: number; body: Uint8Array }>): PluginTestServicesFixture {
  // Substitute only the host credential store and Daytona HTTP transport.
  return {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-key' } }) },
    http: { request: async (input: { url: string; method: string; body?: Uint8Array }) => ({ finalUrl: input.url, headers: {}, ...await request(input) }) },
  } as unknown as PluginTestServicesFixture;
}
const response = (status: number, value: unknown) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)) });

describe('Daytona preparation through public Actions', () => {
  it('recovers by operation and launch in a fresh runtime without CLI or archive input', async () => {
    const calls: string[] = [];
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      const path = new URL(request.url).pathname;
      calls.push(request.method + ' ' + path);
      if (path === '/api/api-keys/current') return response(200, { organizationId: 'org-one' });
      return response(200, { id: value.snapshotId, name: value.name, organizationId: value.organizationId, state: 'active' });
    }) });
    try {
      const result = await kit.invokeAction('prepare-inspect', { operationId: 'build-one', launch: { snapshot: 'selected-base' } }, { surface: 'plugin' });
      expect(result).toEqual({ kind: 'ready', artifact });
      expect(calls).toEqual(['GET /api/api-keys/current', 'GET /api/snapshots/happier-prepared-build-one']);
    } finally { await kit.dispose(); }
  });

  it('builds, inspects and deletes through the six declared role input/result contracts', async () => {
    let state = 'building', present = true;
    const calls: string[] = [];
    // Provider-issued temporary storage uses the native HTTP boundary, separate
    // from the host's API-key-bearing Daytona transport.
    const storage = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/storage\.example\/builds\/org-one\//);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(headers.get('authorization')).not.toContain('fixture-key');
      expect(init?.body).toBeInstanceOf(Uint8Array);
      return new Response(null, { status: 200 });
    });
    let kit: Awaited<ReturnType<typeof createPluginTestkit>> | undefined;
    try {
      kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      const path = new URL(request.url).pathname;
      calls.push(request.method + ' ' + path);
      if (path === '/api/api-keys/current') return response(200, { organizationId: 'org-one' });
      if (path === '/api/object-storage/push-access') return response(200, { organizationId: 'org-one', accessKey: 'temporary-key', secret: 'temporary-secret',
        sessionToken: 'temporary-session', storageUrl: 'https://storage.example', bucket: 'builds', region: 'us-east-1' });
      if (path === '/api/snapshots/selected-base') return response(200, { id: 'base-id', name: 'selected-base', state: 'active', sandboxClass: 'container', ref: 'debian:bookworm-slim' });
      if (request.method === 'DELETE') { present = false; return { status: 200, body: new Uint8Array() }; }
      return present ? response(200, { id: value.snapshotId, name: value.name, organizationId: value.organizationId, state })
        : response(404, { message: 'not found' });
      }) });
      const localInput = { ...input, input: { ...input.input, cli: { ...input.input.cli,
        files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'AAECAw==' }] }, setupScript: 'printf setup\n' } };
      const pending = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', localInput, { surface: 'plugin' }));
      expect(pending).toEqual({ kind: 'pending', nativeOperationRef: nativeOperation });
      state = 'active';
      const ready = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { nativeOperation }, { surface: 'plugin' }));
      expect(ready).toEqual({ kind: 'ready', artifact });
      expect(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch: input.input.launch.choices }, { surface: 'plugin' })).toEqual(ready);
      const destroyed = MachineProvisionerPreparationDestroyResultV1Schema.parse(await kit.invokeAction('prepare-destroy', { artifact }, { surface: 'plugin' }));
      expect(destroyed).toEqual({ kind: 'confirmed' });
      expect(calls.filter(call => call.startsWith('POST '))).toEqual(['POST /api/snapshots']);
      expect(calls.filter(call => call.startsWith('DELETE '))).toEqual(['DELETE /api/snapshots/snapshot-one']);
      expect(storage).toHaveBeenCalledTimes(1);
    } finally { storage.mockRestore(); await kit?.dispose(); }
  });

  it('projects a native inspect refusal into the shared unknown union with its cleanup reference', async () => {
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN,
      services: services(async () => response(403, { message: 'private-vendor-detail' })) });
    try {
      const result = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { nativeOperation }, { surface: 'plugin' }));
      expect(result).toEqual({ kind: 'unknown', code: 'credential_unavailable', nativeOperationRef: nativeOperation });
      expect(JSON.stringify(result)).not.toContain('private-vendor-detail');
    } finally { await kit.dispose(); }
  });

  it.each(['prepare-build', 'prepare-inspect', 'prepare-destroy'])('preserves typed plugin boundary failure through %s', async action => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the account',
      failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: null, httpStatus: null } });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async () => { throw refusal; }) });
    try {
      await expect(kit.invokeAction(action, action === 'prepare-build' ? input
        : action === 'prepare-inspect' ? { nativeOperation } : { artifact }, { surface: 'plugin' }))
        .rejects.toMatchObject({ data: refusal.data });
    } finally { await kit.dispose(); }
  });
});
