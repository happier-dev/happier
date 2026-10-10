import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../__tests__/testkit/packageLayoutSandbox';

describe('bundled generator preparation process boundary', () => {
  it('publishes and checks semantic projections from authored dependencies without internal dist', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-source-generator-');
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const copy = (path: string) => {
      mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
      cpSync(join(sourceRoot, path), join(repoRoot, path), { recursive: true });
    };
    try {
      copy('scripts');
      copy('apps/stack/scripts');
      copy('apps/cli/scripts');
      copy('apps/cli/src');
      copy('apps/cli/tsconfig.json');
      for (const name of ['agents', 'protocol', 'cli-common', 'plugin-sdk', 'release-runtime', 'brand']) {
        copy(`packages/${name}/package.json`);
        copy(`packages/${name}/src`);
      }
      copy('packages/brand/planet.mjs');
      // Development JS helpers are authored package files, not compiled output.
      cpSync(join(sourceRoot, 'packages/cli-common'), join(repoRoot, 'packages/cli-common'), {
        recursive: true, filter: (path) => !/(?:^|\/)(?:dist|node_modules)(?:\/|$)/u.test(path),
      });
      symlinkSync(join(sourceRoot, 'node_modules'), join(repoRoot, 'node_modules'), 'dir');
      const sourceOnlyLoader = join(repoRoot, 'source-only-loader.mjs');
      writeFileSync(sourceOnlyLoader, `
        import { registerHooks } from 'node:module';
        registerHooks({ resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          if (/(?:packages|@happier-dev)\\/[^/]+\\/(?:dist|package-dist)\\//u.test(result.url)) {
            throw new Error('Generator consumed internal dist: ' + result.url);
          }
          return result;
        } });
      `);
      writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-selected'] });
      writeFileSync(join(happyCliDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli', type: 'module', bundledDependencies: ['@happier-dev/plugins-selected'],
      }));
      const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'selected' });
      const manifest = { schemaVersion: 2, id: 'happier.selected', version: '0.0.0', displayName: 'Selected',
        engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] }, contributes: {} };
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-selected', version: '0.0.0', type: 'module' }));
      // Prior npm packaging can leave a nearer private workspace copy. It must
      // not become the authority for this authored-source generation.
      const privateProtocol = join(packageRoot, 'node_modules/@happier-dev/protocol');
      mkdirSync(privateProtocol, { recursive: true });
      writeFileSync(join(privateProtocol, 'package.json'), JSON.stringify({
        name: '@happier-dev/protocol', type: 'module', exports: {
          './plugins/manifest': { 'happier-source': './src/missing.ts', default: './dist/missing.js' },
        },
      }));
      writeFileSync(join(packageRoot, 'src/manifest.ts'), [
        "import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';",
        `const result = ingestPluginManifestV2(${JSON.stringify(manifest)});`,
        "if (!result.ok) throw new Error('Fixture authored manifest is invalid');",
        'export const PLUGIN_MANIFEST = result.manifest;',
      ].join('\n'));
      const unrelatedRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'unrelated' });
      writeFileSync(join(unrelatedRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-unrelated', version: '0.0.0', type: 'module' }));
      writeFileSync(join(unrelatedRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...manifest, id: 'happier.unrelated' })};`);
      const generator = join(happyCliDir, 'scripts/build-owned/generateBundledPluginEntries.ts');
      const run = (mode: 'write' | 'check') => promisify(execFile)(process.execPath,
        ['--conditions=happier-source', '--import', sourceOnlyLoader, '--experimental-strip-types', generator, '--root', repoRoot,
          ...(mode === 'check' ? ['--scope', 'projections'] : []), '--workspace', 'plugins-selected', '--mode', mode],
        { cwd: repoRoot, env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '0',
          // Keep the no-dist assertion active in the real inspection children too.
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(sourceOnlyLoader).href)}`,
        }, encoding: 'utf8' });
      await run('write');
      expect(existsSync(join(packageRoot, '.happier-plugin'))).toBe(false);
      for (const name of ['agents', 'protocol', 'cli-common', 'plugin-sdk', 'release-runtime', 'brand']) {
        expect(existsSync(join(repoRoot, 'packages', name, 'dist'))).toBe(false);
      }
      const projection = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
      const published = readFileSync(projection, 'utf8');
      expect(published).toContain('happier.selected');
      await run('check');
      writeFileSync(projection, `${published}\nexport const drift = true;\n`);
      await expect(run('check')).rejects.toThrow(/differs/u);
      writeFileSync(projection, published);
      writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...manifest, schemaVersion: 99 })};`);
      await expect(run('check')).rejects.toThrow(/Invalid PLUGIN_MANIFEST/u);
      expect(readFileSync(projection, 'utf8')).toBe(published);
    } finally { cleanup(); }
  }, 120_000);
});
