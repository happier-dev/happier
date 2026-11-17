import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PluginHostedWebSecurityPolicyV1Schema,
    PluginUiArtifactsManifestV2Schema,
} from '@happier-dev/protocol/plugins/ui';

import { createHostedWebStaticAssetLifecycle } from './lifecycle';
import { logger } from '@/ui/logger';
import {
    createLocalServicePreviewRegistry,
    listLocalServicePreviewResources,
    registerLocalServicePreview,
    unregisterLocalServicePreview,
} from '../../preview/registry';

let root: string;
const DIGEST_WEB = `sha256:${'a'.repeat(64)}`;
const DIGEST_WEB_V2 = `sha256:${'b'.repeat(64)}`;
const INDEX_HTML = '<html>preview</html>';
const INDEX_JS = 'globalThis.previewLoaded = true;';

async function writeAsset(relativePath: string, contents: string): Promise<void> {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
}

function manifestFile(relativePath: string, contents: string) {
    return {
        relativePath,
        digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
        byteSize: new TextEncoder().encode(contents).byteLength,
    };
}

function manifest(digest = DIGEST_WEB) {
    return PluginUiArtifactsManifestV2Schema.parse({
        version: 2,
        entries: [{
            artifactId: 'preview-web',
            tier: 'hostedWeb',
            entry: 'hosted-web/preview-web/index.html',
            files: [
                manifestFile('hosted-web/preview-web/index.html', INDEX_HTML),
                manifestFile('hosted-web/preview-web/assets/index.js', INDEX_JS),
            ],
            digest,
            builtWith: { staging: 'staticDirectory' },
            hostUiApiRange: `^${PLUGIN_UI_HOST_API_VERSION_V1}`,
        }],
    });
}

function contribution(overrides: Partial<Parameters<ReturnType<typeof createHostedWebStaticAssetLifecycle>['sync']>[0][number]> = {}) {
    return {
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        sessionId: 'session-1',
        machineId: 'machine-1',
        title: 'Preview web',
        installedRoot: root,
        runtimeMode: {
            kind: 'installedStaticAssets' as const,
            artifactId: 'preview-web',
            assetRootId: 'hosted-web/preview-web',
        },
        artifactManifest: manifest(),
        routeMode: 'pathFallback' as const,
        security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
        sourceMaps: { enabled: false },
        ...overrides,
    };
}

const artifact = {
    id: 'hosted-web-preview',
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    contributionFamily: 'hostedWeb',
    artifactKind: 'hostedWebAsset',
    platform: 'web',
    channel: 'internal',
    integrity: { digest: DIGEST_WEB },
    compatibility: {
        hostAppVersion: '1.0.0',
        hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
        reactVersion: '19.0.0',
        nativeCapabilities: [],
    },
    byteSize: 2048,
    contentType: 'text/html',
} as const;

