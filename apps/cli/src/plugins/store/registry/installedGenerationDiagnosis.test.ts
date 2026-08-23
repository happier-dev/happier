import { mkdir, mkdtemp, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../configuration', () => ({
  configuration: { happyHomeDir: join(tmpdir(), 'unused-installed-doctor-home') },
}));

import { resolvePluginStorePaths } from '../paths';
import type { PluginRegistryCommitRecord } from './commitRecord';
import {
  persistInstallationStateRevision,
  prepareImmutablePluginGeneration,
  type PluginInstallationStateRevision,
} from './generationStore';
import { diagnoseInstalledPluginGenerations } from './installedGenerationDiagnosis';

const PLUGIN_ID = 'acme.plugin';

const MANIFEST_TEXT = JSON.stringify({
  schemaVersion: 2,
  id: PLUGIN_ID,
  version: '1.0.0',
  displayName: 'Acme',
  engines: { happier: '^0.2.0' },
  runtime: { apiVersion: 1 },
  contributes: {},
});

function stateRevision(generationId: string): PluginInstallationStateRevision {
  return {
    t: 'happier_plugin_installations_v1',
    schemaVersion: 1,
    revisionId: 'state-1',
    createdAtMs: 1,
    plugins: {
      [PLUGIN_ID]: {
        enabled: true,
        trust: {
          pluginId: PLUGIN_ID,
          distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
          state: 'trusted',
          approvedAtMs: 1,
        },
        source: { distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' } },
        updatePolicy: 'manual',
        optionalAccess: [],
      },
    },
    rollbackRetention: [],
  };
}

async function seedInstalledGeneration(): Promise<Readonly<{
  paths: ReturnType<typeof resolvePluginStorePaths>;
  generationRootPath: string;
  happyHomeDir: string;
  sourceRootPath: string;
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-installed-doctor-home-'));
  const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-installed-doctor-source-'));
  const paths = resolvePluginStorePaths({ happyHomeDir });
  const daemonText = 'export default "daemon"';
  await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
  await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), MANIFEST_TEXT, 'utf8');
  await writeFile(join(sourceRootPath, 'daemon.mjs'), daemonText, 'utf8');

  const prepared = await prepareImmutablePluginGeneration({
    paths,
    sourceRootPath,
    record: {
      t: 'happier_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: PLUGIN_ID,
      immutableGenerationId: 'generation-a',
      createdAtMs: 1,
      sourceProvenance: 'localSource',
      manifestRelativePath: '.happier-plugin/plugin.json',
      files: [
        { relativePath: '.happier-plugin/plugin.json', byteLength: Buffer.byteLength(MANIFEST_TEXT) },
        { relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(daemonText) },
      ],
    },
  });
  const installationState = await persistInstallationStateRevision({
    paths,
    state: stateRevision('generation-a'),
  });
  const commit: PluginRegistryCommitRecord = {
    t: 'happier_plugin_registry_commit_v1',
    schemaVersion: 1,
    revision: 0,
    transactionId: 'tx-a',
    baseRevision: null,
    installationState,
    pluginGenerations: { [PLUGIN_ID]: prepared.reference },
    createdAtMs: 1,
    creator: { pid: 42, instanceId: 'daemon-a' },
  };
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit), 'utf8');
  return { paths, generationRootPath: prepared.rootPath, happyHomeDir, sourceRootPath };
}

