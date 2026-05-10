import type { StoryDeckCard, TranslationKey } from '@/changelog/releaseNotes';

export type OnboardingShowcaseManifest = Readonly<{
    schemaVersion: 'v1';
    showcaseVersion: string;
    titleKey: TranslationKey;
    subtitleKey?: TranslationKey;
    cards: ReadonlyArray<StoryDeckCard>;
}>;
