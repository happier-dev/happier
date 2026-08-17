import { describe, expect, it } from 'vitest';

import { PluginHostedWebSecurityPolicyV1Schema } from '../contributions/ui/hostedWebSecurity.js';
import {
  createHostedWebAssetNativePolicyConformanceVectorsV1,
  createHostedWebAssetNativePolicyTableV1,
  resolveHostedWebAssetNativePolicyRequestV1,
} from './hostedWebAssetPolicyNative.js';

const security = PluginHostedWebSecurityPolicyV1Schema.parse({});

function baseInput(
  overrides: Partial<Parameters<typeof createHostedWebAssetNativePolicyTableV1>[0]> = {},
) {
  return {
    assetRootId: 'hosted-web/preview-web',
    entryPath: 'hosted-web/preview-web/index.html',
    files: [
      'hosted-web/preview-web/index.html',
      'hosted-web/preview-web/assets/index.js',
      'hosted-web/preview-web/assets/index.css',
      'hosted-web/preview-web/assets/index.js.map',
      'hosted-web/preview-web/assets/blob.bin',
    ],
    digest: 'sha256:web',
    routeMode: 'pathFallback' as const,
    requestPath: '/assets/index.js',
    security,
    sourceMaps: { enabled: false },
    ...overrides,
  };
}

describe('hosted web native asset policy table', () => {
  it('derives a JSON-safe opaque-resource table from the canonical policy without exposing artifact paths', () => {
    const built = createHostedWebAssetNativePolicyTableV1(baseInput({
      frameAncestors: ['https://app.happier.test'],
    }));

    expect(built).toMatchObject({ ok: true });
    if (!built.ok) throw new Error('expected a renderable native asset policy table');

    expect(built.table).toMatchObject({
      version: 1,
      pathFallback: expect.objectContaining({
        resourceId: expect.any(String),
        contentType: 'text/html; charset=utf-8',
      }),
    });
    expect(built.table.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'assets/index.js',
        outcome: expect.objectContaining({
          kind: 'content',
          contentType: 'text/javascript; charset=utf-8',
          headers: expect.objectContaining({
            'Cache-Control': 'public, max-age=31536000, immutable',
            ETag: '"sha256:web"',
            'X-Content-Type-Options': 'nosniff',
          }),
        }),
      }),
      expect.objectContaining({
        path: 'assets/index.js.map',
        outcome: {
          kind: 'rejected',
          code: 'source_map_unavailable',
          status: 404,
        },
      }),
      expect.objectContaining({
        path: 'assets/blob.bin',
        outcome: {
          kind: 'rejected',
          code: 'mime_type_not_allowed',
          status: 415,
        },
      }),
    ]));
    expect(built.resourceBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'hosted-web/preview-web/index.html' }),
      expect.objectContaining({ relativePath: 'hosted-web/preview-web/assets/index.js' }),
    ]));
    expect(JSON.stringify(built.table)).not.toContain('hosted-web/preview-web');
    expect(JSON.stringify(built.table)).not.toContain('relativePath');
  });

  it('is a generic fail-closed interpreter for normalized request paths, exact responses, and SPA fallback', () => {
    const built = createHostedWebAssetNativePolicyTableV1(baseInput({
      frameAncestors: ['https://app.happier.test'],
    }));
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) throw new Error('expected a renderable native asset policy table');

    const exact = resolveHostedWebAssetNativePolicyRequestV1(built.table, '/assets//index.js?cache=bust');
    expect(exact).toMatchObject({
      kind: 'content',
      contentType: 'text/javascript; charset=utf-8',
      headers: {
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://app.happier.test; object-src 'none'; script-src 'self'; worker-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; block-all-mixed-content",
      },
    });
    expect(resolveHostedWebAssetNativePolicyRequestV1(built.table, '/settings/team')).toMatchObject({
      kind: 'content',
      fallback: 'spa',
      contentType: 'text/html; charset=utf-8',
    });
    expect(resolveHostedWebAssetNativePolicyRequestV1(built.table, '/%2e%2e/outside.js')).toEqual({
      kind: 'rejected',
      code: 'invalid_request_path',
      status: 400,
    });
    expect(resolveHostedWebAssetNativePolicyRequestV1(built.table, '/assets/index.js.map')).toEqual({
      kind: 'rejected',
      code: 'source_map_unavailable',
      status: 404,
    });
    expect(resolveHostedWebAssetNativePolicyRequestV1(built.table, '/assets/blob.bin')).toEqual({
      kind: 'rejected',
      code: 'mime_type_not_allowed',
      status: 415,
    });
    expect(resolveHostedWebAssetNativePolicyRequestV1(built.table, '/assets/unknown.js')).toEqual({
      kind: 'rejected',
      code: 'asset_not_declared',
      status: 404,
    });
    expect(resolveHostedWebAssetNativePolicyRequestV1(built.table, '/directory/')).toEqual({
      kind: 'rejected',
      code: 'directory_listing_disabled',
      status: 404,
    });
  });

  it('rejects encoded traversal and Windows-shaped paths before a native handler can interpret them', () => {
    const built = createHostedWebAssetNativePolicyTableV1(baseInput());
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) throw new Error('expected a renderable native asset policy table');

    for (const requestPath of [
      '/assets/%2e%2e/index.html',
      '/assets/.%2E/index.html',
      '/assets%2f..%2findex.html',
      '/C:/Windows/system32',
      '/%2fserver/share/index.html',
      '/assets\\\\server\\share/index.html',
    ]) {
      expect(resolveHostedWebAssetNativePolicyRequestV1(built.table, requestPath)).toEqual({
        kind: 'rejected',
        code: 'invalid_request_path',
        status: 400,
      });
    }

    expect(createHostedWebAssetNativePolicyTableV1(baseInput({
      assetRootId: 'C:\\hosted-web',
      entryPath: 'C:\\hosted-web/index.html',
      files: ['C:\\hosted-web/index.html'],
    }))).toEqual({
      ok: false,
      code: 'invalid_request_path',
      status: 400,
    });
  });

  it('refuses to serialize a policy whose entry cannot be served', () => {
    expect(createHostedWebAssetNativePolicyTableV1(baseInput({
      entryPath: 'other-root/index.html',
      files: ['other-root/index.html'],
    }))).toEqual({
      ok: false,
      code: 'invalid_request_path',
      status: 400,
    });
  });

  it('emits shared conformance vectors for native handlers without exposing private bindings', () => {
    const built = createHostedWebAssetNativePolicyTableV1(baseInput());
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) throw new Error('expected a renderable native asset policy table');

    expect(createHostedWebAssetNativePolicyConformanceVectorsV1(built.table, [
      { name: 'exact', requestPath: '/assets/index.js' },
      { name: 'fallback', requestPath: '/settings/team' },
      { name: 'traversal', requestPath: '/%2e%2e/outside.js' },
      { name: 'unsupported mime', requestPath: '/assets/blob.bin' },
    ])).toEqual([
      expect.objectContaining({
        name: 'exact',
        outcome: expect.objectContaining({ kind: 'content' }),
      }),
      expect.objectContaining({
        name: 'fallback',
        outcome: expect.objectContaining({ kind: 'content', fallback: 'spa' }),
      }),
      {
        name: 'traversal',
        requestPath: '/%2e%2e/outside.js',
        outcome: { kind: 'rejected', code: 'invalid_request_path', status: 400 },
      },
      {
        name: 'unsupported mime',
        requestPath: '/assets/blob.bin',
        outcome: { kind: 'rejected', code: 'mime_type_not_allowed', status: 415 },
      },
    ]);
  });
});
