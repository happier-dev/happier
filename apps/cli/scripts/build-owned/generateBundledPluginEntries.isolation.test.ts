import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { readBundledPluginPublicationFailures } from '../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage, writeWorkspacePackageFixture } from '../__tests__/testkit/packageLayoutSandbox';
import { writeRetainedCatalogAgent } from '../__tests__/testkit/bundledPluginProjectionSandbox';
import { publishBundledPluginEntries, publishBundledPluginSemanticProjection } from './generateBundledPluginEntries';
import { parseGeneratorCliArgs } from './bundledPlugins/options';
import { writePluginDaemonOutputManifest } from '../../src/plugins/authoring/daemonOutputManifest';
import { PLUGIN_HOST_SHARED_RUNTIME_PACKAGES } from '../pluginHostSharedRuntimePackages.mjs';
import { renderUiBundledPluginEntriesTs } from './bundledPlugins/agentUi';

it.each([
  { scoped: false, badId: 'bad', failure: 'artifact' },
  { scoped: true, badId: 'bad', failure: 'artifact' },
  { scoped: false, badId: 'codex', failure: 'artifact' },
  { scoped: false, badId: 'bad', failure: 'source' },
  { scoped: true, badId: 'bad', failure: 'source' },
  { scoped: false, badId: 'bad', failure: 'inventory' },
  { scoped: true, badId: 'bad', failure: 'retired-resource' },
  { scoped: false, badId: 'bad', failure: 'missing-source' },
])('publishes healthy manifests while retaining failed artifacts (scoped=$scoped, failed=$badId, cause=$failure)', async ({ scoped, badId, failure }) => {
  const selector = scoped ? ['--workspace', 'plugins-good', '--workspace', `plugins-${badId}`] : [];
  const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('publisher-isolation-');
  const readManifest = (id: string) => JSON.parse(readFileSync(join(happyCliDir, `assets/bundled-plugin-manifests/${id}.json`), 'utf8'));
  try {
    for (const id of ['good', badId, 'peer']) {
      const root = writeWorkspacePackageFixture({ repoRoot, workspacePath: `packages/plugins/${id}`,
        packageName: `@happier-dev/plugins-${id}`, manifestOverrides: { files: ['dist', '.happier-plugin'] } });
      writeBundledPluginSourceInputs({ repoRoot, pluginId: id, writePackageJson: false });
      const manifest = { schemaVersion: 2, id: id === 'codex' ? 'happier.agent.codex' : `happier.${id}`, version: '0.0.0', displayName: `Old ${id}`,
        runtime: { apiVersion: 1 }, contributes: {} };
      mkdirSync(join(root, '.happier-plugin'), { recursive: true });
      writeFileSync(join(root, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
      writeFileSync(join(root, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...manifest, displayName: `New ${id}`,
        ...(id === badId ? { entrypoints: { daemon: './.happier-plugin/missing.js' } } : {}) })};`);
    }
    writeRetainedCatalogAgent(repoRoot, happyCliDir);
    const runtimePackages = failure === 'retired-resource' ? PLUGIN_HOST_SHARED_RUNTIME_PACKAGES : [];
    for (const packageName of runtimePackages) writeWorkspacePackageFixture({ repoRoot,
      workspacePath: `packages/${packageName.replace('@happier-dev/', '')}`, packageName,
    });
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: [
      ...['good', badId, 'peer', 'fixture-acp'].map(id => `@happier-dev/plugins-${id}`), ...runtimePackages,
    ] });
    if (failure === 'source') writeFileSync(join(repoRoot, `packages/plugins/${badId}/src/manifest.ts`), 'throw new Error("broken plugin source");');
    if (failure === 'inventory') {
      const manifestPath = join(repoRoot, `packages/plugins/${badId}/src/manifest.ts`);
      writeFileSync(manifestPath, `export const PLUGIN_MANIFEST = ${JSON.stringify({
        schemaVersion: 2, id: `happier.${badId}`, version: '0.0.0', displayName: `New ${badId}`,
        runtime: { apiVersion: 1 }, contributes: { resources: [{ id: 'payload', kind: 'asset', path: 'missing.txt', contentType: 'text/plain' }] },
      })};`);
    }
    if (failure === 'retired-resource') {
      const root = join(repoRoot, `packages/plugins/${badId}`);
      const manifest = { schemaVersion: 2, id: `happier.${badId}`, version: '0.0.0', displayName: `New ${badId}`,
        runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
        contributes: { resources: [{ id: 'old-chunk', kind: 'asset', path: '.happier-plugin/obsolete.js', contentType: 'text/javascript' }] },
      };
      writeFileSync(join(root, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
      writeFileSync(join(root, 'src/index.ts'), 'export { PLUGIN_MANIFEST as manifest } from "./manifest.js"; export function activate() {}');
      writeFileSync(join(root, '.happier-plugin/obsolete.js'), 'old generated output');
      await writePluginDaemonOutputManifest({ projectRoot: root, outputRelativePaths: ['.happier-plugin/obsolete.js'] });
    }
    const uiPath = join(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
    mkdirSync(dirname(uiPath), { recursive: true });
    writeFileSync(uiPath, renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages: [] }));
    await withWorkspaceBundleLock(lease => publishBundledPluginSemanticProjection(
      parseGeneratorCliArgs(['--root', repoRoot, '--mode', 'write', '--aggregate']),
      { protocol: { ingestPluginManifestV2 } }, lease,
    ), { lockPath: join(repoRoot, 'publication.lock') });
    const oldArtifact = readFileSync(join(repoRoot, `packages/plugins/${badId}/.happier-plugin/plugin.json`), 'utf8');
    if (failure === 'missing-source') rmSync(join(repoRoot, `packages/plugins/${badId}/src/manifest.ts`));
    const sourceFailure = failure === 'source' || failure === 'missing-source';
    const result = await withWorkspaceBundleLock(lease => publishBundledPluginEntries(
      parseGeneratorCliArgs(['--root', repoRoot, '--mode', 'write', '--package-artifacts', ...selector]), lease,
    ), { lockPath: join(repoRoot, 'publication.lock') });
    expect(result).toMatchObject({ publishedPackageNames: expect.arrayContaining(['@happier-dev/plugins-good']),
      failures: [{ packageName: `@happier-dev/plugins-${badId}`, diagnostic: { code: sourceFailure ? 'plugin_manifest_invalid' : 'plugin_package_build_failed' } }] });
    expect(result.failures[0]?.diagnostic.message).toContain(failure === 'source'
      ? 'broken plugin source' : failure === 'missing-source' ? 'manifest.ts' : failure === 'artifact' ? 'must provide src/index.ts' : 'omits resource');
    expect(readManifest('good')).toMatchObject({ displayName: 'New good' });
    expect(readManifest(badId)).toMatchObject({ displayName: `Old ${badId}` });
    expect(readFileSync(join(repoRoot, `packages/plugins/${badId}/.happier-plugin/plugin.json`), 'utf8')).toBe(oldArtifact);
    expect(readBundledPluginPublicationFailures(repoRoot)).toMatchObject([{
      packageName: `@happier-dev/plugins-${badId}`, diagnostic: { code: sourceFailure ? 'plugin_manifest_invalid' : 'plugin_package_build_failed', message: expect.any(String) },
    }]);
    if (failure === 'retired-resource') expect(readFileSync(join(repoRoot,
      `packages/plugins/${badId}/.happier-plugin/obsolete.js`), 'utf8')).toBe('old generated output');
    const ui = readFileSync(uiPath, 'utf8');
    expect(ui).toContain('New good');
    expect(ui).toContain(`Old ${badId}`);
    expect(ui).not.toContain(`New ${badId}`);
  } finally { cleanup(); }
}, 120_000); // Match the generator integration test's existing cold-loader allowance.
