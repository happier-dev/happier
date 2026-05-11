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

    it('uses desktop video media overrides without leaking base video URLs', () => {
        const resolved = resolveStoryDeckMediaSources({
            key: 'mobile-demo.mp4',
            desktop: {
                key: 'desktop-demo.mp4',
                fallbackUrl: 'https://cdn.example.com/desktop-demo.mp4',
            },
        }, { surface: 'desktop' });

        expect(resolved.urls.join(' ')).toContain('desktop-demo.mp4');
        expect(resolved.urls.join(' ')).not.toContain('mobile-demo.mp4');
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

    it('uses surface-specific poster overrides independently from the video override', () => {
        expect(resolveStoryDeckPosterSources({
            key: 'mobile-demo.mp4',
            posterUrl: 'https://cdn.example.com/mobile-poster.webp',
            desktop: {
                posterUrl: 'https://cdn.example.com/desktop-poster.webp',
            },
        }, { surface: 'desktop' }).urls).toEqual(['https://cdn.example.com/desktop-poster.webp']);
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

    it('uses desktop image overrides as a replacement for base image sources', () => {
        const baseSource = { uri: 'asset://base' };
        const desktopSource = { uri: 'asset://desktop' };

        const resolved = resolveStoryDeckImageSources({
            localAssetKey: 'base-hero',
            key: 'base-remote.webp',
            altKey: 'releaseNotes.hero.alt',
            desktop: {
                localAssetKey: 'desktop-hero',
            },
        }, {
            surface: 'desktop',
            resolveBundledImageAsset: (key) => {
                if (key === 'base-hero') return baseSource;
                if (key === 'desktop-hero') return desktopSource;
                return null;
            },
        });

        expect(resolved.sources).toEqual([{
            kind: 'local',
            key: 'desktop-hero',
            source: desktopSource,
        }]);
        expect(resolved.cacheKey).toBe('local:desktop-hero');
    });

    it('falls back to base image media when the requested surface has no override', () => {
        expect(resolveStoryDeckImageSources({
            url: 'https://cdn.example.com/base.webp',
            altKey: 'releaseNotes.hero.alt',
        }, { surface: 'mobile' }).sources).toEqual([{
            kind: 'remote',
            uri: 'https://cdn.example.com/base.webp',
            source: { uri: 'https://cdn.example.com/base.webp' },
        }]);
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
