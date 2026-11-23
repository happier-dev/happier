import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

import { derivePluginAccountExecutionArtifactSlots } from '@happier-dev/protocol/plugins/contributions/catalog';
import { resolveWorkspaceBundlesFromPackageJson } from '@happier-dev/cli-common/workspaces';
import { discoverExecutablePluginUiArtifacts } from '../../../../../packages/plugin-sdk/src/ui/build/manifestArtifactDiscovery';
import { compileUniversalPluginUiCommonJs } from '../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { sourcePluginUiBuildOptions } from '../../../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { stagePluginDaemonRuntime } from '../../../src/plugins/authoring/bundleDaemonRuntime';
import { evaluatePluginAuthorRuntimeStagingSource } from '../../../src/plugins/authoring/runtimeStagingSource';
import { normalizePluginManifestV2 } from '../../../src/plugins/manifest/normalize';
import { loadVerifiedPluginModule, type PluginModuleNamespace } from '../../../src/plugins/runtime/loadPluginModule';
import { PLUGIN_HOST_SHARED_RUNTIME_PACKAGES } from '../../pluginHostSharedRuntimePackages.mjs';
import { pluginPackageNameToPackageId, readBundledPluginPackageNames } from '../bundledPluginMembership';
import { importPluginAuthorRuntimeModules } from '../generateBundledPluginEntries';
import { selectCanonicalRuntimeWorkspacePackageRoots } from './runtimeWorkspaces.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const hostPackageDir = join(repoRoot, 'apps/cli');
const workspaceRoots = selectCanonicalRuntimeWorkspacePackageRoots(
  resolveWorkspaceBundlesFromPackageJson({ repoRoot, hostPackageDir }),
);
const buildOptions = await sourcePluginUiBuildOptions({ repoRoot });

async function loadEntry(entryPath: string) {
  return await loadVerifiedPluginModule({
    entryPath, loadMode: 'immutable-js', generationScope: {}, cacheKey: entryPath,
  });
}

it.each(readBundledPluginPackageNames(repoRoot))('loads shipped runtime entries for %s', async packageName => {
  const projectRoot = join(repoRoot, 'packages/plugins', pluginPackageNameToPackageId(packageName));
  const loadSource = (entryPath: string) => importPluginAuthorRuntimeModules(async load => (
    await load(pathToFileURL(entryPath).href, import.meta.url) as PluginModuleNamespace
  ));
  const manifest = normalizePluginManifestV2((await loadSource(join(projectRoot, 'src/manifest.ts'))).PLUGIN_MANIFEST);
  const accountSlots = derivePluginAccountExecutionArtifactSlots(manifest.contributes);
  const daemon = manifest.entrypoints?.daemon;
  if (!daemon && accountSlots.length === 0) return;

  const root = await mkdtemp(join(tmpdir(), 'happier-bundled-runtime-'));
  try {
    const manifestPath = join(root, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const artifacts = accountSlots.length === 0 ? [] : await discoverExecutablePluginUiArtifacts(
      projectRoot, manifestPath, buildOptions.exportConditions,
    );
    for (const artifactId of new Set(accountSlots.map(({ registrationRight }) => registrationRight.target.artifactId))) {
      const artifact = artifacts.find(candidate => candidate.artifactId === artifactId);
      if (!artifact) throw new Error(`Missing declared Account artifact ${artifactId}`);
      const compiled = await compileUniversalPluginUiCommonJs({ ...artifact, ...buildOptions, projectRoot });
      const entryPath = join(root, compiled.relativePath);
      await mkdir(dirname(entryPath), { recursive: true });
      await writeFile(entryPath, compiled.bytes);
      const loaded = await loadEntry(entryPath);
      for (const name of artifact.requestedExports) {
        expect(loaded[name], `${artifactId}#${name}`).toBeTypeOf('function');
      }

      // Evaluate every emitted external with the same resolver, including
      // imports reached only after activation or an Action invocation.
      const externalsPath = join(dirname(entryPath), 'externals.cjs.bundle');
      await writeFile(externalsPath, compiled.externalSpecifiers.map(name => `require(${JSON.stringify(name)});`).join('\n'));
      await loadEntry(externalsPath);
    }

    if (daemon) {
      const sourceEntryPath = join(projectRoot, 'src/index.ts');
      const { sessionRunnerFactories } = await evaluatePluginAuthorRuntimeStagingSource({
        locator: sourceEntryPath, rootPath: projectRoot, loadModule: loadSource,
        authority: { kind: 'bundled_first_party', pluginId: manifest.id, packageRootPath: projectRoot },
      });
      const daemonExternalReads = new Set<string>();
      await stagePluginDaemonRuntime({
        sourceRootPath: projectRoot, sourceEntryPath, stagedRootPath: root, daemonEntrypoint: daemon,
        sessionRunnerFactories, canonicalWorkspacePackageRoots: workspaceRoots,
        firstPartyPackagedWorkspaceExternals: PLUGIN_HOST_SHARED_RUNTIME_PACKAGES,
      }, {
        inspectEmittedOutputs(outputs) {
          for (const { imports } of Object.values(outputs)) {
            for (const { external, kind, path } of imports) {
              // The bundler resolves ordinary package imports itself. Node
              // built-ins and optional dependencies (such as pg-native) can
              // also appear as externals without being part of the CLI closure.
              if (!external || !PLUGIN_HOST_SHARED_RUNTIME_PACKAGES.some(name => path === name || path.startsWith(`${name}/`))) continue;
              const specifier = JSON.stringify(path);
              daemonExternalReads.add(kind === 'require-call' || kind === 'require-resolve'
                ? `require.resolve(${specifier});`
                : `await import(${specifier});`);
            }
          }
        },
      });

      // The installed daemon resolves the shared SDK/Protocol from the CLI closure.
      // Link just those dependencies so incidental workspace packages stay invisible.
      await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      for (const name of PLUGIN_HOST_SHARED_RUNTIME_PACKAGES) {
        const link = join(root, 'node_modules', name);
        await mkdir(dirname(link), { recursive: true });
        await symlink(join(hostPackageDir, 'node_modules', name), link, 'junction');
      }
      const daemonPath = join(root, daemon);
      expect((await loadEntry(daemonPath)).activate, daemon).toBeTypeOf('function');
      const externalsPath = join(dirname(daemonPath), 'externals.mjs');
      await writeFile(externalsPath, [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        ...daemonExternalReads,
      ].join('\n'));
      await loadEntry(externalsPath);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
