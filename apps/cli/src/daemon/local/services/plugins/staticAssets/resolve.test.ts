import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginHostedWebSecurityPolicyV1Schema } from '@happier-dev/protocol/plugins/ui';

import { resolveHostedWebStaticAssetRequest } from './resolve';

let root: string;

async function writeAsset(relativePath: string, contents: string): Promise<void> {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
}

function baseRequest(overrides: Partial<Parameters<typeof resolveHostedWebStaticAssetRequest>[0]> = {}) {
    return {
        installedRoot: root,
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
        security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
        sourceMaps: { enabled: false },
        requestPath: '/assets/index.js',
        ...overrides,
    };
}

describe('hosted-web static asset resolver', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-hosted-web-assets-'));
        await writeAsset('hosted-web/preview-web/index.html', '<html>preview</html>');
        await writeAsset('hosted-web/preview-web/assets/index.js', 'console.log("preview");');
        await writeAsset('hosted-web/preview-web/assets/index.css', 'body{}');
        await writeAsset('hosted-web/preview-web/assets/index.js.map', '{}');
        await writeAsset('outside.js', 'escape');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('resolves only manifest-declared files inside the declared asset root with deterministic MIME metadata', async () => {
        await expect(resolveHostedWebStaticAssetRequest(baseRequest())).resolves.toMatchObject({
            ok: true,
            relativePath: 'hosted-web/preview-web/assets/index.js',
            contentType: 'text/javascript; charset=utf-8',
            headers: {
                'Cache-Control': 'public, max-age=31536000, immutable',
                'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; navigate-to 'none'; block-all-mixed-content",
                ETag: '"sha256:web"',
                'X-Content-Type-Options': 'nosniff',
            },
        });

        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            requestPath: '/assets/unknown.wasm',
        }))).resolves.toEqual({
            ok: false,
            code: 'asset_not_declared',
            status: 404,
        });
    });

    it('rejects directory listing, unknown MIME types, revoked digests, and source maps unless policy allows them', async () => {
        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            requestPath: '/assets/',
        }))).resolves.toEqual({
            ok: false,
            code: 'directory_listing_disabled',
            status: 404,
        });

        await writeAsset('hosted-web/preview-web/assets/blob.bin', 'bin');
        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            files: [...baseRequest().files, 'hosted-web/preview-web/assets/blob.bin'],
            requestPath: '/assets/blob.bin',
        }))).resolves.toEqual({
            ok: false,
            code: 'mime_type_not_allowed',
            status: 415,
        });

        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            requestPath: '/assets/index.js.map',
        }))).resolves.toEqual({
            ok: false,
            code: 'source_map_unavailable',
            status: 404,
        });

        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            requestPath: '/assets/index.js.map',
            sourceMaps: { enabled: true, allowedDigests: new Set(['sha256:web']) },
        }))).resolves.toMatchObject({
            ok: true,
            relativePath: 'hosted-web/preview-web/assets/index.js.map',
            contentType: 'application/json; charset=utf-8',
        });
    });

    it('applies SPA fallback only for path-fallback roots and rejects symlink escapes by realpath containment', async () => {
        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            requestPath: '/settings/team',
        }))).resolves.toMatchObject({
            ok: true,
            relativePath: 'hosted-web/preview-web/index.html',
            fallback: 'spa',
        });

        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            requestPath: '/settings/team',
            routeMode: 'hostOrigin',
        }))).resolves.toEqual({
            ok: false,
            code: 'asset_not_declared',
            status: 404,
        });

        await symlink(join(root, 'outside.js'), join(root, 'hosted-web/preview-web/assets/escape.js'));
        await expect(resolveHostedWebStaticAssetRequest(baseRequest({
            files: [...baseRequest().files, 'hosted-web/preview-web/assets/escape.js'],
            requestPath: '/assets/escape.js',
        }))).resolves.toEqual({
            ok: false,
            code: 'asset_root_escape',
            status: 403,
        });
    });
});
