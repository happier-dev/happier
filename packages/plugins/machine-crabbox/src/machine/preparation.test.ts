import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { CRABBOX_PLUGIN } from '../manifest.js';

const contributionRef = { pluginId: 'happier.machine.crabbox', localId: 'crabbox' };
const operationId = 'prepare-clean';
const imageId = `sha256:${'a'.repeat(64)}`;
const launch = { backendId: 'local-container', transport: 'direct', namespace: 'local', target: 'linux',
  nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
const input = { launch: { provider: contributionRef, schemaVersion: 1, choices: launch },
  cli: { identity: 'public:test', versionId: 'test', binaryPath: '/opt/happier/.local/bin/happier',
    installScript: 'test -f payload && printf cli > /cli', files: [{ path: 'payload', contentsBase64: Buffer.from('clean-cli').toString('base64') }] },
  setupScript: 'test -f /cli && printf setup > /setup' };
function result(stdout: unknown, exitCode = 0): PluginProcessResult {
  return { stdout: Buffer.from(typeof stdout === 'string' ? stdout : JSON.stringify(stdout)), stderr: Buffer.alloc(0),
    stdoutTruncated: false, stderrTruncated: false,
    termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } } };
}
async function fixture(options: { foreign?: boolean; interrupted?: boolean; unavailable?: boolean; podman?: boolean } = {}) {
  let exists = Boolean(options.foreign);
  const requests: Parameters<ExecService['run']>[0][] = [];
  const run: ExecService['run'] = async request => {
    requests.push(request);
    const args = request.args ?? [];
    if (options.unavailable) return result('', 1);
    if (args[0] === 'build') {
      expect(await readdir(args.at(-1)!)).toEqual(['payload']);
      expect(await readFile(join(args.at(-1)!, 'payload'), 'utf8')).toBe('clean-cli');
      exists = true;
      if (options.interrupted) throw new Error('reply lost after native commit');
      return result('built');
    }
    if (args[1] === 'ls') return result(exists ? options.podman ? imageId.slice(7) : imageId : '');
    if (args[1] === 'inspect') return result([{ Id: options.podman ? imageId.slice(7) : imageId, Config: { Labels: options.foreign ? {} : {
      'happier.prepared-operation': operationId, 'happier.prepared-provider': 'happier.machine.crabbox/crabbox',
    } } }]);
    if (args[1] === 'rm') { exists = false; return result('removed'); }
    throw new Error('Unexpected native command');
  };
  // Only the native process and dependency adapters are substituted.
  const services = { exec: { run }, managedServices: { dependencies: { status: async () => ({ state: 'ready',
    executable: { kind: 'managedDependency', id: { pluginId: contributionRef.pluginId, localId: 'docker' } } }) } } } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: CRABBOX_PLUGIN.manifest, module: CRABBOX_PLUGIN, services });
  return { kit, requests };
}
describe('Crabbox clean image preparation', () => {
  it('builds CLI and setup without a leased guest, recovers by operation, and deletes only its owned tag', async () => {
    const h = await fixture();
    try {
      const ready = await h.kit.invokeAction('prepare-build', { operationId, input }, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { contributionRef, value: { imageId, launch: { ...launch, nativeImageId: imageId } } } });
      const build = h.requests.find(request => request.args?.[0] === 'build')!;
      const dockerfile = new TextDecoder().decode(build.stdin);
      expect(dockerfile).toContain(`FROM --platform=linux/${process.arch === 'x64' ? 'amd64' : 'arm64'} ubuntu:24.04`);
      expect(dockerfile).toContain(input.cli.installScript);
      expect(dockerfile).toContain(input.setupScript);
      expect(build.args).not.toEqual(expect.arrayContaining(['--secret', '--ssh', '--build-arg']));
      await expect(readdir(build.args!.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await h.kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toMatchObject({ kind: 'ready' });
      expect(await h.kit.invokeAction('prepare-destroy', { artifact: (ready as { artifact: unknown }).artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      const removal = h.requests.find(request => request.args?.[1] === 'rm')!;
      expect(removal.args).toEqual(['image', 'rm', '--no-prune', '--', `happier-crabbox-prepared-${Buffer.from(operationId).toString('hex')}:latest`]);
    } finally { await h.kit.dispose(); }
  });
  it('keeps interrupted build identity recoverable without starting a second build', async () => {
    const h = await fixture({ interrupted: true });
    try {
      expect(await h.kit.invokeAction('prepare-build', { operationId, input }, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId } } });
      expect(await h.kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toMatchObject({ kind: 'ready' });
      expect(h.requests.filter(request => request.args?.[0] === 'build')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });
  it('refuses a foreign tag collision before writing or deleting', async () => {
    const h = await fixture({ foreign: true });
    try {
      expect(await h.kit.invokeAction('prepare-build', { operationId, input }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'prepared_artifact_not_owned' });
      const operation = { contributionRef, schemaVersion: 1, value: { operationId, launch } };
      expect(await h.kit.invokeAction('prepare-destroy', { nativeOperation: operation }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'prepared_artifact_not_owned' });
      expect(h.requests.some(request => request.args?.[0] === 'build' || request.args?.[1] === 'rm')).toBe(false);
    } finally { await h.kit.dispose(); }
  });
  it('reports an unavailable native store as unknown, never absent', async () => {
    const h = await fixture({ unavailable: true });
    try { expect(await h.kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toMatchObject({ kind: 'unknown' }); }
    finally { await h.kit.dispose(); }
  });
  it('accepts Podman native full IDs without a sha256 prefix', async () => {
    const h = await fixture({ podman: true });
    try {
      const podman = { ...input, launch: { ...input.launch, choices: { ...launch, localContainerRuntime: 'podman' } } };
      expect(await h.kit.invokeAction('prepare-build', { operationId, input: podman }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'ready', artifact: { value: { imageId } } });
    } finally { await h.kit.dispose(); }
  });
  it('refuses payload traversal before invoking a native build', async () => {
    const h = await fixture();
    try {
      expect(await h.kit.invokeAction('prepare-build', { operationId, input: { ...input, cli: { ...input.cli,
        files: [{ path: '../escape', contentsBase64: '' }] } } }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'refused', code: 'invalid_request' });
      expect(h.requests.some(request => request.args?.[0] === 'build')).toBe(false);
    } finally { await h.kit.dispose(); }
  });
});
