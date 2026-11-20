import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerPreparationBuildResultV1Schema, MachineProvisionerPreparationInspectResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';

const launch = { from: 'base', vcpu: 1, memoryMib: 1024, diskGib: 5 };
const name = 'happier-prepared-operation-one';
const builderName = name + '-builder';
const sandbox = (id: string, sandboxName: string, extra = {}) => ({ id, name: sandboxName, state: 'running', forEndUser: true,
  dataPlaneUrl: 'https://api-' + id + '.sb.mtm.sh/v1', secret: 'sandbox-only-secret', ...extra });
const snapshot = { name, sourceSandboxId: 'sbx-builder', resources: { vcpu: 1, memoryMib: 1024, diskGib: 5 }, storedBytes: 100, screen: 'none', createdAt: '2026-11-16T08:00:00Z' };
const input = { operationId: 'operation-one', input: { launch: { provider: { pluginId: 'happier.machine.maritime', localId: 'maritime-sandbox' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'release:0.3', versionId: '0.3', binaryPath: '/opt/happier/cli/happier', installScript: 'printf install', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAEC' }] }, setupScript: 'printf setup' } };

function vendor(options: { injectSecrets?: boolean; commandFails?: boolean; interruptSave?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const boxes = new Map<string, ReturnType<typeof sandbox>>();
  let saved: (Omit<typeof snapshot, 'sourceSandboxId' | 'resources'> & { sourceSandboxId: string | null; resources: typeof snapshot.resources | null }) | null = null;
  const http = async (request: { url: string; method: string; body?: Uint8Array }) => {
    const path = new URL(request.url).pathname;
    const body: unknown = request.body?.length ? JSON.parse(new TextDecoder().decode(request.body)) : undefined;
    calls.push({ method: request.method, path, body });
    const answer = (status: number, value: unknown) => ({ status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
    if (path === '/v1/sandboxes' && request.method === 'POST') {
      const fields = body as { name: string; forEndUser: boolean };
      const box = sandbox(fields.name === builderName ? 'sbx-builder' : 'sbx-launch', fields.name, { forEndUser: !options.injectSecrets });
      boxes.set(box.id, box); return answer(201, box);
    }
    if (path.endsWith('/save')) { saved = snapshot; if (options.interruptSave) throw new Error('connection lost'); return answer(200, snapshot); }
    if (path.startsWith('/v1/snapshots/')) {
      if (request.method === 'DELETE') { saved = null; return answer(200, { deleted: true }); }
      return saved ? answer(200, saved) : answer(404, { code: 'snapshot_not_found' });
    }
    if (path.startsWith('/v1/sandboxes/')) {
      const id = decodeURIComponent(path.slice('/v1/sandboxes/'.length));
      const box = [...boxes.values()].find(b => b.id === id || b.name === id);
      if (request.method === 'DELETE') { if (box) boxes.delete(box.id); return answer(200, { deleted: true }); }
      return box ? answer(200, box) : answer(404, { code: 'sandbox_not_found' });
    }
    throw new Error('Unexpected control-plane request ' + request.method + ' ' + path);
  };
  // Only the vendor control/data HTTP and host credential store are substituted.
  const services = { connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer account-only-key' } }) },
    http: { request: http } } as unknown as PluginTestServicesFixture;
  const data = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api-sbx-(builder|launch)\.sb\.mtm\.sh\/v1\/(commands|files)/);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull(); expect(headers.get('x-maritime-token')).toBe('sandbox-only-secret');
    if (new URL(String(url)).pathname.endsWith('/files')) {
      expect(init?.body).toBeInstanceOf(Uint8Array);
      const path = new URL(String(url)).searchParams.get('path');
      if (path?.startsWith('/tmp/.happier-input.') && init?.body instanceof Uint8Array) writeFileSync(path, init.body);
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init?.body)) as { cmd: string[] };
    if (body.cmd[0] === 'mktemp' || body.cmd[0] === 'sh' && (body.cmd[2]?.startsWith('umask 077;') || body.cmd[2]?.startsWith('trap '))) {
      // This boundary models the Linux guest, including its real binary shell IO.
      const result = spawnSync(body.cmd[0], body.cmd.slice(1), { encoding: 'utf8' });
      return Response.json({ state: 'exited', exitCode: result.status, stdout: result.stdout, stderr: result.stderr, truncated: false });
    }
    const probing = body.cmd.join(' ').includes('uname -s');
    return Response.json({ state: 'exited', exitCode: options.commandFails && !probing ? 7 : 0, stdout: probing ? 'Linux\nx86_64\n/root\n' : 'ok', stderr: '', truncated: false });
  });
  return { calls, boxes, services, data, setSnapshot(value: NonNullable<typeof saved>) { saved = value; } };
}

describe('Maritime native sandbox and preparation through public Actions', () => {
  it('runs installation and setup as root when the native base command user requires passwordless sudo', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'maritime-guest-'));
    const binaryPath = join(directory, 'happier');
    // Model only guest OS executables: Maritime base docs install under /home/user.
    // The effect itself requires UID0; this sudo boundary changes the child identity.
    writeFileSync(join(directory, 'id'), '#!/bin/sh\nprintf "%s\\n" "$MARITIME_TEST_UID"\n', { mode: 0o700 });
    writeFileSync(join(directory, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && [ "$2" = -- ] || exit 74\nshift 2\nexport MARITIME_TEST_UID=0\nexec "$@"\n', { mode: 0o700 });
    writeFileSync(join(directory, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const v = vendor();
    v.data.mockImplementation(async (_url, init) => {
      const { cmd } = JSON.parse(String(init?.body)) as { cmd: string[] };
      const result = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', env: { ...process.env,
        PATH: directory + ':' + process.env.PATH, MARITIME_TEST_UID: '1000', MARITIME_TEST_BIN: binaryPath } });
      return Response.json({ state: 'exited', exitCode: result.status, stdout: result.stdout, stderr: result.stderr, truncated: false });
    });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('prepare-build', { ...input, input: { ...input.input,
        cli: { ...input.input.cli, binaryPath, files: [],
          installScript: '[ "$(id -u)" = 0 ] || exit 73; touch "$MARITIME_TEST_BIN"; /bin/chmod +x "$MARITIME_TEST_BIN"' },
        setupScript: '[ "$(id -u)" = 0 ] || exit 73' } }, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'ready' });
    } finally { await kit.dispose(); v.data.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('builds without account-secret injection, launches saved image, executes and destroys both native resources', async () => {
    const v = vendor(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const options = await kit.invokeAction('sandbox-options', {}, { surface: 'plugin' });
      const projected = projectMachineProvisionerSelectionV1({ options, selection: {}, launchSchema: entry.SANDBOX_PROVISIONER.launchSchema });
      expect(projected).toMatchObject({ kind: 'ready', launch, nativeFacts: { preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' } } });
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      expect(built).toMatchObject({ kind: 'ready', artifact: { contributionRef: { localId: 'maritime-sandbox' }, value: { name, sourceSandboxId: 'sbx-builder', launch: { ...launch, from: name } } } });
      if (built.kind !== 'ready') throw new Error('Expected prepared snapshot');
      expect(v.boxes.size).toBe(0);
      const create = v.calls.find(c => c.method === 'POST' && c.path === '/v1/sandboxes');
      expect(create?.body).toEqual({ ...launch, name: builderName, forEndUser: true, env: {}, keepAwake: true });
      const inspected = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' }));
      expect(inspected).toEqual(built);
      const acquired = await kit.invokeAction('sandbox-acquire', { launch: built.artifact.value.launch, managedId: 'warm-launch' }, { surface: 'plugin' });
      expect(acquired).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'sbx-launch', name: 'happier-warm-launch' } } });
      const resource = { sandboxId: 'sbx-launch', name: 'happier-warm-launch' };
      expect(await kit.invokeAction('sandbox-bootstrap', { resource }, { surface: 'plugin' })).toMatchObject({ kind: 'native', transport: { contributionRef: { localId: 'maritime-sandbox' } } });
      expect(await kit.invokeAction('sandbox-exec', { resource, argv: ['printf', 'ok'], allowWake: false }, { surface: 'plugin' })).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
      expect(await kit.invokeAction('sandbox-destroy', { resource }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(await kit.invokeAction('prepare-destroy', { artifact: built.artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(v.boxes.size).toBe(0);
      expect(JSON.stringify(built)).not.toMatch(/sandbox-only-secret|account-only-key/);
    } finally { await kit.dispose(); v.data.mockRestore(); }
  });

  it.each([{ injectSecrets: true, code: 'maritime_builder_secret_exclusion_unconfirmed' }, { commandFails: true, code: 'maritime_preparation_command_failed' }])('retains cleanup reference and never saves unsafe builder: %s', async failure => {
    const v = vendor(failure); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: 'unknown', code: failure.code, nativeOperationRef: { value: { name, launch } } });
      if (failure.code === 'maritime_preparation_command_failed') expect(result).toMatchObject({ nativeCause: {
        localCause: 'native_command_failed', command: 'run', exitCode: 7,
      } });
      expect(v.calls.some(c => c.path.endsWith('/save'))).toBe(false);
      if (result.kind !== 'unknown') throw new Error('Expected cleanup reference');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(v.boxes.size).toBe(0);
    } finally { await kit.dispose(); v.data.mockRestore(); }
  });

  it('adopts a completed save after response loss and cleans its leftover builder in a new runtime', async () => {
    const v = vendor({ interruptSave: true }); let kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'unknown' });
      await kit.dispose(); kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
      v.setSnapshot({ ...snapshot, sourceSandboxId: null });
      const ready = await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { sourceSandboxId: 'sbx-builder' } } }); expect(v.boxes.size).toBe(0);
    } finally { await kit.dispose(); v.data.mockRestore(); }
  });

  it.each(['somebody-else', null])('never deletes a stock template or a saved snapshot from a different builder: %s', async sourceSandboxId => {
    const v = vendor(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      v.setSnapshot({ ...snapshot, sourceSandboxId, resources: sourceSandboxId === null ? null : snapshot.resources });
      expect(await kit.invokeAction('prepare-destroy', { artifact: { contributionRef: { pluginId: 'happier.machine.maritime', localId: 'maritime-sandbox' }, schemaVersion: 1,
        value: { name, sourceSandboxId: snapshot.sourceSandboxId, launch: { ...launch, from: name } } } }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'maritime_snapshot_identity_mismatch' });
      expect(v.calls.some(c => c.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); v.data.mockRestore(); }
  });

  it('settles an unfinished builder as interrupted and deletes it on the next admission without build input', async () => {
    const v = vendor(); v.boxes.set('sbx-builder', sandbox('sbx-builder', builderName));
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'failed', code: 'maritime_preparation_interrupted' });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: { contributionRef: { pluginId: 'happier.machine.maritime', localId: 'maritime-sandbox' }, schemaVersion: 1,
        value: { name, launch } } }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(v.boxes.size).toBe(0); expect(v.calls.some(c => c.method === 'POST')).toBe(false);
    } finally { await kit.dispose(); v.data.mockRestore(); }
  });

  it('recovers and deletes a saved snapshot after the source sandbox identity is no longer returned', async () => {
    const v = vendor(); v.setSnapshot({ ...snapshot, sourceSandboxId: null });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'ready', artifact: { value: { name, launch: { ...launch, from: name } } } });
      if (result.kind !== 'ready') throw new Error('Expected saved snapshot');
      expect(await kit.invokeAction('prepare-destroy', { artifact: result.artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); v.data.mockRestore(); }
  });

  it.each(['prepare-build', 'prepare-inspect', 'prepare-destroy'])('preserves typed host credential refusals through %s', async action => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the account' });
    const services = { connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture' } }) },
      http: { request: async () => { throw refusal; } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
    try {
      const operation = { contributionRef: { pluginId: 'happier.machine.maritime', localId: 'maritime-sandbox' }, schemaVersion: 1, value: { name, launch } };
      await expect(kit.invokeAction(action, action === 'prepare-build' ? input : { nativeOperation: operation }, { surface: 'plugin' })).rejects.toMatchObject({ code: refusal.code });
    } finally { await kit.dispose(); }
  });

  it('preserves binary stdin, both output channels and exit status across the native text API', async () => {
    const v = vendor(); v.boxes.set('sbx-launch', sandbox('sbx-launch', 'happier-warm-launch'));
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('sandbox-exec', { resource: { sandboxId: 'sbx-launch', name: 'happier-warm-launch' },
        argv: ['sh', '-c', 'cat; printf "\\000\\377\\200" >&2; exit 7'], inputBase64: 'AP+A', allowWake: false }, { surface: 'plugin' });
      expect(result).toMatchObject({ stdoutBase64: 'AP+A', stderrBase64: 'AP+A', termination: { observed: { kind: 'exit', exitCode: 7 } }, stdoutTruncated: false, stderrTruncated: false });
    } finally { await kit.dispose(); v.data.mockRestore(); }
  });
});
