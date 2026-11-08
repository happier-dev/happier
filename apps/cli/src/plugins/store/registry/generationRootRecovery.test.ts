import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createPluginRegistryStateStore } from './currentState';
import { prepareOwnedImmutablePluginGeneration, readCurrentCommittedPluginGenerations } from './generationStore';

it('recovers an old private generation through uninstall and reinstall while preserving its settings, state and secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-code-root-recovery-'));
  const happyHomeDir = join(root, 'custodian', '.happier');
  vi.stubEnv('HOME', join(root, 'custodian'));
  vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '');
  const pluginId = 'acme.relocated-code';
  const manifest = createPluginManifestV2Fixture({ id: pluginId });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir, plugins: [{
    manifest, files: { 'daemon.mjs': 'export function activate() {}' },
  }] });
  try {
    const prior = fixture.committed.generations.get(pluginId);
    if (!prior?.installation?.trust || prior.installation.trust.distribution.kind !== 'localPath') {
      throw new Error('Fixture must have a reviewed local-path installation');
    }
    const trust = prior.installation.trust;
    const distribution = trust.distribution;
    if (distribution.kind !== 'localPath') throw new Error('Fixture source must be a local path');
    const oldStore = createPluginRegistryStateStore({ happyHomeDir });
    const catalog = (await oldStore.read()).plugins[pluginId]!;
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
    const missing = await readCurrentCommittedPluginGenerations(store.paths, { isolateInvalidInstalledGenerations: true });
    expect(missing?.rejectedGenerations.has(pluginId)).toBe(true);
    const install = async () => {
      const candidate = await prepareOwnedImmutablePluginGeneration({ paths: store.paths, pluginId,
        sourceRootPath: distribution.canonicalPath,
        manifestRelativePath: '.happier-plugin/plugin.json', distribution,
        updatePolicy: 'allowed', createdAtMs: Date.now() });
      try {
        return await store.install({ pluginId, catalogRecord: catalog, trust,
          updatePolicy: 'allowed', optionalAccess: [], approvedAuthorityManifest: PluginManifestV2Schema.parse(manifest),
          preparedGeneration: candidate });
      } finally { await candidate.cleanup(); }
    };
    // Ordinary replacement retains rollback bytes and therefore cannot silently
    // reinterpret a missing predecessor generation as an available one.
    await expect(install()).rejects.toMatchObject({ code: 'ENOENT' });
    await store.uninstall(pluginId);
    await expect(install()).resolves.toMatchObject({ status: 'committed' });
    expect((await readCurrentCommittedPluginGenerations(store.paths))?.generations.get(pluginId)?.rootPath)
      .toContain(store.paths.generationsDir);
    for (const path of privateFiles) await expect(readFile(path, 'utf8')).resolves.toBe('retained private plugin data');
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
