import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage, writeWorkspacePackageFixture } from '../__tests__/testkit/packageLayoutSandbox';
import { serializeCanonicalPluginManifest } from '../../src/plugins/manifest/serialize';
import { importPluginAuthorRuntimeModules, publishBundledPluginSemanticProjection } from './generateBundledPluginEntries.ts';
import { renderUiBundledPluginEntriesTs } from './bundledPlugins/agentUi.ts';
import { renderCliBundledPluginManifestAssets } from './bundledPlugins/registry.ts';
import { QWEN_UI_DESCRIPTOR } from '../../../../packages/plugins/qwen/src/ui/descriptor';
import { parseGeneratorCliArgs } from './bundledPlugins/options.ts';
import { isRecord } from './bundledPlugins/literals.ts';
import type { BundledPluginPackage } from './bundledPlugins/projectionFacts.ts';
import { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } from './bundledPlugins/uiDeclarations.mjs';

// Match the publisher's prepared dependency boundary: both cases use its real
// Protocol source ingress, with cold tool initialization outside each scenario.
const { ingestPluginManifestV2 } = await importPluginAuthorRuntimeModules(async sourceImport =>
  await sourceImport(new URL('../../../../packages/protocol/src/plugins/manifest/index.ts', import.meta.url).href,
    import.meta.url) as typeof import('@happier-dev/protocol/plugins/manifest'));