describe('hosted-web static asset lifecycle', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-hosted-web-lifecycle-'));
        await writeAsset('hosted-web/preview-web/index.html', INDEX_HTML);
        await writeAsset('hosted-web/preview-web/assets/index.js', INDEX_JS);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it.each(['start', 'stop'] as const)('retains %s publication failure causes while keeping existing lifecycle diagnostics', async phase => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const failure = Object.assign(new Error('private preview publication text'), { code: 'ECONNREFUSED' });
        const lifecycle = createHostedWebStaticAssetLifecycle({
            // Preview publication/unpublication is a remote server IO boundary.
            registerPreview: async () => { if (phase === 'start') throw failure; },
            unregisterPreview: async () => { if (phase === 'stop') throw failure; },
            verifyArtifact: () => ({ ok: true as const }),
        });
        try {
            await lifecycle.sync([contribution()]);
            if (phase === 'stop') await lifecycle.stop();
            expect(lifecycle.snapshot()).toMatchObject({ active: [], diagnostics: [{ code: `static_asset_server_${phase}_failed` }] });
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: `static_assets.${phase}`, errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null,
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private preview publication text');
        } finally { await lifecycle.stop(); }
    });

    it('starts installed static assets through the daemon preview registry and reuses unchanged servers', async () => {
        const registry = createLocalServicePreviewRegistry();
        const verifyArtifact = vi.fn(() => ({ ok: true as const }));
        const lifecycle = createHostedWebStaticAssetLifecycle({
            registerPreview: (resource) => registerLocalServicePreview(registry, resource),
            unregisterPreview: (previewId) => unregisterLocalServicePreview(registry, previewId),
            verifyArtifact,
        });

        const first = await lifecycle.sync([contribution()]);
        const second = await lifecycle.sync([contribution()]);

        expect(first.diagnostics).toEqual([]);
        expect(first.active).toHaveLength(1);
        expect(second.active).toHaveLength(1);
        expect(second.active[0]?.baseUrl).toBe(first.active[0]?.baseUrl);
        expect(listLocalServicePreviewResources(registry)).toEqual([
            expect.objectContaining({
                previewId: 'plugin-static:acme.preview:preview-web:session-1:machine-1',
                owner: { kind: 'plugin', id: 'acme.preview' },
                machineId: 'machine-1',
                sessionId: 'session-1',
                originMode: 'host',
            }),
        ]);

        const response = await fetch(`${first.active[0]?.baseUrl}/assets/index.js`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('globalThis.previewLoaded = true;');
        expect(verifyArtifact).toHaveBeenCalledWith(expect.objectContaining({
            digest: DIGEST_WEB,
            files: expect.arrayContaining([
                expect.objectContaining({ relativePath: 'hosted-web/preview-web/index.html' }),
                expect.objectContaining({ relativePath: 'hosted-web/preview-web/assets/index.js' }),
            ]),
        }));

        await lifecycle.stop();
        expect(listLocalServicePreviewResources(registry)).toEqual([]);
    });

    it('keeps hosted-web static preview identities isolated across sessions for the same plugin surface', async () => {
        const registry = createLocalServicePreviewRegistry();
        const lifecycle = createHostedWebStaticAssetLifecycle({
            registerPreview: (resource) => registerLocalServicePreview(registry, resource),
            unregisterPreview: (previewId) => unregisterLocalServicePreview(registry, previewId),
            verifyArtifact: () => ({ ok: true as const }),
        });

        const result = await lifecycle.sync([
            contribution({ sessionId: 'session-1', machineId: 'machine-1' }),
            contribution({ sessionId: 'session-2', machineId: 'machine-1' }),
        ]);

        expect(result.active).toHaveLength(2);
        expect(new Set(result.active.map((active) => active.previewId)).size).toBe(2);
        expect(listLocalServicePreviewResources(registry)).toEqual(expect.arrayContaining([
            expect.objectContaining({ sessionId: 'session-1', machineId: 'machine-1' }),
            expect.objectContaining({ sessionId: 'session-2', machineId: 'machine-1' }),
        ]));

        await lifecycle.stop();
        expect(listLocalServicePreviewResources(registry)).toEqual([]);
    });

    it('restarts changed contributions and unregisters removed contributions', async () => {
        const registry = createLocalServicePreviewRegistry();
        const lifecycle = createHostedWebStaticAssetLifecycle({
            registerPreview: (resource) => registerLocalServicePreview(registry, resource),
            unregisterPreview: (previewId) => unregisterLocalServicePreview(registry, previewId),
            verifyArtifact: () => ({ ok: true as const }),
        });

        const first = await lifecycle.sync([contribution()]);
        const changed = await lifecycle.sync([
            contribution({
                title: 'Preview web v2',
                artifactManifest: manifest(DIGEST_WEB_V2),
            }),
        ]);

        expect(changed.active).toHaveLength(1);
        expect(changed.active[0]?.baseUrl).not.toBe(first.active[0]?.baseUrl);
        expect(listLocalServicePreviewResources(registry)[0]).toMatchObject({
            display: { title: 'Preview web v2' },
        });

        const removed = await lifecycle.sync([]);

        expect(removed.active).toEqual([]);
        expect(listLocalServicePreviewResources(registry)).toEqual([]);

        await lifecycle.stop();
    });

    it('fails closed when runtime resolution fails or duplicate preview identities are provided', async () => {
        const registry = createLocalServicePreviewRegistry();
        const lifecycle = createHostedWebStaticAssetLifecycle({
            registerPreview: (resource) => registerLocalServicePreview(registry, resource),
            unregisterPreview: (previewId) => unregisterLocalServicePreview(registry, previewId),
            verifyArtifact: () => ({ ok: true as const }),
        });

        const result = await lifecycle.sync([
            contribution({ artifactManifest: { version: 2, entries: [] } }),
            contribution(),
            contribution({ title: 'Duplicate preview' }),
        ]);

        expect(result.active).toHaveLength(1);
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'artifact_entry_missing',
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
            }),
            expect.objectContaining({
                code: 'duplicate_static_asset_preview_identity',
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
            }),
        ]));
        expect(listLocalServicePreviewResources(registry)).toHaveLength(1);

        await lifecycle.stop();
    });

});
