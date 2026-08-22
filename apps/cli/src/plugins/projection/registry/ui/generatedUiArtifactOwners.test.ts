import { describe, expect, it } from 'vitest';

import {
  PluginUiArtifactDigestV1Schema,
  type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
  findGeneratedReactNativeCollectionMigrationsModule,
  findGeneratedReactNativeArtifactEntry,
  type ResolvedGeneratedReactNativeArtifactOwner,
} from './generatedUiArtifactOwners';

const digest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
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
  it('admits host-private Collection migration code only from an explicit signed module declaration', () => {
    const base: PluginUiArtifactsManifestEntryV1 = {
      contributionId: 'panel-artifact',
      tier: 'reactNative',
      platform: 'ios',
      entry: 'react-native/panel/ios.bundle',
      files: [file('react-native/panel/ios.bundle')],
      digest,
      builtWith: { bundler: 'repack', version: '5.2.5' },
      repack: {
        containerName: 'acme_panel',
        modulePath: './renderSurface',
        exportName: 'renderSurface',
      },
      hostUiApiVersion: '1.0.0',
      compat: { react: '19.2.0', reactNative: '0.83.4' },
    };

    expect(findGeneratedReactNativeCollectionMigrationsModule({
      owner: createOwner(base),
      platform: 'ios',
    })).toEqual({
      entry: null,
      moduleReference: null,
      failure: 'generated_react_native_collection_migrations_module_missing',
    });

    const declared: PluginUiArtifactsManifestEntryV1 = {
      ...base,
      collectionMigrations: {
        containerName: 'acme_panel',
        modulePath: './renderSurface',
        exportName: 'collectionMigrations',
      },
    };
    expect(findGeneratedReactNativeCollectionMigrationsModule({
      owner: createOwner(declared),
      platform: 'ios',
    })).toEqual({
      entry: declared,
      moduleReference: declared.collectionMigrations,
      failure: null,
    });
  });

  it('fails closed before projection when a Voice declaration targets a different Re.Pack module', () => {
    const entry: PluginUiArtifactsManifestEntryV1 = {
      contributionId: 'voice-artifact',
      tier: 'reactNative',
      platform: 'ios',
      entry: 'react-native/voice/ios.bundle',
      files: [file('react-native/voice/ios.bundle')],
      digest,
      builtWith: { bundler: 'repack', version: '5.2.5' },
      repack: {
        containerName: 'acme_voice',
        modulePath: './otherRuntime',
        exportName: 'activate',
      },
      hostUiApiVersion: '1.0.0',
      compat: { react: '19.2.0', reactNative: '0.83.4' },
    };
    const owner: ResolvedGeneratedReactNativeArtifactOwner = {
      ...createOwner(entry),
      kind: 'voiceProvider',
      contributionId: 'conversation',
      artifactId: 'voice-artifact',
      declaredPlatforms: ['ios'],
      expectedRepackModule: {
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    };

    expect(findGeneratedReactNativeArtifactEntry({ owner, platform: 'ios' })).toEqual({
      entry: null,
      failure: 'generated_react_native_repack_identity_mismatch',
    });
  });

  it('fails closed when a native generated graph bypasses parsing without exact Re.Pack identity', () => {
    const owner = createOwner({
      contributionId: 'panel-artifact',
      tier: 'reactNative',
      platform: 'ios',
      entry: 'react-native/panel/ios.bundle',
      files: [file('react-native/panel/ios.bundle')],
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
