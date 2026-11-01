import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  PluginUiArtifactDigestV1Schema,
  PluginUiArtifactsManifestEntryV2Schema,
  computePluginUiArtifactSha256DigestV1,
  computePluginUiArtifactFileSetSha256DigestV1,
  type PluginUiArtifactsManifestEntryV2,
} from '@happier-dev/protocol/plugins/ui';

import {
  collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners,
  collectResolvedGeneratedReactNativeClientContributionArtifactOwners,
  findGeneratedReactNativeArtifactEntry,
  findGeneratedReactNativeCollectionMigrationsModule,
  type ResolvedGeneratedReactNativeCollectionMigrationArtifactOwner,
  type ResolvedGeneratedReactNativeArtifactOwner,
} from './generatedUiArtifactOwners';
import type { ResolvedContributionRegistry } from '../types';
import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../fullProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';

const digest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);

function createEntry(exports: readonly string[] = ['renderSurface']): PluginUiArtifactsManifestEntryV2 {
  const entry = 'react-native/panel-artifact/entry.cjs.bundle';
  return {
    artifactId: 'panel-artifact',
    tier: 'reactNative',
    entry,
    files: [{ relativePath: entry, digest, byteSize: 1 }],
    digest,
    builtWith: { bundler: 'esbuild', version: '0.25.0' },
    executable: { exports: [...exports] },
    hostUiApiRange: '^1.0.0',
  };
}

function createOwner(
  entry: PluginUiArtifactsManifestEntryV2,
  expectedExport = 'renderSurface',
): ResolvedGeneratedReactNativeArtifactOwner {
  return {
    kind: 'renderer',
    pluginId: 'acme.native',
    pluginSource: { kind: 'path' },
    contributionId: 'panel',
    artifactId: 'panel-artifact',
    pluginRootPath: '/plugins/acme.native',
    manifestPath: '/plugins/acme.native/.happier-plugin/plugin.json',
    generatedUiArtifactsManifest: { version: 2, entries: [entry] },
    requiredHostMethods: [],
    expectedExecutable: { exportName: expectedExport },
  };
}

