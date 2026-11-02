import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../__tests__/testkit/packageLayoutSandbox';
import { renderCliBundledAgentRegistrationBindingsTs } from './bundledPlugins/registry';
import { PLUGIN_MANIFEST as CUSTOM_ACP_MANIFEST } from '../../../../packages/plugins/custom-acp/src/manifest';

async function createSourceGeneratorFixture() {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-source-generator-');
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    // CLI source imports consume transfers and its peer-mediation dependency.
    // Keep that real source closure available to the no-dist loader boundary.
    const sourceWorkspaces = ['agents', 'protocol', 'cli-common', 'plugin-sdk', 'release-runtime', 'brand', 'transfers', 'peer-mediation'];
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
      copy('apps/cli/tsconfig.runtime.json');
      for (const name of sourceWorkspaces) {
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
      const manifest = {
        ...CUSTOM_ACP_MANIFEST,
        id: 'happier.selected', displayName: 'Selected',
      };
      // Full semantic publication inspects the authored public entry and its
      // declared Resources, not only the membership manifest/Agent facts.
      writeFileSync(join(packageRoot, 'src/index.ts'),
        [
          "import type { PluginApi } from '@happier-dev/plugin-sdk';",
          "import { createCustomAcpAgentRuntime } from './agent/runtime/factory.js';",
          "export { PLUGIN_MANIFEST as manifest } from './manifest.js';",
          'export function activate(api: PluginApi) {',
          "  api.agents.register('custom-acp', createCustomAcpAgentRuntime, {",
          "    sessionRunnerFactory: { module: './agent/runtime/factory', export: 'createCustomAcpAgentRuntime', runtimeApiVersion: 1 },",
          '  });',
          '}',
        ].join('\n'));
      mkdirSync(join(packageRoot, 'assets'), { recursive: true });
      cpSync(join(sourceRoot, 'packages/plugins/custom-acp/assets/brand.png'), join(packageRoot, 'assets/brand.png'));
      // Retained host registrations must agree with this synthetic host's real
      // Agent declaration; never retain the copied checkout's unrelated Agents.
      writeFileSync(join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
        renderCliBundledAgentRegistrationBindingsTs([{
          pluginId: manifest.id, localId: 'custom-acp', implementationOwnerId: 'custom-acp', registrationFamily: 'agents',
        }]));
      cpSync(join(sourceRoot, 'packages/plugins/custom-acp/src/agent'), join(packageRoot, 'src/agent'), { recursive: true });
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
      const { brand: _brand, resources: _resources, ...unrelatedManifest } = manifest;
      writeFileSync(join(unrelatedRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...unrelatedManifest, id: 'happier.unrelated', contributes: {} })};`);
      const generator = join(happyCliDir, 'scripts/build-owned/generateBundledPluginEntries.ts');
      const run = (mode: 'write' | 'check', options: Readonly<{ packageArtifacts?: boolean; workspace?: string; preload?: string }> = {}) => promisify(execFile)(process.execPath,
        ['--import', join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'), '--conditions=happier-source', '--import', sourceOnlyLoader, ...(options.preload ? ['--import', options.preload] : []),
          '--experimental-strip-types', generator, '--root', repoRoot,
          ...(mode === 'check' && !options.packageArtifacts ? ['--scope', 'projections'] : []),
          ...(options.packageArtifacts ? ['--package-artifacts'] : []),
          '--workspace', options.workspace ?? 'plugins-selected', '--mode', mode],
        { cwd: repoRoot, env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '0',
          // Keep the no-dist assertion active in the real inspection children too.
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(sourceOnlyLoader).href)}`,
        }, encoding: 'utf8' });
      await run('write');
      const projection = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
      const published = readFileSync(projection, 'utf8');
      return { repoRoot, packageRoot, sourceWorkspaces, projection, published, manifest, run, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
}