describe('installed plugin generation diagnosis', () => {
  it('reports a healthy installed generation with no diagnostics', async () => {
    const seeded = await seedInstalledGeneration();
    try {
      const report = await diagnoseInstalledPluginGenerations({ paths: seeded.paths });

      expect(report.plugins).toHaveLength(1);
      const plugin = report.plugins[0]!;
      expect(plugin.pluginId).toBe(PLUGIN_ID);
      expect(plugin.immutableGenerationId).toBe('generation-a');
      expect(plugin.inspectedFileCount).toBe(2);
      expect(plugin.diagnostics).toEqual([]);
      expect(plugin.repair).toBeUndefined();
      expect(report.ok).toBe(true);
    } finally {
      await rm(seeded.happyHomeDir, { recursive: true, force: true });
      await rm(seeded.sourceRootPath, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing, escaped, non-regular and size-drifted declared file', async () => {
    const seeded = await seedInstalledGeneration();
    try {
      await unlink(join(seeded.generationRootPath, 'daemon.mjs'));

      const missing = await diagnoseInstalledPluginGenerations({ paths: seeded.paths });
      expect(missing.plugins[0]!.diagnostics.map((entry) => [entry.code, entry.relativePath]))
        .toEqual([['plugin_installed_generation_file_missing', 'daemon.mjs']]);
      expect(missing.plugins[0]!.repair).toBe('reinstall');
      expect(missing.ok).toBe(false);

      await symlink(join(seeded.sourceRootPath, 'daemon.mjs'), join(seeded.generationRootPath, 'daemon.mjs'));
      const escaped = await diagnoseInstalledPluginGenerations({ paths: seeded.paths });
      expect(escaped.plugins[0]!.diagnostics.map((entry) => entry.code))
        .toEqual(['plugin_installed_generation_file_escaped']);

      await unlink(join(seeded.generationRootPath, 'daemon.mjs'));
      await mkdir(join(seeded.generationRootPath, 'daemon.mjs'));
      const notRegular = await diagnoseInstalledPluginGenerations({ paths: seeded.paths });
      expect(notRegular.plugins[0]!.diagnostics.map((entry) => entry.code))
        .toEqual(['plugin_installed_generation_file_not_regular']);

      await rm(join(seeded.generationRootPath, 'daemon.mjs'), { recursive: true });
      await writeFile(join(seeded.generationRootPath, 'daemon.mjs'), 'export default "daemon"', 'utf8');
      await truncate(join(seeded.generationRootPath, 'daemon.mjs'), 3);
      const drifted = await diagnoseInstalledPluginGenerations({ paths: seeded.paths });
      expect(drifted.plugins[0]!.diagnostics.map((entry) => entry.code))
        .toEqual(['plugin_installed_generation_file_size_mismatch']);
    } finally {
      await rm(seeded.happyHomeDir, { recursive: true, force: true });
      await rm(seeded.sourceRootPath, { recursive: true, force: true });
    }
  });

  it('reports an unloadable manifest as a distinct loadability fact', async () => {
    const seeded = await seedInstalledGeneration();
    try {
      const manifestPath = join(seeded.generationRootPath, '.happier-plugin', 'plugin.json');
      await writeFile(manifestPath, 'x'.repeat(Buffer.byteLength(MANIFEST_TEXT)), 'utf8');

      const report = await diagnoseInstalledPluginGenerations({ paths: seeded.paths });

      expect(report.plugins[0]!.diagnostics.map((entry) => entry.code))
        .toEqual(['plugin_installed_generation_manifest_unloadable']);
      expect(report.plugins[0]!.diagnostics[0]!.message).not.toBe('');
      expect(report.ok).toBe(false);
    } finally {
      await rm(seeded.happyHomeDir, { recursive: true, force: true });
      await rm(seeded.sourceRootPath, { recursive: true, force: true });
    }
  });

  it('reports a generation the registry itself refuses instead of throwing', async () => {
    const seeded = await seedInstalledGeneration();
    try {
      await rm(join(seeded.generationRootPath, 'plugin-generation.v1.json'));

      const report = await diagnoseInstalledPluginGenerations({ paths: seeded.paths });

      expect(report.plugins[0]!.diagnostics.map((entry) => entry.code))
        .toEqual(['plugin_installed_generation_unavailable']);
      expect(report.plugins[0]!.repair).toBe('reinstall');
      expect(report.ok).toBe(false);
    } finally {
      await rm(seeded.happyHomeDir, { recursive: true, force: true });
      await rm(seeded.sourceRootPath, { recursive: true, force: true });
    }
  });

  it('restricts the report to one requested plugin id and reports an unknown one', async () => {
    const seeded = await seedInstalledGeneration();
    try {
      const scoped = await diagnoseInstalledPluginGenerations({
        paths: seeded.paths,
        pluginId: PLUGIN_ID,
      });
      expect(scoped.plugins.map((entry) => entry.pluginId)).toEqual([PLUGIN_ID]);

      const unknown = await diagnoseInstalledPluginGenerations({
        paths: seeded.paths,
        pluginId: 'acme.absent',
      });
      expect(unknown.plugins).toEqual([]);
      expect(unknown.unknownPluginId).toBe('acme.absent');
      expect(unknown.ok).toBe(false);
    } finally {
      await rm(seeded.happyHomeDir, { recursive: true, force: true });
      await rm(seeded.sourceRootPath, { recursive: true, force: true });
    }
  });
});