describe('findGeneratedReactNativeArtifactEntry', () => {
  it('discovers the authored Account Action generated graph without a renderer or client Action', async () => {
    const { compileUniversalPluginUiCommonJs } = await import('../../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler');
    const { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } = await import('../../../../../../../packages/cli-common/sourceRuntimeEntries.mjs');
    const { manifest: authoredManifest } = await import('../../../../../../../packages/plugin-sdk/fixtures/account-actions/src/index');
    const manifest = normalizePluginManifestV2(authoredManifest);
    const projectRoot = resolve(import.meta.dirname, '../../../../../../../packages/plugin-sdk/fixtures/account-actions');
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../../../..'));
    const compiled = await compileUniversalPluginUiCommonJs({
      projectRoot,
      entryPath: resolve(projectRoot, packageJson.exports['./happier-plugin-ui/account-runtime']!),
      artifactId: 'account-runtime', requestedExports: ['activate'], exportConditions: ['happier-source'],
      resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
        ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    const artifact = PluginUiArtifactsManifestEntryV2Schema.parse({
      artifactId: compiled.artifactId, tier: 'reactNative', entry: compiled.relativePath,
      files: [{ relativePath: compiled.relativePath, digest: computePluginUiArtifactSha256DigestV1(compiled.bytes), byteSize: compiled.bytes.length }],
      digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: compiled.relativePath, bytes: compiled.bytes }]),
      builtWith: { bundler: 'esbuild', version: compiled.esbuildVersion },
      executable: { exports: compiled.exports }, hostUiApiRange: '^1.0.0',
    });
    const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
      provenance: 'external',
      loadResult: {
        loadedPlugins: [{
          pluginId: manifest.id, pluginRootPath: projectRoot,
          manifestPath: join(projectRoot, '.happier-plugin/plugin.json'),
          daemonEntryPath: join(projectRoot, 'dist/index.js'), devDaemonEntryPath: null, manifest,
          sourceSpec: { kind: 'archive', locator: '/test/account-actions.tgz', resolvedPath: projectRoot,
            resolvedVersion: manifest.version, trustPolicy: 'prompt', installPolicy: 'copy' },
          generatedUiArtifactsManifest: { version: 2, entries: [artifact] },
        }], diagnosticsByPluginId: {},
      },
    }));
    const owners = collectResolvedGeneratedReactNativeClientContributionArtifactOwners(registry);
    expect(owners.map(owner => owner.contributionId).sort()).toEqual(
      manifest.contributes.actions.map(action => action.id).sort(),
    );
    for (const owner of owners) {
      expect(owner).toMatchObject({ pluginId: manifest.id, artifactId: 'account-runtime',
        declaredPlatforms: ['web', 'ios', 'android'], expectedExecutable: { exportName: 'activate' } });
      expect(findGeneratedReactNativeArtifactEntry({ owner, platform: 'web' })).toEqual({ entry: artifact, failure: null });
    }
  });

  it('resolves one universal executable artifact for every host platform', () => {
    const entry = createEntry();
    const owner = createOwner(entry);

    for (const platform of ['web', 'ios', 'android'] as const) {
      expect(findGeneratedReactNativeArtifactEntry({ owner, platform })).toEqual({
        entry,
        failure: null,
      });
    }
  });

  it('fails closed when the universal artifact omits the declared export', () => {
    const owner = createOwner(createEntry(['otherExport']));

    expect(findGeneratedReactNativeArtifactEntry({ owner, platform: 'ios' })).toEqual({
      entry: null,
      failure: 'generated_react_native_export_missing',
    });
  });

  it('does not infer host-private Collection migrations from a render artifact', () => {
    expect(collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners({
      agents: [],
      actions: [],
      resources: [],
      accountCollections: [],
      uiRenderersV2: [],
    } as unknown as ResolvedContributionRegistry)).toEqual([]);
  });

  it('resolves Collection migration authority only from its Account Collection declaration', () => {
    const entry = createEntry(['collectionMigrations']);
    const owner: ResolvedGeneratedReactNativeCollectionMigrationArtifactOwner = {
      kind: 'collectionMigrations',
      pluginId: 'acme.native',
      pluginSource: { kind: 'path' },
      pluginVersion: '2.0.0',
      contributionId: 'tasks',
      artifactId: 'panel-artifact',
      pluginRootPath: '/plugins/acme.native',
      manifestPath: '/plugins/acme.native/.happier-plugin/plugin.json',
      generatedUiArtifactsManifest: { version: 2, entries: [entry] },
      requiredHostMethods: [],
      declaredPlatforms: ['web', 'ios', 'android'],
      expectedExecutable: { exportName: 'collectionMigrations' },
    };

    expect(findGeneratedReactNativeCollectionMigrationsModule({ owner, platform: 'ios' })).toEqual({
      entry,
      moduleReference: { exportName: 'collectionMigrations' },
      failure: null,
    });
    expect(collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners({
      agents: [],
      actions: [],
      resources: [],
      accountCollections: [{
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: owner.pluginId,
        pluginVersion: owner.pluginVersion,
        identity: { pluginId: owner.pluginId, localId: owner.contributionId },
        manifestPath: owner.manifestPath,
        pluginRootPath: owner.pluginRootPath,
        generatedUiArtifactsManifest: owner.generatedUiArtifactsManifest,
        migrationArtifact: { artifactId: owner.artifactId, exportName: 'collectionMigrations' },
        definition: {
          pluginId: owner.pluginId,
          collectionId: owner.contributionId,
          migrations: [{ id: 'v1-v2', fromSchemaVersion: 1, toSchemaVersion: 2 }],
        } as never,
      }],
    } as unknown as ResolvedContributionRegistry)).toEqual([owner]);
  });
});
