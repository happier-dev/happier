import { renderBundledDeclarationAsset } from '../projection/registry/builtIn/declarationAssets';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs';
import * as fileSystemPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
  type SourceDevSharedDepsPreflightResult,
} from '@/subprocess/sourceDevSharedDepsPreflight';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { projectActivationTarget } from './lifecycle/activation/targets';
import { projectAdmittedBackgroundServicePlugin } from './lifecycle/contributions/backgroundServiceProcessSource';
import { loadAdmittedPluginProcessRegistrations } from './lifecycle/activation/admittedProcessPlugins';
import { bindPluginRuntimeSourceAuthority, resolvePluginSourceCustody } from './sourceAuthority';
import { createPluginRuntimeOccurrenceId } from './runtimeSlots';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS, BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';

import {
  createBundledActivationSourceResolver,
  createRuntimeBundledActivationSourceResolver,
  resolvePackagedBundledActivationPaths,
  resolveBundledActivationSourceRepoRoot,
  resolveSourceDevelopmentBundledPackageNames,
} from './bundledActivationSource';
import type { PluginDaemonModuleNamespace } from './types';

const pluginModuleFixture: PluginDaemonModuleNamespace = {
  activate: async () => undefined,
};

const syncedPreflight = {
  type: 'ready',
  checked: true,
  reason: 'source-imports',
} satisfies SourceDevSharedDepsPreflightResult;

const distOnlyPreflight = {
  type: 'ready',
  checked: false,
  reason: 'not-source-dev',
} satisfies SourceDevSharedDepsPreflightResult;

