import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createPluginRegistryStateStore } from './currentState';
import { prepareOwnedImmutablePluginGeneration, readCurrentCommittedPluginGenerations, readPreparedImmutablePluginGeneration } from './generationStore';

it('restages committed private generations at startup without changing installation authority or private plugin data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-code-root-recovery-'));
  const happyHomeDir = join(root, 'custodian', '.happier');
  vi.stubEnv('HOME', join(root, 'custodian'));
  vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', '');
  vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '');
  const pluginId = 'acme.relocated-code';
  const manifest = createPluginManifestV2Fixture({ id: pluginId });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir, plugins: [{
    manifest, files: { 'daemon.mjs': 'export function activate() {}' },
  }] });
  try {
    const retained = fixture.committed.generations.get(pluginId);
    if (!retained?.installation?.trust || retained.installation.trust.distribution.kind !== 'localPath') {
      throw new Error('Fixture must have a reviewed local-path installation');
    }
    const oldStore = createPluginRegistryStateStore({ happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: fixture.controller }) });
    const firstCatalog = await oldStore.read();
    const trust = retained.installation.trust;
    if (trust.distribution.kind !== 'localPath') throw new Error('Fixture source must be a local path');
    const prepared = await prepareOwnedImmutablePluginGeneration({ paths: oldStore.paths, pluginId,
      sourceRootPath: trust.distribution.canonicalPath, manifestRelativePath: '.happier-plugin/plugin.json',
      distribution: trust.distribution, updatePolicy: 'allowed', createdAtMs: Date.now() });
    try {
      await oldStore.install({ pluginId, catalogRecord: firstCatalog.plugins[pluginId]!, trust,
        updatePolicy: 'allowed', optionalAccess: [], approvedAuthorityManifest: PluginManifestV2Schema.parse(manifest),
        preparedGeneration: prepared });
    } finally { await prepared.cleanup(); }
    const catalog = await oldStore.read();
    const prior = (await readCurrentCommittedPluginGenerations(oldStore.paths))!.generations.get(pluginId)!;
    const committedBytes = await readFile(oldStore.paths.registryCurrentFilePath, 'utf8');
    const privateFiles = [oldStore.paths.settingsDir, oldStore.paths.storageDir, oldStore.paths.secretsDir]
      .map(path => join(path, pluginId, 'retained.json'));
    for (const path of privateFiles) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'retained private plugin data', { mode: 0o600 });
    }
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', join(root, 'managed-install'));
    const store = createPluginRegistryStateStore({ happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: fixture.controller }) });
    expect(store.paths.generationsDir).not.toBe(oldStore.paths.generationsDir);
    // The original local-path source can disappear after installation. Startup
    // must use the daemon's reviewed generation, without installing it again.
    await rm(trust.distribution.canonicalPath, { recursive: true, force: true });
    await expect(store.initialize()).resolves.toEqual(catalog);
    const current = await readCurrentCommittedPluginGenerations(store.paths);
    const restaged = current?.generations.get(pluginId);
    expect(restaged).toMatchObject({ immutableGenerationId: prior.immutableGenerationId,
      record: prior.record, installation: prior.installation });
    expect(restaged?.rootPath).toBe(join(store.paths.generationsDir, prior.immutableGenerationId));
    await expect(readFile(join(restaged!.rootPath, 'daemon.mjs'), 'utf8'))
      .resolves.toBe('export function activate() {}');
    await expect(readFile(oldStore.paths.registryCurrentFilePath, 'utf8')).resolves.toBe(committedBytes);
    await expect(readFile(join(prior.rootPath, 'daemon.mjs'), 'utf8')).resolves.toBe('export function activate() {}');
    await expect(readPreparedImmutablePluginGeneration({ paths: store.paths,
      immutableGenerationId: retained.immutableGenerationId })).resolves.toMatchObject({ record: retained.record });
    if (process.platform !== 'win32') {
      expect((await stat(restaged!.rootPath)).mode & 0o777).toBe(0o755);
      expect((await stat(join(restaged!.rootPath, 'daemon.mjs'))).mode & 0o777).toBe(0o644);
    }
    // An already-published external generation never rereads the retained root.
    await rm(prior.rootPath, { recursive: true, force: true });
    await rm(retained.rootPath, { recursive: true, force: true });
    await expect(store.initialize()).resolves.toEqual(catalog);
    await store.rollback(pluginId);
    expect((await readCurrentCommittedPluginGenerations(store.paths))?.generations.get(pluginId)?.immutableGenerationId)
      .toBe(retained.immutableGenerationId);
    for (const path of privateFiles) await expect(readFile(path, 'utf8')).resolves.toBe('retained private plugin data');
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['retained source', 'external destination'] as const)('keeps a corrupt %s rejected during startup conversion', async (location) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-code-root-corrupt-'));
  const happyHomeDir = join(root, 'custodian', '.happier');
  vi.stubEnv('HOME', join(root, 'custodian'));
  vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', '');
  vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '');
  const pluginId = 'acme.corrupt-code';
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir, plugins: [{
    manifest: createPluginManifestV2Fixture({ id: pluginId }),
    files: { 'daemon.mjs': 'export function activate() {}' },
  }] });
  try {
    const prior = fixture.committed.generations.get(pluginId)!;
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', join(root, 'managed-install'));
    const failures: string[] = [];
    const store = createPluginRegistryStateStore({ happyHomeDir,
      onReconciliationPending: ({ message }) => { if (message) failures.push(message); } });
    const corruptRoot = location === 'retained source' ? prior.rootPath
      : join(store.paths.generationsDir, prior.immutableGenerationId);
    await mkdir(corruptRoot, { recursive: true });
    await writeFile(join(corruptRoot, 'plugin-generation.v1.json'), '{}');
    await store.initialize();
    const current = await readCurrentCommittedPluginGenerations(store.paths, { isolateInvalidInstalledGenerations: true });
    expect(current?.generations.has(pluginId)).toBe(false);
    expect(current?.rejectedGenerations.has(pluginId)).toBe(true);
    await expect(readFile(join(corruptRoot, 'plugin-generation.v1.json'), 'utf8')).resolves.toBe('{}');
    if (location === 'retained source') expect(failures.some(message => message.includes(pluginId))).toBe(true);
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
