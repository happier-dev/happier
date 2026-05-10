import { describe, expect, it } from 'vitest';

import {
    resolveStoryDeckImageSources,
    resolveStoryDeckMediaSources,
    resolveStoryDeckPosterImageSources,
    resolveStoryDeckPosterSources,
} from './StoryDeckMediaSources';

describe('resolveStoryDeckMediaSources', () => {
    it('prefers explicit primary and fallback URLs when the domain provides them', () => {
        expect(resolveStoryDeckMediaSources({
            key: 'fallback-key',
            primaryUrl: 'http://localhost:4150/media.mp4',
            fallbackUrl: 'https://cdn.example.com/media.mp4',
        })).toEqual({
            primaryUrl: 'http://localhost:4150/media.mp4',
            fallbackUrl: 'https://cdn.example.com/media.mp4',
            urls: [
                'http://localhost:4150/media.mp4',
                'https://cdn.example.com/media.mp4',
            ],
            sha256: null,
        });
    });

    it('deduplicates repeated fallback URLs', () => {
        expect(resolveStoryDeckMediaSources({
            url: 'https://cdn.example.com/media.png',
            fallbackUrl: 'https://cdn.example.com/media.png',
        }).urls).toEqual(['https://cdn.example.com/media.png']);
    });
});

describe('resolveStoryDeckPosterSources', () => {
    it('accepts explicit poster fallback URLs from future media contracts', () => {
        expect(resolveStoryDeckPosterSources({
            posterKey: 'poster-key',
            posterUrl: 'http://localhost:4150/poster.png',
            posterFallbackUrl: 'https://cdn.example.com/poster.png',
        }).urls).toEqual([
            'http://localhost:4150/poster.png',
            'https://cdn.example.com/poster.png',
        ]);
    });
});

describe('resolveStoryDeckImageSources', () => {
    it('prefers a bundled local asset over a remote image fallback', () => {
        const bundledSource = { uri: 'asset://hero' };

        const resolved = resolveStoryDeckImageSources({
            localAssetKey: 'hero-bundle',
            key: 'hero-remote',
            primaryUrl: 'https://cdn.example.com/hero.png',
        }, {
            resolveBundledImageAsset: (key) => (key === 'hero-bundle' ? bundledSource : null),
        });

        expect(resolved.sources).toEqual([
            {
                kind: 'local',
                key: 'hero-bundle',
                source: bundledSource,
            },
            {
                kind: 'remote',
                uri: 'https://cdn.example.com/hero.png',
                source: { uri: 'https://cdn.example.com/hero.png' },
            },
        ]);
        expect(resolved.cacheKey).toBe('local:hero-bundle|remote:https://cdn.example.com/hero.png');
    });
});

describe('resolveStoryDeckPosterImageSources', () => {
    it('prefers a bundled local poster while keeping the remote poster as fallback', () => {
        const posterSource = { uri: 'asset://poster' };

        const resolved = resolveStoryDeckPosterImageSources({
            localPosterAssetKey: 'poster-bundle',
            posterUrl: 'https://cdn.example.com/poster.png',
        }, {
            resolveBundledImageAsset: (key) => (key === 'poster-bundle' ? posterSource : null),
        });

        expect(resolved.sources).toEqual([
            {
                kind: 'local',
                key: 'poster-bundle',
                source: posterSource,
            },
            {
                kind: 'remote',
                uri: 'https://cdn.example.com/poster.png',
                source: { uri: 'https://cdn.example.com/poster.png' },
            },
        ]);
    });
});
