import type * as React from 'react';
import type { Ionicons } from '@expo/vector-icons';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * Curated icon set for StoryDeck list-card rows.
 *
 * Authors reference these by `iconId` in the manifest. The registry maps each id
 * to a stable Ionicons name. This indirection keeps the manifest format icon-set
 * agnostic and allows future swaps without rewriting authored content.
 */
export const STORY_DECK_ICON_REGISTRY = {
    sparkles: 'sparkles-outline',
    rocket: 'rocket-outline',
    shield: 'shield-checkmark-outline',
    bolt: 'flash-outline',
    star: 'star-outline',
    heart: 'heart-outline',
    bookmark: 'bookmark-outline',
    bell: 'notifications-outline',
    cloud: 'cloud-outline',
    code: 'code-slash-outline',
    cog: 'settings-outline',
    download: 'download-outline',
    upload: 'cloud-upload-outline',
    eye: 'eye-outline',
    flag: 'flag-outline',
    folder: 'folder-outline',
    globe: 'globe-outline',
    image: 'image-outline',
    info: 'information-circle-outline',
    key: 'key-outline',
    layers: 'layers-outline',
    link: 'link-outline',
    lock: 'lock-closed-outline',
    moon: 'moon-outline',
    pin: 'pin-outline',
    play: 'play-outline',
    refresh: 'refresh-outline',
    search: 'search-outline',
    settings: 'options-outline',
    share: 'share-outline',
    sun: 'sunny-outline',
    terminal: 'terminal-outline',
    time: 'time-outline',
    user: 'person-outline',
    wand: 'color-wand-outline',
    warning: 'warning-outline',
    wifi: 'wifi-outline',
    zap: 'flash-outline',
} as const satisfies Record<string, IoniconName>;

export type StoryDeckIconId = keyof typeof STORY_DECK_ICON_REGISTRY;

export function isKnownStoryDeckIconId(value: string): value is StoryDeckIconId {
    return Object.prototype.hasOwnProperty.call(STORY_DECK_ICON_REGISTRY, value);
}

export function resolveStoryDeckIconName(id: string): IoniconName {
    if (isKnownStoryDeckIconId(id)) {
        return STORY_DECK_ICON_REGISTRY[id];
    }
    return 'sparkles-outline';
}
