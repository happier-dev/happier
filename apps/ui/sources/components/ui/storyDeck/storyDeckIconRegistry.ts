import type * as React from 'react';
import type { IconName } from '@/components/ui/icons/Icon';

type IoniconName = IconName;

/**
 * Curated icon set for StoryDeck list-card rows.
 *
 * Authors reference these by `iconId` in the manifest. The registry maps each id
 * to a stable Ionicons name. This indirection keeps the manifest format icon-set
 * agnostic and allows future swaps without rewriting authored content.
 */
export const STORY_DECK_ICON_REGISTRY = {
    sparkles: 'sparkle',
    rocket: 'rocket',
    shield: 'shield-check',
    bolt: 'lightning',
    star: 'star',
    heart: 'heart',
    bookmark: 'bookmark',
    bell: 'bell',
    cloud: 'cloud',
    code: 'code',
    cog: 'sliders-horizontal',
    download: 'download',
    upload: 'cloud-arrow-up',
    eye: 'eye',
    flag: 'flag',
    folder: 'folder',
    globe: 'globe',
    image: 'image',
    info: 'info',
    key: 'key',
    layers: 'stack-simple',
    link: 'link',
    lock: 'lock',
    moon: 'moon',
    pin: 'push-pin',
    play: 'play',
    refresh: 'arrow-clockwise',
    search: 'magnifying-glass',
    settings: 'sliders-horizontal',
    share: 'share',
    sun: 'sun',
    terminal: 'terminal',
    time: 'clock',
    user: 'person',
    wand: 'magic-wand',
    warning: 'warning',
    wifi: 'wifi-high',
    zap: 'lightning',
} as const satisfies Record<string, IoniconName>;

export type StoryDeckIconId = keyof typeof STORY_DECK_ICON_REGISTRY;

export function isKnownStoryDeckIconId(value: string): value is StoryDeckIconId {
    return Object.prototype.hasOwnProperty.call(STORY_DECK_ICON_REGISTRY, value);
}

export function resolveStoryDeckIconName(id: string): IoniconName {
    if (isKnownStoryDeckIconId(id)) {
        return STORY_DECK_ICON_REGISTRY[id];
    }
    return 'sparkle';
}
