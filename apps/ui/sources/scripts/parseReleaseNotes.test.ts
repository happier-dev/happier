import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import * as releaseNotesParser from './parseReleaseNotes';

type TranslationPathValidator = (source: string, keys: ReadonlyArray<string>) => string[];
type AssetIndexBuilder = (params: {
    releases: ReadonlyArray<{
        releaseId: string;
        cards: ReadonlyArray<{
            kind: 'image' | 'video';
            media: {
                key?: string;
                altKey?: string;
                localAssetKey?: string;
                posterKey?: string;
                localPosterAssetKey?: string;
                accessibilityLabelKey?: string;
            };
            titleKey: string;
            bodyKey: string;
        }>;
    }>;
    assetsDir: string;
    assetBaseUrl: string;
    generatedAt: string;
}) => unknown;

describe('release notes translation-key validation', () => {
    it('validates full nested paths under releaseNotes instead of loose segment names', () => {
        const moduleExports = releaseNotesParser as typeof releaseNotesParser & {
            validateTranslationKeyPathsForTests?: TranslationPathValidator;
        };
        expect(moduleExports.validateTranslationKeyPathsForTests).toBeTypeOf('function');

        const source = `
            export default {
                releaseNotes: {
                    v9_9_9: {
                        title: 'Release title',
                        cards: {
                            hero: {
                                title: 'Hero title',
                                body: 'Hero body',
                            },
                        },
                    },
                },
                unrelated: {
                    missing: {
                        path: 'segment names elsewhere must not satisfy release note keys',
                    },
                },
            };
        `;

        const missing = moduleExports.validateTranslationKeyPathsForTests?.(source, [
            'releaseNotes.v9_9_9.title',
            'releaseNotes.v9_9_9.cards.hero.body',
            'releaseNotes.v9_9_9.cards.missing.path',
        ]);

        expect(missing).toEqual(['releaseNotes.v9_9_9.cards.missing.path']);
    });
});

describe('release notes bundled asset index generation', () => {
    it('emits flat published filenames and integrity metadata for referenced media', () => {
        const moduleExports = releaseNotesParser as typeof releaseNotesParser & {
            buildReleaseNotesAssetIndexForTests?: AssetIndexBuilder;
        };
        expect(moduleExports.buildReleaseNotesAssetIndexForTests).toBeTypeOf('function');

        const root = join(tmpdir(), `happier-release-notes-parser-${Date.now()}`);
        const assetsDir = join(root, 'assets');
        mkdirSync(join(assetsDir, 'v9.9.9', 'nested'), { recursive: true });
        const assetBody = 'fixture-image';
        writeFileSync(join(assetsDir, 'v9.9.9', 'nested', 'hero.webp'), assetBody);

        const index = moduleExports.buildReleaseNotesAssetIndexForTests?.({
            releases: [{
                releaseId: 'v9.9.9',
                cards: [{
                    kind: 'image',
                    titleKey: 'releaseNotes.v9_9_9.cards.hero.title',
                    bodyKey: 'releaseNotes.v9_9_9.cards.hero.body',
                    media: {
                        key: 'nested/hero.webp',
                        altKey: 'releaseNotes.v9_9_9.cards.hero.alt',
                    },
                }],
            }],
            assetsDir,
            assetBaseUrl: 'https://cdn.example.test/release-notes/',
            generatedAt: '2026-05-09T00:00:00.000Z',
        }) as {
            assets?: Record<string, {
                assetKey?: string;
                releaseId?: string;
                fileName?: string;
                sha256?: string;
                sizeBytes?: number;
                contentType?: string;
            }>;
        } | undefined;

        expect(index?.assets?.['v9.9.9/nested/hero.webp']).toMatchObject({
            assetKey: 'v9.9.9/nested/hero.webp',
            releaseId: 'v9.9.9',
            fileName: 'release-notes__v9.9.9__nested__hero.webp',
            sha256: createHash('sha256').update(assetBody).digest('hex'),
            sizeBytes: Buffer.byteLength(assetBody),
            contentType: 'image/webp',
        });
    });

    it('does not require bundled image assets or bundled video posters in the remote asset index', () => {
        const moduleExports = releaseNotesParser as typeof releaseNotesParser & {
            buildReleaseNotesAssetIndexForTests?: AssetIndexBuilder;
        };
        expect(moduleExports.buildReleaseNotesAssetIndexForTests).toBeTypeOf('function');

        const root = join(tmpdir(), `happier-release-notes-parser-local-${Date.now()}`);
        const assetsDir = join(root, 'assets');
        mkdirSync(join(assetsDir, 'v9.9.9'), { recursive: true });
        writeFileSync(join(assetsDir, 'v9.9.9', 'demo.mp4'), 'fixture-video');

        const index = moduleExports.buildReleaseNotesAssetIndexForTests?.({
            releases: [{
                releaseId: 'v9.9.9',
                cards: [{
                    kind: 'image',
                    titleKey: 'releaseNotes.v9_9_9.cards.hero.title',
                    bodyKey: 'releaseNotes.v9_9_9.cards.hero.body',
                    media: {
                        localAssetKey: 'release-v9-hero',
                        altKey: 'releaseNotes.v9_9_9.cards.hero.alt',
                    },
                }, {
                    kind: 'video',
                    titleKey: 'releaseNotes.v9_9_9.cards.video.title',
                    bodyKey: 'releaseNotes.v9_9_9.cards.video.body',
                    media: {
                        key: 'demo.mp4',
                        localPosterAssetKey: 'release-v9-video-poster',
                        accessibilityLabelKey: 'releaseNotes.v9_9_9.cards.video.label',
                    },
                }],
            }],
            assetsDir,
            assetBaseUrl: 'https://cdn.example.test/release-notes/',
            generatedAt: '2026-05-09T00:00:00.000Z',
        }) as {
            assets?: Record<string, unknown>;
        } | undefined;

        expect(Object.keys(index?.assets ?? {})).toEqual(['v9.9.9/demo.mp4']);
    });
});
