import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage,
  writeWorkspacePackageFixture } from '../__tests__/testkit/packageLayoutSandbox.ts';
import { importPluginAuthorRuntimeModules, publishBundledPluginSemanticProjection } from './generateBundledPluginEntries.ts';
import { parseGeneratorCliArgs } from './bundledPlugins/options.ts';
import type { BundledPluginPackage } from './bundledPlugins/projectionFacts.ts';

const { ingestPluginManifestV2 } = await importPluginAuthorRuntimeModules(async sourceImport =>
  await sourceImport(new URL('../../../../packages/protocol/src/plugins/manifest/index.ts', import.meta.url).href,
    import.meta.url) as typeof import('@happier-dev/protocol/plugins/manifest'));

it('scoped manifest publication preserves an invalid retained peer while updating its target', async () => {
  const fixture = createPackageLayoutSandbox('happier-scoped-manifest-assets-');
  try {
    const packages: BundledPluginPackage[] = ['inspector', 'neighbor'].map(id => {
      writeWorkspacePackageFixture({ repoRoot: fixture.repoRoot, workspacePath: `packages/plugins/${id}`,
        packageName: `@happier-dev/plugins-${id}` });
      writeBundledPluginSourceInputs({ repoRoot: fixture.repoRoot, pluginId: id, writePackageJson: false });
      const admitted = ingestPluginManifestV2({ schemaVersion: 2, id: `happier.${id}`, version: '0.0.0',
        displayName: id, runtime: { apiVersion: 1 }, contributes: {} });
      if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
      return { pluginPackageId: id, pluginId: admitted.manifest.id, packageName: `@happier-dev/plugins-${id}`,
        packageVersion: '0.0.0', manifest: admitted.manifest };
    });
    writeCliBundledHostPackage({ happyCliDir: fixture.happyCliDir, bundledDependencies: packages.map(entry => entry.packageName) });
    const publish = (workspaceNames: string[], pluginPackages: readonly BundledPluginPackage[]) => withWorkspaceBundleLock(
      lease => publishBundledPluginSemanticProjection(parseGeneratorCliArgs(['--root', fixture.repoRoot, '--mode', 'write',
        ...workspaceNames.flatMap(name => ['--workspace', name])]), { protocol: { ingestPluginManifestV2 } },
      lease, [], [], { pluginPackages, failures: [] }), { lockPath: join(fixture.repoRoot, 'publication.lock') });
    await publish([], packages);
    const peerPath = join(fixture.happyCliDir, 'assets/bundled-plugin-manifests/neighbor.json');
    // Retained JSON can predate today's schema. Runtime admission owns that
    // peer's unavailable state; publishing the target must preserve its bytes.
    const stalePeer = JSON.parse(readFileSync(peerPath, 'utf8'));
    stalePeer.runtime.apiVersion = 999;
    const retainedPeer = JSON.stringify(stalePeer);
    writeFileSync(peerPath, retainedPeer);
    expect(ingestPluginManifestV2(retainedPeer).ok).toBe(false);
    await publish(['plugins-inspector'], packages.map(entry => entry.pluginPackageId === 'neighbor'
      ? { ...entry, manifest: stalePeer }
      : { ...entry, manifest: { ...entry.manifest, displayName: 'New Inspector' } }));
    expect(JSON.parse(readFileSync(join(fixture.happyCliDir, 'assets/bundled-plugin-manifests/inspector.json'), 'utf8')).displayName)
      .toBe('New Inspector');
    expect(readFileSync(peerPath, 'utf8')).toBe(retainedPeer);
  } finally { fixture.cleanup(); }
});
