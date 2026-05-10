import { z } from 'zod';

import type {
    ReleaseNotesAssetIndex,
    ReleaseNotesManifest,
} from './types';
import {
    STORY_DECK_LIST_CARD_MAX_ROWS,
    STORY_DECK_MAX_CARDS,
} from './storyDeckCardLimits';

const TranslationKeySchema = z.string().min(1).max(200);
const IconIdSchema = z.string().min(1).max(80);
const ReleaseIdSchema = z.string().min(1).max(120);
const AssetKeySchema = z.string().min(1).max(200);
const UrlSchema = z.string().min(1).max(4000);

const ListCardSchema = z.object({
    kind: z.literal('list'),
    titleKey: TranslationKeySchema,
    rows: z.array(z.object({
        iconId: IconIdSchema,
        titleKey: TranslationKeySchema,
        bodyKey: TranslationKeySchema,
    })).min(1).max(STORY_DECK_LIST_CARD_MAX_ROWS),
});

const ImageCardSchema = z.object({
    kind: z.literal('image'),
    titleKey: TranslationKeySchema,
    bodyKey: TranslationKeySchema,
    media: z.object({
        localAssetKey: AssetKeySchema.optional(),
        key: AssetKeySchema.optional(),
        altKey: TranslationKeySchema,
        primaryUrl: UrlSchema.optional(),
        fallbackUrl: UrlSchema.optional(),
        url: UrlSchema.optional(),
    }).superRefine((media, ctx) => {
        if (media.localAssetKey || media.key || media.primaryUrl || media.url) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Image media must include localAssetKey, key, primaryUrl, or url.',
            path: ['key'],
        });
    }),
});

const VideoCardSchema = z.object({
    kind: z.literal('video'),
    titleKey: TranslationKeySchema,
    bodyKey: TranslationKeySchema,
    media: z.object({
        key: AssetKeySchema,
        localPosterAssetKey: AssetKeySchema.optional(),
        posterKey: AssetKeySchema.optional(),
        accessibilityLabelKey: TranslationKeySchema,
        primaryUrl: UrlSchema.optional(),
        fallbackUrl: UrlSchema.optional(),
        posterUrl: UrlSchema.optional(),
        posterFallbackUrl: UrlSchema.optional(),
        loop: z.boolean().optional(),
        muted: z.boolean().optional(),
    }).superRefine((media, ctx) => {
        if (media.localPosterAssetKey || media.posterKey || media.posterUrl) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Video media must include localPosterAssetKey, posterKey, or posterUrl.',
            path: ['posterKey'],
        });
    }),
});

export const StoryDeckCardSchema = z.discriminatedUnion('kind', [
    ListCardSchema,
    ImageCardSchema,
    VideoCardSchema,
]);

export const ReleaseNotesReleaseSchema = z.object({
    releaseId: ReleaseIdSchema,
    versionLabel: z.string().min(1).max(40),
    publishedAt: z.string().min(1).max(64),
    titleKey: TranslationKeySchema,
    subtitleKey: TranslationKeySchema.optional(),
    cards: z.array(StoryDeckCardSchema).min(1).max(STORY_DECK_MAX_CARDS),
    actions: z.object({
        viewFullReleaseNotes: z.boolean().optional(),
    }).optional(),
});

export const ReleaseNotesManifestSchema = z.object({
    schemaVersion: z.literal('v1'),
    latestReleaseId: ReleaseIdSchema.nullable(),
    generatedAt: z.string().min(1),
    assetBaseUrl: z.string().min(1),
    releases: z.array(ReleaseNotesReleaseSchema),
});

export const ReleaseNotesAssetIndexEntrySchema = z.object({
    assetKey: AssetKeySchema,
    releaseId: ReleaseIdSchema,
    path: z.string().min(1),
    fileName: z.string().min(1),
    sha256: z.string().min(1),
    contentType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
});

export const ReleaseNotesAssetIndexSchema = z.object({
    schemaVersion: z.literal('v1'),
    generatedAt: z.string().min(1),
    assetsBaseUrl: z.string().min(1),
    assets: z.record(AssetKeySchema, ReleaseNotesAssetIndexEntrySchema),
});

export function parseReleaseNotesManifest(raw: unknown): ReleaseNotesManifest | null {
    const result = ReleaseNotesManifestSchema.safeParse(raw);
    if (!result.success) {
        return null;
    }
    return result.data as ReleaseNotesManifest;
}

export function parseReleaseNotesAssetIndex(raw: unknown): ReleaseNotesAssetIndex | null {
    const result = ReleaseNotesAssetIndexSchema.safeParse(raw);
    if (!result.success) {
        return null;
    }
    return result.data as ReleaseNotesAssetIndex;
}
