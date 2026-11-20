import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import * as entry from './index.js';

const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
const labels = { 'happier-preparation': 'build-one' };
const ref = <T>(value: T) => ({ contributionRef: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' }, schemaVersion: 1, value });
const operation = { operationId: 'build-one', launch, serverId: 41, primaryIpIds: [61] };
const input = { operationId: operation.operationId, input: {
  launch: { provider: ref(null).contributionRef, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier', installScript: 'set -eu\nprintf installed\n', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAEC' }] },
  setupScript: 'printf setup\n',
} };
const response = (status: number, value: unknown) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)) });
const absent = () => response(404, { error: { code: 'not_found' } });

function fixture(options: { lostCreate?: boolean; failCreateAction?: boolean; setupPending?: boolean; foreign?: boolean; foreignImage?: boolean; deletePending?: boolean; failSnapshot?: boolean; failSnapshotAction?: boolean; lostSnapshot?: boolean; error?: PluginError } = {}) {
  let server = false, image = false, ip = false, snapshotting = false;
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const serverValue = () => ({ id: 41, status: options.setupPending ? 'running' : 'off', labels: options.foreign ? { 'happier-preparation': 'someone-else' } : labels,
    public_net: { ipv4: { id: 61, ip: '192.0.2.1' }, ipv6: null } });
  const imageValue = () => ({ id: 71, type: 'snapshot', status: snapshotting ? 'creating' : 'available',
    labels: { ...(options.foreignImage ? { 'happier-preparation': 'someone-else' } : labels), 'happier-build-server': '41', 'happier-build-ips': '61' } });
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-secret' } }) },
    machineProvisioners: { waitForNativeObservation: async () => { snapshotting = false; if (options.setupPending) throw new DOMException('Cancelled', 'AbortError'); } },
    http: { request: async (request: { url: string; method: string; body?: Uint8Array }) => {
      if (options.error) throw options.error;
      const url = new URL(request.url), path = url.pathname;
      const body = request.body && JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
      calls.push({ path, method: request.method, ...(body ? { body } : {}) });
      let reply;
      if (path === '/v1/servers' && request.method === 'POST') {
        server = ip = true;
        if (options.lostCreate) throw new TypeError('response lost');
        reply = response(201, { server: serverValue(), action: { id: 1, status: options.failCreateAction ? 'error' : 'success' } });
      } else if (path === '/v1/servers/41/actions/create_image') {
        if (options.failSnapshot) return { finalUrl: request.url, headers: {}, ...response(503, { error: { code: 'service_unavailable' } }) };
        image = snapshotting = true;
        if (options.lostSnapshot) throw new TypeError('response lost');
        reply = response(201, { image: imageValue(), action: { id: 2, status: 'running' } });
      } else if (path === '/v1/servers/41/actions/2') reply = response(200, { action: { id: 2, status: options.failSnapshotAction ? 'error' : 'success' } });
      else if (path === '/v1/servers/41') {
        if (request.method === 'DELETE' && !options.deletePending) server = false;
        reply = server ? response(200, { server: serverValue() }) : absent();
      } else if (path === '/v1/images/71') {
        if (request.method === 'DELETE' && !options.deletePending) image = false;
        reply = image ? response(200, { image: imageValue() }) : absent();
      } else if (path === '/v1/primary_ips/61') {
        if (request.method === 'DELETE' && !options.deletePending) ip = false;
        reply = ip ? response(200, { primary_ip: { id: 61 } }) : absent();
      } else if (path === '/v1/servers') reply = response(200, { servers: server ? [serverValue()] : [], meta: { pagination: { next_page: null } } });
      else if (path === '/v1/images') reply = response(200, { images: image ? [imageValue()] : [], meta: { pagination: { next_page: null } } });
      else throw new Error('Unexpected request ' + request.method + ' ' + path);
      return { finalUrl: request.url, headers: {}, ...reply };
    } },
  } as unknown as PluginTestServicesFixture; // Only credential, transport and native-observation wait boundaries are replaced.
  return { services, calls, settle: () => { snapshotting = false; }, resources: () => ({ server, image, ip }) };
}
async function kitFor(native: ReturnType<typeof fixture>) {
  return createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: native.services });
}

