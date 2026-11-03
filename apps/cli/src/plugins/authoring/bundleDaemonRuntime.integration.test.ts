import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { materializePrepublicationWorkspacePackageRoots, resolveWorkspaceBundlesFromPackageJson } from '@happier-dev/cli-common/workspaces';
import { ingestPluginManifestV2, type PluginManifestV2 } from '@happier-dev/protocol';
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk';
import { bundlePluginDaemonRuntime as bundlePluginDaemonRuntimeImplementation } from './bundleDaemonRuntime';
import { evaluatePluginAuthorSource } from './sourceModule';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';

const execFileAsync = promisify(execFile);

const publicAuthoringSourceRoot = fileURLToPath(new URL(
  '../../../../../packages/plugin-sdk/examples/public-authoring',
  import.meta.url,
));

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

async function linkCanonicalPublicRuntimePackages(projectRoot: string): Promise<void> {
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps', 'cli'),
  }).map((bundle) => ({
    ...bundle,
    destDir: join(projectRoot, 'node_modules', ...bundle.packageName.split('/')),
  }));
  materializePrepublicationWorkspacePackageRoots({
    bundles,
    rootPackageNames: ['@happier-dev/plugin-sdk'],
  });
}

describe('bundlePluginDaemonRuntime', () => {

  it('installs the maintained Store kind from a built bundle with only its declared SDK dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-store-bundle-install-'));
    const projectRoot = join(root, 'author');
    const installedRoot = join(root, 'built');
    const happyHomeDir = join(root, 'home');
    const controller = createPluginReloadController({ happyHomeDir });
    const service = createDaemonPluginChangeService({ prepare: createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: controller }),
      readManagedResources: async () => ({ resources: [], reviewed: true }),
    }) });
    try {
      await mkdir(projectRoot, { recursive: true });
      await cp(join(publicAuthoringSourceRoot, 'storeKinds.ts'), join(projectRoot, 'storeKinds.ts'));
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'store-bundle-install', version: '1.0.0', type: 'module', main: './index.ts',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }));
      await writeFile(join(projectRoot, 'index.ts'), `import { createExternalStoreKind } from './storeKinds.js';
const plugin = createExternalStoreKind({ read: async () => null, write: async () => {}, remove: async () => {} });
export const manifest = { ...plugin.manifest, entrypoints: { daemon: './dist/index.js' } };
export const activate = plugin.activate;
`);
      await linkCanonicalPublicRuntimePackages(projectRoot);
      await bundlePluginDaemonRuntimeImplementation(projectRoot);
      await mkdir(installedRoot);
      await cp(join(projectRoot, 'dist'), join(installedRoot, 'dist'), { recursive: true });
      await cp(join(projectRoot, '.happier-plugin'), join(installedRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(installedRoot, 'package.json'), JSON.stringify({ type: 'module' }));
      // The installer receives only emitted artifacts, with no author tree or node_modules.
      const review = await service.requestPluginChange({ kind: 'installPath', locator: installedRoot });
      expect(review, JSON.stringify(review)).toMatchObject({ kind: 'reviewRequired', reviewKind: 'installation' });
      if (review.kind !== 'reviewRequired') throw new Error('Expected Store installation review');
      const installedResult = await service.decidePluginChange({ pendingChangeId: review.pendingChangeId, decision: 'installAndTrust' });
      expect(installedResult, JSON.stringify(installedResult)).toMatchObject({ kind: 'committed', pluginId: 'com.example.store' });
      const [installed] = await readInstalledPluginCatalog({ happyHomeDir });
      expect(installed?.diagnostics).toEqual([]);
      expect(installed?.manifest?.contributes.storeKinds).toMatchObject([{ id: 'theme', operations: { acquire: 'acquire' } }]);
    } finally {
      await service.shutdown();
      await controller.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes lazy dependency imports after an external plugin is installed away from its source', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-installed-plugin-lazy-'));
    const projectRoot = join(parentRoot, 'author');
    const installedRoot = join(parentRoot, 'installed');
    const manifest = {
      schemaVersion: 2, id: 'acme.lazy-parser', version: '1.0.0', displayName: 'Lazy parser',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' }, contributes: {},
    };
    try {
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
      const dependency = join(projectRoot, 'node_modules', 'fixture-css');
      await mkdir(dependency, { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module', dependencies: { 'fixture-css': '1.0.0' } }));
      await writeFile(join(projectRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
      await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-css', version: '1.0.0',
        type: 'module', exports: { import: './index.js', require: './index.cjs' } }));
      await writeFile(join(dependency, 'index.js'), "export const generate = (text) => `import:${text}`;");
      await writeFile(join(dependency, 'index.cjs'), "module.exports = { generate: (text) => `require:${text}` };");
      await writeFile(join(projectRoot, 'src/shape.ts'), "import { generate } from 'fixture-css'; export function shape(text: string) { return [generate(text), require('fixture-css').generate(text)]; }");
      await writeFile(join(projectRoot, 'src/index.ts'), `export const manifest = ${JSON.stringify(manifest)};
export function activate() {}
export async function parse(text: string) { return (await import('./shape.js')).shape(text); }
`);
      await bundlePluginDaemonRuntimeImplementation(projectRoot);
      await mkdir(installedRoot, { recursive: true });
      await cp(join(projectRoot, 'dist'), join(installedRoot, 'dist'), { recursive: true });
      await cp(join(projectRoot, 'package.json'), join(installedRoot, 'package.json'));
      const packed = await import(pathToFileURL(join(installedRoot, 'dist/index.js')).href) as Readonly<{
        parse(text: string): Promise<readonly string[]>;
      }>;
      await expect(packed.parse('synthetic')).resolves.toEqual(['import:synthetic', 'require:synthetic']);
      await expect(packed.parse('again')).resolves.toEqual(['import:again', 'require:again']);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('builds the current public-authoring source into its declared daemon entry and activates its declared runtimes', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-public-authoring-stage-'));
    const projectRoot = join(parentRoot, 'public-authoring');
    try {
      await cp(publicAuthoringSourceRoot, projectRoot, { recursive: true });
      await linkCanonicalPublicRuntimePackages(projectRoot);

      const evaluated = await evaluatePluginAuthorSource({ locator: projectRoot });
      await bundlePluginDaemonRuntimeImplementation(projectRoot);

      const daemonPath = join(projectRoot, 'dist', 'daemon.js');
      await execFileAsync(process.execPath, [
        '--test',
        'test/index.test.mjs',
      ], { cwd: projectRoot });

      const generatedManifestPath = join(projectRoot, '.happier-plugin', 'plugin.json');
      await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
      await writeFile(generatedManifestPath, evaluated.canonicalManifestJson, 'utf8');
      const daemonModuleLoaded = await import(`${pathToFileURL(daemonPath).href}?public-authoring-stage`);
      const daemonModule = daemonModuleLoaded as Readonly<{
          manifest: unknown;
          activate(api: unknown): Promise<void>;
          reviewAgentRunnerFactory: Readonly<{
            module: string;
            export: string;
            runtimeApiVersion: number;
          }>;
        }>;
      const registered = Object.freeze({
        actions: [] as string[],
        agents: [] as string[],
        hooks: [] as string[],
        dynamicResources: [] as string[],
        voiceProviders: [] as string[],
        composerReferences: [] as string[],
      });

      await daemonModule.activate({
        actions: { register(id: string) { registered.actions.push(id); } },
        agents: { register(id: string) { registered.agents.push(id); } },
        hooks: { register(id: string) { registered.hooks.push(id); } },
        resources: {
          registerDynamicResource(id: string) { registered.dynamicResources.push(id); },
        },
        voiceProviders: { register(id: string) { registered.voiceProviders.push(id); } },
        composerReferences: {
          register(id: string) { registered.composerReferences.push(id); },
        },
      });

      const daemonManifestResult = ingestPluginManifestV2(daemonModule.manifest);
      expect(daemonManifestResult).toMatchObject({ ok: true });
      if (!daemonManifestResult.ok) {
        throw new Error('Bundled public-authoring manifest must remain valid at the canonical ingress');
      }
      const daemonManifest = daemonManifestResult.manifest;
      const declared = daemonManifest.contributes;
      const declaredActions = declared?.actions;
      const declaredAgents = declared?.agents;
      const declaredHooks = declared?.hooks;
      const declaredResources = declared?.resources;
      const declaredVoiceProviders = declared?.voiceProviders;
      const declaredComposerReferences = declared?.composerReferences;
      if (
        !declaredActions
        || !declaredAgents
        || !declaredHooks
        || !declaredResources
        || !declaredVoiceProviders
        || !declaredComposerReferences
      ) {
        throw new Error('Public authoring fixture must declare every exercised daemon contribution family');
      }
      const generatedManifest = JSON.parse(await readFile(generatedManifestPath, 'utf8')) as PluginManifestV2;
      expect(generatedManifest).toEqual(evaluated.manifest);
      expect(daemonManifest).toEqual(generatedManifest);
      expect(daemonManifest.entrypoints).toEqual({ daemon: './dist/daemon.js' });
      expect(daemonModule.reviewAgentRunnerFactory).toEqual({
        module: './agent/runtime.js',
        export: 'createReviewAgentRuntime',
        runtimeApiVersion: 1,
      });
      // Client-target actions are activated by their declared client artifact;
      // daemon activation owns only the daemon-target declarations.
      expect(registered.actions).toEqual(
        declaredActions
          .filter(({ execution }) => execution.target === 'daemon')
          .map(({ id }) => id),
      );
      expect(registered.agents).toEqual(declaredAgents.map(({ id }) => id));
      expect(registered.hooks).toEqual(declaredHooks.map(({ id }) => id));
      expect(registered.dynamicResources).toEqual(
        declaredResources.filter(({ source }) => source === 'dynamic').map(({ id }) => id),
      );
      // Conversation Voice rows point at their client artifact and therefore
      // are intentionally absent from daemon activation; speech rows carry
      // the daemon runtime producer in this source definition.
      expect(registered.voiceProviders).toEqual(
        declaredVoiceProviders
          .filter(({ kind }) => kind === 'speech')
          .map(({ id }) => id),
      );
      expect(registered.composerReferences).toEqual(
        declaredComposerReferences.map(({ id }) => id),
      );
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('preserves the canonical PluginError contract across the packed SDK copy', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-error-abi-'));
    const manifest = {
      schemaVersion: 2,
      id: 'acme.error-abi',
      version: '1.0.0',
      displayName: 'Error ABI Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    };
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      "import { PluginError, isPluginError } from '@happier-dev/plugin-sdk';",
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function readHostError(error: unknown) {',
      '  if (!isPluginError(error)) return null;',
      '  return { code: error.code, details: error.details };',
      '}',
      'export function createPluginError() {',
      "  return new PluginError({ code: 'plugin_failure', details: { direction: 'plugin-to-host' } });",
      '}',
      'export function isPluginFailure(error: unknown) { return isPluginError(error); }',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    await linkCanonicalPublicRuntimePackages(projectRoot);

    try {
      await bundlePluginDaemonRuntimeImplementation(projectRoot);
      const outputPath = join(projectRoot, 'dist', 'index.js');
      const packed = await import(`${pathToFileURL(outputPath).href}?error-abi=${Date.now()}`) as Readonly<{
        readHostError(error: unknown): unknown;
        createPluginError(): unknown;
        isPluginFailure(error: unknown): boolean;
      }>;
      const hostError = new PluginError({
        code: 'host_failure',
        details: { direction: 'host-to-plugin' },
      });

      expect(packed.readHostError(hostError)).toEqual({
        code: 'host_failure',
        details: { direction: 'host-to-plugin' },
      });

      const pluginError = packed.createPluginError();
      expect(pluginError).not.toBeInstanceOf(PluginError);
      expect(isPluginError(pluginError)).toBe(true);
      if (!isPluginError(pluginError)) {
        throw new Error('Packed PluginError must retain the canonical public error contract.');
      }
      expect(pluginError.code).toBe('plugin_failure');
      expect(pluginError.details).toEqual({ direction: 'plugin-to-host' });

      expect(isPluginError({ ...hostError })).toBe(false);
      expect(packed.isPluginFailure({ ...pluginError })).toBe(false);
      expect(isPluginError(new Error('ordinary failure'))).toBe(false);
      expect(packed.isPluginFailure(new Error('ordinary failure'))).toBe(false);

      const decoratedOrdinaryError = Object.assign(new Error('ordinary failure'), {
        code: 'plugin_failure',
        retryable: false,
        data: {
          name: 'PluginError',
          code: 'plugin_failure',
          message: 'ordinary failure',
        },
      });
      expect(isPluginError(decoratedOrdinaryError)).toBe(false);
      expect(packed.isPluginFailure(decoratedOrdinaryError)).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
