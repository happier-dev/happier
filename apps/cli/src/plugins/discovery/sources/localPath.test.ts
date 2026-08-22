import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveLocalPathPluginSource } from './localPath';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const BUNDLED_PLUGIN_ROOT = resolve(import.meta.dirname, '../../../../../../packages/plugins/codex');

async function writePluginManifest(rootDir: string, manifestOverrides?: Record<string, unknown>): Promise<string> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, 'plugin.json');
  await writeFile(
    manifestPath,
    JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.ohmypi',
      version: '1.0.0',
      displayName: 'Acme Oh My Pi',
      description: 'Adds Oh My Pi support',
      engines: {
        happier: '^0.2.0',
      },
      contributes: {},
      ...(manifestOverrides ?? {}),
    }), null, 2),
    'utf8',
  );
  return manifestPath;
}

async function writeStandaloneManifest(manifestPath: string, manifestOverrides?: Record<string, unknown>): Promise<string> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.standalone',
      version: '1.0.0',
      displayName: 'Acme Standalone',
      description: 'Standalone manifest file',
      engines: {
        happier: '^0.2.0',
      },
      contributes: {},
      ...(manifestOverrides ?? {}),
    }), null, 2),
    'utf8',
  );
  return manifestPath;
}

describe('resolveLocalPathPluginSource', () => {
  it('resolves a plugin root directory into a parsed local-path plugin source', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    const manifestPath = await writePluginManifest(pluginRoot);
    const canonicalPluginRoot = await realpath(pluginRoot);
    const canonicalManifestPath = await realpath(manifestPath);

    const result = await resolveLocalPathPluginSource({ locator: pluginRoot });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginRootPath).toBe(canonicalPluginRoot);
    expect(result.manifestPath).toBe(canonicalManifestPath);
    expect(result.manifest.id).toBe('acme.ohmypi');
    expect(result.sourceSpec).toMatchObject({
      kind: 'path',
      locator: canonicalPluginRoot,
      trustPolicy: 'prompt',
      installPolicy: 'link',
    });
    expect(result).not.toHaveProperty('manifestDigest');
    expect(result.sourceSpec).not.toHaveProperty('resolvedDigest');
  });

  it('resolves a plugin this checkout bundles under the first-party authority its reserved id requires', async () => {
    const manifest = JSON.parse(
      await readFile(join(BUNDLED_PLUGIN_ROOT, '.happier-plugin', 'plugin.json'), 'utf8'),
    ) as Readonly<{ id: string }>;
    expect(manifest.id.startsWith('happier.')).toBe(true);

    const result = await resolveLocalPathPluginSource({ locator: BUNDLED_PLUGIN_ROOT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe(manifest.id);
    expect(result.manifestAuthority).toBe('bundled_first_party');
  });

  it('reports external authority for an ordinary local plugin root', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-external-'));
    await writePluginManifest(pluginRoot);

    const result = await resolveLocalPathPluginSource({ locator: pluginRoot });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifestAuthority).toBe('external');
  });

  it('still refuses a local root that imitates the bundled package contract to claim a reserved id', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-impostor-'));
    await writePluginManifest(pluginRoot, { id: 'happier.agent.codex' });
    await writeFile(
      join(pluginRoot, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugins-codex', private: true }),
      'utf8',
    );

    const result = await resolveLocalPathPluginSource({ locator: pluginRoot });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ message: expect.stringContaining('reserved happier.* namespace') }),
    ]);
  });

  it('preserves an explicit standalone manifest-file locator instead of rewriting it to the parent directory', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    const manifestPath = await writeStandaloneManifest(join(pluginRoot, 'standalone-plugin.json'));
    const canonicalPluginRoot = await realpath(pluginRoot);
    const canonicalManifestPath = await realpath(manifestPath);

    const result = await resolveLocalPathPluginSource({ locator: manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginRootPath).toBe(canonicalPluginRoot);
    expect(result.manifestPath).toBe(canonicalManifestPath);
    expect(result.sourceSpec.locator).toBe(canonicalManifestPath);
  });

  it('resolves a .happier-plugin directory locator into the same canonical local-path source', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    const manifestPath = await writePluginManifest(pluginRoot);
    const manifestDir = join(pluginRoot, '.happier-plugin');
    const canonicalPluginRoot = await realpath(pluginRoot);
    const canonicalManifestPath = await realpath(manifestPath);

    const result = await resolveLocalPathPluginSource({ locator: manifestDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginRootPath).toBe(canonicalPluginRoot);
    expect(result.manifestPath).toBe(canonicalManifestPath);
    expect(result.sourceSpec.locator).toBe(canonicalPluginRoot);
  });

  it('returns a compatibility diagnostic when the local path does not contain a plugin manifest', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));

    const result = await resolveLocalPathPluginSource({ locator: pluginRoot });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_missing',
      }),
    ]);
  });

  it('returns a source-missing diagnostic when the local path does not exist', async () => {
    const missingPluginRoot = join(tmpdir(), 'happier-plugin-missing-path', 'missing-plugin');

    const result = await resolveLocalPathPluginSource({ locator: missingPluginRoot });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_source_missing',
      }),
    ]);
  });

  it('fails closed on remote URL locators instead of treating them as local paths', async () => {
    const result = await resolveLocalPathPluginSource({ locator: 'https://example.test/plugins/acme.sample' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_source_kind_unsupported',
        message: expect.stringMatching(/https?:\/\//i),
      }),
    ]);
  });
});
