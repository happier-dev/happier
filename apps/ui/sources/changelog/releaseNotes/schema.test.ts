import { describe, expect, it } from 'vitest';

import {
    parseReleaseNotesAssetIndex,
    parseReleaseNotesManifest,
} from './schema';

describe('parseReleaseNotesManifest', () => {
    it('accepts a minimal valid manifest', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: 'v1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetBaseUrl: 'https://example.com/release-notes/',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: '2026-01-01T00:00:00.000Z',
                titleKey: 'releaseNotes.v1_0_0.title',
                cards: [{
                    kind: 'list',
                    titleKey: 'releaseNotes.v1_0_0.cards.0.title',
                    rows: [{
                        iconId: 'sparkles',
                        titleKey: 'releaseNotes.v1_0_0.cards.0.row1Title',
                        bodyKey: 'releaseNotes.v1_0_0.cards.0.row1Body',
                    }],
                }],
            }],
        });
        expect(parsed?.releases.length).toBe(1);
        expect(parsed?.latestReleaseId).toBe('v1.0.0');
    });

    it('rejects an unknown card kind', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: null,
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetBaseUrl: 'x',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: '2026-01-01T00:00:00.000Z',
                titleKey: 't',
                cards: [{ kind: 'audio', titleKey: 't' } as unknown],
            }],
        });
        expect(parsed).toBeNull();
    });

    it('rejects empty translation keys', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: null,
            generatedAt: 'x',
            assetBaseUrl: 'x',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: 'x',
                titleKey: '',
                cards: [{ kind: 'list', titleKey: 't', rows: [{ iconId: 'sparkles', titleKey: 'a', bodyKey: 'b' }] }],
            }],
        });
        expect(parsed).toBeNull();
    });

    it('accepts bundled image cards without requiring a remote image asset key', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: 'v1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetBaseUrl: 'https://example.com/release-notes/',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: '2026-01-01T00:00:00.000Z',
                titleKey: 'releaseNotes.v1_0_0.title',
                cards: [{
                    kind: 'image',
                    titleKey: 'releaseNotes.v1_0_0.cards.hero.title',
                    bodyKey: 'releaseNotes.v1_0_0.cards.hero.body',
                    media: {
                        localAssetKey: 'release-v1-hero',
                        altKey: 'releaseNotes.v1_0_0.cards.hero.alt',
                    },
                }],
            }],
        });

        const card = parsed?.releases[0]?.cards[0];
        expect(card?.kind).toBe('image');
    });

    it('accepts optional mobile and desktop media overrides on image cards', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: 'v1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetBaseUrl: 'https://example.com/release-notes/',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: '2026-01-01T00:00:00.000Z',
                titleKey: 'releaseNotes.v1_0_0.title',
                cards: [{
                    kind: 'image',
                    titleKey: 'releaseNotes.v1_0_0.cards.hero.title',
                    bodyKey: 'releaseNotes.v1_0_0.cards.hero.body',
                    media: {
                        localAssetKey: 'release-v1-hero',
                        altKey: 'releaseNotes.v1_0_0.cards.hero.alt',
                        mobile: {
                            localAssetKey: 'release-v1-hero-mobile',
                        },
                        desktop: {
                            key: 'hero-desktop.webp',
                            altKey: 'releaseNotes.v1_0_0.cards.hero.desktopAlt',
                        },
                    },
                }],
            }],
        });

        const card = parsed?.releases[0]?.cards[0];
        expect(card?.kind).toBe('image');
        expect(card?.kind === 'image' ? card.media.desktop?.key : null).toBe('hero-desktop.webp');
    });

    it('accepts optional wide title keys on story deck cards', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: 'v1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetBaseUrl: 'https://example.com/release-notes/',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: '2026-01-01T00:00:00.000Z',
                titleKey: 'releaseNotes.v1_0_0.title',
                cards: [{
                    kind: 'image',
                    titleKey: 'releaseNotes.v1_0_0.cards.hero.title',
                    wideTitleKey: 'releaseNotes.v1_0_0.cards.hero.wideTitle',
                    bodyKey: 'releaseNotes.v1_0_0.cards.hero.body',
                    media: {
                        localAssetKey: 'release-v1-hero',
                        altKey: 'releaseNotes.v1_0_0.cards.hero.alt',
                    },
                }],
            }],
        });

        const card = parsed?.releases[0]?.cards[0];
        expect(card?.kind).toBe('image');
        expect(card?.kind === 'image' ? card.wideTitleKey : null).toBe('releaseNotes.v1_0_0.cards.hero.wideTitle');
    });

    it('rejects empty wide title keys', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: null,
            generatedAt: 'x',
            assetBaseUrl: 'x',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: 'x',
                titleKey: 'releaseNotes.v1_0_0.title',
                cards: [{
                    kind: 'list',
                    titleKey: 'releaseNotes.v1_0_0.cards.list.title',
                    wideTitleKey: '',
                    rows: [{ iconId: 'sparkles', titleKey: 'a', bodyKey: 'b' }],
                }],
            }],
        });

        expect(parsed).toBeNull();
    });

    it('accepts bundled video posters without requiring a remote poster asset key', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: 'v1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetBaseUrl: 'https://example.com/release-notes/',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: '2026-01-01T00:00:00.000Z',
                titleKey: 'releaseNotes.v1_0_0.title',
                cards: [{
                    kind: 'video',
                    titleKey: 'releaseNotes.v1_0_0.cards.video.title',
                    bodyKey: 'releaseNotes.v1_0_0.cards.video.body',
                    media: {
                        key: 'demo.mp4',
                        localPosterAssetKey: 'release-v1-video-poster',
                        accessibilityLabelKey: 'releaseNotes.v1_0_0.cards.video.label',
                    },
                }],
            }],
        });

        const card = parsed?.releases[0]?.cards[0];
        expect(card?.kind).toBe('video');
    });

    it('accepts optional mobile and desktop media overrides on video cards', () => {
        const parsed = parseReleaseNotesManifest({
            schemaVersion: 'v1',
            latestReleaseId: 'v1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetBaseUrl: 'https://example.com/release-notes/',
            releases: [{
                releaseId: 'v1.0.0',
                versionLabel: 'v1.0.0',
                publishedAt: '2026-01-01T00:00:00.000Z',
                titleKey: 'releaseNotes.v1_0_0.title',
                cards: [{
                    kind: 'video',
                    titleKey: 'releaseNotes.v1_0_0.cards.video.title',
                    bodyKey: 'releaseNotes.v1_0_0.cards.video.body',
                    media: {
                        key: 'demo-mobile.mp4',
                        localPosterAssetKey: 'release-v1-video-poster',
                        accessibilityLabelKey: 'releaseNotes.v1_0_0.cards.video.label',
                        desktop: {
                            key: 'demo-desktop.mp4',
                            posterKey: 'demo-desktop-poster.webp',
                        },
                    },
                }],
            }],
        });

        const card = parsed?.releases[0]?.cards[0];
        expect(card?.kind).toBe('video');
        expect(card?.kind === 'video' ? card.media.desktop?.key : null).toBe('demo-desktop.mp4');
    });

    it('returns null on completely malformed input', () => {
        expect(parseReleaseNotesManifest('not an object')).toBeNull();
        expect(parseReleaseNotesManifest(null)).toBeNull();
    });
});

