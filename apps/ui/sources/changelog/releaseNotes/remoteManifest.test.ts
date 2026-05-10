import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAssetIndexForTests } from './assetIndex';
import { resolveAssetUrl } from './assetUrlResolver';
import { resetManifestRuntimeCacheForTests } from './manifestRuntime';
import { resetRemoteManifestForTests, revalidateRemoteManifest } from './remoteManifest';
import * as releaseNotesStorage from './storage';

const storageWithOptionalAssetIndexCache = releaseNotesStorage as typeof releaseNotesStorage & Readonly<{
    clearCachedAssetIndex?: () => void;
}>;

function responseWithText(body: string, ok = true): Response {
    return {
        ok,
        text: async () => body,
    } as Response;
}

const validManifest = JSON.stringify({
    schemaVersion: 'v1',
    latestReleaseId: 'v0.0.0',
    generatedAt: '2026-05-09T00:00:00.000Z',
    assetBaseUrl: 'https://cdn.example/releases/',
    releases: [{
        releaseId: 'v0.0.0',
        versionLabel: 'v0.0.0',
        publishedAt: '2026-05-09T00:00:00.000Z',
        titleKey: 'releaseNotes.v0.title',
        cards: [{
            kind: 'image',
            titleKey: 'releaseNotes.v0.card.title',
            bodyKey: 'releaseNotes.v0.card.body',
            media: { key: 'v0.0.0/hero.webp', altKey: 'releaseNotes.v0.card.alt' },
        }],
    }],
});

const validAssetIndex = JSON.stringify({
    schemaVersion: 'v1',
    generatedAt: '2026-05-09T00:00:00.000Z',
    assetsBaseUrl: 'https://cdn.example/releases/',
    assets: {
        'v0.0.0/hero.webp': {
            assetKey: 'v0.0.0/hero.webp',
            releaseId: 'v0.0.0',
            path: 'v0.0.0/hero.webp',
            fileName: 'release-notes__v0.0.0__hero.webp',
            sha256: 'feedfacecafebeef',
            contentType: 'image/webp',
            sizeBytes: 123,
        },
    },
});

describe('revalidateRemoteManifest', () => {
    beforeEach(() => {
        releaseNotesStorage.clearCachedManifest();
        storageWithOptionalAssetIndexCache.clearCachedAssetIndex?.();
        resetManifestRuntimeCacheForTests();
        resetAssetIndexForTests();
        resetRemoteManifestForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        releaseNotesStorage.clearCachedManifest();
        storageWithOptionalAssetIndexCache.clearCachedAssetIndex?.();
        resetManifestRuntimeCacheForTests();
        resetAssetIndexForTests();
        resetRemoteManifestForTests();
    });

    it('fetches the manifest and asset index with cache busting', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes('release-notes__assets-index.json')) {
                return responseWithText(validAssetIndex);
            }
            return responseWithText(validManifest);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await revalidateRemoteManifest();

        expect(result).toMatchObject({
            manifest: { committed: true },
            assetIndex: { committed: true },
        });
        const fetchedUrls = fetchMock.mock.calls.map(([url]) => String(url));
        expect(fetchedUrls).toHaveLength(2);
        expect(fetchedUrls.some((url) => url.includes('release-notes__manifest.json'))).toBe(true);
        expect(fetchedUrls.some((url) => url.includes('release-notes__assets-index.json'))).toBe(true);
        expect(fetchedUrls.every((url) => url.includes('happierCacheBust='))).toBe(true);
    });

    it('reloads a cached asset index after the in-memory index is reset', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => (
            String(url).includes('release-notes__assets-index.json')
                ? responseWithText(validAssetIndex)
                : responseWithText(validManifest)
        )));

        await revalidateRemoteManifest();
        resetAssetIndexForTests();

        const resolved = resolveAssetUrl('v0.0.0/hero.webp');

        expect(resolved?.primary.uri).toBe(
            'https://cdn.example/releases/release-notes__v0.0.0__hero.webp?v=feedfacecafe',
        );
    });

    it('does not activate a remote manifest without its matching asset index', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => (
            String(url).includes('release-notes__assets-index.json')
                ? responseWithText('not-json')
                : responseWithText(validManifest)
        )));

        const result = await revalidateRemoteManifest();

        expect(result).toMatchObject({
            manifest: { committed: false },
            assetIndex: { committed: false },
        });
    });

    it('does not activate a remote manifest when a valid asset index is stale or mismatched', async () => {
        const staleAssetIndex = JSON.stringify({
            schemaVersion: 'v1',
            generatedAt: '2026-05-09T00:00:00.000Z',
            assetsBaseUrl: 'https://cdn.example/releases/',
            assets: {},
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => (
            String(url).includes('release-notes__assets-index.json')
                ? responseWithText(staleAssetIndex)
                : responseWithText(validManifest)
        )));

        const result = await revalidateRemoteManifest();

        expect(result).toMatchObject({
            manifest: { committed: false },
            assetIndex: { committed: false },
        });
    });
});
