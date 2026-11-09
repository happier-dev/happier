import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { readBundledPluginPublicationFailures } from '../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { importPluginAuthorRuntimeModules, main, publishBundledPluginSemanticProjection } from './generateBundledPluginEntries.ts';
import { parseGeneratorCliArgs } from './bundledPlugins/options.ts';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage, writeWorkspacePackageFixture } from '../__tests__/testkit/packageLayoutSandbox.ts';
import { writeRetainedCatalogAgent } from '../__tests__/testkit/bundledPluginProjectionSandbox.ts';
import { serializeCanonicalPluginManifest } from '../../src/plugins/manifest/serialize.ts';
import { renderUiBundledPluginEntriesTs } from './bundledPlugins/agentUi.ts';
import type { BundledPluginPackage } from './bundledPlugins/projectionFacts.ts';

// Prepare the publisher's genuine source graph outside individual scenarios,
// matching the adjacent Account declaration publication harness.
const { ingestPluginManifestV2, resolvePluginManifestSetReferencesV2 } = await importPluginAuthorRuntimeModules(async sourceImport =>
  await sourceImport(new URL('../../../../packages/protocol/src/plugins/manifest/index.ts', import.meta.url).href,
    import.meta.url) as typeof import('@happier-dev/protocol/plugins/manifest'));

