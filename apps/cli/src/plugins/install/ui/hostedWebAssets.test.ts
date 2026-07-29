import { describe, expect, it } from 'vitest';

import { resolveHostedWebAssetRuntime } from './hostedWebAssets';

const manifest = {
  version: 1,
  entries: [
    {
      contributionId: 'preview-web',
      tier: 'hostedWeb',
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
      compat: { react: '19.0.0' },
    },
  ],
} as const;

const artifact = {
  id: 'artifact-preview-web',
  pluginId: 'acme.preview',
  contributionId: 'preview-web',
  contributionFamily: 'hostedWeb',
  artifactKind: 'hostedWebAsset',
  platform: 'web',
  channel: 'internal',
  integrity: { digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
  compatibility: {
    hostAppVersion: '1.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    nativeCapabilities: [],
  },
  byteSize: 2048,
  contentType: 'text/html',
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

  it('fails closed when managed services are requested before LSV-2 runtime resolution', () => {
    expect(resolveHostedWebAssetRuntime({
      contributionId: 'preview-web',
      runtimeMode: {
        kind: 'managedLocalService',
        localServiceId: 'preview-dev-server',
      },
      manifest,
    })).toEqual({
      ok: false,
      code: 'managed_service_requires_lsv2',
      diagnostics: ['lsv2_runtime_required'],
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

  it('requires hosted-web artifact integrity when installed artifact metadata is provided', () => {
    expect(resolveHostedWebAssetRuntime({
      contributionId: 'preview-web',
      pluginId: 'acme.preview',
      runtimeMode: {
        kind: 'installedStaticAssets',
        artifactId: 'artifact-preview-web',
        assetRootId: 'hosted-web/preview-web',
      },
      manifest,
      artifact,
    })).toMatchObject({
      ok: true,
      artifactId: 'artifact-preview-web',
      cacheKey: expect.stringContaining('acme.preview:preview-web:hostedWebAsset:web:internal:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
      integrity: {
        digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        artifactKind: 'hostedWebAsset',
      },
    });

  });
});
