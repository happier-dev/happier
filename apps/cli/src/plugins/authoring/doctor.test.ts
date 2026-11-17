import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runPluginAuthorDoctor } from './doctor';
import { preparePluginAuthorDependencies, type PluginAuthorToolchainSpawnResult } from './toolchain';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { readPluginManifest } from '@/plugins/manifest/read';

async function withAuthorRoot(
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSingleFilePlugin(
  root: string,
  fileName: string,
  manifest: Readonly<Record<string, unknown>>,
  trailingSource = '',
): Promise<string> {
  const locator = join(root, fileName);
  await writeFile(
    locator,
    `export const manifest = ${JSON.stringify(manifest)}; export function activate() {}\n${trailingSource}`,
    'utf8',
  );
  return locator;
}

async function writePackageRootPlugin(
  root: string,
  manifest: Readonly<Record<string, unknown>>,
  options: Readonly<{ materialized: boolean; trailingSource?: string }>,
): Promise<void> {
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'happier-doctor-fixture',
    version: '0.1.0',
    type: 'module',
  }), 'utf8');
  await writeFile(
    join(root, 'src', 'index.ts'),
    `export const manifest = ${JSON.stringify(manifest)};\nexport function activate() {}\n${options.trailingSource ?? ''}`,
    'utf8',
  );
  if (options.materialized) {
    const sdkRoot = join(root, 'node_modules', '@happier-dev', 'plugin-sdk');
    await mkdir(sdkRoot, { recursive: true });
    await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    }), 'utf8');
  }
}

