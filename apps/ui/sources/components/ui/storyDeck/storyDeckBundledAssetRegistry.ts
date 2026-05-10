import type { ImageProps } from 'expo-image';

export type StoryDeckBundledImageAssetSource = ImageProps['source'];

const bundledImageAssetLoaders: Record<string, () => StoryDeckBundledImageAssetSource> = {
    // Add release-note and onboarding story images here with static Metro require() calls, for example:
    // cockpitPreview: () => require('../../../../assets/storyDeck/cockpit-preview.png') as StoryDeckBundledImageAssetSource,
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
