import { describe, expect, it } from 'vitest';

import {
  PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1,
  PluginUiArtifactsManifestV1Schema,
} from './uiArtifactsManifest.js';

const HOSTED_DIGEST = `sha256:${'d'.repeat(64)}`;
const NATIVE_DIGEST = `sha256:${'e'.repeat(64)}`;
const FILE_DIGEST = `sha256:${'f'.repeat(64)}`;

function artifactFile(relativePath: string, byteSize = 12) {
  return { relativePath, digest: FILE_DIGEST, byteSize };
}

describe('plugin UI artifacts manifest', () => {
  it('exports the one public artifact grammar version used by generated build facts', () => {
    expect(PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1).toBe(1);
    expect(PluginUiArtifactsManifestV1Schema.parse({
      version: PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1,
      entries: [],
    }).version).toBe(PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1);
  });

  it('binds hosted-web and RN outputs to one canonical build manifest', () => {
    const manifest = PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [
        {
          contributionId: 'preview-web',
          tier: 'hostedWeb',
          platform: 'web',
          entry: 'hosted-web/preview-web/index.html',
          files: [
            artifactFile('hosted-web/preview-web/index.html'),
            artifactFile('hosted-web/preview-web/assets/app.js'),
          ],
          digest: HOSTED_DIGEST,
          builtWith: { bundler: 'vite', version: '7.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: {},
        },
        {
          contributionId: 'preview-native',
          tier: 'reactNative',
          platform: 'ios',
          repack: {
            containerName: 'preview_native',
            modulePath: './renderSurface',
            exportName: 'renderSurface',
          },
          entry: 'react-native/preview-native/ios.bundle',
          files: [artifactFile('react-native/preview-native/ios.bundle')],
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

  it('permits framework-free hosted-web artifacts while keeping React compatibility mandatory for reactNative tiers', () => {
    const hostedWeb = {
      contributionId: 'plain-dom-web',
      tier: 'hostedWeb',
      platform: 'web',
      entry: 'hosted-web/plain-dom-web/index.html',
      files: [artifactFile('hosted-web/plain-dom-web/index.html')],
      digest: HOSTED_DIGEST,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: {},
    } as const;
    const reactNativeWithoutReact = {
      contributionId: 'native-without-react',
      tier: 'reactNative',
      platform: 'web',
      entry: 'react-native-web/native-without-react/entry.mjs.bundle',
      files: [artifactFile('react-native-web/native-without-react/entry.mjs.bundle')],
      digest: NATIVE_DIGEST,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: { reactNative: '0.83.4' },
    } as const;

    expect(PluginUiArtifactsManifestV1Schema.parse({ version: 1, entries: [hostedWeb] }).entries[0]?.compat)
      .toEqual({});
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{ ...hostedWeb, compat: { react: '19.2.0' } }],
    }).success).toBe(false);
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [reactNativeWithoutReact],
    }).success).toBe(false);
  });

  it('rejects removed embedded-web generated artifact entries', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'removed-embedded-web',
        tier: 'embeddedWeb',
        platform: 'web',
        entry: 'embedded-web/removed-embedded-web/entry.mjs',
        files: [artifactFile('embedded-web/removed-embedded-web/entry.mjs')],
        digest: HOSTED_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: {},
      }],
    }).success).toBe(false);
  });

  it('rejects mismatched bundlers and RN entries without a native platform', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'preview-native',
        tier: 'reactNative',
        entry: 'react-native/preview-native/ios.bundle',
        files: [artifactFile('react-native/preview-native/ios.bundle')],
        digest: NATIVE_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
      }],
    }).success).toBe(false);
  });

  it('requires exact Re.Pack container, module, and export identity for native generated entries', () => {
    const base = {
      contributionId: 'preview-native',
      tier: 'reactNative',
      platform: 'ios',
      entry: 'react-native/preview-native/ios.bundle',
      files: [artifactFile('react-native/preview-native/ios.bundle')],
      digest: NATIVE_DIGEST,
      builtWith: { bundler: 'repack', version: '5.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: { react: '19.2.0', reactNative: '0.83.4' },
    } as const;

    expect(PluginUiArtifactsManifestV1Schema.safeParse({ version: 1, entries: [base] }).success).toBe(false);
    expect(PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [{
        ...base,
        repack: {
          containerName: 'preview_native',
          modulePath: './PluginPanel',
          exportName: 'PluginPanel',
        },
      }],
    }).entries[0]?.repack).toEqual({
      containerName: 'preview_native',
      modulePath: './PluginPanel',
      exportName: 'PluginPanel',
    });
  });

  it('accepts a reactNative tier, web platform entry built with Vite (LEDGER DEC-6 RN-web)', () => {
    const manifest = PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [{
        contributionId: 'preview-native',
        tier: 'reactNative',
        platform: 'web',
        entry: 'react-native-web/preview-native/entry.mjs.bundle',
        files: [artifactFile('react-native-web/preview-native/entry.mjs.bundle')],
        digest: NATIVE_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
      }],
    });

    expect(manifest.entries).toHaveLength(1);
  });

  it('admits a web candidate migration export without inventing native federation identity', () => {
    const base = {
      contributionId: 'preview-native',
      tier: 'reactNative',
      platform: 'web',
      entry: 'react-native-web/preview-native/entry.mjs.bundle',
      files: [artifactFile('react-native-web/preview-native/entry.mjs.bundle')],
      digest: NATIVE_DIGEST,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: { react: '19.2.0', reactNative: '0.83.4' },
    } as const;

    expect(PluginUiArtifactsManifestV1Schema.parse({
      version: 1,
      entries: [{ ...base, collectionMigrations: { exportName: 'collectionMigrations' } }],
    }).entries[0]?.collectionMigrations).toEqual({ exportName: 'collectionMigrations' });
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        ...base,
        collectionMigrations: {
          containerName: 'fake-web-container',
          modulePath: './fake-web-module',
          exportName: 'collectionMigrations',
        },
      }],
    }).success).toBe(false);
  });

  it('rejects a reactNative tier, web platform entry built with Re.Pack', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'preview-native',
        tier: 'reactNative',
        platform: 'web',
        entry: 'react-native-web/preview-native/entry.mjs.bundle',
        files: [artifactFile('react-native-web/preview-native/entry.mjs.bundle')],
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
          repack: { containerName: 'preview_native', modulePath: './renderSurface', exportName: 'renderSurface' },
          entry: 'react-native/preview-native/ios.bundle',
          files: [artifactFile('react-native/preview-native/ios.bundle')],
          digest: NATIVE_DIGEST,
          builtWith: { bundler: 'repack', version: '5.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        {
          contributionId: 'preview-native',
          tier: 'reactNative',
          platform: 'android',
          repack: { containerName: 'preview_native', modulePath: './renderSurface', exportName: 'renderSurface' },
          entry: 'react-native/preview-native/android.bundle',
          files: [artifactFile('react-native/preview-native/android.bundle')],
          digest: NATIVE_DIGEST,
          builtWith: { bundler: 'repack', version: '5.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        {
          contributionId: 'preview-native',
          tier: 'reactNative',
          platform: 'web',
          entry: 'react-native-web/preview-native/entry.mjs.bundle',
          files: [artifactFile('react-native-web/preview-native/entry.mjs.bundle')],
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

  it('rejects path-only file lists that cannot verify each artifact byte stream', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'preview-native',
        tier: 'reactNative',
        platform: 'web',
        entry: 'react-native-web/preview-native/entry.mjs.bundle',
        files: ['react-native-web/preview-native/entry.mjs.bundle'],
        digest: NATIVE_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
      }],
    }).success).toBe(false);
  });

  it('rejects generated artifact entries that are absent from their verified file set', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'preview-web',
        tier: 'hostedWeb',
        platform: 'web',
        entry: 'hosted-web/preview-web/index.html',
        files: [artifactFile('hosted-web/preview-web/assets/app.js')],
        digest: HOSTED_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: {},
      }],
    }).success).toBe(false);
  });

  it('rejects generated artifact paths that are not portable across host filesystems', () => {
    const baseEntry = {
      contributionId: 'preview-web',
      tier: 'hostedWeb',
      platform: 'web',
      entry: 'hosted-web/preview-web/index.html',
      files: [artifactFile('hosted-web/preview-web/index.html')],
      digest: HOSTED_DIGEST,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: {},
    } as const;
    const unsafePaths = [
      '',
      '/hosted-web/preview-web/index.html',
      'C:/hosted-web/preview-web/index.html',
      String.raw`hosted-web\preview-web\index.html`,
      'hosted-web/../index.html',
      'hosted-web/./index.html',
      'hosted-web//index.html',
      'hosted-web/CON/index.html',
      'hosted-web/CLOCK$/index.html',
      'hosted-web/CONIN$/index.html',
      'hosted-web/CONOUT$/index.html',
      'hosted-web/file./index.html',
      'hosted-web/file /index.html',
      'hosted-web/cafe\u0301/index.html',
    ];

    for (const unsafePath of unsafePaths) {
      expect(
        PluginUiArtifactsManifestV1Schema.safeParse({
          version: 1,
          entries: [{ ...baseEntry, entry: unsafePath }],
        }).success,
        `entry path ${JSON.stringify(unsafePath)}`,
      ).toBe(false);
      expect(
        PluginUiArtifactsManifestV1Schema.safeParse({
          version: 1,
          entries: [{ ...baseEntry, files: [artifactFile(unsafePath)] }],
        }).success,
        `file path ${JSON.stringify(unsafePath)}`,
      ).toBe(false);
    }

    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        ...baseEntry,
        entry: 'hosted-web/café/index.html',
        files: [artifactFile('hosted-web/café/index.html')],
      }],
    }).success).toBe(true);
  });

  it('rejects generated file paths that alias on case-insensitive host filesystems', () => {
    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        contributionId: 'preview-web',
        tier: 'hostedWeb',
        platform: 'web',
        entry: 'hosted-web/preview-web/index.html',
        files: [
          artifactFile('hosted-web/preview-web/index.html'),
          artifactFile('hosted-web/preview-web/INDEX.HTML'),
        ],
        digest: HOSTED_DIGEST,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: {},
      }],
    }).success).toBe(false);

    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [
        {
          contributionId: 'preview-web-upper',
          tier: 'hostedWeb',
          platform: 'web',
          entry: 'hosted-web/Preview/index.html',
          files: [artifactFile('hosted-web/Preview/index.html')],
          digest: HOSTED_DIGEST,
          builtWith: { bundler: 'vite', version: '7.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: {},
        },
        {
          contributionId: 'preview-web-lower',
          tier: 'hostedWeb',
          platform: 'web',
          entry: 'hosted-web/preview/index.html',
          files: [artifactFile('hosted-web/preview/index.html')],
          digest: HOSTED_DIGEST,
          builtWith: { bundler: 'vite', version: '7.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: {},
        },
      ],
    }).success).toBe(false);
  });

  it('rejects duplicate and file-versus-directory artifact paths without rejecting prefix siblings', () => {
    const entry = {
      contributionId: 'preview-web',
      tier: 'hostedWeb',
      platform: 'web',
      entry: 'hosted-web/preview/index.html',
      digest: HOSTED_DIGEST,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: {},
    } as const;

    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        ...entry,
        files: [
          artifactFile('hosted-web/preview/index.html'),
          artifactFile('hosted-web/preview/assets'),
          artifactFile('hosted-web/preview/assets/app.js'),
        ],
      }],
    }).success).toBe(false);

    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [
        {
          ...entry,
          files: [artifactFile('hosted-web/preview/index.html')],
        },
        {
          ...entry,
          contributionId: 'preview-web-duplicate',
          files: [artifactFile('hosted-web/preview/index.html')],
        },
      ],
    }).success).toBe(false);

    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [
        {
          ...entry,
          files: [artifactFile('hosted-web/preview/index.html')],
        },
        {
          ...entry,
          contributionId: 'preview-web-child',
          entry: 'hosted-web/child/index.html',
          files: [
            artifactFile('hosted-web/child/index.html'),
            artifactFile('hosted-web/preview/index.html/source-map.js'),
          ],
        },
      ],
    }).success).toBe(false);

    expect(PluginUiArtifactsManifestV1Schema.safeParse({
      version: 1,
      entries: [{
        ...entry,
        files: [
          artifactFile('hosted-web/preview/index.html'),
          artifactFile('hosted-web/preview/index.html.map'),
        ],
      }],
    }).success).toBe(true);
  });
});