describe('plugin author doctor', () => {
  it('refuses an invalid authored Settings default while host admission isolates that contribution', async () => {
    const manifest = createPluginManifestV2Fixture({ id: 'acme.settings-admission', contributes: {
      settings: [{ id: 'preferences', title: 'Preferences', scope: 'daemon', target: { kind: 'plugin' },
        fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: 'true' }] }],
    } });
    const root = await mkdtemp(join(tmpdir(), 'happier-doctor-settings-'));
    try {
      const locator = join(root, 'plugin.mjs');
      await writeFile(locator, `export const manifest = ${JSON.stringify(manifest)}; export function activate() {}`);
      const diagnostic = { code: 'PLUGIN_SETTINGS_DEFAULT_INVALID', pluginId: 'acme.settings-admission',
        contributionId: 'preferences', fieldId: 'enabled' };
      await expect(runPluginAuthorDoctor({ locator })).resolves.toMatchObject({ ok: false,
        diagnostics: [expect.objectContaining(diagnostic)] });
      expect(ingestCanonicalPluginManifest(manifest, { sourceProvenance: 'localSource' }))
        .toMatchObject({ ok: false, diagnostics: [expect.objectContaining(diagnostic)] });
      const manifestPath = join(root, 'plugin.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(readPluginManifest({ manifestPath, sourceProvenance: 'localSource' })).resolves.toMatchObject({
        ok: true, manifest: { contributes: { settings: [] } },
        diagnostics: [{ code: 'plugin_contribution_skipped',
          contribution: { pluginId: diagnostic.pluginId, localId: diagnostic.contributionId },
        }],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports the canonical projection and observable evaluation timing without purity claims', async () => {
    const manifest = createPluginManifestV2Fixture({ id: 'example.doctor', version: '0.1.0' });
    await withAuthorRoot('happier-doctor-projection-', async (root) => {
      const locator = await writeSingleFilePlugin(root, 'plugin.mjs', manifest);
      const nowMs = vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(145);

      const result = await runPluginAuthorDoctor({ locator, nowMs, slowEvaluationMs: 100 });

      expect(result).toEqual({
        ok: true,
        pluginId: 'example.doctor',
        version: '0.1.0',
        entryPath: locator,
        evaluationMs: 45,
        canonicalManifestJson: expect.any(String),
        diagnostics: [],
      });
      if (!result.ok) return;
      expect(JSON.parse(result.canonicalManifestJson)).toMatchObject({ id: 'example.doctor', version: '0.1.0' });
    });
  });

  it('reports slowness and import failures as diagnostics rather than reproducibility proof', async () => {
    await withAuthorRoot('happier-doctor-slow-broken-', async (root) => {
      const slowLocator = await writeSingleFilePlugin(
        root,
        'slow.mjs',
        createPluginManifestV2Fixture({ id: 'example.slow', version: '0.1.0' }),
      );
      const slow = await runPluginAuthorDoctor({
        locator: slowLocator,
        nowMs: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(250),
        slowEvaluationMs: 100,
      });
      expect(slow).toMatchObject({
        ok: true,
        pluginId: 'example.slow',
        diagnostics: [{ code: 'plugin_author_evaluation_slow' }],
      });

      const brokenLocator = await writeSingleFilePlugin(
        root,
        'broken.mjs',
        createPluginManifestV2Fixture({ id: 'example.broken', version: '0.1.0' }),
        "throw new Error('top-level boom');\n",
      );
      const broken = await runPluginAuthorDoctor({ locator: brokenLocator });
      expect(broken).toMatchObject({
        ok: false,
        diagnostics: [{
          code: 'plugin_author_evaluation_failed',
          message: 'Plugin author evaluation failed: Failed to load plugin author source module',
          details: { cause: { phase: 'evaluate', code: 'UNKNOWN', retryable: 'unknown' } },
        }],
      });
      if (broken.ok) return;
      expect(broken.diagnostics).toHaveLength(1);
    });
  });

  it('reports an evaluator source location relative to the author project without leaking stack paths', async () => {
    await withAuthorRoot('happier-doctor-location-', async (root) => {
      await writePackageRootPlugin(
        root,
        createPluginManifestV2Fixture({ id: 'example.location', version: '0.1.0' }),
        {
          materialized: true,
          trailingSource: "throw new Error('top-level boom at /private/runtime-secret.ts');\n",
        },
      );

      const result = await runPluginAuthorDoctor({ locator: root });

      expect(result).toEqual({
        ok: false,
        diagnostics: [{
          code: 'plugin_author_evaluation_failed',
          message: 'Plugin author evaluation failed: Failed to load plugin author source module',
          details: { cause: { phase: 'evaluate', code: 'UNKNOWN', retryable: 'unknown' } },
          location: expect.objectContaining({ file: 'src/index.ts', line: expect.any(Number) }),
        }],
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain('/private/runtime-secret.ts');
      expect(serialized).not.toContain('top-level boom');
      expect(serialized).not.toContain('    at ');
    });
  });

  it('keeps the dependency-preparation source location the toolchain resolved', async () => {
    await withAuthorRoot('happier-doctor-prepare-location-', async (root) => {
      await writePackageRootPlugin(
        root,
        createPluginManifestV2Fixture({ id: 'example.prepare', version: '0.1.0' }),
        // Evaluation would fail loudly if preparation did not stop the doctor first.
        { materialized: false, trailingSource: "throw new Error('evaluation must not run');\n" },
      );
      const spawnCwds: string[] = [];
      const toolchainDeps: NonNullable<Parameters<typeof preparePluginAuthorDependencies>[1]> = {
        ensureManagedPnpmCommand: async () => '/managed/pnpm',
        managedPnpmBinPath: () => '/managed/pnpm',
        buildManagedPnpmEnvironment: (env = {}) => env,
        spawn: async (input): Promise<PluginAuthorToolchainSpawnResult> => {
          spawnCwds.push(input.cwd);
          return {
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: `${join(input.cwd, 'package.json')}(4,3): invalid dependency range`,
          };
        },
        processEnv: {},
      };

      const result = await runPluginAuthorDoctor({
        locator: root,
        prepareDependencies: async ({ projectRoot }) => await preparePluginAuthorDependencies(
          { projectRoot },
          toolchainDeps,
        ),
      });

      expect(spawnCwds).toEqual([root]);
      expect(result).toEqual({
        ok: false,
        diagnostics: [{
          code: 'plugin_author_dependency_preparation_failed',
          message: 'Plugin development install failed with 1: <path>(4,3): invalid dependency range',
          location: { file: 'package.json', line: 4, column: 3 },
        }],
      });
      expect(JSON.stringify(result)).not.toContain(root);
    });
  });

  it('prepares a non-materialized package root, then evaluates it', async () => {
    await withAuthorRoot('happier-doctor-prepared-', async (root) => {
      await writePackageRootPlugin(
        root,
        createPluginManifestV2Fixture({ id: 'example.prepared', version: '0.1.0' }),
        { materialized: false },
      );
      const prepareDependencies = vi.fn(async ({ projectRoot }: { projectRoot: string }) => ({ ok: true as const, projectRoot }));

      await expect(runPluginAuthorDoctor({
        locator: root,
        prepareDependencies: prepareDependencies as never,
      })).resolves.toMatchObject({
        ok: true,
        pluginId: 'example.prepared',
        entryPath: join(root, 'src', 'index.ts'),
      });
      expect(prepareDependencies).toHaveBeenCalledExactlyOnceWith({ projectRoot: root });
    });
  });

  it('reuses a materialized package root instead of reinstalling before evaluation', async () => {
    await withAuthorRoot('happier-doctor-materialized-', async (root) => {
      await writePackageRootPlugin(
        root,
        createPluginManifestV2Fixture({ id: 'example.materialized', version: '0.1.0' }),
        { materialized: true },
      );
      const prepareDependencies = vi.fn();

      await expect(runPluginAuthorDoctor({
        locator: root,
        prepareDependencies: prepareDependencies as never,
      })).resolves.toMatchObject({
        ok: true,
        pluginId: 'example.materialized',
        entryPath: join(root, 'src', 'index.ts'),
      });
      expect(prepareDependencies).not.toHaveBeenCalled();
    });
  });
});
