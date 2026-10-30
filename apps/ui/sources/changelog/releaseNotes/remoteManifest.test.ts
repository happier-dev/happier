import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commitRemoteAssetIndex, getAssetIndex, resetAssetIndexForTests } from './assetIndex';
import { resolveAssetUrl } from './assetUrlResolver';
import { commitRemoteManifest, getActiveManifest, resetManifestRuntimeCacheForTests } from './manifestRuntime';
import { parseReleaseNotesAssetIndex, parseReleaseNotesManifest } from './schema';
import { resetRemoteManifestForTests, revalidateRemoteManifest } from './remoteManifest';
import * as releaseNotesStorage from './storage';

function responseWithText(body: string, ok = true): Response {
    return new Response(body, { status: ok ? 200 : 503 });
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

const nextManifest = validManifest.replaceAll('v0.0.0', 'v0.0.1');

function expectLastGoodPair(): void {
    expect(getActiveManifest()).toEqual(JSON.parse(validManifest));
    expect(getAssetIndex()).toEqual(JSON.parse(validAssetIndex));
    expect(releaseNotesStorage.getCachedManifestRaw()).toBe(validManifest);
    expect(releaseNotesStorage.getCachedAssetIndexRaw()).toBe(validAssetIndex);
}

function seedLastGoodPair(): void {
    expect(commitRemoteManifest(validManifest)).not.toBeNull();
    expect(commitRemoteAssetIndex(validAssetIndex)).not.toBeNull();
    expectLastGoodPair();
    // A valid next manifest must be refused only because its index is unavailable/mismatched.
    expect(parseReleaseNotesManifest(JSON.parse(nextManifest))).not.toBeNull();
}

describe('revalidateRemoteManifest', () => {
    beforeEach(() => {
        releaseNotesStorage.clearCachedManifest();
        releaseNotesStorage.clearCachedAssetIndex();
        resetManifestRuntimeCacheForTests();
        resetAssetIndexForTests();
        resetRemoteManifestForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        releaseNotesStorage.clearCachedManifest();
        releaseNotesStorage.clearCachedAssetIndex();
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
        expectLastGoodPair();
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
        seedLastGoodPair();
        vi.stubGlobal('fetch', vi.fn(async (url: string) => (
            String(url).includes('release-notes__assets-index.json')
                ? responseWithText('not-json')
                : responseWithText(nextManifest)
        )));

        const result = await revalidateRemoteManifest();

        expect(result).toMatchObject({
            manifest: { committed: false },
            assetIndex: { committed: false },
        });
        expectLastGoodPair();
        resetManifestRuntimeCacheForTests();
        resetAssetIndexForTests();
        expectLastGoodPair();
    });

    it('does not activate a remote manifest when a valid asset index is stale or mismatched', async () => {
        const emptyAssetIndex = JSON.stringify({
            schemaVersion: 'v1',
            generatedAt: '2026-05-09T00:00:00.000Z',
            assetsBaseUrl: 'https://cdn.example/releases/',
            assets: {},
        });
        // Preserve both the valid-empty boundary and an older nonempty index.
        for (const assetIndex of [emptyAssetIndex, validAssetIndex]) {
            resetRemoteManifestForTests();
            seedLastGoodPair();
            expect(parseReleaseNotesAssetIndex(JSON.parse(assetIndex))).not.toBeNull();
            vi.stubGlobal('fetch', vi.fn(async (url: string) => (
                String(url).includes('release-notes__assets-index.json')
                    ? responseWithText(assetIndex)
                    : responseWithText(nextManifest)
            )));

            const result = await revalidateRemoteManifest();

            expect(result).toMatchObject({
                manifest: { committed: false },
                assetIndex: { committed: false },
            });
            expectLastGoodPair();
            resetManifestRuntimeCacheForTests();
            resetAssetIndexForTests();
            expectLastGoodPair();
        }
    });
});
