import { describe, expect, it } from 'vitest';

import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import { PluginAvailabilityMaterializationsReportActionInputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { projectPluginMachineMaterializationReportFactsV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { createVerifiedPortablePluginInstallationAvailability, projectVerifiedPluginUiReleaseSlotsV2 } from './releaseFacts';

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

describe('verified portable Plugin Availability facts', () => {
  it('publishes the exact portable Account executable graph without a renderer declaration', () => {
    const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({
      id: 'com.acme.account-only', contributes: { actions: [{
        id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe',
        placementBindings: ['commandPalette'], execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } },
      }], resources: [{ id: 'read', source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'global',
        execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } } }] },
    }));
    const generatedUiArtifacts = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
      artifactId: 'account', tier: 'reactNative', entry: 'react-native/account/entry.cjs.bundle',
      files: [{ relativePath: 'react-native/account/entry.cjs.bundle', digest: digest('b'), byteSize: 12 }],
      digest: digest('c'), builtWith: { bundler: 'esbuild', version: '0.27.2' },
      executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0',
    }] });
    expect(projectVerifiedPluginUiReleaseSlotsV2({ manifest, generatedUiArtifacts })).toEqual(
      ['read', 'resources/read'].flatMap(contributionId => ['web', 'ios', 'android'].map(platform => ({
        contributionId, artifactId: 'account', tier: 'reactNative',
        platform, artifactDigest: digest('c'), hostUiApiRange: '^1.0.0', artifactGraph: generatedUiArtifacts.entries[0] }))),
    );
    const uiArtifacts = projectVerifiedPluginUiReleaseSlotsV2({ manifest, generatedUiArtifacts });
    const snapshot = { serverIdentityId: 'srv_availability', machineId: 'machine', materializations: [
      projectPluginMachineMaterializationReportFactsV1({ serverIdentityId: 'srv_availability', machineId: 'machine',
        materializationId: 'installation', pluginId: manifest.id, version: manifest.version,
        sourceClass: 'bundledFirstParty', portableRelease: false, uiArtifacts,
        enabled: true, trustState: 'trusted', observedAt: 1 }),
    ] };
    // Release slots retain the executable graph; the Machine census carries
    // only materialization facts. A leaked graph rejects the entire report.
    expect(PluginAvailabilityMaterializationsReportActionInputV1Schema.safeParse({ expectedRevision: null, snapshot }).success).toBe(true);
  });
  it('does not publish a native declaration backed by the wrong artifact tier', () => {
    const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({
      id: 'com.acme.invalid-ui', contributes: { ui: { renderers: [
        { id: 'native-panel', kind: 'reactNative', artifact: 'panel' },
      ] } },
    }));
    const generatedUiArtifacts = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
      artifactId: 'panel', tier: 'hostedWeb', entry: 'hosted-web/panel/index.html',
      files: [{ relativePath: 'hosted-web/panel/index.html', digest: digest('b'), byteSize: 12 }],
      digest: digest('c'), builtWith: { staging: 'staticDirectory' }, hostUiApiRange: '^1.0.0',
    }] });
    expect(projectVerifiedPluginUiReleaseSlotsV2({ manifest, generatedUiArtifacts })).toEqual([]);
  });

  it('omits missing artifacts while preserving a verified neighbouring contribution', () => {
    const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({
      id: 'com.acme.partial-ui',
      contributes: { ui: { renderers: [
        { id: 'missing-panel', kind: 'reactNative', artifact: 'missing-bundle' },
        { id: 'ready-panel', kind: 'reactNative', artifact: 'ready-bundle' },
      ] } },
    }));
    const generatedUiArtifacts = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
      artifactId: 'ready-bundle', tier: 'reactNative',
      entry: 'react-native/ready-bundle/entry.cjs.bundle',
      files: [{ relativePath: 'react-native/ready-bundle/entry.cjs.bundle', digest: digest('b'), byteSize: 12 }],
      digest: digest('c'), builtWith: { bundler: 'esbuild', version: '0.27.2' },
      executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0',
    }] });
    expect(projectVerifiedPluginUiReleaseSlotsV2({ manifest, generatedUiArtifacts }))
      .toEqual(['web', 'ios', 'android'].map(platform => ({
        contributionId: 'ready-panel', artifactId: 'ready-bundle', tier: 'reactNative', platform,
        artifactDigest: digest('c'), hostUiApiRange: '^1.0.0',
        artifactGraph: generatedUiArtifacts.entries[0],
      })));
  });

  it('binds every verified generated UI artifact slot using only artifact-declared compatibility', () => {
    const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({
      id: 'com.acme.artifacts',
      version: '1.2.3',
      contributes: {
        ui: {
          renderers: [
            { id: 'native-panel', kind: 'reactNative', artifact: 'native-bundle' },
            { id: 'web-panel', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'hosted-static' } },
          ],
        },
        resources: [{
          id: 'brand',
          kind: 'asset',
          path: 'assets/brand.png',
          contentType: 'image/png',
        }],
      },
    }));
    const generatedUiArtifacts = PluginUiArtifactsManifestV2Schema.parse({
      version: 2,
      entries: [
        {
          artifactId: 'native-bundle',
          tier: 'reactNative',
          entry: 'react-native/native-bundle/entry.cjs.bundle',
          files: [{
            relativePath: 'react-native/native-bundle/entry.cjs.bundle',
            digest: digest('b'),
            byteSize: 12,
          }],
          digest: digest('c'),
          builtWith: { bundler: 'esbuild', version: '0.27.2' },
          executable: { exports: ['renderSurface'] },
          hostUiApiRange: '^1.0.0',
        },
        {
          artifactId: 'hosted-static',
          tier: 'hostedWeb',
          entry: 'hosted-web/hosted-static/index.html',
          files: [{
            relativePath: 'hosted-web/hosted-static/index.html',
            digest: digest('d'),
            byteSize: 13,
          }],
          digest: digest('e'),
          builtWith: { staging: 'staticDirectory' },
          hostUiApiRange: '^1.0.0',
        },
      ],
    });

    const availability = createVerifiedPortablePluginInstallationAvailability({
      sourceClass: 'versionedArchive',
      archiveDigestSha256: digest('a'),
      manifest,
      generatedUiArtifacts,
      packageAssetArchive: {
        archiveDigestSha256: digest('f'),
        resources: [{
          resourceId: 'brand',
          path: 'assets/brand.png',
          mimeType: 'image/png',
          byteSize: 3,
          digestSha256: digest('e'),
        }],
      },
    });

    expect(availability.release?.uiSlots).toEqual([
      {
        contributionId: 'native-panel',
        artifactId: 'native-bundle',
        tier: 'reactNative',
        platform: 'android',
        artifactDigest: digest('c'),
        hostUiApiRange: '^1.0.0',
        artifactGraph: generatedUiArtifacts.entries[0],
      },
      {
        contributionId: 'native-panel', artifactId: 'native-bundle', tier: 'reactNative', platform: 'ios',
        artifactDigest: digest('c'), hostUiApiRange: '^1.0.0',
        artifactGraph: generatedUiArtifacts.entries[0],
      },
      {
        contributionId: 'native-panel', artifactId: 'native-bundle', tier: 'reactNative', platform: 'web',
        artifactDigest: digest('c'), hostUiApiRange: '^1.0.0',
        artifactGraph: generatedUiArtifacts.entries[0],
      },
      {
        contributionId: 'web-panel',
        artifactId: 'hosted-static',
        tier: 'hostedWeb',
        platform: 'web',
        artifactDigest: digest('e'),
        hostUiApiRange: '^1.0.0',
        artifactGraph: generatedUiArtifacts.entries[1],
      },
    ]);
    expect(availability.release?.packageAssetArchive).toEqual({
      archiveDigestSha256: digest('f'),
      resources: [{
        resourceId: 'brand',
        path: 'assets/brand.png',
        mimeType: 'image/png',
        byteSize: 3,
        digestSha256: digest('e'),
      }],
    });
  });
});