const tempDirs: string[] = [];
async function writeFlatAdmittedPluginCopy(params: Readonly<{
  cliProjectPath: string;
  workspaceName: string;
}>): Promise<{ outputPath: string }> {
  const packageDir = join(
    params.cliProjectPath,
    'node_modules',
    '@happier-dev',
    params.workspaceName,
  );
  const packageJsonPath = join(packageDir, 'package.json');
  const outputPath = join(packageDir, 'dist', 'index.js');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(
    packageJsonPath,
    JSON.stringify({
      name: `@happier-dev/${params.workspaceName}`,
      main: './dist/index.js',
    }),
    'utf8',
  );
  await writeFile(outputPath, 'export const admitted = true;\n', 'utf8');
  const packageJsonStat = await stat(packageJsonPath);
  const outputStat = await stat(outputPath);
  await writeFile(
    join(params.cliProjectPath, '.cli-source-snapshot-admission.json'),
    JSON.stringify({
      version: 1,
      packages: {
        [params.workspaceName]: {
          dependencies: [],
          dist: {
            fileCount: 1,
            totalBytes: outputStat.size,
          },
          outputs: [
            {
              path: 'package.json',
              size: packageJsonStat.size,
              mtimeMs: packageJsonStat.mtimeMs,
            },
            {
              path: 'dist/index.js',
              size: outputStat.size,
              mtimeMs: outputStat.mtimeMs,
            },
          ],
        },
      },
    }),
    'utf8',
  );
  return { outputPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('createBundledActivationSourceResolver', () => {
  it('places an admitted bundled child in the guest runtime while retaining an external exact source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-guest-bundled-source-'));
    tempDirs.push(root);
    const pluginId = 'happier.scm.backend.git';
    const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(entry => entry.pluginId === pluginId);
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(entry => entry.pluginId === pluginId);
    if (!metadata || !locator) throw new Error('Git bundled source declaration is unavailable');
    const runtimeRoot = join(root, 'guest-runtime');
    const manifest = createPluginManifestV2Fixture({ id: pluginId });
    const manifestPath = join(runtimeRoot, locator.manifestRelativePath);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, renderBundledDeclarationAsset(JSON.stringify(normalizePluginManifestV2(manifest))));
    const guestRoot = join(runtimeRoot, 'node_modules', metadata.packageName);
    await mkdir(guestRoot, { recursive: true });
    const marker = join(root, 'activated');
    await writeFile(join(guestRoot, 'daemon.mjs'), `
      import { appendFile } from 'node:fs/promises';
      export async function activate() { await appendFile(${JSON.stringify(marker)}, 'guest\\n'); }
    `);
    const admitted = await Promise.all([pluginId, 'acme.external'].map(async id => {
      const bundled = id === pluginId;
      const pluginRoot = join(root, bundled ? 'controller-bundled' : 'controller-external');
      await mkdir(pluginRoot);
      const entryPath = join(pluginRoot, 'daemon.mjs');
      await writeFile(entryPath, `
        import { appendFile } from 'node:fs/promises';
        export async function activate() { await appendFile(${JSON.stringify(marker)}, 'external\\n'); }
      `);
      const parsed = ingestCanonicalPluginManifest(createPluginManifestV2Fixture({ id }), {
        sourceProvenance: 'registryCustodied', ...(bundled ? { manifestAuthority: 'bundled_first_party' } : {}),
      });
      if (!parsed.ok) throw new Error(parsed.diagnostics.map(entry => entry.message).join('\n'));
      const sourceAuthority = bindPluginRuntimeSourceAuthority({ custody: { kind: 'development', registeredRootId: pluginRoot },
        resolvedRoot: pluginRoot, observedRevision: 1 });
      const plugin = projectAdmittedBackgroundServicePlugin({
        target: projectActivationTarget({ pluginId: id, provenance: bundled ? 'first_party' : 'external',
          source: { kind: bundled ? 'bundled' : 'path' }, manifest: parsed.manifest,
          manifestPath: join(pluginRoot, 'plugin.json'), daemonEntryPath: bundled ? metadata.packageName : entryPath,
          sourceSpec: bundled ? { kind: 'bundled', locator: metadata.packageName }
            : { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link' } }),
        occurrenceId: createPluginRuntimeOccurrenceId(id), sourceCustody: resolvePluginSourceCustody(sourceAuthority),
        source: bundled ? { kind: 'bundled', moduleId: metadata.packageName, sourceAuthority,
          processEntry: { entryPath, rootPath: pluginRoot, loadMode: 'immutable-js' }, load: async () => ({}) }
          : { kind: 'file_backed', sourceAuthority, entryPath },
      });
      // The guest cannot read the controller's bundled module. External code
      // remains at its admitted path and must not be replaced by bundled code.
      if (bundled) await rm(entryPath);
      return plugin;
    }));
    const packagedRuntime = { kind: 'pinned_runner_snapshot', snapshotId: 'guest-runtime' } as const;
    const resolveBundledActivationSource = createRuntimeBundledActivationSourceResolver({
      activationTargets: admitted.map(plugin => plugin.target),
      packagedRuntime: { root: runtimeRoot, packagedRuntime, provenance: 'packaged-snapshot' },
    });
    const registry = await loadAdmittedPluginProcessRegistrations(admitted, 1,
      async () => { throw new Error('No Account service is available in the guest'); }, undefined,
      { resolveBundledActivationSource });
    try {
      expect([...registry.activatedPluginIds].sort()).toEqual([pluginId, 'acme.external'].sort());
      expect((await readFile(marker, 'utf8')).trim().split('\n').sort()).toEqual(['external', 'guest']);
      expect(registry.readPluginSourceCustody(pluginId)).toEqual({ kind: 'bundled_first_party', packagedRuntime });
      expect(registry.readPluginOccurrenceId(pluginId)).toBe(admitted[0]?.occurrenceId);
      expect(registry.readPluginSourceCustody('acme.external')).toEqual(admitted[1]?.sourceCustody);
    } finally { await registry.dispose(); }
  });
  it('resolves admitted bundled plugins from the executing packaged runtime when the admitted daemon path is outside it, while keeping external exact sources', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-member-cli-bundled-source-')));
    tempDirs.push(root);
    const pluginId = 'happier.scm.backend.git';
    const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(entry => entry.pluginId === pluginId);
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(entry => entry.pluginId === pluginId);
    if (!metadata || !locator) throw new Error('Git bundled source declaration is unavailable');
    const memberRuntimeRoot = join(root, 'member-cli-runtime');
    const manifest = createPluginManifestV2Fixture({ id: pluginId });
    const manifestPath = join(memberRuntimeRoot, locator.manifestRelativePath);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, renderBundledDeclarationAsset(JSON.stringify(normalizePluginManifestV2(manifest))));
    const memberPluginRoot = join(memberRuntimeRoot, 'node_modules', metadata.packageName);
    await mkdir(memberPluginRoot, { recursive: true });
    const marker = join(root, 'activated');
    await writeFile(join(memberPluginRoot, 'daemon.mjs'), `
      import { appendFile } from 'node:fs/promises';
      export async function activate() { await appendFile(${JSON.stringify(marker)}, 'member-cli\\n'); }
    `);
    const daemonPackagedRuntime = { kind: 'cli_version_root', versionRootId: 'local-daemon-1' } as const;
    const memberPackagedRuntime = { kind: 'cli_version_root', versionRootId: 'a'.repeat(64) } as const;
    const admitted = await Promise.all([pluginId, 'acme.external'].map(async id => {
      const bundled = id === pluginId;
      const pluginRoot = join(root, bundled ? 'daemon-private-bundled' : 'controller-external');
      await mkdir(pluginRoot);
      const entryPath = join(pluginRoot, 'daemon.mjs');
      await writeFile(entryPath, `
        import { appendFile } from 'node:fs/promises';
        export async function activate() { await appendFile(${JSON.stringify(marker)}, ${JSON.stringify(bundled ? 'daemon\n' : 'external\n')}); }
      `);
      const parsed = ingestCanonicalPluginManifest(createPluginManifestV2Fixture({ id }), {
        sourceProvenance: 'registryCustodied', ...(bundled ? { manifestAuthority: 'bundled_first_party' } : {}),
      });
      if (!parsed.ok) throw new Error(parsed.diagnostics.map(entry => entry.message).join('\n'));
      const sourceAuthority = bundled
        ? bindPluginRuntimeSourceAuthority({ custody: { kind: 'bundled_first_party', packagedRuntime: daemonPackagedRuntime }, resolvedRoot: pluginRoot })
        : bindPluginRuntimeSourceAuthority({ custody: { kind: 'development', registeredRootId: pluginRoot }, resolvedRoot: pluginRoot, observedRevision: 1 });
      const plugin = projectAdmittedBackgroundServicePlugin({
        target: projectActivationTarget({ pluginId: id, provenance: bundled ? 'first_party' : 'external',
          source: { kind: bundled ? 'bundled' : 'path' }, manifest: parsed.manifest,
          manifestPath: join(pluginRoot, 'plugin.json'), daemonEntryPath: bundled ? metadata.packageName : entryPath,
          sourceSpec: bundled ? { kind: 'bundled', locator: metadata.packageName }
            : { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link' } }),
        occurrenceId: createPluginRuntimeOccurrenceId(id), sourceCustody: resolvePluginSourceCustody(sourceAuthority),
        source: bundled ? { kind: 'bundled', moduleId: metadata.packageName, sourceAuthority,
          processEntry: { entryPath, rootPath: pluginRoot, loadMode: 'immutable-js' }, load: async () => ({}) }
          : { kind: 'file_backed', sourceAuthority, entryPath },
      });
      // Simulate the daemon's private ~/.happier home being inaccessible to the isolated member OS user.
      if (bundled) await rm(entryPath);
      return plugin;
    }));
    const registry = await loadAdmittedPluginProcessRegistrations(
      admitted,
      2,
      async () => { throw new Error('No Account service is available in the member worker'); },
      undefined,
      {
        resolveExecutingPackagedRuntimeCustody: () => ({
          root: memberRuntimeRoot,
          packagedRuntime: memberPackagedRuntime,
          provenance: 'packaged-module',
        }),
      },
    );
    try {
      expect([...registry.activatedPluginIds].sort()).toEqual([pluginId, 'acme.external'].sort());
      expect((await readFile(marker, 'utf8')).trim().split('\n').sort()).toEqual(['external', 'member-cli']);
      expect(registry.readPluginSourceCustody(pluginId)).toEqual({ kind: 'bundled_first_party', packagedRuntime: memberPackagedRuntime });
      expect(registry.readPluginOccurrenceId(pluginId)).toBe(admitted[0]?.occurrenceId);
      expect(registry.readPluginSourceCustody('acme.external')).toEqual(admitted[1]?.sourceCustody);
    } finally { await registry.dispose(); }
  });
  it('keeps the admitted bundled process entry when already inside the executing packaged runtime root', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-same-runtime-bundled-source-')));
    tempDirs.push(root);
    const pluginId = 'happier.scm.backend.git';
    const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(entry => entry.pluginId === pluginId);
    if (!metadata) throw new Error('Git bundled source declaration is unavailable');
    const runtimeRoot = join(root, 'same-cli-runtime');
    const pluginRoot = join(runtimeRoot, 'node_modules', metadata.packageName);
    await mkdir(pluginRoot, { recursive: true });
    const marker = join(root, 'activated');
    const entryPath = join(pluginRoot, 'admitted-entry.mjs');
    await writeFile(entryPath, `
      import { appendFile } from 'node:fs/promises';
      export async function activate() { await appendFile(${JSON.stringify(marker)}, 'admitted-same-root\\n'); }
    `);
    const parsed = ingestCanonicalPluginManifest(createPluginManifestV2Fixture({ id: pluginId }), {
      sourceProvenance: 'registryCustodied', manifestAuthority: 'bundled_first_party',
    });
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(entry => entry.message).join('\n'));
    const packagedRuntime = { kind: 'cli_version_root', versionRootId: 'local-same-1' } as const;
    const sourceAuthority = bindPluginRuntimeSourceAuthority({
      custody: { kind: 'bundled_first_party', packagedRuntime },
      resolvedRoot: pluginRoot,
    });
    const plugin = projectAdmittedBackgroundServicePlugin({
      target: projectActivationTarget({ pluginId, provenance: 'first_party',
        source: { kind: 'bundled' }, manifest: parsed.manifest,
        manifestPath: join(pluginRoot, 'plugin.json'), daemonEntryPath: metadata.packageName,
        sourceSpec: { kind: 'bundled', locator: metadata.packageName } }),
      occurrenceId: createPluginRuntimeOccurrenceId(pluginId), sourceCustody: resolvePluginSourceCustody(sourceAuthority),
      source: { kind: 'bundled', moduleId: metadata.packageName, sourceAuthority,
        processEntry: { entryPath, rootPath: pluginRoot, loadMode: 'immutable-js' }, load: async () => ({}) },
    });
    // No bundled manifest is written under runtimeRoot, so re-resolving would fail; keeping the admitted entry succeeds.
    const registry = await loadAdmittedPluginProcessRegistrations(
      [plugin],
      3,
      async () => { throw new Error('No Account service is available'); },
      undefined,
      {
        resolveExecutingPackagedRuntimeCustody: () => ({
          root: runtimeRoot,
          packagedRuntime,
          provenance: 'packaged-module',
        }),
      },
    );
    try {
      expect([...registry.activatedPluginIds]).toEqual([pluginId]);
      expect((await readFile(marker, 'utf8')).trim()).toBe('admitted-same-root');
      expect(registry.readPluginSourceCustody(pluginId)).toEqual({ kind: 'bundled_first_party', packagedRuntime });
    } finally { await registry.dispose(); }
  });
  it('resolves packaged activation metadata when an unrelated contribution is skipped', () => {
    const packageName = '@happier-dev/plugins-tolerant-fixture';
    const pluginId = 'happier.tolerant-fixture';
    const result = resolvePackagedBundledActivationPaths({ runtimeRoot: '/runtime',
      activationTargets: [{ pluginId, daemonEntryPath: packageName,
        sourceSpec: { kind: 'bundled' } }],
      metadata: [{ pluginId, packageName }],
      locators: [{ pluginId, manifest: createPluginManifestV2Fixture({ id: pluginId,
        contributes: { actions: [{ id: 'future', futureRestriction: true }] } }) }],
    });
    expect(result.entryPathsByPackageName.get(packageName)).toBe(join('/runtime/node_modules', packageName, 'daemon.mjs'));
  });
  it('keeps another bundled source usable when one declared package root is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-account-missing-bundle-'));
    tempDirs.push(root);
    const declarations = ['missing', 'ready'].map(name => {
      const packageName = `@happier-dev/plugins-${name}`;
      return {
        pluginId: `happier.${name}`, pluginRootPath: join(root, name), manifestPath: `bundled:${name}`,
        daemonEntryPath: null, devDaemonEntryPath: null,
        sourceSpec: { kind: 'bundled' as const, locator: packageName, trustPolicy: 'prompt' as const, installPolicy: 'copy' as const },
        manifest: normalizePluginManifestV2(createPluginManifestV2Fixture({ id: `happier.${name}` })),
      };
    });
    const ready = declarations[1]!;
    await mkdir(ready.pluginRootPath);
    await writeFile(join(ready.pluginRootPath, 'package.json'), JSON.stringify({ name: ready.sourceSpec.locator }));
    const resolveSource = createBundledActivationSourceResolver({
      bundledPackageNames: declarations.map(declaration => declaration.sourceSpec.locator), bundledDeclarations: declarations,
    });
    expect(resolveSource(declarations[0]!, { realm: 'account' })).toBeNull();
    const source = resolveSource(ready, { realm: 'account' });
    expect(source?.sourceAuthority).toMatchObject({ kind: 'bundled_first_party', resolvedRoot: await realpath(ready.pluginRootPath) });
    await expect(source?.prepare?.()).resolves.toBeUndefined();
  });
  it.each([
    { mode: 'packaged', daemon: false }, { mode: 'source', daemon: false },
    { mode: 'packaged', daemon: true }, { mode: 'source', daemon: true },
  ] as const)('admits bundled declaration from its actual $mode root in Account realm (daemon=$daemon)', async ({ mode, daemon }) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-account-bundled-'));
    tempDirs.push(runtimeRoot);
    const packageName = '@happier-dev/plugins-account-fixture';
    const packageRoot = join(runtimeRoot, 'node_modules', packageName);
    const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: 'happier.account-fixture',
      entrypoints: daemon ? { daemon: './daemon.cjs' } : {} }));
    await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }));
    await writeFile(join(packageRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
    const packagedRuntime = { kind: 'cli_version_root', versionRootId: 'actual-runtime' } as const;
    const sourceSpec = { kind: 'bundled', locator: packageName, trustPolicy: 'prompt', installPolicy: 'copy' } as const;
    const resolveSource = createBundledActivationSourceResolver({ bundledPackageNames: [packageName],
      bundledDeclarations: [{ pluginId: manifest.id, pluginRootPath: packageRoot, manifestPath: 'bundled:fixture',
        daemonEntryPath: daemon ? packageName : null, devDaemonEntryPath: null, sourceSpec, manifest }],
      ...(mode === 'packaged' ? { packagedRuntime, packagedRuntimeRoot: runtimeRoot } : {}),
    });
    const target = { pluginId: manifest.id, daemonEntryPath: daemon ? packageName : null, sourceSpec, pluginRootPath: packageRoot, manifest };
    const source = resolveSource(target, { realm: 'account' });
    expect(source?.sourceAuthority).toEqual({ kind: 'bundled_first_party',
      packagedRuntime: mode === 'packaged' ? packagedRuntime : { kind: 'source_declaration', packageName },
      resolvedRoot: await realpath(packageRoot) });
    expect(resolveSource({ ...target, manifest: { ...manifest, version: '9.0.0' } }, { realm: 'account' })).toBeNull();
    expect(resolveSource({ ...target, pluginRootPath: runtimeRoot }, { realm: 'account' })).toBeNull();
    await source?.prepare?.();
    await expect(source?.load()).rejects.toThrow('declared Account artifact');
  });
  it('activates frozen bundle plugins and runner leaves on first demand from a bundled host chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-first-demand-'));
    tempDirs.push(root);
    const pluginRoot = join(root, 'packages/plugins/fixture');
    await mkdir(join(pluginRoot, 'dist/agent'), { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture', type: 'module' }));
    await writeFile(join(pluginRoot, 'dist/index.js'), "export const marker = 'frozen-activation'; export async function activate() {}\n");
    await writeFile(join(pluginRoot, 'dist/agent/runner.js'), "export const marker = 'frozen-runner';\n");
    const repoRoot = resolveBundledActivationSourceRepoRoot(pathToFileURL(join(root, 'apps/cli/src/chunks/runtime.js')).href);
    const source = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-fixture'], repoRoot,
      canImportFirstPartyPluginSource: () => false,
    })({ pluginId: 'happier.fixture', daemonEntryPath: '@happier-dev/plugins-fixture' });
    expect((await source?.load())?.marker).toBe('frozen-activation');
    expect((await source?.resolveRelativeModule('./agent/runner.js'))?.module.marker).toBe('frozen-runner');
  });
  it('binds packaged activation from an executing runner snapshot to snapshot custody', () => {
    const pluginId = 'happier.snapshot.fixture';
    const packageName = '@happier-dev/plugins-snapshot-fixture';
    const packageRoot = '/runtime/.runner-snapshots/snapshot-a/node_modules/@happier-dev/plugins-snapshot-fixture';
    const daemonEntryPath = join(packageRoot, '.happier-plugin', 'daemon.js');

    const source = createBundledActivationSourceResolver({
      bundledPackageNames: [packageName],
      immutableArtifactPackageNames: [packageName],
      immutableArtifactEntryPathsByPackageName: new Map([[packageName, daemonEntryPath]]),
      immutableArtifactRootPathsByPackageName: new Map([[packageName, packageRoot]]),
      canImportFirstPartyPluginSource: () => false,
      packagedRuntime: {
        kind: 'pinned_runner_snapshot',
        snapshotId: 'snapshot-a',
      },
    })({ pluginId, daemonEntryPath: packageName });

    expect(source?.sourceAuthority).toEqual({
      kind: 'bundled_first_party',
      packagedRuntime: {
        kind: 'pinned_runner_snapshot',
        snapshotId: 'snapshot-a',
      },
      resolvedRoot: packageRoot,
    });
  });

  it('activates admitted packaged bytes without rereading package metadata or creating a plugin generation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-packaged-bundled-direct-'));
    tempDirs.push(tempDir);
    const runtimeRoot = join(tempDir, 'versions', 'cli-version-0.3.0');
    const happyHomeDir = join(tempDir, 'home');
    const packageName = '@happier-dev/plugins-direct-fixture';
    const pluginId = 'happier.direct.fixture';
    const packageRoot = join(
      runtimeRoot,
      'node_modules',
      '@happier-dev',
      'plugins-direct-fixture',
    );
    const daemonEntryPath = join(packageRoot, '.happier-plugin', 'daemon.mjs');
    const manifestRelativePath = 'assets/bundled-plugin-manifests/direct-fixture.json';
    const manifest = createPluginManifestV2Fixture({
      id: pluginId,
      displayName: 'Direct fixture',
      entrypoints: { daemon: './.happier-plugin/daemon.mjs' },
    });
    await mkdir(dirname(daemonEntryPath), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: packageName,
      version: '1.0.0',
    }), 'utf8');
    await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await mkdir(dirname(join(runtimeRoot, manifestRelativePath)), { recursive: true });
    await writeFile(join(runtimeRoot, manifestRelativePath), renderBundledDeclarationAsset(JSON.stringify(normalizePluginManifestV2(manifest))), 'utf8');
    await writeFile(daemonEntryPath, 'export async function activate() { return "activated"; }\n', 'utf8');

    // Observe the real filesystem boundary; producer admission and module loading remain real.
    const opens = vi.spyOn(fileSystem, 'openSync');
    const readFile = vi.spyOn(fileSystemPromises, 'readFile');
    try {
      const packaged = resolvePackagedBundledActivationPaths({
        runtimeRoot,
        activationTargets: [{
          pluginId,
          daemonEntryPath: packageName,
          sourceSpec: { kind: 'bundled' },
        }],
        metadata: [{ pluginId, packageName }],
        locators: [{ pluginId, manifestRelativePath }],
      });
      const source = createBundledActivationSourceResolver({
        bundledPackageNames: [packageName],
        immutableArtifactPackageNames: [packageName],
        immutableArtifactEntryPathsByPackageName: packaged.entryPathsByPackageName,
        immutableArtifactRootPathsByPackageName: packaged.rootPathsByPackageName,
        canImportFirstPartyPluginSource: () => false,
        packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-version-0.3.0' },
        repoRoot: '/source-checkout-unavailable',
      })({ pluginId, daemonEntryPath: packageName });

      expect(source?.sourceAuthority).toEqual({
        kind: 'bundled_first_party',
        packagedRuntime: {
          kind: 'cli_version_root',
          versionRootId: 'cli-version-0.3.0',
        },
        resolvedRoot: packageRoot,
      });
      if (!source) throw new Error('Packaged activation source is unavailable');
      const loaded = await source.load();
      if (typeof loaded.activate !== 'function') throw new Error('Packaged activate export is unavailable');
      await expect(loaded.activate()).resolves.toBe('activated');
      expect(opens.mock.calls.filter(([path]) => String(path) === join(runtimeRoot, manifestRelativePath))).toHaveLength(1);
      expect(readFile.mock.calls.filter(([path]) => (
        String(path) === join(packageRoot, 'package.json')
        || String(path) === join(packageRoot, '.happier-plugin', 'plugin.json')
      ))).toHaveLength(0);
      await expect(stat(resolvePluginStorePaths({ happyHomeDir }).generationsDir))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      opens.mockRestore();
      readFile.mockRestore();
    }
  });

  it('resolves the canonical checkout through a preserve-symlinks source snapshot path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-source-root-symlink-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const canonicalSourceRoot = join(repoRoot, 'apps', 'cli', 'src');
    const canonicalModulePath = join(
      canonicalSourceRoot,
      'plugins',
      'runtime',
      'bundledActivationSource.ts',
    );
    const snapshotSourceRoot = join(
      repoRoot,
      '.project',
      'tmp',
      'cli-dist-snapshot',
      'src',
    );
    await mkdir(dirname(canonicalModulePath), { recursive: true });
    await mkdir(dirname(snapshotSourceRoot), { recursive: true });
    await writeFile(canonicalModulePath, '// source fixture\n', 'utf8');
    await symlink(canonicalSourceRoot, snapshotSourceRoot, 'dir');

    expect(resolveBundledActivationSourceRepoRoot(
      pathToFileURL(join(
        snapshotSourceRoot,
        'plugins',
        'runtime',
        'bundledActivationSource.ts',
      )),
    )).toBe(resolve(await realpath(repoRoot)));
  });

  it('retains lexical root resolution for virtual packaged module paths', () => {
    expect(resolveBundledActivationSourceRepoRoot(
      pathToFileURL('/$bunfs/root/apps/cli/src/plugins/runtime/bundledActivationSource.js'),
    )).toBe(resolve('/$bunfs/root'));
  });

  it('recognizes a source-development package resolved through the snapshot node_modules overlay', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-package-overlay-symlink-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const packageName = '@happier-dev/plugins-session-owner';
    const workspaceName = 'plugins-session-owner';
    const sourceEntryPath = join(
      repoRoot,
      'packages',
      'plugins',
      'session-owner',
      'src',
      'index.ts',
    );
    const canonicalPackageRoot = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      workspaceName,
    );
    const canonicalPackageEntry = join(canonicalPackageRoot, 'dist', 'index.js');
    const snapshotPackageRoot = join(
      repoRoot,
      '.project',
      'tmp',
      'cli-dist-snapshot',
      'node_modules',
      '@happier-dev',
      workspaceName,
    );
    await mkdir(dirname(sourceEntryPath), { recursive: true });
    await mkdir(dirname(canonicalPackageEntry), { recursive: true });
    await mkdir(dirname(snapshotPackageRoot), { recursive: true });
    await writeFile(sourceEntryPath, 'export function activate() {}\n', 'utf8');
    await writeFile(canonicalPackageEntry, 'export function activate() {}\n', 'utf8');
    await symlink(canonicalPackageRoot, snapshotPackageRoot, 'dir');

    expect([...resolveSourceDevelopmentBundledPackageNames({
      artifacts: [{
        packageName,
        packageEntryRelativePath: 'dist/index.js',
      }],
      canImportFirstPartyPluginSource: () => true,
      repoRoot,
      resolveBundledPackageEntry: () => join(snapshotPackageRoot, 'dist', 'index.js'),
    })]).toEqual([packageName]);
  });

  it('ignores declarative bundled targets without an executable daemon entry', () => {
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-example'],
    });

    expect(resolveActivationSource({
      pluginId: 'happier.example',
      daemonEntryPath: null,
    })).toBeNull();
  });

  it('fails before importing an unadmitted flat plugin copy', async () => {
    const importModule = vi.fn();
    const prepareSourceDevSharedDeps = vi.fn(async () => ({
      type: 'error' as const,
      errorMessage: 'source-dev shared deps are stale',
    }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => false,
      importModule,
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-version-0.3.0' },
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    const source = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    });

    expect(source).toEqual(expect.objectContaining({
      kind: 'bundled',
      moduleId: '@happier-dev/plugins-scm-git',
    }));
    await expect(source?.load()).rejects.toThrow('source-dev shared deps are stale');
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: '@happier-dev/plugins-scm-git',
      }),
    );
    expect(importModule).not.toHaveBeenCalled();
  });

  it('uses first-party plugin dist when source exists but the current host cannot import plugin source', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => false,
      existsSync: (path) => (
        path === '/repo/packages/plugins/scm-git/src/index.ts'
        || path === '/repo/packages/plugins/scm-git/dist/index.js'
      ),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/packages\/plugins\/scm-git\/dist\/index\.js$/u);
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
  });

  it('binds checkout development custody to a first-party plugin loaded from its checkout dist', async () => {
    // A repo-dev daemon runs from built output, so it cannot import plugin
    // source and loads `packages/plugins/<id>/dist`. There is no packaged
    // runtime root; the checkout package root is the source authority.
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-triage'],
      canImportFirstPartyPluginSource: () => false,
      existsSync: (path) => (
        path === '/repo/packages/plugins/triage/src/index.ts'
        || path === '/repo/packages/plugins/triage/dist/index.js'
      ),
      importModule: vi.fn(async () => pluginModuleFixture),
      prepareSourceDevSharedDeps: vi.fn(async () => syncedPreflight),
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development',
        registeredRootId: rootPath,
        canonicalRoot: rootPath,
        observedRevision: pluginId === 'happier.triage' ? 0 : -1,
      }),
      repoRoot: '/repo',
    });

    const source = resolveActivationSource({
      pluginId: 'happier.triage',
      daemonEntryPath: '@happier-dev/plugins-triage',
    });

    expect(source?.sourceAuthority).toEqual({
      kind: 'development',
      registeredRootId: '/repo/packages/plugins/triage',
      canonicalRoot: '/repo/packages/plugins/triage',
      observedRevision: 0,
    });
  });

  it('prefers first-party plugin source over dist when the current host can import plugin source', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => (
        path === '/repo/packages/plugins/scm-git/src/index.ts'
        || path === '/repo/packages/plugins/scm-git/dist/index.js'
      ),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/packages\/plugins\/scm-git\/src\/index\.ts$/u);
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
  });

  it('selects the canonical source-development activation input', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-source-dev-copy-extras-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const sourceEntryPath = join(
      repoRoot,
      'packages',
      'plugins',
      'session-owner',
      'src',
      'index.ts',
    );
    await mkdir(join(sourceEntryPath, '..'), { recursive: true });
    await writeFile(sourceEntryPath, 'export function activate() {}\n', 'utf8');
    const sourceDevelopmentPackageNames =
      resolveSourceDevelopmentBundledPackageNames({
        artifacts: [{
          packageName: '@happier-dev/plugins-session-owner',
          packageEntryRelativePath: 'dist/index.js',
        }],
        canImportFirstPartyPluginSource: () => true,
        existsSync: (path) => path === sourceEntryPath,
        repoRoot,
        resolveBundledPackageEntry: () =>
          join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugins-session-owner', 'dist', 'index.js'),
      });
    expect([...sourceDevelopmentPackageNames]).toEqual([
      '@happier-dev/plugins-session-owner',
    ]);

    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: [],
      unavailableImmutableArtifactPackageNames: new Set(),
      canImportFirstPartyPluginSource: () => true,
      importModule,
      prepareSourceDevSharedDeps,
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development',
        registeredRootId: `registered:${pluginId}`,
        canonicalRoot: rootPath,
        observedRevision: 3,
      }),
      repoRoot,
    });

    const source = resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    });
    await expect(source?.load()).resolves.toBe(pluginModuleFixture);
    expect(source?.sourceAuthority).toEqual({
      kind: 'development',
      registeredRootId: 'registered:happier.agent.session-owner',
      canonicalRoot: join(repoRoot, 'packages', 'plugins', 'session-owner'),
      observedRevision: 3,
    });
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
    expect(importModule).toHaveBeenCalledWith(
      expect.stringMatching(/\/packages\/plugins\/session-owner\/src\/index\.ts$/u),
      { loadMode: 'source-ts' },
    );
  });

  it('keeps an unavailable immutable artifact fail-closed outside a source-capable host', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: ['@happier-dev/plugins-session-owner'],
      unavailableImmutableArtifactPackageNames: new Set([
        '@happier-dev/plugins-session-owner',
      ]),
      canImportFirstPartyPluginSource: () => false,
      existsSync: () => true,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    })?.load()).rejects.toThrow('Bundled immutable artifact is unavailable');
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('does not fall through to dist when a known immutable artifact has no exact admitted path', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: ['@happier-dev/plugins-session-owner'],
      canImportFirstPartyPluginSource: () => false,
      existsSync: (path) => (
        path === '/repo/packages/plugins/session-owner/dist/index.js'
        || path === '/repo/packages/plugins/session-owner/dist/agent/runtime/engine.js'
      ),
      importModule,
      prepareSourceDevSharedDeps: async () => distOnlyPreflight,
      repoRoot: '/repo',
    });
    const source = resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    });

    await expect(source?.load()).rejects.toThrow(
      'Bundled immutable artifact is unavailable',
    );
    await expect(source?.resolveRelativeModule('./agent/runtime/engine')).rejects.toThrow(
      'has no file-backed runner module root',
    );
    expect(importModule).not.toHaveBeenCalled();
  });

  it('does not bypass a rejected immutable artifact with unadmitted source-dev bytes', async () => {
    expect([...resolveSourceDevelopmentBundledPackageNames({
      artifacts: [{
        packageName: '@happier-dev/plugins-session-owner',
        packageEntryRelativePath: 'dist/index.js',
      }],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path === '/repo/packages/plugins/session-owner/src/index.ts',
      repoRoot: '/repo',
      resolveBundledPackageEntry: () =>
        '/installed/plugins-session-owner/dist/index.js',
    })]).toEqual([]);
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: ['@happier-dev/plugins-session-owner'],
      unavailableImmutableArtifactPackageNames: new Set([
        '@happier-dev/plugins-session-owner',
      ]),
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path === '/repo/packages/plugins/session-owner/src/index.ts',
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    })?.load()).rejects.toThrow('Bundled immutable artifact is unavailable');
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('loads an inventory-admitted bundled artifact from its exact admitted package entry', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const admittedEntryPath = '/installed/review-coderabbit/dist/index.js';
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-review-coderabbit'],
      immutableArtifactEntryPathsByPackageName: new Map([
        ['@happier-dev/plugins-review-coderabbit', admittedEntryPath],
      ]),
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => true,
      importModule,
      prepareSourceDevSharedDeps: async () => syncedPreflight,
      repoRoot: '/different-source-checkout',
    });

    await resolveActivationSource({
      pluginId: 'happier.review.coderabbit',
      daemonEntryPath: '@happier-dev/plugins-review-coderabbit',
    })?.load();

    expect(imported).toEqual([expect.stringMatching(/\/installed\/review-coderabbit\/dist\/index\.js$/u)]);
  });

  it('activates the published daemon runtime and its staged runner leaf, not the compiler package root export', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-daemon-entry-'));
    tempDirs.push(tempDir);
    const installedRoot = join(tempDir, 'installed', 'plugins-session-owner');
    // The compiler's own emit. The publisher never writes here, and the daemon must
    // never resolve activation or a runner leaf out of it.
    const compilerPackageEntryPath = join(installedRoot, 'dist', 'index.js');
    const compilerRunnerPath = join(installedRoot, 'dist', 'agent', 'runtime', 'engine.js');
    // The published daemon runtime and the runner leaf staged beside it.
    const daemonEntryPath = join(installedRoot, '.happier-plugin', 'daemon.js');
    const publishedRunnerPath = join(installedRoot, '.happier-plugin', 'agent', 'runtime', 'engine.js');
    await mkdir(dirname(compilerRunnerPath), { recursive: true });
    await mkdir(dirname(publishedRunnerPath), { recursive: true });
    const publishedRunnerBytes = 'export const createSessionOwnerAgentRuntime = () => ({ published: true });\n';
    await writeFile(compilerPackageEntryPath, 'export const packageRootExport = true;\n', 'utf8');
    await writeFile(compilerRunnerPath, 'export const createSessionOwnerAgentRuntime = () => ({});\n', 'utf8');
    await writeFile(daemonEntryPath, 'export const activate = () => undefined;\n', 'utf8');
    await writeFile(publishedRunnerPath, publishedRunnerBytes, 'utf8');
    await writeFile(join(installedRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-session-owner',
    }), 'utf8');
    await writeFile(join(installedRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'happier.agent.session-owner',
      version: '1.0.0',
      displayName: 'Session owner',
      engines: { happier: '^0.3.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    }), 'utf8');

    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactEntryPathsByPackageName: new Map([
        ['@happier-dev/plugins-session-owner', daemonEntryPath],
      ]),
      immutableArtifactRootPathsByPackageName: new Map([
        ['@happier-dev/plugins-session-owner', installedRoot],
      ]),
      canImportFirstPartyPluginSource: () => true,
      importModule,
      prepareSourceDevSharedDeps: async () => syncedPreflight,
      repoRoot: join(tempDir, 'unrelated-source-checkout'),
    });
    const source = resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    });

    await source?.load();
    expect(imported).toEqual([pathToFileURL(daemonEntryPath).href]);

    const resolved = await source?.resolveRelativeModule('./agent/runtime/engine');
    expect(resolved?.normalizedModulePath).toBe('.happier-plugin/agent/runtime/engine.js');
    expect(imported.at(-1)).toBe(pathToFileURL(await realpath(publishedRunnerPath)).href);
  });

  it('falls back to first-party plugin dist when source is unavailable', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      existsSync: (path) => path === '/repo/packages/plugins/scm-git/dist/index.js',
      importModule,
      prepareSourceDevSharedDeps: async () => distOnlyPreflight,
      repoRoot: '/repo',
    });

    await resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/packages\/plugins\/scm-git\/dist\/index\.js$/u);
  });

  it('rejects a corrupt admitted flat plugin copy before import under inherited test-process env', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-flat-copy-corrupt-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'flat-cli-copy');
    const { outputPath } = await writeFlatAdmittedPluginCopy({
      cliProjectPath,
      workspaceName: 'plugins-scm-git',
    });
    await writeFile(outputPath, 'export const admitted = false;\n', 'utf8');
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn((params: Readonly<{
      packageName: string;
      workspaceNames?: readonly string[];
    }>) =>
      prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
        ...params,
        cliProjectPath,
      }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => false,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: join(tempDir, 'outside-flat-copy'),
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load()).rejects.toThrow('admitted source snapshot');
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git'],
    });
    expect(importModule).not.toHaveBeenCalled();
  });

  it('imports a valid admitted flat plugin copy after local preflight under inherited test-process env', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-flat-copy-valid-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'flat-cli-copy');
    await writeFlatAdmittedPluginCopy({
      cliProjectPath,
      workspaceName: 'plugins-scm-git',
    });
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn((params: Readonly<{
      packageName: string;
      workspaceNames?: readonly string[];
    }>) =>
      prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
        ...params,
        cliProjectPath,
      }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => false,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: join(tempDir, 'outside-flat-copy'),
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load()).resolves.toBe(pluginModuleFixture);
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git'],
    });
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('keeps an ordinary test-process dist load without local admission free of live preflight', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-no-admission-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'flat-cli-copy');
    await mkdir(cliProjectPath, { recursive: true });
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn((params: Readonly<{
      packageName: string;
      workspaceNames?: readonly string[];
    }>) =>
      prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
        ...params,
        cliProjectPath,
      }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => false,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: join(tempDir, 'outside-flat-copy'),
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load()).resolves.toBe(pluginModuleFixture);
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git'],
    });
    expect(importModule).toHaveBeenCalledTimes(1);
  });

});