function readUiMap(source: string, name: string): Record<string, unknown> {
  const start = source.indexOf(`export const ${name}:`);
  const end = source.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error(`Missing UI map ${name}`);
  const exports: Record<string, Record<string, unknown>> = {};
  runInNewContext(transpileModule(source.slice(start, end + '\n});'.length), {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText, { exports });
  return exports[name]!;
}

function browserActionReference(pluginId: string) {
  return {
    browserTargets: [{ id: 'preview', title: 'Preview', url: 'https://preview.example.test/' }],
    browserActions: [{ id: 'runner', title: 'Runner', target: 'preview', action: { pluginId, localId: 'missing' } }],
  };
}

describe('scoped bundled publication', () => {
  it('reference admission scopes both incoming and outgoing edges to the changed plugin', () => {
    const parse = (id: string, contributes: unknown) => {
      const result = ingestPluginManifestV2({ schemaVersion: 2, id, version: '0.0.0', displayName: id, runtime: { apiVersion: 1 }, contributes });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      return result.manifest;
    };
    const target = parse('happier.inspector', {});
    const foreign = parse('happier.foreign', browserActionReference('happier.other'));
    const incoming = parse('happier.incoming', browserActionReference(target.id));
    expect(resolvePluginManifestSetReferencesV2([target, foreign], new Set([target.id]))).toEqual({ ok: true });
    expect(resolvePluginManifestSetReferencesV2([target, incoming], new Set([target.id])).ok).toBe(false);
    expect(resolvePluginManifestSetReferencesV2([target, foreign]).ok).toBe(false);
    expect(resolvePluginManifestSetReferencesV2([foreign, target], new Set([foreign.id])).ok).toBe(false);
  });
  async function createScopedPublicationFixture() {
    const sandbox = createPackageLayoutSandbox('happier-scoped-publication-');
    const { repoRoot, happyCliDir } = sandbox;
    const pluginPackages: BundledPluginPackage[] = [];
    for (const id of ['inspector', 'neighbor']) {
      const packageRoot = writeWorkspacePackageFixture({ repoRoot,
        workspacePath: `packages/plugins/${id}`, packageName: `@happier-dev/plugins-${id}`,
        manifestOverrides: { files: ['dist', 'assets'] },
      });
      writeBundledPluginSourceInputs({ repoRoot, pluginId: id, writePackageJson: false });
      const manifest = { schemaVersion: 2, id: `happier.${id}`, version: '0.0.0', displayName: id, description: `${id} description`,
        runtime: { apiVersion: 1 }, contributes: { resources: [{ id: 'payload', kind: 'asset', path: 'assets/payload.txt', contentType: 'text/plain' }] } };
      writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
      mkdirSync(join(packageRoot, 'dist'), { recursive: true });
      mkdirSync(join(packageRoot, 'assets'), { recursive: true });
      writeFileSync(join(packageRoot, 'dist/index.js'), 'export {};');
      writeFileSync(join(packageRoot, 'assets/payload.txt'), 'payload');
      mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
      writeFileSync(join(packageRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
      const admitted = ingestPluginManifestV2(manifest);
      if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
      pluginPackages.push({ pluginPackageId: id, pluginId: manifest.id,
        packageName: `@happier-dev/plugins-${id}`, packageVersion: '0.0.0', manifest: admitted.manifest });
    }
    const uiPath = join(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
    mkdirSync(dirname(uiPath), { recursive: true });
    writeFileSync(uiPath, renderUiBundledPluginEntriesTs({ packageNames: pluginPackages.map(entry => entry.packageName), pluginPackages }));
    writeRetainedCatalogAgent(repoRoot, happyCliDir);
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['inspector', 'neighbor', 'fixture-acp'].map(id => `@happier-dev/plugins-${id}`) });
    await withWorkspaceBundleLock(lease => publishBundledPluginSemanticProjection(
      parseGeneratorCliArgs(['--root', repoRoot, '--mode', 'write', '--aggregate']),
      { protocol: { ingestPluginManifestV2 } }, lease,
    ), { lockPath: join(repoRoot, 'publication.lock') });
    for (const id of ['inspector', 'neighbor', 'fixture-acp']) {
      const result = ingestPluginManifestV2(readFileSync(join(happyCliDir, `assets/bundled-plugin-manifests/${id}.json`), 'utf8'));
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      writeFileSync(join(repoRoot, `packages/plugins/${id}/.happier-plugin/plugin.json`), serializeCanonicalPluginManifest(result.manifest));
    }
    return { ...sandbox, uiPath, catalog: join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts') };
  }

  it.each(['scoped', 'aggregate'] as const)('%s semantic publication refreshes manifest presentation and Agent declarations', async mode => {
    const fixture = await createScopedPublicationFixture();
    try {
      const before = readFileSync(fixture.uiPath, 'utf8');
      const manifestPath = join(fixture.repoRoot, 'packages/plugins/inspector/.happier-plugin/plugin.json');
      const current = ingestPluginManifestV2(readFileSync(manifestPath, 'utf8'));
      if (!current.ok) throw new Error(JSON.stringify(current.diagnostics));
      writeFileSync(manifestPath, serializeCanonicalPluginManifest({ ...current.manifest,
        displayName: { key: 'plugins.inspector.name', fallback: 'New Inspector' }, description: 'New description' }));
      const agentPath = join(fixture.repoRoot, 'packages/plugins/fixture-acp/.happier-plugin/plugin.json');
      const agent = ingestPluginManifestV2(readFileSync(agentPath, 'utf8'));
      if (!agent.ok) throw new Error(JSON.stringify(agent.diagnostics));
      const updated = ingestPluginManifestV2({ ...agent.manifest, contributes: { ...agent.manifest.contributes,
        agents: agent.manifest.contributes.agents?.map(entry => ({ ...entry,
          catalog: { ...entry.catalog, acpRegistryIds: ['new-registry-id'] } })),
      } });
      if (!updated.ok) throw new Error(JSON.stringify(updated.diagnostics));
      writeFileSync(agentPath, serializeCanonicalPluginManifest(updated.manifest));
      await withWorkspaceBundleLock(lease => publishBundledPluginSemanticProjection(
        parseGeneratorCliArgs(['--root', fixture.repoRoot, '--mode', 'write', ...(mode === 'aggregate'
          ? ['--aggregate'] : ['--workspace', 'plugins-inspector', '--workspace', 'plugins-fixture-acp'])]),
        { protocol: { ingestPluginManifestV2 } }, lease,
      ), { lockPath: join(fixture.repoRoot, 'publication.lock') });
      const after = readFileSync(fixture.uiPath, 'utf8');
      const presentation = readUiMap(after, 'BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION');
      expect.soft(presentation['happier.inspector']).toEqual({
        displayName: { key: 'plugins.inspector.name', fallback: 'New Inspector' }, description: 'New description',
      });
      expect(presentation['happier.neighbor']).toEqual(readUiMap(before, 'BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION')['happier.neighbor']);
      expect(readUiMap(after, 'BUNDLED_CANONICAL_AGENT_DECLARATIONS')['fixture-acp']).toMatchObject({ acpRegistryIds: ['new-registry-id'] });
    } finally { fixture.cleanup(); }
  });

  it.each(['replace', 'remove', 'insert'] as const)('semantic publication updates embedded Agent manifest fields (%s)', async transition => {
    const fixture = await createScopedPublicationFixture();
    try {
      const admitted = ingestPluginManifestV2(readFileSync(new URL('../../assets/bundled-plugin-manifests/qwen.json', import.meta.url), 'utf8'));
      if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
      const providerAgent = ingestPluginManifestV2(readFileSync(new URL('../../assets/bundled-plugin-manifests/claude.json', import.meta.url), 'utf8'));
      if (!providerAgent.ok) throw new Error(JSON.stringify(providerAgent.diagnostics));
      const providerRequirements = providerAgent.manifest.contributes.agents?.[0]?.providerRequirements;
      if (!providerRequirements) throw new Error('Expected real Claude Provider requirements');
      const qwen: BundledPluginPackage = { pluginPackageId: 'qwen', pluginId: admitted.manifest.id,
        packageName: '@happier-dev/plugins-qwen', packageVersion: '0.0.0', agentId: 'qwen', manifest: admitted.manifest };
      const revise = (ownedEnvKeys: string[], permissionModeMapping: { default: string } | undefined): BundledPluginPackage => {
        const manifest = ingestPluginManifestV2({ ...qwen.manifest, contributes: { ...qwen.manifest.contributes,
          agents: qwen.manifest.contributes.agents?.map(agent => {
            if (agent.runtime.kind !== 'acp') throw new Error('Expected real Qwen ACP declaration');
            const { permissionModeMapping: _old, ...definition } = agent.runtime.definition ?? {};
            return { ...agent, providerRequirements: { ...providerRequirements,
              authIsolation: { ...providerRequirements.authIsolation, ownedEnvKeys } },
              runtime: { ...agent.runtime, definition: { ...definition, ...(permissionModeMapping ? { permissionModeMapping } : {}) } } };
          }),
        } });
        if (!manifest.ok) throw new Error(JSON.stringify(manifest.diagnostics));
        return { ...qwen, manifest: manifest.manifest };
      };
      const previous = revise(['OLD_API_KEY'], transition === 'insert' ? undefined : { default: 'old' });
      const current = revise(['NEW_API_KEY'], transition === 'remove' ? undefined : { default: 'new' });
      const render = (entry: BundledPluginPackage) => renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages: [entry] });
      writeFileSync(fixture.uiPath, render(previous));
      const packageRoot = writeWorkspacePackageFixture({ repoRoot: fixture.repoRoot,
        workspacePath: 'packages/plugins/qwen', packageName: qwen.packageName });
      writeBundledPluginSourceInputs({ repoRoot: fixture.repoRoot, pluginId: 'qwen', writePackageJson: false });
      mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
      writeFileSync(join(packageRoot, '.happier-plugin/plugin.json'), serializeCanonicalPluginManifest(current.manifest));
      writeCliBundledHostPackage({ happyCliDir: fixture.happyCliDir,
        bundledDependencies: ['inspector', 'neighbor', 'fixture-acp', 'qwen'].map(id => `@happier-dev/plugins-${id}`) });
      await withWorkspaceBundleLock(lease => publishBundledPluginSemanticProjection(
        parseGeneratorCliArgs(['--root', fixture.repoRoot, '--mode', 'write', '--workspace', 'plugins-qwen']),
        { protocol: { ingestPluginManifestV2 } }, lease,
      ), { lockPath: join(fixture.repoRoot, 'publication.lock') });
      // Compare the retained executable expression with the full canonical renderer,
      // including nested permission mapping insertion/removal and unchanged UI facts.
      const coreAndUi = (source: string) => source.slice(source.indexOf('const QWEN_CORE:'),
        source.indexOf('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES:'));
      expect(coreAndUi(readFileSync(fixture.uiPath, 'utf8'))).toBe(coreAndUi(render(current)));
    } finally { fixture.cleanup(); }
  });

  it.each([false, true])('scoped write admits the target while foreign source is invalid (packageArtifacts=%s)', async (packageArtifacts) => {
    const fixture = await createScopedPublicationFixture();
    try {
      const peer = join(fixture.repoRoot, 'packages/plugins/neighbor/src/manifest.ts');
      const peerProjection = join(fixture.happyCliDir, 'assets/bundled-plugin-manifests/neighbor.json');
      const publishedPeer = readFileSync(peerProjection, 'utf8');
      const peerArtifact = join(fixture.repoRoot, 'packages/plugins/neighbor/.happier-plugin/plugin.json');
      const publishedArtifact = readFileSync(peerArtifact, 'utf8');
      const peerPresentation = readUiMap(readFileSync(fixture.uiPath, 'utf8'), 'BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION')['happier.neighbor'];
      writeFileSync(peer, 'throw new Error("Foreign manifest is mid-edit");');
      const target = join(fixture.repoRoot, 'packages/plugins/inspector/src/manifest.ts');
      writeFileSync(target, readFileSync(target, 'utf8')
        .replace('"displayName":"inspector"', '"displayName":"New Inspector"')
        .replace('"description":"inspector description"', '"description":"New description"'));
      await main(['--root', fixture.repoRoot, '--mode', 'write', '--workspace', 'plugins-inspector', ...(packageArtifacts ? ['--package-artifacts'] : [])]);
      expect(JSON.parse(readFileSync(join(fixture.happyCliDir, 'assets/bundled-plugin-manifests/inspector.json'), 'utf8')).displayName).toBe('New Inspector');
      const presentation = readUiMap(readFileSync(fixture.uiPath, 'utf8'), 'BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION');
      expect(presentation['happier.inspector']).toEqual({ displayName: 'New Inspector', description: 'New description' });
      expect(presentation['happier.neighbor']).toEqual(peerPresentation);
      expect(readFileSync(peerProjection, 'utf8')).toBe(publishedPeer);
      expect(readFileSync(peerArtifact, 'utf8')).toBe(publishedArtifact);
      if (packageArtifacts) expect(JSON.parse(readFileSync(join(fixture.repoRoot, 'packages/plugins/inspector/.happier-plugin/plugin.json'), 'utf8')).displayName).toBe('New Inspector');
    } finally { fixture.cleanup(); }
  });

  it.each([false, true])('scoped write rejects an invalid target (packageArtifacts=%s)', async (packageArtifacts) => {
    const fixture = await createScopedPublicationFixture();
    try {
      const published = readFileSync(fixture.catalog, 'utf8');
      writeFileSync(join(fixture.repoRoot, 'packages/plugins/inspector/src/manifest.ts'), 'throw new Error("Target manifest is mid-edit");');
      await expect(main(['--root', fixture.repoRoot, '--mode', 'write', '--workspace', 'plugins-inspector', ...(packageArtifacts ? ['--package-artifacts'] : [])])).rejects.toThrow(/Target manifest is mid-edit/u);
      expect(readFileSync(fixture.catalog, 'utf8')).toBe(published);
    } finally { fixture.cleanup(); }
  });

  it('refuses a packaged registry declaration whose authored catalog is omitted from the published inventory', async () => {
    const fixture = await createScopedPublicationFixture();
    try {
      const root = join(fixture.repoRoot, 'packages/plugins/inspector');
      const manifestPath = join(root, 'src/manifest.ts');
      const manifest = { schemaVersion: 2, id: 'happier.inspector', version: '0.0.0', displayName: 'Inspector',
        runtime: { apiVersion: 1 }, contributes: { registrySources: [{ id: 'apps', title: 'Apps', format: 'happier-catalog',
          kinds: ['app'], packageContent: { path: 'resources/registry/apps.json' } }] } };
      writeFileSync(manifestPath, `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
      const catalogPath = join(root, 'resources/registry/apps.json');
      mkdirSync(dirname(catalogPath), { recursive: true });
      const catalog = JSON.stringify({ schemaVersion: 1, apps: [] });
      writeFileSync(catalogPath, catalog);
      // The real package-content reader can only read files shipped by this
      // same publisher; an authored file outside package.json#files is not one.
      const publish = () => main(['--root', fixture.repoRoot, '--mode', 'write', '--workspace', 'plugins-inspector', '--package-artifacts']);
      // Development publication keeps optional declarations with a diagnostic;
      // artifact publication must refuse the same missing package bytes.
      vi.stubEnv('HAPPIER_WORKSPACE_BUNDLE_PUBLICATION_MODE', 'development');
      await publish();
      expect(readBundledPluginPublicationFailures(fixture.repoRoot)).toEqual([expect.objectContaining({
        packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
        diagnostic: expect.objectContaining({ message: expect.stringContaining('resources/registry/apps.json') }),
      })]);
      vi.stubEnv('HAPPIER_WORKSPACE_BUNDLE_PUBLICATION_MODE', 'artifact');
      await expect(publish()).rejects.toThrow(/resources\/registry\/apps\.json/u);
      const packagePath = join(root, 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { files: string[] };
      writeFileSync(packagePath, JSON.stringify({ ...packageJson, files: [...packageJson.files, 'resources'] }));
      await publish();
      expect(readBundledPluginPublicationFailures(fixture.repoRoot)).toEqual([]);
      const published = JSON.parse(readFileSync(join(fixture.happyCliDir, 'assets/bundled-plugin-manifests/inspector.json'), 'utf8'));
      expect(published.contributes.registrySources).toEqual(manifest.contributes.registrySources);
      expect(readFileSync(catalogPath, 'utf8')).toBe(catalog);
    } finally { vi.unstubAllEnvs(); fixture.cleanup(); }
  });

  it('scoped write rejects a target id conflicting with a published peer', async () => {
    const fixture = await createScopedPublicationFixture();
    try {
      const published = readFileSync(fixture.catalog, 'utf8');
      const target = join(fixture.repoRoot, 'packages/plugins/inspector/src/manifest.ts');
      writeFileSync(target, readFileSync(target, 'utf8').replace('happier.inspector', 'happier.neighbor'));
      await expect(main(['--root', fixture.repoRoot, '--mode', 'write', '--workspace', 'plugins-inspector'])).rejects.toThrow(/Duplicate bundled plugin id/u);
      expect(readFileSync(fixture.catalog, 'utf8')).toBe(published);
    } finally { fixture.cleanup(); }
  });

  it.each([['write', []], ['check', ['--workspace', 'plugins-inspector']]] as const)('strict %s rejects invalid foreign source', async (mode, selector) => {
    const fixture = await createScopedPublicationFixture();
    try {
      const published = readFileSync(fixture.catalog, 'utf8');
      writeFileSync(join(fixture.repoRoot, 'packages/plugins/neighbor/src/manifest.ts'), 'throw new Error("Foreign manifest is mid-edit");');
      await expect(main(['--root', fixture.repoRoot, '--mode', mode, ...selector])).rejects.toThrow(/Foreign manifest is mid-edit/u);
      expect(readFileSync(fixture.catalog, 'utf8')).toBe(published);
    } finally { fixture.cleanup(); }
  });

  it.each([
    ['reference', browserActionReference('happier.neighbor'), /references missing actions/u],
    ['targeted contributor', { targetedPluginContributions: [{ id: 'extension', target: { pluginId: 'happier.neighbor', pointId: 'missing' }, protocol: { id: 'acme.protocol/extensions', version: 1 }, descriptor: { title: 'Extension' }, operations: {} }] }, /point_absent|target_absent/u],
  ] as const)('scoped write resolves a target %s against published peers', async (_kind, contributes, diagnostic) => {
    const fixture = await createScopedPublicationFixture();
    try {
      writeFileSync(join(fixture.repoRoot, 'packages/plugins/inspector/src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({ schemaVersion: 2, id: 'happier.inspector', version: '0.0.0', displayName: 'Inspector', runtime: { apiVersion: 1 }, contributes })};`);
      await expect(main(['--root', fixture.repoRoot, '--mode', 'write', '--workspace', 'plugins-inspector'])).rejects.toThrow(diagnostic);
    } finally { fixture.cleanup(); }
  });

});