describe('bundled generator preparation process boundary', () => {
  let fixture: Awaited<ReturnType<typeof createSourceGeneratorFixture>>;

  // Each real process boundary gets the existing test budget. Four sequential
  // inspections otherwise exhaust it even while every child makes progress.
  beforeAll(async () => {
    fixture = await createSourceGeneratorFixture();
  }, 120_000);

  afterAll(() => fixture?.cleanup());

  it('publishes and checks semantic projections from authored dependencies without internal dist', async () => {
    const { repoRoot, packageRoot, sourceWorkspaces, published, run } = fixture;
    expect(existsSync(join(packageRoot, '.happier-plugin'))).toBe(false);
    for (const name of sourceWorkspaces) {
      expect(existsSync(join(repoRoot, 'packages', name, 'dist'))).toBe(false);
    }
    expect(published).toContain('happier.selected');
    await run('check');
  }, 120_000);

  it('rejects a stale semantic projection', async () => {
    const { projection, published, run } = fixture;
    try {
      writeFileSync(projection, `${published}\nexport const drift = true;\n`);
      await expect(run('check')).rejects.toThrow(/differs/u);
    } finally {
      writeFileSync(projection, published);
    }
  }, 120_000);

  it('checks packaged resource membership without reading payload bytes', async () => {
    const { repoRoot, run } = fixture;
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'resource-only' });
    const manifest = {
      schemaVersion: 2, id: 'happier.resource-only', version: '0.0.0', displayName: 'Resource only',
      runtime: { apiVersion: 1 }, contributes: {
        resources: [{ id: 'payload', kind: 'asset', path: 'assets/payload.bin', contentType: 'application/octet-stream' }],
      },
    };
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-resource-only', version: '0.0.0', type: 'module', files: ['dist', 'assets'],
    }));
    mkdirSync(join(packageRoot, 'assets'), { recursive: true });
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    const payloadPath = join(packageRoot, 'assets/payload.bin');
    writeFileSync(payloadPath, 'packaged payload\n');
    writeFileSync(join(packageRoot, 'dist/index.js'), 'export {};\n');
    writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
    writeFileSync(join(packageRoot, 'src/index.ts'), "export { PLUGIN_MANIFEST as manifest } from './manifest.js'; export function activate() {}\n");
    const readsPath = join(repoRoot, 'payload-reads.log');
    const preload = join(repoRoot, 'observe-payload-reads.mjs');
    // Observe the real generator's filesystem boundary in its private process.
    writeFileSync(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      fs.readFileSync = (path, ...args) => {
        if (String(path) === ${JSON.stringify(payloadPath)}) fs.appendFileSync(${JSON.stringify(readsPath)}, 'read\\n');
        return read(path, ...args);
      };
      syncBuiltinESMExports();
    `);
    const options = { packageArtifacts: true, workspace: 'plugins-resource-only', preload };
    await run('write', options);
    expect(existsSync(readsPath) ? readFileSync(readsPath, 'utf8') : '').toBe('');
    expect(readFileSync(payloadPath, 'utf8')).toBe('packaged payload\n');
    rmSync(payloadPath);
    await expect(run('check', options)).rejects.toThrow(/payload\.bin/u);
  }, 120_000);

  it('rejects an invalid authored manifest without replacing the projection', async () => {
    const { packageRoot, manifest, projection, run } = fixture;
    const currentProjection = readFileSync(projection, 'utf8');
    const manifestPath = join(packageRoot, 'src/manifest.ts');
    const authoredManifest = readFileSync(manifestPath, 'utf8');
    try {
      writeFileSync(manifestPath, `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...manifest, schemaVersion: 99 })};`);
      await expect(run('check')).rejects.toThrow(/Invalid PLUGIN_MANIFEST/u);
      expect(readFileSync(projection, 'utf8')).toBe(currentProjection);
    } finally {
      writeFileSync(manifestPath, authoredManifest);
    }
  }, 120_000);
});
