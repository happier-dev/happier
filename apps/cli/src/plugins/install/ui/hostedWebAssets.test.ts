import { describe, expect, it } from 'vitest';

import { resolveHostedWebAssetRuntime } from './hostedWebAssets';
import { createPluginUiArtifactRevocationState } from './revocation';

const manifest = {
  version: 1,
  entries: [
    {
      contributionId: 'preview-web',
      tier: 'hostedWeb',
      entry: 'hosted-web/preview-web/index.html',
      files: [
        'hosted-web/preview-web/index.html',
        'hosted-web/preview-web/assets/index.js',
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

const revocableArtifact = {
  ...artifact,
  integrity: {
    ...artifact.integrity,
    signingKeyId: 'web-key-1',
  },
  installSourceId: 'marketplace:acme',
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

  it('requires hosted-web artifact integrity and revocation validation when installed artifact metadata is provided', () => {
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
      revokedDigests: new Set(),
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
      revokedDigests: new Set(['sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff']),
    })).toEqual({
      ok: false,
      code: 'artifact_revoked',
      diagnostics: ['hosted_web_artifact_revoked'],
    });
  });

  it('rejects signing-key scoped revocations for installed hosted-web artifacts', () => {
    const resolutionInput = {
      contributionId: 'preview-web',
      pluginId: 'acme.preview',
      runtimeMode: {
        kind: 'installedStaticAssets' as const,
        artifactId: 'artifact-preview-web',
        assetRootId: 'hosted-web/preview-web',
      },
      manifest,
      artifact: revocableArtifact,
      revokedDigests: new Set<string>(),
      revocationState: createPluginUiArtifactRevocationState({
        revocations: [{
          id: 'revoke-web-signing-key',
          scope: { kind: 'signingKey', signingKeyId: 'web-key-1' },
          reason: 'compromised',
          revokedAt: '2026-06-20T00:00:00.000Z',
        }],
      }),
    };

    expect(resolveHostedWebAssetRuntime(resolutionInput)).toEqual({
      ok: false,
      code: 'artifact_revoked',
      diagnostics: ['hosted_web_artifact_revoked'],
    });
  });

  it('rejects install-source scoped revocations for installed hosted-web artifacts', () => {
    const resolutionInput = {
      contributionId: 'preview-web',
      pluginId: 'acme.preview',
      runtimeMode: {
        kind: 'installedStaticAssets' as const,
        artifactId: 'artifact-preview-web',
        assetRootId: 'hosted-web/preview-web',
      },
      manifest,
      artifact: revocableArtifact,
      revokedDigests: new Set<string>(),
      revocationState: createPluginUiArtifactRevocationState({
        revocations: [{
          id: 'revoke-web-install-source',
          scope: { kind: 'installSource', sourceId: 'marketplace:acme' },
          reason: 'policy_denied',
          revokedAt: '2026-06-21T00:00:00.000Z',
        }],
      }),
    };

    expect(resolveHostedWebAssetRuntime(resolutionInput)).toEqual({
      ok: false,
      code: 'artifact_revoked',
      diagnostics: ['hosted_web_artifact_revoked'],
    });
  });
});
