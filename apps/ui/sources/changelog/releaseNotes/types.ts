/**
 * Release Notes domain types.
 *
 * Card payloads use the generic `StoryDeckCard` contract directly so the same renderer
 * can serve both release notes and the onboarding showcase.
 */

export type StoryDeckIconId = string;

export type TranslationKey = string;

export type StoryDeckMediaSurface = 'mobile' | 'desktop';

export type StoryDeckListCard = Readonly<{
    kind: 'list';
    titleKey: TranslationKey;
    wideTitleKey?: TranslationKey;
    rows: ReadonlyArray<Readonly<{
        iconId: StoryDeckIconId;
        titleKey: TranslationKey;
        bodyKey: TranslationKey;
    }>>;
}>;

export type StoryDeckImageMediaOverride = Readonly<{
    localAssetKey?: string;
    key?: string;
    altKey?: TranslationKey;
    primaryUrl?: string;
    fallbackUrl?: string;
    url?: string;
}>;

export type StoryDeckImageMedia = StoryDeckImageMediaOverride & Readonly<{
    altKey: TranslationKey;
    mobile?: StoryDeckImageMediaOverride;
    desktop?: StoryDeckImageMediaOverride;
}>;

export type StoryDeckImageCard = Readonly<{
    kind: 'image';
    titleKey: TranslationKey;
    wideTitleKey?: TranslationKey;
    bodyKey: TranslationKey;
    media: StoryDeckImageMedia;
}>;

export type StoryDeckVideoMediaOverride = Readonly<{
    key?: string;
    localPosterAssetKey?: string;
    posterKey?: string;
    primaryUrl?: string;
    fallbackUrl?: string;
    posterUrl?: string;
    posterFallbackUrl?: string;
    accessibilityLabelKey?: TranslationKey;
    loop?: boolean;
    muted?: boolean;
}>;

export type StoryDeckVideoMedia = StoryDeckVideoMediaOverride & Readonly<{
    key: string;
    accessibilityLabelKey: TranslationKey;
    mobile?: StoryDeckVideoMediaOverride;
    desktop?: StoryDeckVideoMediaOverride;
}>;

export type StoryDeckVideoCard = Readonly<{
    kind: 'video';
    titleKey: TranslationKey;
    wideTitleKey?: TranslationKey;
    bodyKey: TranslationKey;
    media: StoryDeckVideoMedia;
}>;

export type StoryDeckCard = StoryDeckListCard | StoryDeckImageCard | StoryDeckVideoCard;

export type ReleaseNotesRelease = Readonly<{
    releaseId: string;
    versionLabel: string;
    publishedAt: string;
    titleKey: TranslationKey;
    subtitleKey?: TranslationKey;
    cards: ReadonlyArray<StoryDeckCard>;
    actions?: Readonly<{
        viewFullReleaseNotes?: boolean;
    }>;
}>;

export type ReleaseNotesManifest = Readonly<{
    schemaVersion: 'v1';
    latestReleaseId: string | null;
    generatedAt: string;
    assetBaseUrl: string;
    releases: ReadonlyArray<ReleaseNotesRelease>;
}>;

export type ReleaseNotesAssetIndexEntry = Readonly<{
    assetKey: string;
    releaseId: string;
    path: string;
    fileName: string;
    sha256: string;
    contentType: string;
    sizeBytes: number;
}>;

export type ReleaseNotesAssetIndex = Readonly<{
    schemaVersion: 'v1';
    generatedAt: string;
    assetsBaseUrl: string;
    assets: Readonly<Record<string, ReleaseNotesAssetIndexEntry>>;
}>;

export type ReleaseNotesMediaSource = Readonly<{
    kind: 'local' | 'remote';
    uri: string;
}>;

export type ResolvedReleaseNotesMedia = Readonly<{
    primary: ReleaseNotesMediaSource;
    fallback: ReleaseNotesMediaSource | null;
    sources: ReadonlyArray<ReleaseNotesMediaSource>;
    /**
     * Back-compat alias for existing card components. New UI should prefer
     * `primary.uri` and walk `sources` when applying fallback behavior.
     */
    url: string;
    fallbackUrl: string | null;
    sha256: string | null;
}>;
