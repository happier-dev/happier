import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestV2Schema, computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { serializeCanonicalPluginManifest } from '../../../src/plugins/manifest/serialize.ts';
import { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } from './uiDeclarations.mjs';
import { collectBundledPluginUiArtifactSources } from '../../../../ui/scripts/generateBundledPluginUiArtifacts.mjs';

const manifest = PluginPortableReleaseManifestV1Schema.parse({
  schemaVersion: 2, id: 'happier.fixture', version: '0.0.0', displayName: 'Fixture', runtime: { apiVersion: 1 },
  contributes: { actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
    placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' } }] },
});
const artifactGraphs = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
  artifactId: 'fixture-card', tier: 'reactNative', entry: 'react-native/fixture-card/entry.cjs.bundle',
  files: [{ relativePath: 'react-native/fixture-card/entry.cjs.bundle', digest: `sha256:${'a'.repeat(64)}`, byteSize: 1 }],
  digest: `sha256:${'b'.repeat(64)}`, builtWith: { bundler: 'esbuild', version: '1.0.0' },
  executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0',
}] }).entries;
const project = (manifest, artifactGraphs) => projectBundledPluginUiDeclaration({
  packageName: '@happier-dev/plugins-fixture', packageVersion: '0.0.1', manifest, artifactGraphs,
});
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function collectorFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-declaration-projection-'));
  roots.push(repoRoot);
  const pluginRoot = join(repoRoot, 'packages/plugins/fixture');
  const artifactsRoot = join(pluginRoot, 'dist/happier-plugin-ui');
  const relativePath = artifactGraphs[0].entry;
  const artifactPath = join(artifactsRoot, relativePath);
  const bytes = new TextEncoder().encode('module.exports = { fixture: true };');
  const graphs = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{ ...artifactGraphs[0],
    digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]),
    files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
  }] }).entries;
  const declaration = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, contributes: { ...manifest.contributes,
    ui: { renderers: [{ id: 'fixture', kind: 'reactNative', artifact: 'fixture-card' }],
      views: [{ id: 'fixture', container: 'appPage', target: { kind: 'app' }, renderer: 'fixture', title: 'Fixture' }] },
  } });
  await Promise.all([mkdir(join(repoRoot, 'apps/ui'), { recursive: true }),
    mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true }), mkdir(dirname(artifactPath), { recursive: true })]);
  await Promise.all([
    writeFile(join(repoRoot, 'apps/ui/package.json'), JSON.stringify({ dependencies: { '@happier-dev/plugins-fixture': '0.0.1' } })),
    writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture', version: '0.0.1',
      exports: { [`./happier-plugin-ui/${relativePath}`]: `./dist/happier-plugin-ui/${relativePath}` } })),
    writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), serializeCanonicalPluginManifest(declaration)),
    writeFile(join(artifactsRoot, 'ui-artifacts.json'), JSON.stringify({ version: 2, entries: graphs })),
    writeFile(artifactPath, bytes),
  ]);
  return { repoRoot, pluginRoot, artifactsRoot, artifactPath, graphs, declaration };
}