describe('Hetzner credential-free preparation through public Actions', () => {
  it.skipIf(process.platform === 'win32').each(['exit 0', 'false'])('executes standalone install/setup with success-only shutdown after %s', async setup => {
    const native = fixture(), kit = await kitFor(native), directory = mkdtempSync(join(tmpdir(), 'hetzner-cloud-init-'));
    try {
      await kit.invokeAction('prepare-build', { ...input, input: { ...input.input,
        cli: { ...input.input.cli, binaryPath: join(directory, 'installed'),
          installScript: 'printf installed > "$INSTALL_MARKER"\nchmod +x "$INSTALL_MARKER"\nexit 0' },
        setupScript: setup === 'false' ? 'false\nprintf wrong > "$SETUP_MARKER"' : 'printf setup > "$SETUP_MARKER"\nexit 0',
      } }, { surface: 'plugin' });
      const create = native.calls.find(call => call.path === '/v1/servers' && call.method === 'POST')!.body!;
      const data = JSON.parse(String(create.user_data).slice('#cloud-config\n'.length)) as {
        write_files: { path: string; content: string; encoding?: string }[]; runcmd: string[][];
      };
      // Map the guest filesystem and power-management tools at the OS boundary;
      // execute the generated shell unchanged apart from those absolute roots.
      const mapPaths = (value: string) => value.split(directory).map(part => part.replace(/\/(tmp|var|etc)(?=\/)/g, prefix => directory + prefix)).join(directory);
      const binaries = join(directory, 'bin'); mkdirSync(binaries);
      for (const command of ['rm', 'cloud-init', 'passwd', 'poweroff']) writeFileSync(join(binaries, command),
        '#!/bin/sh\n' + (command === 'poweroff' ? 'touch "$SHUTDOWN_MARKER"\n' : 'exit 0\n'), { mode: 0o700 });
      for (const file of data.write_files) {
        const path = mapPaths(file.path); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.encoding === 'b64' ? Buffer.from(file.content, 'base64') : mapPaths(file.content), { mode: 0o700 });
      }
      const shutdown = join(directory, 'shutdown'), installed = join(directory, 'installed'), configured = join(directory, 'configured');
      const command = data.runcmd[0]!.map(mapPaths);
      const executed = spawnSync(command[0]!, command.slice(1), { env: { ...process.env, PATH: binaries + ':' + process.env.PATH,
        SHUTDOWN_MARKER: shutdown, INSTALL_MARKER: installed, SETUP_MARKER: configured }, encoding: 'utf8' });
      expect(executed.status, executed.stderr).toBe(setup === 'false' ? 1 : 0);
      expect(existsSync(shutdown)).toBe(setup !== 'false');
      expect(existsSync(installed)).toBe(true);
      expect(existsSync(configured)).toBe(setup !== 'false');
    } finally { await kit.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses the native 32KiB user-data overflow before allocation', async () => {
    const native = fixture(), kit = await kitFor(native);
    try {
      const large = { ...input, input: { ...input.input, setupScript: 'x'.repeat(32 * 1024) } };
      expect(await kit.invokeAction('prepare-build', large, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'native_preparation_userdata_too_large' });
      expect(native.calls.some(call => call.method === 'POST')).toBe(false);
      const near = { ...input, input: { ...input.input, setupScript: 'x'.repeat(30 * 1024) } };
      expect(await kit.invokeAction('prepare-build', near, { surface: 'plugin' })).toMatchObject({ kind: 'ready' });
    } finally { await kit.dispose(); }
  });

  it('inspects an existing operation before a repeated build can allocate again', async () => {
    const native = fixture({ lostCreate: true }), kit = await kitFor(native);
    try {
      await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', code: 'native_preparation_interrupted' });
      expect(native.calls.filter(call => call.method === 'POST' && call.path === '/v1/servers')).toHaveLength(1);
    } finally { await kit.dispose(); }
  });

  it('builds only a clean guest, snapshots after successful shutdown, retires temporary resources, then confirms image deletion', async () => {
    const native = fixture(), kit = await kitFor(native);
    try {
      const ready = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { imageId: 71, launch: { ...launch, imageId: '71' } } } });
      expect(native.resources()).toEqual({ server: false, image: true, ip: false });
      const create = native.calls.find(call => call.path === '/v1/servers' && call.method === 'POST')!.body!;
      expect(create).not.toHaveProperty('ssh_keys');
      expect(create.labels).toEqual(labels);
      const userData = String(create.user_data);
      expect(userData).toContain('printf installed');
      expect(userData).toContain('printf setup');
      expect(userData).toContain('AAEC');
      expect(userData).not.toMatch(/fixture-secret|authorized_keys|daemon start|auth login/);
      expect(userData).toContain('poweroff');
      expect(native.calls.filter(call => call.path.endsWith('/create_image'))).toHaveLength(1);
      expect(native.calls.find(call => call.path.endsWith('/create_image'))?.body?.labels).toMatchObject(labels);
      const recovered = await kit.invokeAction('prepare-inspect', { operationId: operation.operationId, launch }, { surface: 'plugin' });
      expect(recovered).toEqual(ready);
      const artifact = (ready as { artifact: unknown }).artifact;
      expect(await kit.invokeAction('prepare-destroy', { artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.resources()).toEqual({ server: false, image: false, ip: false });
    } finally { await kit.dispose(); }
  });

  it.each(['lostCreate', 'lostSnapshot'] as const)('recovers %s using operation labels without a second create', async lost => {
    const native = fixture({ [lost]: true }), kit = await kitFor(native);
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId: operation.operationId } } });
      native.settle();
      const result = await kit.invokeAction('prepare-inspect', { operationId: operation.operationId, launch }, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'failed', code: lost === 'lostSnapshot' ? 'native_preparation_cleanup_required' : 'native_preparation_interrupted', nativeOperationRef: ref(operation) });
      if (lost === 'lostSnapshot') expect(native.resources()).toEqual({ server: true, image: true, ip: true });
      const value = result as { artifact?: unknown; nativeOperationRef?: unknown };
      expect(await kit.invokeAction('prepare-destroy', value.artifact ? { artifact: value.artifact } : { nativeOperation: value.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.calls.filter(call => call.path === '/v1/servers' && call.method === 'POST')).toHaveLength(1);
      expect(native.calls.filter(call => call.path.endsWith('/create_image'))).toHaveLength(lost === 'lostSnapshot' ? 1 : 0);
      expect(native.resources()).toEqual({ server: false, image: false, ip: false });
    } finally { await kit.dispose(); }
  });

  it('leaves unsuccessful setup pending, supports cancellation and deletes the exact owned build', async () => {
    const native = fixture({ setupPending: true }), kit = await kitFor(native);
    try {
      await expect(kit.invokeAction('prepare-build', input, { surface: 'plugin' })).rejects.toMatchObject({ data: { code: 'plugin_action_aborted' } });
      const inspected = await kit.invokeAction('prepare-inspect', { operationId: operation.operationId, launch }, { surface: 'plugin' });
      expect(inspected).toMatchObject({ kind: 'pending', nativeOperationRef: ref(operation) });
      expect(native.calls.some(call => call.path.endsWith('/create_image'))).toBe(false);
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: ref(operation) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.resources()).toEqual({ server: false, image: false, ip: false });
    } finally { await kit.dispose(); }
  });

  it('refuses foreign ownership labels before any destructive effect', async () => {
    const native = fixture({ lostCreate: true, foreign: true }), kit = await kitFor(native);
    try {
      await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: ref(operation) }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'native_identity_mismatch' });
      expect(native.calls.some(call => call.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('refuses a mismatching retained source identity before deletion', async () => {
    const native = fixture({ lostCreate: true }), kit = await kitFor(native);
    try {
      await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: ref({ ...operation, serverId: 42 }) }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'refused', code: 'native_identity_mismatch' });
      expect(native.calls.some(call => call.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('retains the cleanup identity after a foreign snapshot response and refuses its deletion', async () => {
    const native = fixture({ foreignImage: true }), kit = await kitFor(native);
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', code: 'native_identity_mismatch', nativeOperationRef: ref(operation) });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: ref(operation) }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'refused', code: 'native_identity_mismatch' });
      expect(native.calls.some(call => call.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('does not snapshot a stopped guest whose native create action failed', async () => {
    const native = fixture({ failCreateAction: true }), kit = await kitFor(native);
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', code: 'native_action_failed', nativeOperationRef: ref(operation) });
      expect(native.calls.some(call => call.path.endsWith('/create_image'))).toBe(false);
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: ref(operation) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); }
  });

  it('refuses a mismatching artifact identity before deleting an image', async () => {
    const native = fixture(), kit = await kitFor(native);
    try {
      const ready = await kit.invokeAction('prepare-build', input, { surface: 'plugin' }) as { artifact: ReturnType<typeof ref<{ imageId: number }>> };
      const before = native.calls.filter(call => call.method === 'DELETE').length;
      expect(await kit.invokeAction('prepare-destroy', { artifact: { ...ready.artifact, value: { ...ready.artifact.value, imageId: 72 } } }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'refused', code: 'native_identity_mismatch' });
      expect(native.calls.filter(call => call.method === 'DELETE')).toHaveLength(before);
      expect(native.resources().image).toBe(true);
    } finally { await kit.dispose(); }
  });

  it.each(['prepare-build', 'prepare-inspect', 'prepare-destroy'])('preserves the host typed failure through %s', async action => {
    const error = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect account' });
    const native = fixture({ error }), kit = await kitFor(native);
    try {
      await expect(kit.invokeAction(action, action === 'prepare-build' ? input : action === 'prepare-inspect'
        ? { operationId: operation.operationId, launch } : { nativeOperation: ref(operation) }, { surface: 'plugin' })).rejects.toMatchObject({ data: error.data });
    } finally { await kit.dispose(); }
  });

  it('does not report cleanup confirmed while an exact owned resource remains', async () => {
    const native = fixture({ lostCreate: true, deletePending: true }), kit = await kitFor(native);
    try {
      await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: ref(operation) }, { surface: 'plugin' })).toMatchObject({ kind: 'pending' });
    } finally { await kit.dispose(); }
  });

  it.each(['failSnapshot', 'failSnapshotAction'] as const)('retains the cleanup reference after %s', async failure => {
    const native = fixture({ [failure]: true }), kit = await kitFor(native);
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'unknown',
        code: failure === 'failSnapshot' ? 'native_service_unavailable' : 'native_snapshot_failed', nativeOperationRef: ref(operation) });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: ref(operation) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); }
  });
});
