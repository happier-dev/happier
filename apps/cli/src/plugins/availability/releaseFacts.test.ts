import { describe, expect, it } from 'vitest';

import { PluginUiArtifactsManifestV1Schema } from '@happier-dev/protocol/plugins/ui';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { createVerifiedPortablePluginInstallationAvailability } from './releaseFacts';

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

describe('verified portable Plugin Availability facts', () => {
  it('binds every verified generated UI artifact slot using only artifact-declared compatibility', () => {
    const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({
      id: 'com.acme.artifacts',
      version: '1.2.3',
      contributes: {
        resources: [{
          id: 'brand',
          kind: 'asset',
          path: 'assets/brand.png',
          contentType: 'image/png',
        }],
      },
    }));
    const generatedUiArtifacts = PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [
        {
          contributionId: 'native-panel',
          tier: 'reactNative',
          platform: 'ios',
          entry: 'native/ios.bundle',
          files: [{
            relativePath: 'native/ios.bundle',
            digest: digest('b'),
            byteSize: 12,
          }],
          digest: digest('c'),
          builtWith: { bundler: 'repack', version: '5.0.0' },
          repack: {
            containerName: 'acme_artifacts',
            modulePath: './Panel',
            exportName: 'Panel',
          },
          hostUiApiVersion: '1.0.0',
          compat: {
            react: '19.0.0',
            reactNative: '0.83.4',
            expoRuntime: '55.0.0',
            hermes: '0.15.0',
          },
        },
        {
          contributionId: 'web-panel',
          tier: 'hostedWeb',
          entry: 'web/index.html',
          files: [{
            relativePath: 'web/index.html',
            digest: digest('d'),
            byteSize: 13,
          }],
          digest: digest('e'),
          builtWith: { bundler: 'vite', version: '6.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: {},
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
        tier: 'reactNative',
        platform: 'ios',
        artifactDigest: digest('c'),
        compatibility: {
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.0.0',
          reactNativeVersion: '0.83.4',
          expoRuntimeVersion: '55.0.0',
          hermesVersion: '0.15.0',
        },
      },
      {
        contributionId: 'web-panel',
        tier: 'hostedWeb',
        platform: 'web',
        artifactDigest: digest('e'),
        compatibility: {
          hostUiApiVersion: '1.0.0',
        },
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
