import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { DEVCONTAINER_PLUGIN } from '../manifest.js';
import { createDevcontainerPreparation, devcontainerPreparationOperation, resolveDevcontainerPreparationInput } from './preparation.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';

// Reuse the provider's external Lima marker boundary; ordinary tests have no
// reproduced bridge-DNS topology regardless of the executing host.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn(async (path: Parameters<typeof actual.access>[0], mode?: number) => {
    if (path === '/run/lima-boot-done') throw Object.assign(new Error('No Lima marker'), { code: 'ENOENT' });
    return actual.access(path, mode);
  }) };
});

const imageId = `sha256:${'a'.repeat(64)}`;
const contributionRef = { pluginId: 'happier.devcontainer', localId: 'devcontainer' };
const operationId = 'prepare-a';
const imageName = `happier-prepared-${Buffer.from(operationId).toString('hex')}`;
const cli = { identity: 'public-release:test', versionId: 'test', binaryPath: '/root/.local/bin/happier',
  installScript: 'printf cli > /cli', files: [] };
function buildInput(runtime: 'docker' | 'podman' = 'docker') {
  return { launch: { provider: contributionRef, schemaVersion: 1,
    choices: { runtime, configuration: { kind: 'image' as const, image: 'alpine:3.22' } } }, cli };
}
function nativeOperation(runtime: 'docker' | 'podman' = 'docker') {
  return devcontainerPreparationOperation(operationId, resolveDevcontainerPreparationInput(buildInput(runtime)));
}
function result(stdout: unknown, exitCode = 0): PluginProcessResult {
  return { stdout: Buffer.from(typeof stdout === 'string' ? stdout : JSON.stringify(stdout)), stderr: Buffer.alloc(0),
    stdoutTruncated: false, stderrTruncated: false,
    termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode } } };
}
function fixture(options: { runtime?: 'docker' | 'podman'; foreign?: 'tag' | 'provider'; interrupted?: boolean; unavailable?: boolean;
  payload?: string; recoverHostDns?: boolean } = {}) {
  const requests: Parameters<ExecService['run']>[0][] = [];
  let exists = Boolean(options.foreign);
  const run: ExecService['run'] = async request => {
    requests.push(request);
    expect(request.executable).toMatchObject({ id: { localId: options.runtime ?? 'docker' } });
    const args = request.args ?? [];
    if (options.unavailable) return result('', 1);
    if (args[0] === 'run' && options.recoverHostDns) return args.includes('bridge') ? result('', 2) : result('github.com');
    if (args[0] === 'build') {
      // No current-directory files, credentials or checkout are sent as build context.
      expect(await readdir(args.at(-1)!)).toEqual(options.payload ? ['happier-cli-payload.tar.gz'] : []);
      if (options.payload) expect(await readFile(join(args.at(-1)!, 'happier-cli-payload.tar.gz'), 'utf8')).toBe(options.payload);
      exists = true;
      if (options.interrupted) throw new Error('transport disconnected after build');
      return result('built');
    }
    if (args[1] === 'ls') return result(exists && !(options.foreign === 'tag' && args.at(-1)?.startsWith('label=')) ? imageId + '\n' : '');
    if (args[1] === 'inspect') return result([{ Id: imageId, Config: { Labels: options.foreign === 'tag' ? {} : {
      'happier.prepared-operation': operationId,
      'happier.prepared-provider': options.foreign === 'provider' ? 'another.provider/image' : 'happier.devcontainer/devcontainer',
    } } }]);
    if (args[1] === 'rm') { exists = false; return result('deleted'); }
    throw new Error(`Unexpected native command ${JSON.stringify(args)}`);
  };
  return { requests, run, native: createDevcontainerPreparation({ exec: { run },
    docker: { kind: 'managedDependency', id: { pluginId: contributionRef.pluginId, localId: options.runtime ?? 'docker' } },
    signal: new AbortController().signal }) };
}
describe('Devcontainer image preparation', () => {
  it('publishes the optional shared preparation role', () => {
    expect(DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners).toContainEqual(expect.objectContaining({
      id: 'devcontainer', preparation: expect.objectContaining({ actions: {
        build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy',
      } }),
    }));
  });
  it('bakes the canonical CLI input while preserving launch choices and unclassified setup', async () => {
    const h = fixture();
    const services = { exec: { run: h.run }, managedServices: { dependencies: { status: async () => ({ state: 'ready',
      executable: { kind: 'managedDependency', id: { pluginId: contributionRef.pluginId, localId: 'docker' } } }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      const input = { launch: { provider: contributionRef, schemaVersion: 1,
        choices: { workspaceFolder: '/project', configuration: { kind: 'image', image: 'alpine:3.22', setupScript: 'printf baked > /setup' } } },
        setupScript: 'test -f /cli && printf classified > /baked',
        cli: { identity: 'public-release:test', versionId: 'test', binaryPath: '/root/.local/bin/happier',
          installScript: 'printf cli > /cli', files: [] } };
      const ready = await kit.invokeAction('prepare-build', { operationId, input }, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { launch: {
        workspaceFolder: '/project', configuration: { kind: 'image', image: imageId, setupScript: 'printf baked > /setup' },
      } } } });
      const dockerfile = new TextDecoder().decode(h.requests.find(request => request.args?.[0] === 'build')?.stdin as Uint8Array);
      expect(dockerfile).toContain('FROM alpine:3.22');
      expect(dockerfile).toContain(input.cli.installScript);
      expect(dockerfile).toContain(input.setupScript);
      expect(dockerfile).not.toContain('printf baked > /setup');
      expect(await kit.invokeAction('prepare-inspect', { operationId, launch: input.launch.choices }, { surface: 'plugin' })).toMatchObject({ kind: 'ready' });
      expect(h.requests.filter(request => request.args?.[0] === 'build')).toHaveLength(1);
    } finally { await kit.dispose(); }
  });
  it('sends only the supplied Home CLI payload files and removes its temporary context', async () => {
    const h = fixture({ payload: 'canonical-archive-bytes' });
    const input = resolveDevcontainerPreparationInput(buildInput());
    const ready = await h.native.build(operationId, { ...input, cli: { ...input.cli, identity: 'home-payload:actual-id',
      files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: Buffer.from('canonical-archive-bytes').toString('base64') }] } });
    expect(ready).toMatchObject({ kind: 'ready' });
    const build = h.requests.find(request => request.args?.[0] === 'build');
    const dockerfile = new TextDecoder().decode(build?.stdin as Uint8Array);
    expect(dockerfile).toContain('COPY ["happier-cli-payload.tar.gz","/opt/happier-build/happier-cli-payload.tar.gz"]');
    expect(dockerfile).not.toMatch(/^(USER|WORKDIR) /mu);
    await expect(readdir(build!.args!.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses payload traversal before any file escapes its owned build context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-prepare-boundary-'));
    const sentinel = join(directory, 'sentinel');
    await writeFile(sentinel, 'unchanged');
    try {
      const h = fixture();
      const input = resolveDevcontainerPreparationInput(buildInput());
      expect(await h.native.build(operationId, { ...input, cli: { ...input.cli, files: [{
        path: `../${basename(directory)}/sentinel`, contentsBase64: Buffer.from('unexpected').toString('base64'),
      }] } })).toMatchObject({ kind: 'refused', code: 'invalid_request' });
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
      expect(h.requests.some(request => request.args?.[0] === 'build')).toBe(false);
    } finally { await rm(directory, { recursive: true }); }
  });
  it('keeps authored advanced configuration cold until a clean context can be supplied', async () => {
    const h = fixture();
    const input = buildInput();
    const resolved = resolveDevcontainerPreparationInput({ ...input, launch: { ...input.launch,
      choices: { workspaceFolder: '/project', configPath: '/project/.devcontainer/devcontainer.json', configuration: { kind: 'file' } } } });
    expect(await h.native.build(operationId, resolved)).toMatchObject({ kind: 'refused', code: 'prepared_configuration_unavailable' });
    expect(h.requests).toHaveLength(0);
  });
  it('uses the existing Lima bridge-DNS diagnosis for CLI image builds', async () => {
    vi.mocked(access).mockResolvedValueOnce(undefined);
    const h = fixture({ recoverHostDns: true });
    expect(await h.native.build(operationId, resolveDevcontainerPreparationInput(buildInput()))).toMatchObject({ kind: 'ready' });
    expect(h.requests.find(request => request.args?.[0] === 'build')?.args)
      .toEqual(expect.arrayContaining(['--network', 'host']));
  });
  it.each(['docker', 'podman'] as const)('builds once with %s from the clean CLI input and deletes the owned image', async runtime => {
    const h = fixture({ runtime });
    const services = { exec: { run: h.run }, managedServices: { dependencies: { status: async () => ({ state: 'ready',
      executable: { kind: 'managedDependency', id: { pluginId: contributionRef.pluginId, localId: runtime } } }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      const ready = await kit.invokeAction('prepare-build', { operationId, input: buildInput(runtime) }, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { contributionRef, schemaVersion: 1,
        value: { operationId, runtime, imageId } } });
      const build = h.requests.find(request => request.args?.[0] === 'build');
      expect(new TextDecoder().decode(build?.stdin as Uint8Array)).toContain(cli.installScript);
      expect(build?.args).toEqual(expect.arrayContaining(['--file', '-', '--tag', imageName]));
      expect(build?.args).toContain('--force-rm');
      expect(build?.args).not.toEqual(expect.arrayContaining(['--secret', '--ssh', '--build-arg']));
      await kit.invokeAction('prepare-build', { operationId, input: buildInput(runtime) }, { surface: 'plugin' });
      expect(h.requests.filter(request => request.args?.[0] === 'build')).toHaveLength(1);
      const reference = { contributionRef, schemaVersion: 1, value: { ...nativeOperation(runtime), imageId,
        launch: { runtime, configuration: { kind: 'image', image: imageId } } } };
      expect(await kit.invokeAction('prepare-inspect', { nativeOperation: reference }, { surface: 'plugin' })).toMatchObject({ kind: 'ready' });
      expect(await kit.invokeAction('prepare-destroy', { artifact: reference }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(h.requests.find(request => request.args?.[1] === 'rm')?.args).toEqual(['image', 'rm', '--no-prune', '--', imageId]);
    } finally { await kit.dispose(); }
  });
  it.each(['tag', 'provider'] as const)('never builds over or deletes a foreign %s image', async foreign => {
    const h = fixture({ foreign });
    expect(await h.native.build(operationId, resolveDevcontainerPreparationInput(buildInput())))
      .toMatchObject({ kind: 'refused', code: 'prepared_artifact_not_owned' });
    expect(await h.native.destroy({ ...nativeOperation(), imageId }))
      .toMatchObject(foreign === 'tag' ? { kind: 'confirmed' } : { kind: 'refused', code: 'prepared_artifact_not_owned' });
    expect(h.requests.some(request => request.args?.[0] === 'build' || request.args?.[1] === 'rm')).toBe(false);
  });
  it('retains the derived native identity after an interrupted build without issuing a second build', async () => {
    const h = fixture({ interrupted: true });
    const pending = await h.native.build(operationId, resolveDevcontainerPreparationInput(buildInput()));
    expect(pending).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId, runtime: 'docker' } } });
    expect(await h.native.inspect(nativeOperation())).toMatchObject({ kind: 'ready' });
    expect(h.requests.filter(request => request.args?.[0] === 'build')).toHaveLength(1);
  });
  it('does not claim absence or deletion when the native runtime cannot answer', async () => {
    const h = fixture({ unavailable: true });
    expect(await h.native.destroy(nativeOperation())).toMatchObject({ kind: 'unknown' });
    expect(h.requests.some(request => request.args?.[1] === 'rm')).toBe(false);
  });
});
