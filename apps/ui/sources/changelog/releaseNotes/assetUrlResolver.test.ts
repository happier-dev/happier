import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAssetIndexForTests, setAssetIndex } from './assetIndex';
import { resolveAssetUrl } from './assetUrlResolver';
import { resetManifestRuntimeCacheForTests } from './manifestRuntime';

const originalEnv = { ...process.env };

declare const __DEV__: boolean | undefined;

describe('resolveAssetUrl', () => {
    beforeEach(() => {
        resetAssetIndexForTests();
        resetManifestRuntimeCacheForTests();
        process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_LOCAL_ASSETS_BASE_URL = '';
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('falls back to the default GitHub release URL when no manifest/asset index is configured', () => {
        const resolved = resolveAssetUrl('v1.0.0/hero.webp');
        expect(resolved?.url).toContain('happier-dev/happier-assets/releases/download/release-notes/');
        expect(resolved?.url).toContain('hero.webp');
    });

    it('appends a version query suffix when the asset index has a sha256', () => {
        setAssetIndex({
            schemaVersion: 'v1',
            generatedAt: 'x',
            assetsBaseUrl: 'https://example.com/',
            assets: {
                'v1.0.0/hero.webp': {
                    assetKey: 'v1.0.0/hero.webp',
                    releaseId: 'v1.0.0',
                    path: 'hero.webp',
                    fileName: 'release-notes__v1.0.0__hero.webp',
                    sha256: 'deadbeef1234',
                    contentType: 'image/webp',
                    sizeBytes: 1,
                },
            },
        });
        const resolved = resolveAssetUrl('v1.0.0/hero.webp');
        expect(resolved?.primary).toEqual({
            kind: 'remote',
            uri: 'https://example.com/release-notes__v1.0.0__hero.webp?v=deadbeef1234',
        });
        expect(resolved?.url).toContain('release-notes__v1.0.0__hero.webp');
        expect(resolved?.url).toContain('?v=deadbeef1234');
    });

    it('uses the local base URL in dev mode and exposes a remote fallback', () => {
        // Force "dev" without modifying the global flag.
        process.env.EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_LOCAL_ASSETS_BASE_URL = 'http://127.0.0.1:4173/';
        const isDev = typeof __DEV__ !== 'undefined' && __DEV__ === true;
        const resolved = resolveAssetUrl('v1.0.0/hero.webp');
        if (isDev) {
            expect(resolved?.primary.kind).toBe('local');
            expect(resolved?.primary.uri).toContain('127.0.0.1');
            expect(resolved?.fallback?.kind).toBe('remote');
            expect(resolved?.fallback?.uri).toContain('happier-dev/happier-assets');
        } else {
            // In a non-dev test runtime, the resolver must still produce a remote URL.
            expect(resolved?.primary.kind).toBe('remote');
            expect(resolved?.url).toContain('happier-dev/happier-assets');
            expect(resolved?.fallback).toBeNull();
        }
    });
});
