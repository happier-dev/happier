import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PluginUiArtifactDigestV1Schema,
    PluginUiArtifactIntegrityBindingV1Schema,
    PluginHostedWebSecurityPolicyV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
} from '@happier-dev/protocol/plugins/ui';

import { startHostedWebStaticAssetServer } from './server';
import {
    createLocalServicePreviewRegistry,
    listLocalServicePreviewResources,
    registerLocalServicePreview,
    unregisterLocalServicePreview,
} from '../../preview/registry';

let root: string;
const DIGEST_WEB = PluginUiArtifactDigestV1Schema.parse(
    `sha256:${'a'.repeat(64)}`,
);
const STATIC_PREVIEW_ID = 'plugin-static:acme.preview:preview-web:session-1:machine-1';

async function writeAsset(relativePath: string, contents: string): Promise<void> {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
}

function requestRawPath(baseUrl: string, path: string): Promise<Readonly<{
    status: number;
    body: string;
}>> {
    const endpoint = new URL(baseUrl);
    return new Promise((resolve, reject) => {
        const request = requestHttp({
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port,
            method: 'GET',
            path,
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.once('error', reject);
            response.once('end', () => {
                resolve(Object.freeze({
                    status: response.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            });
        });
        request.once('error', reject);
        request.end();
    });
}

function serverInput(overrides: Partial<Parameters<typeof startHostedWebStaticAssetServer>[0]> = {}) {
    return {
        installedRoot: root,
        assetRootId: 'hosted-web/preview-web',
        entryPath: 'hosted-web/preview-web/index.html',
        files: [
            'hosted-web/preview-web/index.html',
            'hosted-web/preview-web/assets/index.js',
        ],
        digest: DIGEST_WEB,
        routeMode: 'pathFallback' as const,
        security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
        sourceMaps: { enabled: false },
        revokedDigests: new Set<string>(),
        preview: {
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-1',
            machineId: 'machine-1',
            title: 'Preview web',
        },
        ...overrides,
    };
}

describe('hosted-web static asset server', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-hosted-web-server-'));
        await writeAsset('hosted-web/preview-web/index.html', '<html>preview</html>');
        await writeAsset('hosted-web/preview-web/assets/index.js', 'console.log("preview");');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('serves digest-verified bytes from a loopback ephemeral endpoint with local-service preview metadata', async () => {
        const verifyArtifact = vi.fn(() => ({ ok: true as const }));
        const registerPreview = vi.fn(() => ({ ok: true as const, previewId: STATIC_PREVIEW_ID }));
        const server = await startHostedWebStaticAssetServer({
            ...serverInput(),
            verifyArtifact,
            registerPreview,
        });

        try {
            expect(server.endpoint).toMatchObject({
                scheme: 'http',
                host: '127.0.0.1',
            });
            expect(server.endpoint.port).toBeGreaterThan(0);
            expect(server.previewResource).toMatchObject({
                owner: { kind: 'plugin', id: 'acme.preview' },
                target: {
                    scheme: 'http',
                    host: '127.0.0.1',
                    port: server.endpoint.port,
                },
                initialPath: { pathname: '/' },
            });
            expect(registerPreview).toHaveBeenCalledWith(server.previewResource);
            expect(server.previewRegistration).toEqual({
                ok: true,
                previewId: STATIC_PREVIEW_ID,
            });

            const response = await fetch(`${server.baseUrl}/assets/index.js`);

            expect(response.status).toBe(200);
            expect(await response.text()).toBe('console.log("preview");');
            expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
            expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
            expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; worker-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; block-all-mixed-content");
            expect(response.headers.get('etag')).toBe(`"${DIGEST_WEB}"`);
            expect(verifyArtifact).toHaveBeenCalledWith(expect.objectContaining({
                digest: DIGEST_WEB,
                files: expect.arrayContaining([
                    expect.objectContaining({ relativePath: 'hosted-web/preview-web/index.html' }),
                    expect.objectContaining({ relativePath: 'hosted-web/preview-web/assets/index.js' }),
                ]),
            }));
        } finally {
            await server.stop();
        }
    });

    it('passes the raw HTTP request path to the canonical policy before WHATWG URL normalization', async () => {
        const server = await startHostedWebStaticAssetServer({
            ...serverInput(),
            verifyArtifact: () => ({ ok: true as const }),
        });

        try {
            const response = await requestRawPath(
                server.baseUrl,
                '/assets/%2e%2e/index.html',
            );

            expect(response).toEqual({ status: 400, body: '' });
        } finally {
            await server.stop();
        }
    });

    it('lets the daemon-issued host embed the entry document and refuses every forged ancestor (EU-8)', async () => {
        const server = await startHostedWebStaticAssetServer({
            ...serverInput(),
            verifyArtifact: () => ({ ok: true as const }),
        });

        try {
            // The daemon mints the ancestor token and hands it to the app in the
            // preview access URL. The app is the only party that has it, so the
            // host ancestor cannot be self-declared by whatever page reaches the
            // loopback port.
            const search = new URLSearchParams(server.previewResource.initialPath.search);
            const token = search.get('happierAncestorToken');
            expect(token).toMatch(/^[0-9a-f]{32,}$/u);

            const embedded = await fetch(
                `${server.baseUrl}/?happierAncestorToken=${token}&happierHostOrigin=${encodeURIComponent('https://host.happier.test')}`,
            );
            expect(embedded.headers.get('content-security-policy'))
                .toContain('frame-ancestors https://host.happier.test');

            // Wrong-implementation controls: no token, a wrong token, and a
            // token with a non-exact origin each fall back to refusing every
            // ancestor rather than trusting the query.
            const forged = await fetch(
                `${server.baseUrl}/?happierAncestorToken=${'0'.repeat(32)}&happierHostOrigin=${encodeURIComponent('https://evil.test')}`,
            );
            const unsigned = await fetch(
                `${server.baseUrl}/?happierHostOrigin=${encodeURIComponent('https://evil.test')}`,
            );
            const wildcard = await fetch(
                `${server.baseUrl}/?happierAncestorToken=${token}&happierHostOrigin=${encodeURIComponent('https://*.happier.test')}`,
            );
            for (const response of [forged, unsigned, wildcard]) {
                expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
            }
        } finally {
            await server.stop();
        }
    });

    it('verifies multi-file hosted-web artifacts once and serves every declared file from the verified set', async () => {
        const indexBytes = new TextEncoder().encode('<html>preview</html>');
        const scriptBytes = new TextEncoder().encode('console.log("preview");');
        const digest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: 'hosted-web/preview-web/index.html', bytes: indexBytes },
            { relativePath: 'hosted-web/preview-web/assets/index.js', bytes: scriptBytes },
        ]);
        const server = await startHostedWebStaticAssetServer({
            ...serverInput({ digest }),
            verifyArtifact: (input) => {
                const integrity = PluginUiArtifactIntegrityBindingV1Schema.safeParse({
                    digest: input.digest,
                    pluginId: 'acme.preview',
                    contributionId: 'preview-web',
                    artifactKind: 'hostedWebAsset',
                });
                if (!integrity.success) {
                    return { ok: false as const, reasonCode: 'unsupported_digest' };
                }
                return verifyPluginUiArtifactFileSetIntegrityV1({
                    files: input.files,
                    integrity: integrity.data,
                });
            },
        });

        try {
            await expect(fetch(`${server.baseUrl}/`).then((response) => response.text()))
                .resolves.toBe('<html>preview</html>');
            await expect(fetch(`${server.baseUrl}/assets/index.js`).then((response) => response.text()))
                .resolves.toBe('console.log("preview");');

            await writeAsset('hosted-web/preview-web/assets/index.js', 'console.log("tampered");');

            await expect(fetch(`${server.baseUrl}/assets/index.js`).then((response) => response.text()))
                .resolves.toBe('console.log("preview");');
        } finally {
            await server.stop();
        }
    });

    it('derives CSP and source-map availability from the hosted-web security policy', async () => {
        await writeAsset('hosted-web/preview-web/assets/index.js.map', '{"version":3}');
        const server = await startHostedWebStaticAssetServer({
            ...serverInput({
                files: [
                    'hosted-web/preview-web/index.html',
                    'hosted-web/preview-web/assets/index.js',
                    'hosted-web/preview-web/assets/index.js.map',
                ],
                security: PluginHostedWebSecurityPolicyV1Schema.parse({
                    allowedConnectOrigins: ['https://api.example.test'],
                    allowedCallbackOrigins: ['https://oauth.example.test'],
                    csp: {
                        connectSrc: 'declaredOrigins',
                        allowBlobUrls: true,
                        allowDataUrls: true,
                        allowInlineStyles: true,
                        allowEval: false,
                    },
                    sourceMaps: 'declaredDigestOnly',
                }),
                sourceMaps: { enabled: true, allowedDigests: new Set([DIGEST_WEB]) },
            }),
            verifyArtifact: () => ({ ok: true as const }),
        });

        try {
            const asset = await fetch(`${server.baseUrl}/assets/index.js`);
            const sourceMap = await fetch(`${server.baseUrl}/assets/index.js.map`);

            expect(asset.status).toBe(200);
            expect(asset.headers.get('content-security-policy')).toBe("default-src 'none'; base-uri 'none'; form-action 'self' https://oauth.example.test; frame-ancestors 'none'; object-src 'none'; script-src 'self'; worker-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' https://api.example.test; block-all-mixed-content");
            expect(sourceMap.status).toBe(200);
            expect(await sourceMap.text()).toBe('{"version":3}');
        } finally {
            await server.stop();
        }
    });

    it('fails closed before binding when artifact verification fails and never binds a non-loopback host', async () => {
        await expect(startHostedWebStaticAssetServer({
            ...serverInput(),
            verifyArtifact: () => ({ ok: false as const, reasonCode: 'digest_mismatch' }),
        })).rejects.toThrow(/digest_mismatch/u);

        await expect(startHostedWebStaticAssetServer({
            ...serverInput(),
            host: '0.0.0.0',
            verifyArtifact: () => ({ ok: true as const }),
        })).rejects.toThrow(/loopback/u);
    });

    it('uses the Protocol loopback grammar for bracketed and mapped IPv6 bind hosts', async () => {
        await expect(startHostedWebStaticAssetServer({
            ...serverInput(),
            host: '[::ffff:192.168.1.1]',
            verifyArtifact: () => ({ ok: true as const }),
        })).rejects.toThrow(/loopback/u);

        // Admission happens before the OS bind. A mapped loopback spelling is
        // accepted by policy even on hosts whose Node runtime cannot bind that
        // bracketed URL spelling directly.
        await expect(startHostedWebStaticAssetServer({
            ...serverInput(),
            host: '[::ffff:127.0.0.1]',
            verifyArtifact: () => ({ ok: false as const, reasonCode: 'stop_before_bind' }),
        })).rejects.toThrow(/stop_before_bind/u);
    });

    it('fails closed before binding when artifact verification throws', async () => {
        await expect(startHostedWebStaticAssetServer({
            ...serverInput(),
            verifyArtifact: () => {
                throw new Error('verification backend unavailable');
            },
        })).rejects.toThrow(/verification backend unavailable/u);
    });

    it('closes the loopback server when preview registration fails', async () => {
        let registeredPort: number | null = null;

        await expect(startHostedWebStaticAssetServer({
            ...serverInput(),
            verifyArtifact: () => ({ ok: true as const }),
            registerPreview: (resource) => {
                registeredPort = resource.target.port;
                throw new Error('preview registration unavailable');
            },
        })).rejects.toThrow(/preview registration unavailable/u);

        expect(registeredPort).toEqual(expect.any(Number));
        await expect(fetch(`http://127.0.0.1:${registeredPort}/assets/index.js`)).rejects.toThrow();
    });

    it('unregisters the preview resource from the daemon registry when stopped', async () => {
        const registry = createLocalServicePreviewRegistry();
        const server = await startHostedWebStaticAssetServer({
            ...serverInput(),
            verifyArtifact: () => ({ ok: true as const }),
            registerPreview: (resource) => registerLocalServicePreview(registry, resource),
            unregisterPreview: (previewId: string) => unregisterLocalServicePreview(registry, previewId),
        });

        expect(listLocalServicePreviewResources(registry).map((resource) => resource.previewId)).toEqual([
            STATIC_PREVIEW_ID,
        ]);

        await server.stop();

        expect(listLocalServicePreviewResources(registry)).toEqual([]);
    });
});
