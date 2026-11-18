import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { transform } from 'esbuild';
import { expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { projectPackedSessionRunnerModulePath } from '../../../src/plugins/authoring/bundleDaemonRuntime';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/custom-acp/src/manifest';
import { readCliSourceEntries, readWorkspacePackages } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { captureBuildInputFiles } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspaceBuildInputs } from '../../../../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../../__tests__/testkit/packageLayoutSandbox';
import { resolveGeneratorHostProjectionOutPaths } from './projectionPaths.mjs';
import { renderCliBundledPluginManifestAssets, renderCliBundledPluginManifestEntriesTs } from './registry';
import { readBundledPluginPackageNames } from '../bundledPluginMembership';

it('evaluates one authored graph per bundled plugin at the current inventory scale', async () => {
  const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-daemon-graph-count-');
  try {
    const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const { brand: _brand, resources: _resources, ...manifest } = PLUGIN_MANIFEST;
    writeCliBundledHostPackage({ happyCliDir });
    const evaluationLog = join(repoRoot, 'factory-evaluations.jsonl');
    // Every package contributes a real Agent registration. The manifest and
    // activation entry import the same factory, as first-party SDK authors do.
    const roots = Array.from({ length: readBundledPluginPackageNames(sourceRoot).length }, (_, index) => {
      const pluginId = `scale-${index}`;
      const root = writeBundledPluginSourceInputs({ repoRoot, pluginId });
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: `@happier-dev/plugins-${pluginId}`, version: '0.0.0', type: 'module',
        exports: { '.': { 'happier-source': './src/index.ts' } },
      }));
      writeFileSync(join(root, 'src/manifest.ts'), [
        "import './agent/runtime/factory.js';",
        `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...manifest, id: `happier.${pluginId}` })};`,
      ].join('\n'));
      const factoryPath = join(root, 'src/agent/runtime/factory.ts');
      mkdirSync(dirname(factoryPath), { recursive: true });
      writeFileSync(factoryPath, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(evaluationLog)}, ${JSON.stringify(`${pluginId}\n`)});`,
        'export function createFixture() { throw new Error("factory is not invoked at admission"); }',
      ].join('\n'));
      writeFileSync(join(root, 'src/index.ts'), [
        "export { PLUGIN_MANIFEST as manifest } from './manifest.js';",
        "import { createFixture } from './agent/runtime/factory.js';",
        'export function activate(api) {',
        "  api.agents.register('custom-acp', createFixture, {sessionRunnerFactory: {",
        "    module: './agent/runtime/factory', export: 'createFixture', runtimeApiVersion: 1,",
        '  }});',
        '}',
      ].join('\n'));
      return root;
    });
    const projectionRoot = join(repoRoot, 'projections');
    await promisify(execFile)(process.execPath, ['--conditions=happier-source', '--import',
      join(sourceRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
      join(sourceRoot, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'),
      '--root', repoRoot, '--daemon-projections', '--daemon-output-root', projectionRoot,
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    const evaluations = readFileSync(evaluationLog, 'utf8').trim().split('\n');
    expect(evaluations).toHaveLength(roots.length);
    expect(new Set(evaluations).size).toBe(roots.length);
    // A revision tree has no package-artifact publication: the same evaluation
    // emits each package's serialized manifest for the tree's Plugin UI compiler.
    for (const root of roots) {
      const relativeRoot = relative(repoRoot, root).replaceAll('\\', '/');
      const emitted = ingestPluginManifestV2(JSON.parse(readFileSync(join(projectionRoot, relativeRoot, '.happier-plugin/plugin.json'), 'utf8')));
      expect(emitted.ok && emitted.manifest.id).toBe(`happier.${relativeRoot.split('/').pop()}`);
      expect(existsSync(join(root, '.happier-plugin/plugin.json'))).toBe(false);
    }
    const scaled = await readCliSourceEntries({ repoDir: repoRoot, projectionRoot, manifest: {}, transform });
    const normalizedPath = projectPackedSessionRunnerModulePath({
      daemonEntrypoint: manifest.entrypoints!.daemon!, locatorModule: './agent/runtime/factory',
    });
    for (const root of roots) {
      const relativeRoot = relative(repoRoot, root).replaceAll('\\', '/');
      expect(scaled.entries[`${relativeRoot}/${normalizedPath.replace(/\.js$/u, '')}`])
        .toBe(join(root, 'src/agent/runtime/factory.ts'));
    }
  } finally { cleanup(); }
}, 240_000);

it('derives isolated source daemon projections while keeping committed-output checks strict', async () => {
  const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-daemon-projections-');
  try {
    // Give the real generator its own publication root. Taking the checkout's
    // live publication lock would couple this fixture to unrelated builds.
    const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const scriptsDir = join(happyCliDir, 'scripts');
    const sourceCli = join(sourceRoot, 'apps/cli');
    await captureBuildInputFiles({ sourceDir: sourceCli, captureDir: happyCliDir,
      readPaths: () => readWorkspaceBuildInputs(sourceCli).filter(path => path.startsWith('scripts/')) });
    // Host projections are writable fixture outputs, so this tree must be a
    // private copy rather than a link to the shared checkout.
    cpSync(join(sourceRoot, 'apps/cli/src'), join(happyCliDir, 'src'), {
      recursive: true, filter: path => !/\.(?:test|spec|testkit)\.[^.]+$/u.test(path),
    });
    symlinkSync(join(sourceRoot, 'node_modules'), join(repoRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await captureBuildInputFiles({ sourceDir: sourceRoot, captureDir: repoRoot,
      readPaths: () => readWorkspaceBuildInputs(sourceRoot).filter(path => path.startsWith('scripts/')) });
    for (const { root: source } of (await readWorkspacePackages(sourceRoot)).values()) {
      const path = relative(sourceRoot, source).replaceAll('\\', '/');
      if (!path.startsWith('packages/') || path.startsWith('packages/plugins/')) continue;
      const target = join(repoRoot, path);
      await captureBuildInputFiles({ sourceDir: source, captureDir: target,
        readPaths: () => readWorkspaceBuildInputs(source, { includeShippedFiles: true }).filter(path => !path.startsWith('../')) });
      symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    for (const path of ['tsconfig.json', 'tsconfig.runtime.json']) {
      cpSync(join(sourceRoot, 'apps/cli', path), join(happyCliDir, path));
    }

    const { main } = await import(pathToFileURL(join(scriptsDir, 'build-owned/generateBundledPluginEntries.ts')).href) as typeof import('../generateBundledPluginEntries');
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-fixture'] });
    writeFileSync(join(happyCliDir, 'package.json'), JSON.stringify({
      ...JSON.parse(readFileSync(join(happyCliDir, 'package.json'), 'utf8')), type: 'module',
    }));
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'fixture' });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-fixture', version: '0.0.0', type: 'module',
      files: ['assets'],
      exports: { '.': { 'happier-source': './src/index.ts' } },
    }));
    const { brand: _brand, resources: _resources, ...manifest } = PLUGIN_MANIFEST;
    writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
    mkdirSync(join(packageRoot, 'assets'), { recursive: true });
    cpSync(join(sourceRoot, 'packages/plugins/custom-acp/assets/brand.png'), join(packageRoot, 'assets/brand.png'));
    const factorySource = join(packageRoot, 'src/agent/runtime/factory.ts');
    mkdirSync(dirname(factorySource), { recursive: true });
    writeFileSync(factorySource, 'export function createFixture() { throw new Error("fixture factory is not invoked at admission"); }');
    writeFileSync(join(packageRoot, 'src/index.ts'), [
      "export { PLUGIN_MANIFEST as manifest } from './manifest.js';",
      "import { createFixture } from './agent/runtime/factory.js';",
      'export function activate(api) {',
      "  api.agents.register('custom-acp', createFixture, {sessionRunnerFactory: {",
      "    module: './agent/runtime/factory', export: 'createFixture', runtimeApiVersion: 1,",
      '  }});',
      '}',
    ].join('\n'));
    for (const path of ['src/agent/definition.ts', 'src/ui/descriptor.ts']) {
      mkdirSync(dirname(join(packageRoot, path)), { recursive: true });
      writeFileSync(join(packageRoot, path), 'throw new Error("daemon must not inspect unrelated projection facts");');
    }
    const factory = {
      localAgentId: 'custom-acp',
      locator: { module: './agent/runtime/factory', export: 'createFixture', runtimeApiVersion: 1 as const },
      normalizedModulePath: projectPackedSessionRunnerModulePath({
        daemonEntrypoint: manifest.entrypoints!.daemon!, locatorModule: './agent/runtime/factory',
      }),
      loadMode: 'immutable-js' as const,
    };
    const normalized = ingestPluginManifestV2({ ...manifest, runtime: { ...manifest.runtime, agentFactories: [factory] } });
    if (!normalized.ok) throw new Error('Fixture declaration must pass the canonical manifest ingress');
    const projectedManifest = normalized.manifest;
    const pluginPackages = [{ pluginPackageId: 'fixture', pluginId: manifest.id,
      packageName: '@happier-dev/plugins-fixture', packageVersion: '0.0.0', manifest: projectedManifest }];
    const locator = resolveGeneratorHostProjectionOutPaths(repoRoot).cliManifestOutPath;
    mkdirSync(dirname(locator), { recursive: true });
    const locatorOutput = renderCliBundledPluginManifestEntriesTs({ pluginPackages });
    writeFileSync(locator, locatorOutput);
    // The committed daemon publication is the manifest plus its derived summary and
    // schema assets, and the help facts derived from the same bundled membership.
    const assets = renderCliBundledPluginManifestAssets({ pluginPackages });
    const [asset] = assets;
    if (!asset) throw new Error('Fixture must produce its declaration asset');
    const assetPath = join(happyCliDir, asset.relativePath);
    for (const published of [...assets, ...renderCliBundledActionCliHelpAssets({ pluginPackages })]) {
      mkdirSync(dirname(join(happyCliDir, published.relativePath)), { recursive: true });
      writeFileSync(join(happyCliDir, published.relativePath), published.out);
    }

    const check = () => main(['--root', repoRoot, '--mode', 'check', '--daemon-projections']);
    await check();
    // The packaged .happier-plugin/plugin.json is an ignored, derived package
    // output (trees and replicas regenerate it). A stale local copy is not
    // declaration drift, so the projection check does not compare it.
    mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
    writeFileSync(join(packageRoot, '.happier-plugin/plugin.json'), '{"id":"stale.packaged.copy"}\n');
    await check();
    const { entries } = await readCliSourceEntries({ repoDir: repoRoot, manifest: {}, transform });
    expect(entries['packages/plugins/fixture/dist/index']).toBe(join(packageRoot, 'src/index.ts'));
    expect(entries['packages/plugins/fixture/dist/agent/runtime/factory']).toBe(factorySource);
    expect(entries[`packages/plugins/fixture/${factory.normalizedModulePath.replace(/\.js$/u, '')}`]).toBe(factorySource);
    // The authored registration is current but its committed declaration still
    // selects the old engine leaf. The strict publication check must refuse it.
    const engineSource = join(packageRoot, 'src/agent/runtime/engine.ts');
    writeFileSync(engineSource, "export { createFixture } from './factory.js';");
    const staleManifest = { ...projectedManifest, runtime: {
      ...projectedManifest.runtime, agentFactories: [{ ...factory,
        locator: { ...factory.locator, module: './agent/runtime/engine' },
        normalizedModulePath: projectPackedSessionRunnerModulePath({
          daemonEntrypoint: manifest.entrypoints!.daemon!, locatorModule: './agent/runtime/engine',
        }),
      }],
    } };
    const [staleAsset] = renderCliBundledPluginManifestAssets({
      pluginPackages: [{ ...pluginPackages[0]!, manifest: staleManifest }],
    });
    if (!staleAsset) throw new Error('Fixture must produce its stale declaration asset');
    writeFileSync(assetPath, staleAsset.out);
    const stale = await readCliSourceEntries({ repoDir: repoRoot, manifest: {}, transform });
    expect(stale.entries['packages/plugins/fixture/dist/agent/runtime/engine']).toBe(engineSource);
    expect(stale.entries['packages/plugins/fixture/dist/agent/runtime/factory']).toBeUndefined();
    await expect(check()).rejects.toThrow(/generated output differs.*fixture\.json/u);
    expect(readFileSync(assetPath, 'utf8')).toContain('agent/runtime/engine');

    // Source reload derives its own declaration from the captured authoring
    // inputs. Stale checkout assets and an invalid optional sibling must not
    // prevent the healthy plugin from loading in the emitted runtime.
    const brokenRoots = ['broken', 'missing', 'syntax'].map(pluginId => {
      const root = writeBundledPluginSourceInputs({ repoRoot, pluginId });
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: `@happier-dev/plugins-${pluginId}`, version: '0.0.0', type: 'module',
        exports: { '.': { 'happier-source': './src/index.ts' } },
      }));
      if (pluginId === 'missing') rmSync(join(root, 'src/manifest.ts'));
      else writeFileSync(join(root, 'src/manifest.ts'), pluginId === 'syntax'
        ? 'export const PLUGIN_MANIFEST = ;'
        : 'export const PLUGIN_MANIFEST = { schemaVersion: 2, id: "happier.broken" };');
      writeFileSync(join(root, 'src/index.ts'), 'export const activate = () => {};');
      return root;
    });
    const staleBytes = readFileSync(assetPath, 'utf8');
    const locatorBytes = readFileSync(locator, 'utf8');
    const cliPackage = JSON.parse(readFileSync(join(happyCliDir, 'package.json'), 'utf8'));
    const sourceCliPackage = JSON.parse(readFileSync(join(sourceRoot, 'apps/cli/package.json'), 'utf8'));
    writeFileSync(join(happyCliDir, 'package.json'), JSON.stringify({ ...cliPackage,
      imports: sourceCliPackage.imports,
      dependencies: Object.fromEntries(Object.entries(sourceCliPackage.dependencies)
        .filter(([name]) => !name.startsWith('@happier-dev/plugins-'))),
    }));
    writeFileSync(join(happyCliDir, 'src/index.ts'), [
      "export { loadCurrentBundledPluginLocatorResult } from './plugins/projection/registry/builtIn/locators';",
      "export { projectBundledPluginCatalogEntries } from './plugins/projection/catalog/installed';",
    ].join('\n'));
    symlinkSync(join(sourceRoot, 'apps/cli/node_modules'), join(happyCliDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const name of ['ui', 'stack']) {
      const target = join(repoRoot, 'apps', name);
      mkdirSync(target, { recursive: true });
      cpSync(join(sourceRoot, 'apps', name, 'package.json'), join(target, 'package.json'));
      cpSync(join(sourceRoot, 'apps', name, 'scripts'), join(target, 'scripts'), {
        recursive: true, filter: path => !/\.(?:test|spec)\.[^.]+$/u.test(path),
      });
    }
    // The real builder is an untyped repository-tool boundary, not a mocked
    // projection producer or an owner-injected replacement for real wiring.
    const { buildSourceRuntimeBundle } = await import(/* @vite-ignore */ pathToFileURL(join(sourceRoot, 'apps/stack/scripts/build/build_source_runtime.mjs')).href);
    const generatorPath = join(scriptsDir, 'build-owned/generateBundledPluginEntries.ts');
    const generatorSource = readFileSync(generatorPath, 'utf8');
    // Reproduce the old caller's strict check through the same real publisher,
    // input capture and builder. Only the fixture's CLI mode is selected here.
    writeFileSync(generatorPath, generatorSource.replace('await main();', "await main(['--mode', 'check', '--daemon-projections']);"));
    await expect(buildSourceRuntimeBundle({ repoDir: repoRoot, outputDir: join(repoRoot, 'strict-runtime'), component: 'daemon' }))
      .rejects.toThrow(/Missing required plugin manifest|Bundled plugin package validation failed|generated output differs/u);
    writeFileSync(generatorPath, generatorSource);
    rmSync(locator);
    const runtime = await buildSourceRuntimeBundle({ repoDir: repoRoot, outputDir: join(repoRoot, 'runtime'), component: 'daemon' });
    const loaded = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const {loadCurrentBundledPluginLocatorResult,projectBundledPluginCatalogEntries} = await import(${JSON.stringify(pathToFileURL(runtime.entrypoint).href)});
      const result = loadCurrentBundledPluginLocatorResult();
      assert.deepEqual(result.loadedPlugins.map(plugin => plugin.pluginId), [${JSON.stringify(manifest.id)}]);
      assert.deepEqual(result.pluginFailures.map(failure => failure.pluginId), ['happier.broken','happier.missing','happier.syntax']);
      const catalog = projectBundledPluginCatalogEntries(result);
      for (const failure of result.pluginFailures) {
        assert.equal(failure.diagnostic.code, 'plugin_manifest_invalid');
        assert.ok(failure.diagnostic.message.length > 0);
        const row = catalog.find(entry => entry.pluginId === failure.pluginId);
        assert.equal(row.enabled, false);
        assert.equal(row.compatibility.status, 'load_error');
        assert.deepEqual(row.diagnostics, [failure.diagnostic]);
      }
      const healthy = result.loadedPlugins[0];
      assert.equal(typeof (await import(healthy.pluginRootPath + '/dist/index.js')).activate, 'function');
      assert.equal(healthy.manifest.runtime.agentFactories[0].locator.module, './agent/runtime/factory');
    `], { encoding: 'utf8', env: { ...process.env, ...runtime.env, NODE_OPTIONS: '' } });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(readFileSync(assetPath, 'utf8')).toBe(staleBytes);
    expect(existsSync(locator)).toBe(false);

    for (const root of brokenRoots) rmSync(root, { recursive: true, force: true });
    writeFileSync(assetPath, asset.out);
    writeFileSync(locator, `${locatorBytes}\nexport const drift = true;\n`);
    await expect(check()).rejects.toThrow(/generated output differs/u);
    await expect(main(['--root', repoRoot, '--daemon-projections', '--daemon-output-root', repoRoot]))
      .rejects.toThrow(/separate from its source checkout/u);
    const requiredRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'codex' });
    writeFileSync(join(requiredRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-codex', version: '0.0.0' }));
    await expect(main(['--root', repoRoot, '--daemon-projections', '--daemon-output-root', join(repoRoot, 'required-output')]))
      .rejects.toThrow(/required by host code/u);
  } finally { cleanup(); }
}, 240_000);
