import type { ImageProps } from 'expo-image';

export type StoryDeckBundledImageAssetSource = ImageProps['source'];

const bundledImageAssetLoaders: Record<string, () => StoryDeckBundledImageAssetSource> = {
    'onboarding-agent-switching': () => require('@/assets/onboarding/storyDeck/features-agent-switching-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-anywhere': () => require('@/assets/onboarding/storyDeck/features-anywhere-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-existing-sessions': () => require('@/assets/onboarding/storyDeck/features-existing-sessions-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-mcp': () => require('@/assets/onboarding/storyDeck/features-mcp-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-navigation': () => require('@/assets/onboarding/storyDeck/features-navigation-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-one-tap-away': () => require('@/assets/onboarding/storyDeck/features-one-tap-away-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-review': () => require('@/assets/onboarding/storyDeck/features-review-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-sail-past-limits': () => require('@/assets/onboarding/storyDeck/features-sail-past-limits-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-sessions-team': () => require('@/assets/onboarding/storyDeck/features-sessions-team-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-subscriptions': () => require('@/assets/onboarding/storyDeck/features-subscriptions-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-terminal': () => require('@/assets/onboarding/storyDeck/features-terminal-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-voice': () => require('@/assets/onboarding/storyDeck/features-voice-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-what-needs-you': () => require('@/assets/onboarding/storyDeck/features-what-needs-you-720.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-planet-backdrop-light': () => require('@/assets/onboarding/storyDeck/planet-backdrop-light-1080.webp') as StoryDeckBundledImageAssetSource,
    'onboarding-planet-backdrop-dark': () => require('@/assets/onboarding/storyDeck/planet-backdrop-dark-1080.webp') as StoryDeckBundledImageAssetSource,
};

export type StoryDeckBundledImageAssetKey = string;

export function resolveStoryDeckBundledImageAsset(key: string | null | undefined): StoryDeckBundledImageAssetSource | null {
    if (!key) return null;
    const loader = bundledImageAssetLoaders[key];
    return loader ? loader() : null;
}

export function hasStoryDeckBundledImageAssetKey(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(bundledImageAssetLoaders, key);
}
