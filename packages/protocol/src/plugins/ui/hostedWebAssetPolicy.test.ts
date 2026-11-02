import { describe, expect, it } from 'vitest';

import { PluginHostedWebSecurityPolicyV1Schema } from '../contributions/ui/hostedWebSecurity.js';
import {
  EPHEMERAL_HOSTED_WEB_ASSET_DELIVERY_HEADERS_V1,
  deriveGeneratedHostedWebAssetPolicyV1,
  resolveHostedWebAssetPolicy,
} from './hostedWebAssetPolicy.js';

const security = PluginHostedWebSecurityPolicyV1Schema.parse({});

function baseInput(
  overrides: Partial<Parameters<typeof resolveHostedWebAssetPolicy>[0]> = {},
) {
  return {
    assetRootId: 'hosted-web/preview-web',
    entryPath: 'hosted-web/preview-web/index.html',
    files: [
      'hosted-web/preview-web/index.html',
      'hosted-web/preview-web/assets/index.js',
      'hosted-web/preview-web/assets/index.css',
      'hosted-web/preview-web/assets/index.js.map',
    ],
    digest: 'sha256:web',
    routeMode: 'pathFallback' as const,
    requestPath: '/assets/index.js',
    security,
    sourceMaps: { enabled: false },
    ...overrides,
  };
}

describe('hosted web asset policy', () => {
  it('derives the sole generated-V2 profile from the verified Artifact graph', () => {
    const graph = {
      artifactId: 'panel',
      tier: 'hostedWeb' as const,
      entry: 'hosted-web/panel/index.html',
      files: [
        {
          relativePath: 'hosted-web/panel/index.html',
          digest: `sha256:${'a'.repeat(64)}`,
          byteSize: 1,
        },
        {
          relativePath: 'hosted-web/panel/assets/app.js',
          digest: `sha256:${'b'.repeat(64)}`,
          byteSize: 2,
        },
      ],
      digest: `sha256:${'c'.repeat(64)}`,
      builtWith: { staging: 'staticDirectory' as const },
      hostUiApiRange: '^1.0.0',
    };

    expect(deriveGeneratedHostedWebAssetPolicyV1(graph)).toMatchObject({
      profile: 'generatedV2',
      assetRootId: 'hosted-web/panel',
      entryPath: 'hosted-web/panel/index.html',
      files: graph.files.map((file) => file.relativePath),
      digest: graph.digest,
      routeMode: 'pathFallback',
      sourceMaps: { enabled: false },
      security: security,
    });
    expect(
      deriveGeneratedHostedWebAssetPolicyV1({
        ...graph,
        files: [
          ...graph.files,
          {
            relativePath: 'outside-root/escape.js',
            digest: `sha256:${'d'.repeat(64)}`,
            byteSize: 1,
          },
        ],
      }),
    ).toBeNull();
  });

  it('owns declared-file routing, MIME, and immutable security/cache headers without filesystem facts', () => {
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({
          frameAncestors: ['https://app.happier.test'],
        }),
      ),
    ).toMatchObject({
      ok: true,
      assetRootId: 'hosted-web/preview-web',
      relativePath: 'hosted-web/preview-web/assets/index.js',
      contentType: 'text/javascript; charset=utf-8',
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy':
          "frame-ancestors https://app.happier.test; block-all-mixed-content",
        ETag: '"sha256:web"',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  it('uses non-persistent, non-referring headers for an expiring browser capability', () => {
    expect(EPHEMERAL_HOSTED_WEB_ASSET_DELIVERY_HEADERS_V1).toEqual({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    const result = resolveHostedWebAssetPolicy(
      baseInput({
        delivery: 'ephemeralCapability',
        frameAncestors: ['https://app.happier.test'],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': expect.stringContaining(
          'frame-ancestors https://app.happier.test',
        ),
        'X-Content-Type-Options': 'nosniff',
      },
    });
    if (!result.ok)
      throw new Error('Expected browser capability delivery policy');
    expect(result.headers).toEqual(
      expect.objectContaining(EPHEMERAL_HOSTED_WEB_ASSET_DELIVERY_HEADERS_V1),
    );
    expect(result.headers).not.toHaveProperty('ETag');
  });

  it('fails closed for malformed paths, undeclared files, and unsupported MIME', () => {
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({
          assetRootId: 'hosted-web/preview-web',
          entryPath: 'other-root/index.html',
          files: ['other-root/index.html'],
          requestPath: '/',
        }),
      ),
    ).toEqual({
      ok: false,
      code: 'invalid_request_path',
      status: 400,
    });
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({ requestPath: '/%2e%2e/outside.js' }),
      ),
    ).toEqual({
      ok: false,
      code: 'invalid_request_path',
      status: 400,
    });
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({ requestPath: '/assets/unknown.js' }),
      ),
    ).toEqual({
      ok: false,
      code: 'asset_not_declared',
      status: 404,
    });
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({
          files: [
            ...baseInput().files,
            'hosted-web/preview-web/assets/blob.bin',
          ],
          requestPath: '/assets/blob.bin',
        }),
      ),
    ).toEqual({
      ok: false,
      code: 'mime_type_not_allowed',
      status: 415,
    });
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({ requestPath: '/assets/index.js.map' }),
      ),
    ).toEqual({
      ok: true,
      relativePath: 'hosted-web/preview-web/assets/index.js.map',
      contentType: 'application/json; charset=utf-8',
      assetRootId: 'hosted-web/preview-web',
      fallback: undefined,
      headers: expect.any(Object),
    });
  });

  it('serves declared source maps without a plugin policy gate and applies path fallback only to extensionless routes', () => {
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({
          requestPath: '/assets/index.js.map',
          sourceMaps: {
            enabled: true,
            allowedDigests: new Set(['sha256:web']),
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      relativePath: 'hosted-web/preview-web/assets/index.js.map',
      contentType: 'application/json; charset=utf-8',
    });
    expect(
      resolveHostedWebAssetPolicy(baseInput({ requestPath: '/settings/team' })),
    ).toMatchObject({
      ok: true,
      relativePath: 'hosted-web/preview-web/index.html',
      fallback: 'spa',
    });
    expect(
      resolveHostedWebAssetPolicy(
        baseInput({ requestPath: '/settings/team.js' }),
      ),
    ).toEqual({
      ok: false,
      code: 'asset_not_declared',
      status: 404,
    });
  });
});
