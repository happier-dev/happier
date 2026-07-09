import { describe, expect, it } from 'vitest';

import { PluginUiArtifactsManifestV1Schema } from './uiArtifactsManifest.js';

const HOSTED_DIGEST = `sha256:${'d'.repeat(64)}`;
const NATIVE_DIGEST = `sha256:${'e'.repeat(64)}`;

describe('plugin UI artifacts manifest', () => {
  it('binds hosted-web, embedded-web, and RN outputs to one canonical build manifest', () => {
    const manifest = PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [
        {
          contributionId: 'preview-web',
          tier: 'hostedWeb',
          platform: 'web',
          entry: 'hosted-web/preview-web/index.html',
          files: ['hosted-web/preview-web/index.html', 'hosted-web/preview-web/assets/app.js'],
          digest: HOSTED_DIGEST,
          builtWith: { bundler: 'vite', version: '7.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0' },
        },
        {
          contributionId: 'preview-native',
          tier: 'reactNative',
          platform: 'ios',
          entry: 'react-native/preview-native/ios.bundle.js',
          files: ['react-native/preview-native/ios.bundle.js'],
          digest: NATIVE_DIGEST,
          builtWith: { bundler: 'repack', version: '5.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: {
            react: '19.2.0',
            reactNative: '0.83.4',
            expoRuntime: '0.2.0-native',
            hermes: '0.15.0',
          },
        },
      ],
    });

    expect(manifest.entries).toHaveLength(2);
  });

  it('rejects mismatched bundlers and RN entries without a native platform', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'preview-native',
        tier: 'reactNative',
        entry: 'react-native/preview-native/ios.bundle.js',
        files: ['react-native/preview-native/ios.bundle.js'],
        digest: NATIVE_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
      }],
    }).success).toBe(false);
  });

  it('accepts a reactNative tier, web platform entry built with Vite (LEDGER DEC-6 RN-web)', () => {
    const manifest = PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [{
        contributionId: 'preview-native',
        tier: 'reactNative',
        platform: 'web',
        entry: 'react-native-web/preview-native/entry.mjs',
        files: ['react-native-web/preview-native/entry.mjs'],
        digest: NATIVE_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
      }],
    });

    expect(manifest.entries).toHaveLength(1);
  });

  it('rejects a reactNative tier, web platform entry built with Re.Pack', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'preview-native',
        tier: 'reactNative',
        platform: 'web',
        entry: 'react-native-web/preview-native/entry.mjs',
        files: ['react-native-web/preview-native/entry.mjs'],
        digest: NATIVE_DIGEST,
        builtWith: { bundler: 'repack', version: '5.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
      }],
    }).success).toBe(false);
  });

  it('a reactNative plugin ships three manifest entries: ios+android via Re.Pack, web via Vite', () => {
    const manifest = PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [
        {
          contributionId: 'preview-native',
          tier: 'reactNative',
          platform: 'ios',
          entry: 'react-native/preview-native/ios.bundle.js',
          files: ['react-native/preview-native/ios.bundle.js'],
          digest: NATIVE_DIGEST,
          builtWith: { bundler: 'repack', version: '5.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        {
          contributionId: 'preview-native',
          tier: 'reactNative',
          platform: 'android',
          entry: 'react-native/preview-native/android.bundle.js',
          files: ['react-native/preview-native/android.bundle.js'],
          digest: NATIVE_DIGEST,
          builtWith: { bundler: 'repack', version: '5.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        {
          contributionId: 'preview-native',
          tier: 'reactNative',
          platform: 'web',
          entry: 'react-native-web/preview-native/entry.mjs',
          files: ['react-native-web/preview-native/entry.mjs'],
          digest: NATIVE_DIGEST,
          builtWith: { bundler: 'vite', version: '7.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
      ],
    });

    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries.map((entry) => entry.platform)).toEqual(['ios', 'android', 'web']);
  });
});
