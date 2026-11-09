import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope } from '../../../../../../../packages/plugin-sdk/src/registration/scope';
import { portableAuthentication } from '../../../../../../../packages/plugin-sdk/examples/public-authoring/portableAuthentication';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readDaemonPluginUiArtifactBytes } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH, GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';

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
  it('reads and activates the emitted public authentication-only artifact through its ordinary contribution inventory', async () => {
    const { discoverExecutablePluginUiArtifacts } = await import('../../../../../../../packages/plugin-sdk/src/ui/build/manifestArtifactDiscovery');
    const { compileUniversalPluginUiCommonJs } = await import('../../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler');
    const { evaluatePortableCommonJs } = await import('../../../../../../../packages/plugin-sdk/src/test-support/evaluatePortableCommonJs');
    const { createPluginHttpFixture } = await import('../../../../../../../packages/plugin-sdk/src/testing/http');
    const root = await mkdtemp(join(tmpdir(), 'happier-public-auth-artifact-'));
    const plugin = definePlugin({ id: 'acme.portable-auth-artifact', version: '1.0.0',
      entrypoints: { daemon: './daemon.mjs' }, connectedAccountDescriptors: { example: {
        declaration: { title: 'Example', authentication: { account: { artifactId: 'portable-auth', exportName: 'activate' },
          defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{
            id: 'token', title: 'Token', secret: true, schema: { type: 'string' },
          }] }] } },
        runtime: { ...portableAuthentication, async refresh() { return { status: 'connected' }; },
          async status() { return { status: 'connected' }; }, async revoke() { return { status: 'remoteUnsupported' }; },
          async materialize() { return { kind: 'httpHeaders', headers: {} }; } },
      } } });
    try {
      await mkdir(join(root, '.happier-plugin'));
      await writeFile(join(root, '.happier-plugin/plugin.json'), JSON.stringify(plugin.manifest));
      await writeFile(join(root, 'package.json'), JSON.stringify({ exports: { './happier-plugin-ui/portable-auth': './auth.ts' } }));
      await writeFile(join(root, 'auth.ts'), await readFile(resolve(import.meta.dirname,
        '../../../../../../../packages/plugin-sdk/examples/public-authoring/portableAuthentication.ts')));
      const [declaration] = await discoverExecutablePluginUiArtifacts(root);
      expect(declaration).toMatchObject({ artifactId: 'portable-auth', requestedExports: ['activate'] });
      if (!declaration) throw new Error('The authored authentication artifact must be discovered');
      const compiled = await compileUniversalPluginUiCommonJs({ projectRoot: root, ...declaration });
      const artifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: compiled.artifactId, tier: 'reactNative', entry: compiled.relativePath,
        files: [{ relativePath: compiled.relativePath, digest: computePluginUiArtifactSha256DigestV1(compiled.bytes), byteSize: compiled.bytes.length }],
        digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: compiled.relativePath, bytes: compiled.bytes }]),
        builtWith: { bundler: 'esbuild', version: compiled.esbuildVersion }, executable: { exports: compiled.exports }, hostUiApiRange: '^1.0.0' });
      const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ manifest: plugin.manifest, files: {
        'daemon.mjs': 'export function activate() { throw new Error("Reading portable auth bytes must not activate the daemon"); }',
        [GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH]: JSON.stringify({ version: 2, entries: [artifact] }),
        [`${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/${compiled.relativePath}`]: compiled.bytes,
      } }] });
      try {
        const owners = collectResolvedGeneratedReactNativeClientContributionArtifactOwners(fixture.registry.contributes);
        expect(owners).toMatchObject([{ contributionId: 'connectedAccountDescriptors/example', artifactId: 'portable-auth',
          expectedExecutable: { exportName: 'activate' }, declaredPlatforms: ['web', 'ios', 'android'] }]);
        const read = await readDaemonPluginUiArtifactBytes({ artifactFamily: 'reactNative', machineId: 'fixture',
          cacheIdentity: { artifactDigest: artifact.digest } }, { resolveRuntimeRegistry: async () => fixture.registry });
        expect(read.ok).toBe(true);
        if (!read.ok) throw new Error(read.code);
        const entry = read.files.find(file => file.relativePath === compiled.relativePath);
        if (!entry) throw new Error('The verified entry bytes must be present');
        const module = { exports: {} as Record<string, unknown> };
        evaluatePortableCommonJs(Buffer.from(entry.bytesBase64, 'base64').toString('utf8'), module);
        const activate = module.exports.activate;
        if (typeof activate !== 'function') throw new Error('The emitted public Account activation must be callable');
        const target = { artifactId: 'portable-auth', exportName: 'activate' };
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target },
          rights: derivePluginAccountContributionRegistrationRights(plugin.manifest.contributes, target) });
        try {
          activate(scope.api);
          const [registration] = scope.commit();
          expect(registration).toMatchObject({ family: 'connectedAccountDescriptors', localId: 'example',
            value: { authentication: { modes: { manual: { kind: 'manual', complete: expect.any(Function) } } } } });
          if (registration?.family !== 'connectedAccountDescriptors') throw new Error('Expected the authored auth runtime');
          const mode = registration.value.authentication.modes.manual;
          if (mode?.kind !== 'manual') throw new Error('Expected the declared manual mode');
          const credentials = new Map<string, string>();
          const service = { pluginId: plugin.manifest.id, localId: 'example' };
          const signal = new AbortController().signal;
          const result = await mode.complete({ fields: { token: 'artifact-fixture-credential' } }, {
            plugin: { id: plugin.manifest.id, version: '1.0.0' }, contribution: { id: 'example', qualifiedId: `${plugin.manifest.id}/example` },
            invokedAtMs: 1, surface: 'ui', signal, service, attempt: { kind: 'connect', attemptId: 'artifact-attempt' },
            configuration: { target: { kind: 'attempt', attemptId: 'artifact-attempt', service, modeId: 'manual' }, revision: '1',
              values: {}, async getSecret() { return null; } },
            attemptCredentials: { async get(key) { return credentials.get(key) ?? null; },
              async set(key, value) { credentials.set(key, value); }, async delete(key) { credentials.delete(key); } },
            services: { http: createPluginHttpFixture({ async request() { throw new Error('Manual sign-in performs no HTTP'); } }) },
          });
          expect(result).toEqual({ status: 'connected', accountId: 'example-account', displayName: 'Example account', scopes: [] });
          expect(credentials.get('token')).toBe('artifact-fixture-credential');
          expect(fixture.registry.activatedPluginIds.size).toBe(0);
        } finally { await scope.dispose(); }
      } finally { await fixture.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('discovers the authored Account Action generated graph without a renderer or client Action', async () => {
    const { compileUniversalPluginUiCommonJs } = await import('../../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler');
    const { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } = await import('../../../../../../../packages/cli-common/sourceRuntimeEntries.mjs');
    const { manifest: authoredManifest } = await import('../../../../../../../packages/plugin-sdk/fixtures/account-actions/src/index');
    const manifest = normalizePluginManifestV2(authoredManifest);
    const execution = manifest.contributes.actions.find(action => action.execution.target === 'account')?.execution;
    if (execution?.target !== 'account') throw new Error('Expected the fixture Account execution declaration');
    const target = execution.account;
    const projectRoot = resolve(import.meta.dirname, '../../../../../../../packages/plugin-sdk/fixtures/account-actions');
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../../../..'));
    const compiled = await compileUniversalPluginUiCommonJs({
      projectRoot,
      entryPath: resolve(projectRoot, packageJson.exports[`./happier-plugin-ui/${target.artifactId}`]!),
      artifactId: target.artifactId, requestedExports: [target.exportName], exportConditions: ['happier-source'],
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
      [...manifest.contributes.actions.map(action => action.id),
        ...manifest.contributes.resources.filter(resource => resource.source === 'dynamic' && resource.execution?.target === 'account')
          .map(resource => `resources/${resource.id}`)].sort(),
    );
    for (const owner of owners) {
      expect(owner).toMatchObject({ pluginId: manifest.id, artifactId: target.artifactId,
        declaredPlatforms: ['web', 'ios', 'android'], expectedExecutable: { exportName: target.exportName } });
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
