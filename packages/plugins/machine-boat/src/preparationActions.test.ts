import { createHash } from 'node:crypto';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import * as entry from './index.js';

const operationId = 'build-one';
const name = 'happier-prepared-' + createHash('sha256').update(operationId).digest('hex').slice(0, 46);
const launch = { size: 'small', source: { kind: 'blank' } };
const input = { operationId, input: {
  launch: { provider: { pluginId: 'happier.machine.boat', localId: 'boat' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'printf prepared', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAECAw==' }] },
  setupScript: 'printf setup',
} };
type Request = { url: string; method: string; body?: Uint8Array };
const response = (status: number, value: unknown) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)) });
function fixture(options: { lost?: 'create' | 'command' | 'save'; cancelled?: boolean; foreign?: boolean; refused?: boolean; failed?: boolean; deletePending?: boolean; deleteBlocked?: boolean } = {}) {
  let guest = false, saved = false, status = 'saving', waits = 0, deletionAccepted = false;
  const calls: Request[] = [];
  const snapshot = () => ({ name, sourceSandboxId: options.foreign ? 'bx_abcdefgh' : 'bx_23456789', snapshotId: 'snap-one', createdAt: '2026-11-15T00:00:00Z', status });
  const request = async (request: Request) => {
    calls.push(request);
    const path = new URL(request.url).pathname, method = request.method;
    if (path.endsWith('/limits')) return response(200, { ok: true, type: 'limits.info', sandboxPlanKey: 'paid' });
    if ((path.endsWith('/sandboxes') || path.endsWith('/fork')) && method === 'POST') {
      if (options.refused) return response(403, { ok: false, code: 'api_key_action_forbidden' });
      guest = true;
      if (options.lost === 'create') throw new TypeError('lost private response');
      return response(202, { ok: true, sandbox: { id: 'bx_23456789' } });
    }
    if (path.endsWith('/sandboxes')) return response(200, { ok: true, type: 'sandbox.list', sandboxes: guest ? [{ id: 'bx_23456789' }] : [] });
    if (path.endsWith('/sandboxes/bx_23456789')) {
      if (method === 'DELETE') { deletionAccepted = true; if (!options.deletePending && !options.deleteBlocked) guest = false; return response(202, { ok: true, type: 'sandbox.deleting', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', status: 'pending' } }); }
      return guest ? response(200, { ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: options.failed ? 'cancelled' : 'ready' } }) : response(404, { ok: false, code: 'not_found' });
    }
    if (path.includes('/deletion-operations/')) return response(200, { ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', status: options.deleteBlocked ? 'blocked' : 'pending' } });
    if (path.endsWith('/files/upload-url')) return response(200, { ok: true, type: 'file.upload_url', url: 'https://upload.example/private', method: 'PUT', expiresAt: '2026-11-15T00:15:00Z', path: JSON.parse(new TextDecoder().decode(request.body)).path });
    if (path.endsWith('/commands') && method === 'POST') {
      if (options.lost === 'command') throw new TypeError('lost reply');
      return response(200, { ok: true, type: 'command.started', success: true, processId: 42, pid: 42, command: JSON.parse(new TextDecoder().decode(request.body)).command, startedAt: '2026-11-15T00:00:00Z' });
    }
    if (path.endsWith('/commands/42')) return response(200, { ok: true, type: 'command.status', success: true, processId: 42, status: 'exited', running: false, exitCode: 0, stdout: '', stderr: '' });
    if (path.endsWith('/saved-snapshots') && method === 'POST') {
      saved = true;
      if (options.lost === 'save') throw new TypeError('lost response');
      return response(202, { ok: true, type: 'snapshot.saved.saving', status, snapshot: snapshot() });
    }
    if (path.endsWith('/saved-snapshots/' + name)) {
      if (method === 'DELETE') { saved = false; return response(200, { ok: true, type: 'snapshot.saved.deleted', name, status: 'deleted' }); }
      return saved ? response(200, { ok: true, type: 'snapshot.saved.info', snapshot: snapshot() }) : response(404, { ok: false, code: 'not_found' });
    }
    throw new Error('Unexpected ' + method + ' ' + path);
  };
  const services = { connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-private' } }) },
    http: { request: async (input: Request) => ({ finalUrl: input.url, headers: {}, ...await request(input) }) },
    machineProvisioners: { waitForNativeObservation: async () => { waits++; status = 'ready'; if (deletionAccepted) guest = false; if (options.cancelled) throw new DOMException('Cancelled', 'AbortError'); } },
  } as unknown as PluginTestServicesFixture;
  return { calls, services, setReady: () => { status = 'ready'; }, hasGuest: () => guest, hasSnapshot: () => saved, waits: () => waits };
}

describe('Boat native preparation through public Actions', () => {
  it('builds a credential-free cold guest, saves its image, confirms guest deletion and launches by name', async () => {
    const native = fixture();
    const upload = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: native.services });
    try {
      const ready = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { name, sourceSandboxId: 'bx_23456789', launch: { size: 'small', source: { kind: 'named-snapshot', name } } } } });
      expect(native.hasGuest()).toBe(false);
      expect(ready.kind === 'ready' && ready.artifact.value.name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
      expect(native.waits()).toBe(1);
      const create = native.calls.find(call => call.method === 'POST' && new URL(call.url).pathname.endsWith('/sandboxes'));
      expect(JSON.parse(new TextDecoder().decode(create?.body))).toMatchObject({ noEnv: true, snapshots: true, type: 'small', labels: { 'happier-managed-id': operationId } });
      const command = native.calls.find(call => call.method === 'POST' && new URL(call.url).pathname.endsWith('/commands'));
      const commandBody = JSON.parse(new TextDecoder().decode(command?.body));
      expect(commandBody).toMatchObject({ detached: true });
      expect(commandBody.command).toContain(input.input.cli.installScript);
      expect(commandBody.command).toContain(input.input.setupScript);
      expect(commandBody.command).not.toMatch(/fixture-private|auth login|daemon start/);
      expect(upload.mock.calls[0]?.[1]?.headers).toBeUndefined();
      expect(new Uint8Array(await new Response(upload.mock.calls[0]?.[1]?.body).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
      if (ready.kind !== 'ready') throw new Error('Expected ready');
      expect(await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toEqual(ready);
      expect(await kit.invokeAction('prepare-destroy', { artifact: ready.artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.hasSnapshot()).toBe(false);
    } finally { upload.mockRestore(); await kit.dispose(); }
  });

  it('refuses to bake a live fork source before creating any paid guest', async () => {
    const native = fixture();
    const upload = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: native.services });
    try {
      const result = await kit.invokeAction('prepare-build', { ...input, input: { ...input.input,
        launch: { ...input.input.launch, choices: { size: 'small', source: { kind: 'fork', sandboxId: 'bx_abcdefgh' } } },
      } }, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'refused', code: 'boat_preparation_source_unsupported' });
      expect(native.calls.filter(call => call.method === 'POST')).toEqual([]);
    } finally { upload.mockRestore(); await kit.dispose(); }
  });

  it.each(['create', 'command', 'save'] as const)('recovers a lost %s reply without replaying an effect and cleans retained resources', async lost => {
    const native = fixture({ lost });
    const upload = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: native.services });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name } } });
      native.setReady();
      const recovered = await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
      expect(recovered.kind).toBe(lost === 'save' ? 'failed' : 'pending');
      const writes = native.calls.filter(call => call.method !== 'GET').length;
      await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
      expect(native.calls.filter(call => call.method !== 'GET')).toHaveLength(writes);
      if (lost === 'save') {
        expect(recovered).toMatchObject({ code: 'boat_builder_cleanup_required', nativeOperationRef: { value: { sandboxId: 'bx_23456789' } } });
        expect(native.hasGuest()).toBe(true);
        expect(native.calls.filter(call => call.method === 'DELETE')).toEqual([]);
        expect(native.calls.filter(call => call.method === 'POST' && new URL(call.url).pathname.endsWith('/saved-snapshots'))).toHaveLength(1);
      }
      if (result.kind !== 'unknown') throw new Error('Expected retained reference');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.hasGuest()).toBe(false); expect(native.hasSnapshot()).toBe(false);
    } finally { upload.mockRestore(); await kit.dispose(); }
  });

  it.each(['foreign', 'refused', 'failed', 'cancelled', 'deletePending', 'deleteBlocked'] as const)('retains safe cleanup identity for %s without false success', async key => {
    const native = fixture({ [key]: true });
    const upload = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: native.services });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(result.kind).toBe(key === 'refused' ? 'refused' : key === 'deletePending' ? 'ready' : 'unknown');
      if (key === 'foreign') {
        if (result.kind !== 'unknown') throw new Error('Expected identity retained');
        expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'boat_snapshot_identity_mismatch' });
        expect(native.calls.filter(call => call.method === 'DELETE')).toEqual([]);
      }
      if (key === 'deleteBlocked') { expect(result).toMatchObject({ code: 'native_delete_blocked', nativeOperationRef: { value: { sandboxId: 'bx_23456789' } } }); expect(native.hasGuest()).toBe(true); }
      if (key === 'deletePending') { expect(native.hasGuest()).toBe(false); expect(native.waits()).toBe(2); }
      if (key === 'failed') expect(native.calls.some(call => new URL(call.url).pathname.endsWith('/commands'))).toBe(false);
    } finally { upload.mockRestore(); await kit.dispose(); }
  });
});