function sourceBetween(startMarker: string, endMarker: string, source: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Missing declaration block ${startMarker}`);
  return source.slice(start, end);
}

describe('bundled Account declaration publication', () => {
  it('retains recipe demand in first paint without putting executable recipe bodies there', async () => {
    const { PLUGIN_MANIFEST } = await import('../../../../packages/plugins/machine-recipes/src/manifest');
    const full = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-machine-recipes',
      packageVersion: PLUGIN_MANIFEST.version, manifest: PLUGIN_MANIFEST, artifactGraphs: [] });
    const firstPaint = await projectBundledPluginUiFirstPaintDeclaration(full);
    expect(firstPaint).toMatchObject({ hasMachineRecipes: true });
    expect(firstPaint.presentationManifest.contributes.machineRecipes).toEqual([]);
  });
  it('keeps provisioner demand discoverable without putting closed schemas into first paint', async () => {
    const source: unknown = JSON.parse(readFileSync(new URL('../../assets/bundled-plugin-manifests/machine-vercel.json', import.meta.url), 'utf8'));
    const admitted = ingestPluginManifestV2(source);
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    const full = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-machine-vercel',
      packageVersion: '0.0.0', manifest: admitted.manifest, artifactGraphs: [] });
    const firstPaint = await projectBundledPluginUiFirstPaintDeclaration(full);
    expect(firstPaint).toMatchObject({ hasMachineProvisioners: true });
    expect(firstPaint.presentationManifest.contributes.machineProvisioners).toEqual([]);
  });
  it.each(['deploy-vercel', 'deploy-cloudflare', 'deployment-neon', 'deployment-supabase'])(
    'keeps %s deployment target demand discoverable without putting descriptors into first paint', async id => {
    const source: unknown = JSON.parse(readFileSync(new URL(`../../assets/bundled-plugin-manifests/${id}.json`, import.meta.url), 'utf8'));
    const admitted = ingestPluginManifestV2(source);
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    const full = await projectBundledPluginUiDeclaration({ packageName: `@happier-dev/plugins-${id}`,
      packageVersion: '0.0.0', manifest: admitted.manifest, artifactGraphs: [] });
    const firstPaint = await projectBundledPluginUiFirstPaintDeclaration(full);
    expect(firstPaint).toMatchObject({ hasDeploymentTargets: true });
    expect(firstPaint).not.toHaveProperty('hasMachineProvisioners');
    expect(firstPaint.presentationManifest.contributes.deploymentTargets).toEqual([]);
  });
  it('retains authored Connected Account metadata for cold Account authentication discovery', async () => {
    const source: unknown = JSON.parse(readFileSync(new URL('../../assets/bundled-plugin-manifests/machine-vercel.json', import.meta.url), 'utf8'));
    if (!isRecord(source) || !isRecord(source.contributes)) throw new Error('Missing Vercel declarations');
    const admitted = ingestPluginManifestV2({
      schemaVersion: 2, id: source.id, version: '0.0.0', displayName: source.displayName,
      runtime: { apiVersion: 1 },
      contributes: { connectedAccountDescriptors: source.contributes.connectedAccountDescriptors },
    });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    const full = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-machine-vercel',
      packageVersion: '0.0.0', manifest: admitted.manifest, artifactGraphs: [] });
    const firstPaint = await projectBundledPluginUiFirstPaintDeclaration(full);
    expect(full.normalizedManifest.contributes.connectedAccountDescriptors.length).toBeGreaterThan(0);
    expect(firstPaint.presentationManifest.contributes.connectedAccountDescriptors)
      .toEqual(full.normalizedManifest.contributes.connectedAccountDescriptors);
  });
  it.each(['scoped', 'aggregate'] as const)('%s publication refreshes Connected Service declarations alongside daemon manifests', async mode => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-account-declaration-twin-');
    try {
      // Match the membership owner's package ordering for full publication.
      const ids = ['machine-fly', 'machine-hetzner', 'machine-modal', 'machine-digitalocean', 'qwen'].sort((a, b) => a.localeCompare(b));
      const pluginPackages: BundledPluginPackage[] = ids.map(id => {
        const current: unknown = JSON.parse(readFileSync(new URL(
          `../../assets/bundled-plugin-manifests/${id}.json`, import.meta.url), 'utf8'));
        if (!isRecord(current) || !isRecord(current.contributes)) throw new Error(`Missing bundled ${id}`);
        // Keep the real Account declaration; unrelated contribution references
        // are outside this filesystem publication fixture.
        const admitted = ingestPluginManifestV2(id === 'qwen' ? current : {
          schemaVersion: 2, id: current.id, version: '0.0.0',
          displayName: id === 'machine-fly' ? { key: 'plugins.fly.name', fallback: 'Fly' } : id,
          runtime: { apiVersion: 1 },
          contributes: { connectedAccountDescriptors: current.contributes.connectedAccountDescriptors },
        });
        if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
        const packageName = `@happier-dev/plugins-${id}`;
        const packageRoot = writeWorkspacePackageFixture({ repoRoot, workspacePath: `packages/plugins/${id}`, packageName });
        writeBundledPluginSourceInputs({ repoRoot, pluginId: id, writePackageJson: false });
        mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
        writeFileSync(join(packageRoot, '.happier-plugin/plugin.json'), serializeCanonicalPluginManifest(admitted.manifest));
        return { pluginPackageId: id, pluginId: admitted.manifest.id, packageName, packageVersion: '0.0.0',
          manifest: admitted.manifest, ...(id === 'qwen' ? { agentId: 'qwen', agentUiDescriptor: QWEN_UI_DESCRIPTOR } : {}) };
      });
      writeCliBundledHostPackage({ happyCliDir, bundledDependencies: pluginPackages.map(entry => entry.packageName) });
      // Scoped publication retains peer daemon manifests from the prior publication.
      for (const asset of renderCliBundledPluginManifestAssets({ pluginPackages })) {
        const assetPath = join(happyCliDir, asset.relativePath);
        mkdirSync(dirname(assetPath), { recursive: true });
        writeFileSync(assetPath, asset.out);
      }
      const uiPath = join(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
      mkdirSync(dirname(uiPath), { recursive: true });
      const fullUi = renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages });
      // Construct the previous presentation header and missing type import,
      // alongside an outdated Agent type, while keeping a real peer's UI bytes.
      const staleHeader = (value: string) => value
        .replace('displayName: PluginLocalizedStringV2; description?: PluginLocalizedStringV2',
          'displayName: string; description?: string')
        .replace(/^import type \{ PluginLocalizedStringV2 \} from .*\n/mu, '')
        .replace('cli: PluginAgentCliMetadata | null;', 'cli: string | null;');
      const oldUi = staleHeader(renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages: pluginPackages.map(entry => ({
        ...entry, manifest: { ...entry.manifest,
          displayName: entry.pluginPackageId === 'machine-fly' ? 'machine-fly' : entry.manifest.displayName,
          contributes: { ...entry.manifest.contributes,
          connectedAccountDescriptors: entry.manifest.contributes.connectedAccountDescriptors?.map(({ ui: _ui, ...descriptor }) => descriptor),
        } },
      })) }));
      writeFileSync(uiPath, oldUi);
      const options = (operation: 'write' | 'check') => parseGeneratorCliArgs(['--root', repoRoot, '--mode', operation,
        ...(mode === 'aggregate' ? ['--aggregate'] : ids.slice(0, 3).flatMap(id => ['--workspace', `plugins-${id}`]))]);
      const publish = (operation: 'write' | 'check') => withWorkspaceBundleLock(lease => publishBundledPluginSemanticProjection(
        options(operation), { protocol: { ingestPluginManifestV2 } }, lease,
      ), { lockPath: join(repoRoot, 'publication.lock') });
      await publish('write');
      const source = readFileSync(uiPath, 'utf8');
      const block = sourceBetween('export const BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS',
        '/** Declared machine kinds and billing;', source);
      const exports: Record<string, Record<string, { descriptor: unknown }>> = {};
      runInNewContext(transpileModule(block, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
      const declarations = exports.BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS!;
      for (const entry of pluginPackages) {
        const daemon = ingestPluginManifestV2(JSON.parse(readFileSync(join(happyCliDir,
          `assets/bundled-plugin-manifests/${entry.pluginPackageId}.json`), 'utf8')));
        if (!daemon.ok) throw new Error(JSON.stringify(daemon.diagnostics));
        for (const descriptor of daemon.manifest.contributes.connectedAccountDescriptors ?? []) {
          expect(declarations[`${entry.pluginId}/${descriptor.id}`]?.descriptor).toEqual(descriptor);
          expect(descriptor.ui?.category).toBe('cloud-machines');
        }
      }
      // Full and retained publication share every declaration and type header.
      expect(source).toBe(fullUi);
      const peerDescriptors = (value: string) => sourceBetween('const QWEN_CORE',
        'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES', value);
      expect(peerDescriptors(source)).toBe(peerDescriptors(oldUi));
      await publish('check');
      // Values alone are current: check mode must still reject stale headers.
      writeFileSync(uiPath, staleHeader(source));
      await expect(publish('check')).rejects.toThrow(/generated output differs: .*generatedBundledPluginEntries\.ts/u);
    } finally { cleanup(); }
  });

});