describe('build-owned bundled app declarations', () => {
  it('projects a graph-bearing package once through the real collector', async () => {
    const fixture = await collectorFixture();
    const session = new Session();
    session.connect();
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      const result = await collectBundledPluginUiArtifactSources(fixture.repoRoot);
      const coverage = await session.post('Profiler.takePreciseCoverage');
      // V8 observes real execution; no projector, parser or serializer is replaced.
      const calls = coverage.result.filter(script => script.url.includes('/bundledPlugins/uiDeclarations.mjs'))
        .flatMap(script => script.functions).filter(fn => fn.functionName === 'projectBundledPluginUiDeclaration')
        .reduce((total, fn) => total + fn.ranges[0].count, 0);
      expect(result.pluginFailures).toEqual([]);
      expect(result.sources).toHaveLength(1);
      expect(result.declarations).toHaveLength(1);
      expect(result.declarations[0].artifactGraphs).toEqual(fixture.graphs);
      expect(calls).toBe(1);
    } finally {
      await session.post('Profiler.stopPreciseCoverage').finally(() => session.disconnect());
    }
  });

  it('retains declarations when artifact bytes or metadata fail', async () => {
    const fixture = await collectorFixture();
    for (const state of ['tampered', 'missing', 'missing-metadata', 'invalid-metadata']) {
      if (state === 'tampered') await writeFile(fixture.artifactPath, 'changed bytes');
      if (state === 'missing') await rm(fixture.artifactPath);
      if (state === 'missing-metadata') await rm(join(fixture.artifactsRoot, 'ui-artifacts.json'));
      if (state === 'invalid-metadata') await writeFile(join(fixture.artifactsRoot, 'ui-artifacts.json'), '{"version":999}');
      const result = await collectBundledPluginUiArtifactSources(fixture.repoRoot);
      expect(result.sources).toEqual([]);
      expect(result.pluginFailures).toHaveLength(1);
      expect(result.declarations).toHaveLength(1);
      expect(result.declarations[0].normalizedManifest.id).toBe(manifest.id);
      expect(result.declarations[0].artifactGraphs).toHaveLength(state.endsWith('metadata') ? 0 : 1);
    }
  });

  it('keeps the source owner selected manifest across byte fallback and absent/failed UI roots', async () => {
    const fixture = await collectorFixture();
    const unavailable = join(fixture.repoRoot, 'unavailable-artifacts');
    await mkdir(unavailable);
    await writeFile(join(unavailable, 'ui-artifacts.json'), JSON.stringify({ version: 2,
      entries: [{ ...fixture.graphs[0], builtWith: { ...fixture.graphs[0].builtWith, version: '0.9.0' } }] }));
    const selected = { ...fixture.declaration, displayName: 'Selected last-good manifest' };
    const result = await collectBundledPluginUiArtifactSources(fixture.repoRoot, [],
      { fixture: [unavailable, fixture.artifactsRoot] }, { fixture: selected });
    expect(result.pluginFailures).toEqual([]);
    expect(result.sources[0].files[0].specifier).toBe(fixture.artifactPath);
    expect(result.declarations[0].artifactGraphs).toEqual(fixture.graphs);
    expect(result.declarations[0].normalizedManifest.displayName).toBe(selected.displayName);
    const daemonOnly = await collectBundledPluginUiArtifactSources(fixture.repoRoot, [], {}, { fixture: selected });
    expect(daemonOnly.sources).toEqual([]);
    expect(daemonOnly.declarations[0].artifactGraphs).toEqual([]);
    const failedSelection = await collectBundledPluginUiArtifactSources(fixture.repoRoot, [], { fixture: [] }, { fixture: selected });
    expect(failedSelection.declarations).toEqual([]);
    expect(failedSelection.sources).toEqual([]);
    await writeFile(join(fixture.artifactsRoot, 'ui-artifacts.json'), JSON.stringify({ version: 2, entries: [] }));
    await writeFile(join(fixture.pluginRoot, '.happier-plugin/plugin.json'), serializeCanonicalPluginManifest(manifest));
    await writeFile(join(fixture.repoRoot, 'apps/ui/package.json'), '{"dependencies":{}}');
    const packagedDaemonOnly = await collectBundledPluginUiArtifactSources(fixture.repoRoot);
    expect(packagedDaemonOnly.sources).toEqual([]);
    expect(packagedDaemonOnly.declarations[0].artifactGraphs).toEqual([]);
    expect(packagedDaemonOnly.declarations[0].declaredExecution.daemonActions).toBe(true);
  });

  it('retains valid compiler facts when a later fallback has no metadata or usable bytes', async () => {
    const fixture = await collectorFixture();
    const unavailable = join(fixture.repoRoot, 'unavailable-artifacts');
    const retainedGraphs = [{ ...fixture.graphs[0], builtWith: { ...fixture.graphs[0].builtWith, version: '0.9.0' } }];
    await mkdir(unavailable);
    await writeFile(join(unavailable, 'ui-artifacts.json'), JSON.stringify({ version: 2, entries: retainedGraphs }));
    const result = await collectBundledPluginUiArtifactSources(fixture.repoRoot, [],
      { fixture: [unavailable, join(fixture.repoRoot, 'missing-metadata')] }, { fixture: fixture.declaration });
    expect(result.sources).toEqual([]);
    expect(result.pluginFailures).toHaveLength(1);
    expect(result.declarations[0].artifactGraphs).toEqual(retainedGraphs);
  });

  it('refuses non-JSON native declarations before publishing otherwise valid byte graphs', async () => {
    const fixture = await collectorFixture();
    const invalid = { ...fixture.declaration, description: undefined };
    const result = await collectBundledPluginUiArtifactSources(fixture.repoRoot, [],
      { fixture: fixture.artifactsRoot }, { fixture: invalid });
    expect(result.sources).toEqual([]);
    expect(result.declarations).toEqual([]);
    expect(result.pluginFailures).toHaveLength(1);
  });

  it('retains valid daemon declarations without an executable UI artifact graph', async () => {
    await expect(project(manifest, [])).resolves.toMatchObject({
      pluginId: manifest.id, pluginVersion: '0.0.1', artifactGraphs: [],
      normalizedManifest: { ...manifest, version: '0.0.1' },
      declaredExecution: { daemonActions: true, contributionPoints: false },
    });
  });

  it('refuses lossy schema serialization while retaining unsupported JSON and canonical optional fields', async () => {
    const withSchema = inputSchema => PluginPortableReleaseManifestV1Schema.parse({ ...manifest,
      contributes: { ...manifest.contributes, pluginContributionPoints: [{ id: 'point', protocols: [{
        id: 'detail', version: 1, operations: {},
        surfaces: { detail: { required: true, presentation: 'content', inputSchema } },
      }] }] },
    });
    await expect(project(withSchema({ type: 'string', enum: undefined }), artifactGraphs)).rejects.toThrow();
    const unsupported = { not: { type: 'null' } };
    const canonical = JSON.parse(serializeCanonicalPluginManifest({ ...withSchema(unsupported), description: undefined }));
    expect(Object.hasOwn(canonical, 'description')).toBe(false);
    const declaration = await project(canonical, artifactGraphs);
    expect(declaration.normalizedManifest.contributes.pluginContributionPoints[0]
      .protocols[0].surfaces.detail.inputSchema).toEqual(unsupported);
    expect(Object.hasOwn(declaration, 'accountCustody')).toBe(false);
  });
  it('carries client registration families into the cold Account manifest', async () => {
    const client = { artifactId: 'fixture-card', exportName: 'renderSurface' };
    const selected = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, contributes: {
      ...manifest.contributes,
      workItems: [{ id: 'work-items', client, platforms: ['web'] }],
      dragSources: [{ id: 'issue', title: 'Issue', referenceSchema: { type: 'object' }, client, platforms: ['web'] }],
      dropTargets: [{ id: 'board', title: 'Board', acceptedKinds: ['session'],
        actions: [{ kind: 'host', actionId: 'session.open' }], client, platforms: ['web'] }],
    } });
    const full = await project(selected, artifactGraphs);
    const cold = await projectBundledPluginUiFirstPaintDeclaration(full);
    expect(cold.presentationManifest.contributes.workItems).toEqual(full.normalizedManifest.contributes.workItems);
    expect(cold.presentationManifest.contributes.dragSources).toEqual(full.normalizedManifest.contributes.dragSources);
    expect(cold.presentationManifest.contributes.dropTargets).toEqual(full.normalizedManifest.contributes.dropTargets);
    expect(cold.presentationManifest.contributes.actions).toEqual([]);
  });

});