describe('parseReleaseNotesAssetIndex', () => {
    it('accepts a valid asset index', () => {
        const parsed = parseReleaseNotesAssetIndex({
            schemaVersion: 'v1',
            generatedAt: '2026-01-01T00:00:00.000Z',
            assetsBaseUrl: 'https://example.com/',
            assets: {
                'v1.0.0/hero.webp': {
                    assetKey: 'v1.0.0/hero.webp',
                    releaseId: 'v1.0.0',
                    path: 'hero.webp',
                    fileName: 'release-notes__v1.0.0__hero.webp',
                    sha256: 'abc123',
                    contentType: 'image/webp',
                    sizeBytes: 1024,
                },
            },
        });
        expect(parsed?.assets['v1.0.0/hero.webp']?.sizeBytes).toBe(1024);
    });

    it('rejects negative size byte counts', () => {
        const parsed = parseReleaseNotesAssetIndex({
            schemaVersion: 'v1',
            generatedAt: 'x',
            assetsBaseUrl: 'x',
            assets: {
                'a': {
                    assetKey: 'a',
                    releaseId: 'v1.0.0',
                    path: 'a',
                    fileName: 'a',
                    sha256: 'x',
                    contentType: 'x',
                    sizeBytes: -1,
                },
            },
        });
        expect(parsed).toBeNull();
    });
});
