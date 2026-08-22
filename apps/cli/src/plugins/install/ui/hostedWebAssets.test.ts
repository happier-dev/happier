import { describe, expect, it } from 'vitest';

import { resolveHostedWebAssetRuntime } from './hostedWebAssets';

const manifest = {
  version: 1,
  entries: [
    {
      contributionId: 'preview-web',
      tier: 'hostedWeb',
      // `defineHostedWebViteBuildArtifact` (plugin-sdk `ui/hostedWebBuild.ts`) always
      // stamps `platform: 'web'`, and the generated-manifest resolution path binds on it.
      platform: 'web',
      entry: 'hosted-web/preview-web/index.html',
      files: [
        {
          relativePath: 'hosted-web/preview-web/index.html',
          digest: `sha256:${'a'.repeat(64)}`,
          byteSize: 1,
        },
        {
          relativePath: 'hosted-web/preview-web/assets/index.js',
          digest: `sha256:${'b'.repeat(64)}`,
          byteSize: 1,
        },
      ],
      digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      builtWith: { bundler: 'vite', version: '6.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: {},
    },
  ],
} as const;

describe('hosted web installed asset runtime resolution', () => {
  it('resolves installed static assets only when the artifact manifest binds the hosted-web contribution', () => {
    expect(resolveHostedWebAssetRuntime({
      contributionId: 'preview-web',
      runtimeMode: {
        kind: 'installedStaticAssets',
        artifactId: 'artifact-preview-web',
        assetRootId: 'hosted-web/preview-web',
      },
      manifest,
    })).toEqual({
      ok: true,
      artifactId: 'artifact-preview-web',
      assetRootId: 'hosted-web/preview-web',
      entryPath: 'hosted-web/preview-web/index.html',
      files: [
        'hosted-web/preview-web/index.html',
        'hosted-web/preview-web/assets/index.js',
      ],
      digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });
  });

  it('fails closed when registered session endpoints are requested before LSV-3 endpoint projection', () => {
    expect(resolveHostedWebAssetRuntime({
      contributionId: 'preview-web',
      runtimeMode: {
        kind: 'registeredSessionEndpoint',
        endpointIdPath: '/endpoints/preview-web/id',
      },
      manifest,
    })).toEqual({
      ok: false,
      code: 'registered_endpoint_requires_lsv3',
      diagnostics: ['lsv3_endpoint_projection_required'],
    });
  });

  it('rejects missing or non-hosted artifact manifest entries', () => {
    expect(resolveHostedWebAssetRuntime({
      contributionId: 'missing-web',
      runtimeMode: {
        kind: 'installedStaticAssets',
        artifactId: 'artifact-missing',
        assetRootId: 'hosted-web/missing-web',
      },
      manifest,
    })).toEqual({
      ok: false,
      code: 'artifact_entry_missing',
      diagnostics: ['hosted_web_artifact_entry_missing'],
    });
  });

  it('rejects a mismatched Host API version through the generated manifest resolver', () => {
    const incompatibleManifest = {
      ...manifest,
      entries: manifest.entries.map((entry) => ({
        ...entry,
        hostUiApiVersion: '9.9.9',
      })),
    };
    const expected = {
      ok: false,
      code: 'hosted_web_static_artifact_host_api_mismatch',
      diagnostics: ['hosted_web_static_artifact_host_api_mismatch'],
    };

    // `staticAssets/source.ts` builds both fields from the same `artifactId`, so a
    // realistic generated-manifest call carries the identical value in each.
    expect(resolveHostedWebAssetRuntime({
      contributionId: 'preview-web-renderer',
      manifestContributionId: 'preview-web',
      runtimeMode: {
        kind: 'installedStaticAssets',
        artifactId: 'preview-web',
        assetRootId: 'hosted-web/preview-web',
      },
      manifest: incompatibleManifest,
    })).toEqual(expected);
  });

  it('fails closed when the requested asset root does not contain the hosted-web manifest entry', () => {
    expect(resolveHostedWebAssetRuntime({
      contributionId: 'preview-web',
      runtimeMode: {
        kind: 'installedStaticAssets',
        artifactId: 'artifact-preview-web',
        assetRootId: 'hosted-web/other-contribution',
      },
      manifest,
    })).toEqual({
      ok: false,
      code: 'asset_root_mismatch',
      diagnostics: ['hosted_web_asset_root_mismatch'],
    });
  });

});
