import { describe, expect, it } from 'vitest';

import type { PluginUiArtifactsManifestEntryV1 } from '@happier-dev/protocol/plugins/ui';

import {
  findGeneratedReactNativeArtifactEntry,
  type ResolvedGeneratedReactNativeArtifactOwner,
} from './generatedUiArtifactOwners';

const digest = `sha256:${'a'.repeat(64)}`;
const file = (relativePath: string) => ({ relativePath, digest, byteSize: 1 });

function createOwner(
  entry: PluginUiArtifactsManifestEntryV1,
): ResolvedGeneratedReactNativeArtifactOwner {
  return {
    kind: 'renderer',
    pluginId: 'acme.native',
    contributionId: 'panel',
    artifactId: 'panel-artifact',
    pluginRootPath: '/plugins/acme.native',
    manifestPath: '/plugins/acme.native/.happier-plugin/plugin.json',
    generatedUiArtifactsManifest: { version: 1, entries: [entry] },
    requiredHostMethods: [],
  };
}

describe('findGeneratedReactNativeArtifactEntry', () => {
  it('fails closed when a native generated graph bypasses parsing without exact Re.Pack identity', () => {
    const owner = createOwner({
      contributionId: 'panel-artifact',
      tier: 'reactNative',
      platform: 'ios',
      entry: 'react-native/panel/ios.bundle.js',
      files: [file('react-native/panel/ios.bundle.js')],
      digest,
      builtWith: { bundler: 'repack', version: '5.2.5' },
      hostUiApiVersion: '1.0.0',
      compat: { react: '19.2.0', reactNative: '0.83.4' },
    });

    expect(findGeneratedReactNativeArtifactEntry({ owner, platform: 'ios' })).toEqual({
      entry: null,
      failure: 'generated_react_native_repack_identity_missing',
    });
  });

  it('fails closed when a web generated graph bypasses parsing with native Re.Pack identity', () => {
    const owner = createOwner({
      contributionId: 'panel-artifact',
      tier: 'reactNative',
      platform: 'web',
      entry: 'react-native/panel/web.js',
      files: [file('react-native/panel/web.js')],
      digest,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      repack: {
        containerName: 'acme_native',
        modulePath: './panel',
        exportName: 'renderSurface',
      },
      hostUiApiVersion: '1.0.0',
      compat: { react: '19.2.0', reactNative: '0.83.4' },
    });

    expect(findGeneratedReactNativeArtifactEntry({ owner, platform: 'web' })).toEqual({
      entry: null,
      failure: 'generated_react_native_repack_identity_unexpected',
    });
  });
});
