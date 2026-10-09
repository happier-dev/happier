import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { readCliSourceEntries } from '../sourceRuntimeEntries.mjs';

describe('CLI source entry ownership', () => {
  it('includes a bundled plugin native worker declared by its package imports', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'happier-plugin-native-entries-'));
    try {
      const cliDir = join(repoDir, 'apps/cli');
      const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
      const pluginDir = join(repoDir, 'packages/plugins/native-worker');
      await mkdir(locatorDir, { recursive: true });
      await mkdir(join(pluginDir, 'src/machine'), { recursive: true });
      await writeFile(join(pluginDir, 'src/index.ts'), 'export const activate = () => {};');
      await writeFile(join(pluginDir, 'src/machine/worker.ts'), 'export const value = 1;');
      await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-native-worker',
        exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } },
        imports: { '#native-worker': { 'happier-source': './src/machine/worker.ts', default: './dist/machine/worker.js' } },
      }));
      await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'),
        `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([{
          daemonEntryPath: './.happier-plugin/daemon.js',
          sourceSpec: { locator: '@happier-dev/plugins-native-worker' },
          manifest: { entrypoints: { daemon: './.happier-plugin/daemon.js' }, runtime: {} },
        }])};`);
      const { entries } = await readCliSourceEntries({ repoDir, manifest: {}, transform });
      expect(entries['packages/plugins/native-worker/dist/machine/worker']).toBe(join(pluginDir, 'src/machine/worker.ts'));
      expect(entries['packages/plugins/native-worker/.happier-plugin/daemon']).toBe(join(pluginDir, 'src/index.ts'));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
