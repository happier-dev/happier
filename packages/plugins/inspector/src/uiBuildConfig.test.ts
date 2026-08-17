import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest';

describe('Plugin Inspector UI build configuration', () => {
  it('includes the bundled TSX entry in the package compiler program while excluding test sources', async () => {
    const configUrl = new URL('../tsconfig.json', import.meta.url);
    const configPath = fileURLToPath(configUrl);
    const packageRoot = dirname(configPath);
    const config = JSON.parse(await readFile(configUrl, 'utf8')) as Readonly<{
      include?: readonly string[];
      exclude?: readonly string[];
    }>;
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, packageRoot, undefined, configPath);

    expect(parsed.fileNames).toContain(resolve(packageRoot, 'src/ui/renderSurface.tsx'));
    expect(parsed.fileNames).not.toContain(resolve(packageRoot, 'src/ui/presentationContract.test.ts'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.jsx).toBe(ts.JsxEmit.React);
    expect(config.include).toEqual(expect.arrayContaining(['src/**/*.ts', 'src/**/*.tsx']));
    expect(config.exclude).toEqual(expect.arrayContaining([
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ]));
  });

  it('declares the complete managed Re.Pack toolchain it invokes', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    }>;

    expect(packageJson.devDependencies?.['@callstack/repack']).toBe('5.2.5');
    expect(packageJson.devDependencies?.['@react-native-community/cli']).toBe('20.1.2');
    expect(packageJson.devDependencies?.['@react-native/metro-config']).toBe('0.83.5');
    expect(packageJson.devDependencies?.['react-native']).toBe('0.83.5');
    expect(packageJson.devDependencies?.['@swc/helpers']).toBe('0.5.23');
    expect(packageJson.scripts?.build).toBe(
      'node ../../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json --happier-staged-output-script build:ui',
    );
    expect(packageJson.scripts?.['build:ui']).toBe('happier-plugin-build-ui');

    for (const configPath of ['vite.config.ts', 'rspack.config.mjs', 'react-native.config.cjs']) {
      await expect(readFile(new URL(`../${configPath}`, import.meta.url), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('loads through public SDK exports and declares one same-source RNW/iOS/Android target', async () => {
    const loaded = await import('../happier-plugin-ui.config.mjs');
    const config = loaded.default as Readonly<{
      projectRoot?: string;
      outDir?: string;
      targets: readonly Readonly<{
        rendererId: string;
        entry: string;
        kind: string;
        platforms: readonly string[];
        module?: Readonly<{
          containerName: string;
          modulePath: string;
          exportName: string;
        }>;
      }>[];
    }>;

    expect(config).toEqual({
      projectRoot: '.',
      outDir: 'node_modules/.cache/happier-plugin-ui',
      targets: [{
        rendererId: 'inspector-app-native',
        entry: 'src/ui/renderSurface.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
        module: {
          containerName: 'happier_inspector_inspector_app_native',
          modulePath: './renderSurface',
          exportName: 'renderSurface',
        },
      }],
    });
    expect(config.targets[0]).not.toHaveProperty('bundlerConfig');
    const renderer = PLUGIN_MANIFEST.contributes.ui.renderers[0];
    expect(renderer).toMatchObject({
      kind: 'reactNative',
      artifact: config.targets[0]?.rendererId,
    });
  }, 20_000);

  it('packages one generated three-platform graph with exact emitted native identity', async () => {
    const artifactsRoot = new URL('../dist/happier-plugin-ui/', import.meta.url);
    const graph = JSON.parse(
      await readFile(new URL('ui-artifacts.json', artifactsRoot), 'utf8'),
    ) as Readonly<{
      entries: readonly Readonly<{
        contributionId: string;
        platform?: string;
        entry: string;
        repack?: Readonly<{ containerName: string; modulePath: string; exportName: string }>;
        files: readonly Readonly<{ relativePath: string; digest: string; byteSize: number }>[];
      }>[];
    }>;

    expect(graph.entries.map((entry) => entry.platform).sort()).toEqual(['android', 'ios', 'web']);
    expect(new Set(graph.entries.map((entry) => entry.contributionId))).toEqual(
      new Set([PLUGIN_MANIFEST.contributes.ui.renderers[0]?.artifact]),
    );
    for (const entry of graph.entries) {
      expect(entry.files.length).toBeGreaterThan(0);
      for (const file of entry.files) {
        const bytes = await readFile(new URL(file.relativePath, artifactsRoot));
        expect(bytes.byteLength).toBe(file.byteSize);
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(file.digest);
      }
    }

    for (const platform of ['ios', 'android']) {
      const entry = graph.entries.find((candidate) => candidate.platform === platform)!;
      expect(entry.repack).toEqual({
        containerName: 'happier_inspector_inspector_app_native',
        modulePath: './renderSurface',
        exportName: 'renderSurface',
      });
      const emittedSources = await Promise.all(entry.files
        .filter((file) => /\.(?:js|bundle)$/u.test(file.relativePath))
        .map((file) => readFile(new URL(file.relativePath, artifactsRoot), 'utf8')));
      expect(emittedSources.join('\n')).toContain('happier_inspector_inspector_app_native');
      expect(emittedSources.join('\n')).toContain('"./renderSurface"');
      expect(emittedSources.join('\n')).toContain('get renderSurface');
      expect(emittedSources.join('\n')).toContain('try { guardedWebpackRequire[key]');
    }

    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      files?: readonly string[];
    };
    expect(packageJson.files).toContain('dist');
  });
});
