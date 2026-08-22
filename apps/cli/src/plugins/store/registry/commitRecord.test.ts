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
    },
    pluginGenerations: {
      'acme.plugin': {
        immutableGenerationId: 'generation-1',
      },
    },
    createdAtMs: 10,
    creator: { pid: 42, instanceId: 'daemon-a' },
  };
}

function unsupportedDigestBearingCommitRecord() {
  return {
    t: 'happier_plugin_registry_commit_v1' as const,
    schemaVersion: 1 as const,
    revision: 27,
    transactionId: 'health-4742c9f0-5b4a-4ab3-9901-153731c08e3a',
    baseRevision: 26,
    installationState: {
      revisionId: 'health-08523559-57c4-4ce7-bcd9-d35876f12a96',
      digest: 'sha256:9277dd1fe2a952053a71a673bd7a34b6c38ed9d9277bd5e9950af4d73b4b7f2d',
    },
    pluginGenerations: {
      'com.qa.decl-surface': {
        immutableGenerationId: 'gen-1786033180655-bc3474d0-5ec1-48ed-a77d-8034e6b841ac',
        generationRecordDigest: 'sha256:cdabbdcabbd69c48b933ce2a4730a897d674c869d2cb0ba17ec2c81b8dd39fc2',
        installedArtifactRecord: {
          relativePath: '.happier-plugin/plugin.json',
          digest: 'sha256:237151151f51cd2b871a89c4b9be91b602b8e4c5c272430ed6d97dd02732c9cf',
        },
      },
    },
    createdAtMs: 1786034026465,
    creator: {
      pid: 65341,
      instanceId: 'plugin-registry-65341-d0e1c5ca-a718-411e-b50a-da7368da910c',
    },
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
    await replacePluginRegistryCommitRecord({ paths, expectedCurrent: null, next: empty });
    const next = nextRecord(empty);

    await replacePluginRegistryCommitRecord({ paths, expectedCurrent: empty, next });

    await expect(readPluginRegistryCommitRecord(paths)).resolves.toEqual(next);
    expect(JSON.parse(await readFile(paths.registryCurrentFilePath, 'utf8'))).toEqual(next);
  });

  it('rejects the unsupported local digest-bearing commit instead of preserving a custom reader', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-legacy-digest-')));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const legacy = unsupportedDigestBearingCommitRecord();
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(legacy), 'utf8');

    expect(() => PluginRegistryCommitRecordSchema.parse(legacy)).toThrow();
    await expect(readPluginRegistryCommitRecord(paths)).rejects.toThrow(/invalid plugin registry commit/i);
  });

  it('rejects malformed, partial, stale digest, and non-monotonic records fail-closed', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-corrupt-')));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify({
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 1,
      transactionId: 'partial', baseRevision: 0, installationState: { revisionId: 'x' },
    }), 'utf8');

    await expect(readPluginRegistryCommitRecord(paths)).rejects.toThrow(/invalid plugin registry commit/i);

    const monotonicHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-monotonic-')));
    const monotonicPaths = resolvePluginStorePaths({ happyHomeDir: monotonicHomeDir });
    const empty = createEmptyPluginRegistryCommitRecord({ transactionId: 'bootstrap', createdAtMs: 1, creatorInstanceId: 'daemon-a', creatorPid: 42 });
    await expect(replacePluginRegistryCommitRecord({ paths: monotonicPaths, expectedCurrent: null, next: nextRecord(empty) })).rejects.toThrow(/revision/i);

    const base = nextRecord(empty);
    expect(() => PluginRegistryCommitRecordSchema.parse({
      ...base,
      installationState: {
        ...base.installationState,
        digest: `sha256:${'1'.repeat(64)}`,
      },
    })).toThrow();
    for (const immutableGenerationId of ['../escape', 'CON', 'dist/trailing.', `control-${String.fromCharCode(1)}`, 'cafe\u0301']) {
      expect(() => PluginRegistryCommitRecordSchema.parse({
        ...base,
        pluginGenerations: {
          'acme.plugin': {
            immutableGenerationId,
          },
        },
      }), immutableGenerationId).toThrow(/portable|normalized|match pattern/i);
    }
    expect(() => PluginRegistryCommitRecordSchema.parse({
      ...base,
      pluginGenerations: {
        'acme.plugin': {
          ...base.pluginGenerations['acme.plugin']!,
          generationRecordDigest: `sha256:${'2'.repeat(64)}`,
        },
      },
    })).toThrow();
  });
});
