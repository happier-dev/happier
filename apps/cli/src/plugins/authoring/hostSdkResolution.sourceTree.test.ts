import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PLUGIN_SDK_PACKAGE_NAME, resolveHostPluginSdkPackageRoot } from './hostSdkResolution';

describe('source tree authoring mode', () => {
  it.each([true, false])('keeps tree source-workspace authoring distinct from physical source bundles (tree=%s)', async (tree) => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'happier-tree-author-'));
    const root = join(repoRoot, 'apps/cli');
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src/index.ts'), 'export {};');
      await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
      await writeFile(join(repoRoot, 'pnpm-lock.yaml'), '');
      await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []');
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@happier-dev/cli',
        bundledDependencies: ['@happier-dev/agents', PLUGIN_SDK_PACKAGE_NAME] }));
      for (const name of ['agents', 'plugin-sdk']) {
        const packageRoot = join(repoRoot, 'packages', name);
        await mkdir(join(packageRoot, 'src'), { recursive: true });
        await writeFile(join(packageRoot, 'src/index.ts'), 'export {};');
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, version: '0.0.0',
          exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
      }
      // prepareSourceTreeRuntimeComponents publishes this same owned record;
      // sourceTree marks a revision workspace with mounted dependencies, not
      // an emitted physical author bundle (RU2 #104, 2026-11-16).
      await writeFile(join(repoRoot, 'source-bundle.json'), JSON.stringify({ runtimeDir: root, cliDir: root,
        ...(tree ? { sourceTree: { base: 'revision', baseBuilt: true, overlaid: 0 } } : {}) }));
      const runtimeModuleUrl = pathToFileURL(join(root, 'src/index.ts')).href;
      if (tree) {
        expect(resolveHostPluginSdkPackageRoot({ runtimeModuleUrl })).toBe(await realpath(join(repoRoot, 'packages/plugin-sdk')));
      } else {
        expect(() => resolveHostPluginSdkPackageRoot({ runtimeModuleUrl })).toThrow(/no physical bundled/);
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
