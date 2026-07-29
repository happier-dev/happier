import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../configuration', () => ({
  configuration: { happyHomeDir: join(tmpdir(), 'unused-plugin-registry-home') },
}));

import { resolvePluginStorePaths } from '../paths';
import {
  createEmptyPluginRegistryCommitRecord,
  PluginRegistryCommitRecordSchema,
  readPluginRegistryCommitRecord,
  replacePluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
} from './commitRecord';

function nextRecord(base: PluginRegistryCommitRecord): PluginRegistryCommitRecord {
  return {
    t: 'happier_plugin_registry_commit_v1',
    schemaVersion: 1,
    revision: base.revision + 1,
    transactionId: `tx-${base.revision + 1}`,
    baseRevision: base.revision,
    installationState: {
      revisionId: `state-${base.revision + 1}`,
      digest: `sha256:${'1'.repeat(64)}`,
    },
    pluginGenerations: {
      'acme.plugin': {
        immutableGenerationId: 'generation-1',
        generationRecordDigest: `sha256:${'2'.repeat(64)}`,
        installedArtifactRecord: {
          relativePath: 'installed-artifacts.v1.json',
          digest: `sha256:${'3'.repeat(64)}`,
        },
      },
    },
    createdAtMs: 10,
    creator: { pid: 42, instanceId: 'daemon-a' },
  };
}

describe('PluginRegistryCommitRecord', () => {
  it('keeps the primed isolated-home registry compatible with the current strict schema', async () => {
    const primedRegistryPath = fileURLToPath(new URL(
      '../../../../prime-isolated-home/plugins/plugins/state/plugin-registry-current.v1.json',
      import.meta.url,
    ));

    const primedRegistry = JSON.parse(await readFile(primedRegistryPath, 'utf8')) as unknown;

    expect(() => PluginRegistryCommitRecordSchema.parse(primedRegistry)).not.toThrow();
  });

  it('atomically advances the sole current record by exactly one revision', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-commit-')));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const empty = createEmptyPluginRegistryCommitRecord({ transactionId: 'bootstrap', createdAtMs: 1, creatorInstanceId: 'daemon-a', creatorPid: 42 });
    await replacePluginRegistryCommitRecord({ paths, expectedRevision: null, next: empty });
    const next = nextRecord(empty);

    await replacePluginRegistryCommitRecord({ paths, expectedRevision: 0, next });

    await expect(readPluginRegistryCommitRecord(paths)).resolves.toEqual(next);
    expect(JSON.parse(await readFile(paths.registryCurrentFilePath, 'utf8'))).toEqual(next);
  });

  it('rejects malformed, partial, unqualified-digest, and non-monotonic records fail-closed', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-corrupt-')));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify({
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 1,
      transactionId: 'partial', baseRevision: 0, installationState: { revisionId: 'x', digest: 'abc' },
    }), 'utf8');

    await expect(readPluginRegistryCommitRecord(paths)).rejects.toThrow(/invalid plugin registry commit/i);

    const monotonicHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-monotonic-')));
    const monotonicPaths = resolvePluginStorePaths({ happyHomeDir: monotonicHomeDir });
    const empty = createEmptyPluginRegistryCommitRecord({ transactionId: 'bootstrap', createdAtMs: 1, creatorInstanceId: 'daemon-a', creatorPid: 42 });
    await expect(replacePluginRegistryCommitRecord({ paths: monotonicPaths, expectedRevision: 1, next: empty })).rejects.toThrow(/revision/i);

    const base = nextRecord(empty);
    for (const relativePath of ['../escape.json', 'CON', 'dist/trailing.', `dist/control-${String.fromCharCode(1)}.json`, 'dist/cafe\u0301.json']) {
      expect(() => PluginRegistryCommitRecordSchema.parse({
        ...base,
        pluginGenerations: {
          'acme.plugin': {
            ...base.pluginGenerations['acme.plugin'],
            installedArtifactRecord: {
              ...base.pluginGenerations['acme.plugin']!.installedArtifactRecord,
              relativePath,
            },
          },
        },
      }), relativePath).toThrow(/portable|normalized/i);
    }
  });
});
