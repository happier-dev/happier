import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from './normalize';

describe('readCanonicalPluginManifest embedded web bundles', () => {
  it('preserves embedded web bundle contributions from v2 manifests', () => {
    const manifest = readCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'acme.embedded',
      version: '1.0.0',
      displayName: 'Acme Embedded UI',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './daemon.mjs' },
      permissions: { required: [], optional: [] },
      contributes: {
        embeddedWebBundles: [{
          id: 'embedded-preview',
          bundle: {
            platform: 'web',
            channel: 'internal',
            assetPath: 'embedded-web/embedded-preview/entry.mjs',
            integrity: { digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
          },
          entry: { mechanism: 'hostRuntimeFactoryV1' },
          compatibility: {
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            hostAppVersion: '2.0.0',
            supportedPlatforms: ['web'],
            supportedChannels: ['internal'],
          },
          hostApi: { minVersion: '1.0.0', methods: ['surface.read'] },
          fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
          display: {
            titleKey: 'title',
            iconToken: 'browser',
          },
        }],
      },
    });

    expect(manifest?.contributes.embeddedWebBundles?.[0]).toMatchObject({
      id: 'embedded-preview',
      entry: { mechanism: 'hostRuntimeFactoryV1' },
      bundle: {
        platform: 'web',
        assetPath: 'embedded-web/embedded-preview/entry.mjs',
        integrity: { digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
      fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
    });
  });
});
