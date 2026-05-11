import { describe, expect, it } from 'vitest';

import {
    collectReleaseNotesManifestMediaKeys,
    doesAssetIndexCoverReleaseNotesManifest,
    findMissingReleaseNotesAssetKeys,
} from './manifestAssetCoverage';
import type { ReleaseNotesAssetIndex, ReleaseNotesManifest } from './types';

const manifest: ReleaseNotesManifest = {
    schemaVersion: 'v1',
    latestReleaseId: 'v1.0.0',
    generatedAt: '2026-05-09T00:00:00.000Z',
    assetBaseUrl: 'https://example.com/',
    releases: [{
        releaseId: 'v1.0.0',
        versionLabel: 'v1.0.0',
        publishedAt: '2026-05-09T00:00:00.000Z',
        titleKey: 'releaseNotes.v1.title',
        cards: [{
            kind: 'image',
            titleKey: 'releaseNotes.v1.hero.title',
            bodyKey: 'releaseNotes.v1.hero.body',
            media: {
                localAssetKey: 'release-v1-hero',
                key: 'hero-remote.webp',
                altKey: 'releaseNotes.v1.hero.alt',
                desktop: {
                    key: 'hero-desktop.webp',
                },
            },
        }, {
            kind: 'video',
            titleKey: 'releaseNotes.v1.video.title',
            bodyKey: 'releaseNotes.v1.video.body',
            media: {
                key: 'v1.0.0/demo.mp4',
                localPosterAssetKey: 'release-v1-video-poster',
                accessibilityLabelKey: 'releaseNotes.v1.video.label',
                mobile: {
                    key: 'demo-mobile.mp4',
                    posterKey: 'demo-mobile-poster.webp',
                },
                desktop: {
                    key: 'demo-desktop.mp4',
                    posterKey: 'demo-desktop-poster.webp',
                },
            },
        }],
    }],
};

function assetIndexFor(keys: string[]): ReleaseNotesAssetIndex {
    return {
        schemaVersion: 'v1',
        generatedAt: '2026-05-09T00:00:00.000Z',
        assetsBaseUrl: 'https://example.com/',
        assets: Object.fromEntries(keys.map((key) => [key, {
            assetKey: key,
            releaseId: 'v1.0.0',
            path: key.replace('v1.0.0/', ''),
            fileName: `release-notes__${key.replace(/\//g, '__')}`,
            sha256: 'abc123',
            contentType: 'application/octet-stream',
            sizeBytes: 1,
        }])),
    };
}

describe('manifest asset coverage', () => {
    it('normalizes manifest media keys by release id', () => {
        expect(collectReleaseNotesManifestMediaKeys(manifest)).toEqual([
            'v1.0.0/demo-desktop-poster.webp',
            'v1.0.0/demo-desktop.mp4',
            'v1.0.0/demo-mobile-poster.webp',
            'v1.0.0/demo-mobile.mp4',
            'v1.0.0/demo.mp4',
            'v1.0.0/hero-desktop.webp',
            'v1.0.0/hero-remote.webp',
        ]);
    });

    it('requires the asset index to cover every manifest media key', () => {
        expect(doesAssetIndexCoverReleaseNotesManifest(
            manifest,
            assetIndexFor([
                'v1.0.0/demo.mp4',
                'v1.0.0/demo-desktop-poster.webp',
                'v1.0.0/demo-desktop.mp4',
                'v1.0.0/demo-mobile-poster.webp',
                'v1.0.0/demo-mobile.mp4',
                'v1.0.0/hero-desktop.webp',
                'v1.0.0/hero-remote.webp',
            ]),
        )).toBe(true);

        const incomplete = assetIndexFor(['v1.0.0/demo.mp4']);

        expect(doesAssetIndexCoverReleaseNotesManifest(manifest, incomplete)).toBe(false);
        expect(findMissingReleaseNotesAssetKeys(manifest, incomplete)).toEqual([
            'v1.0.0/demo-desktop-poster.webp',
            'v1.0.0/demo-desktop.mp4',
            'v1.0.0/demo-mobile-poster.webp',
            'v1.0.0/demo-mobile.mp4',
            'v1.0.0/hero-desktop.webp',
            'v1.0.0/hero-remote.webp',
        ]);
    });
});
