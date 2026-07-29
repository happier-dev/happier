import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest';

describe('Plugin Inspector UI build configuration', () => {
  it('declares the complete managed Re.Pack toolchain it invokes', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    }>;

    expect(packageJson.devDependencies?.['@callstack/repack']).toBe('5.2.5');
    expect(packageJson.devDependencies?.['@react-native-community/cli']).toBe('20.1.2');
    expect(packageJson.devDependencies?.['@react-native/metro-config']).toBe('0.83.4');
    expect(packageJson.devDependencies?.['@swc/helpers']).toBe('0.5.23');
    expect(packageJson.scripts?.build).toContain('happier-plugin-build-ui');

    const reactNativeConfig = await import('../react-native.config.cjs');
    expect(reactNativeConfig.default.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'bundle' }),
    ]));
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
    const renderer = PLUGIN_MANIFEST.contributes.ui.renderers[0];
    expect(renderer).toMatchObject({
      kind: 'reactNative',
      artifact: config.targets[0]?.rendererId,
    });
  }, 20_000);

  it('projects the SDK-owned exact no-fallback React runtime closure into Re.Pack', async () => {
    const loaded = await import('../rspack.config.mjs');
    const config = loaded.default({ platform: 'ios', mode: 'production' }) as Readonly<{
      plugins: readonly Readonly<{
        config?: Readonly<{
          shared?: Readonly<Record<string, Readonly<{
            singleton: boolean;
            eager: boolean;
            import: boolean;
          }>>>;
        }>;
      }>[];
    }>;
    const shared = config.plugins
      .map((plugin) => plugin.config?.shared)
      .find((value) => value !== undefined);

    expect(shared?.['react/jsx-runtime']).toEqual({
      singleton: true,
      eager: false,
      import: false,
    });
    expect(shared?.['react/jsx-dev-runtime']).toEqual({
      singleton: true,
      eager: false,
      import: false,
    });
    expect(shared?.['react/compiler-runtime']).toBeUndefined();
  });

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
