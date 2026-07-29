import { describe, expect, it } from 'vitest';

import {
  PluginUiExecutableArtifactManifestV1Schema,
  derivePluginUiArtifactCacheKeyV1,
} from './artifacts.js';

const compatibility = {
  hostAppVersion: '2.0.0',
  hostUiApiVersion: '1.0.0',
  reactVersion: '19.0.0',
  reactNativeVersion: '0.79.0',
};
const VALID_DIGEST = `sha256:${'c'.repeat(64)}`;

describe('plugin UI executable artifact manifests', () => {
  it('binds executable artifacts to plugin, contribution, digest, platform, channel, and compatibility', () => {
    const parsed = PluginUiExecutableArtifactManifestV1Schema.parse({
      id: 'native-preview-ios',
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      contributionFamily: 'reactNativeBundles',
      artifactKind: 'reactNativeBundle',
      platform: 'ios',
      channel: 'internal',
      integrity: { digest: VALID_DIGEST },
      compatibility,
      byteSize: 1024,
      contentType: 'application/javascript',
      assetPath: 'ui/native/ios.bundle',
    });

    expect(derivePluginUiArtifactCacheKeyV1(parsed)).toContain(VALID_DIGEST);
  });

  it('rejects removed per-artifact signing and install-source trust metadata', () => {
    const baseArtifact = {
      id: 'native-preview-ios',
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      contributionFamily: 'reactNativeBundles',
      artifactKind: 'reactNativeBundle',
      platform: 'ios',
      channel: 'internal',
      integrity: { digest: VALID_DIGEST },
      compatibility,
      byteSize: 1024,
      contentType: 'application/javascript',
      assetPath: 'ui/native/ios.bundle',
    } as const;

    expect(PluginUiExecutableArtifactManifestV1Schema.safeParse({
      ...baseArtifact,
      integrity: {
        ...baseArtifact.integrity,
        signature: 'legacy-ui-signature',
        signingKeyId: 'legacy-ui-key',
      },
    }).success).toBe(false);
    expect(PluginUiExecutableArtifactManifestV1Schema.safeParse({
      ...baseArtifact,
      installSourceId: 'legacy-ui-install-source',
    }).success).toBe(false);
  });

  it('binds native capability compatibility into executable artifact cache keys', () => {
    const baseArtifact = PluginUiExecutableArtifactManifestV1Schema.parse({
      id: 'native-preview-ios',
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      contributionFamily: 'reactNativeBundles',
      artifactKind: 'reactNativeBundle',
      platform: 'ios',
      channel: 'internal',
      integrity: { digest: VALID_DIGEST },
      compatibility,
      byteSize: 1024,
      contentType: 'application/javascript',
      assetPath: 'ui/native/ios.bundle',
    });
    const clipboardArtifact = PluginUiExecutableArtifactManifestV1Schema.parse({
      ...baseArtifact,
      compatibility: {
        ...baseArtifact.compatibility,
        nativeCapabilities: ['clipboard'],
      },
    });
    const reorderedCapabilityArtifact = PluginUiExecutableArtifactManifestV1Schema.parse({
      ...baseArtifact,
      compatibility: {
        ...baseArtifact.compatibility,
        nativeCapabilities: ['filesystem', 'clipboard'],
      },
    });
    const orderedCapabilityArtifact = PluginUiExecutableArtifactManifestV1Schema.parse({
      ...baseArtifact,
      compatibility: {
        ...baseArtifact.compatibility,
        nativeCapabilities: ['clipboard', 'filesystem'],
      },
    });

    expect(derivePluginUiArtifactCacheKeyV1(clipboardArtifact)).not.toBe(
      derivePluginUiArtifactCacheKeyV1(baseArtifact),
    );
    expect(derivePluginUiArtifactCacheKeyV1(reorderedCapabilityArtifact)).toBe(
      derivePluginUiArtifactCacheKeyV1(orderedCapabilityArtifact),
    );
  });

  it('invalidates executable artifact cache keys across host app upgrades', () => {
    const baseArtifact = PluginUiExecutableArtifactManifestV1Schema.parse({
      id: 'native-preview-ios',
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      contributionFamily: 'reactNativeBundles',
      artifactKind: 'reactNativeBundle',
      platform: 'ios',
      channel: 'internal',
      integrity: { digest: VALID_DIGEST },
      compatibility,
      byteSize: 1024,
      contentType: 'application/javascript',
      assetPath: 'ui/native/ios.bundle',
    });
    const upgradedHostArtifact = PluginUiExecutableArtifactManifestV1Schema.parse({
      ...baseArtifact,
      compatibility: {
        ...baseArtifact.compatibility,
        hostAppVersion: '2.1.0',
      },
    });

    expect(derivePluginUiArtifactCacheKeyV1(baseArtifact)).not.toBe(
      derivePluginUiArtifactCacheKeyV1(upgradedHostArtifact),
    );
  });

  it('rejects production dev URLs and missing digests', () => {
    const result = PluginUiExecutableArtifactManifestV1Schema.safeParse({
      id: 'web-assets',
      pluginId: 'acme.preview',
      contributionId: 'preview-web',
      contributionFamily: 'hostedWeb',
      artifactKind: 'hostedWebAsset',
      platform: 'web',
      channel: 'store',
      integrity: {},
      compatibility: { hostUiApiVersion: '1.0.0' },
      byteSize: 1024,
      contentType: 'text/html',
      devUrl: 'http://127.0.0.1:5173',
    });

    expect(result.success).toBe(false);
  });

  it('allows local development dev URLs without immutable artifact integrity', () => {
    const parsed = PluginUiExecutableArtifactManifestV1Schema.parse({
      id: 'native-dev-server',
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      contributionFamily: 'reactNativeBundles',
      artifactKind: 'reactNativeBundle',
      platform: 'ios',
      channel: 'development',
      compatibility,
      byteSize: 1,
      contentType: 'application/javascript',
      devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
    });

    expect(parsed.devUrl).toBe('http://127.0.0.1:8082/index.bundle?platform=ios&dev=true');
  });

  it('rejects removed embedded-web artifact family and kind values', () => {
    expect(PluginUiExecutableArtifactManifestV1Schema.safeParse({
      id: 'removed-web-entry',
      pluginId: 'acme.preview',
      contributionId: 'removed-web',
      contributionFamily: 'embeddedWebBundles',
      artifactKind: 'embeddedWebBundle',
      platform: 'web',
      channel: 'internal',
      integrity: { digest: VALID_DIGEST },
      compatibility,
      byteSize: 1024,
      contentType: 'text/javascript',
      assetPath: 'removed-web/entry.mjs',
    }).success).toBe(false);
  });

  it('rejects source map digests that do not use the plugin UI digest contract', () => {
    const result = PluginUiExecutableArtifactManifestV1Schema.safeParse({
      id: 'native-preview-map',
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      contributionFamily: 'reactNativeBundles',
      artifactKind: 'reactNativeSourceMap',
      platform: 'ios',
      channel: 'internal',
      integrity: { digest: VALID_DIGEST },
      compatibility,
      byteSize: 1024,
      contentType: 'application/json',
      assetPath: 'ui/native/ios.bundle.map',
      sourceMapDigest: 'map',
    });

    expect(result.success).toBe(false);
  });
});
