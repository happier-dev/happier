import type { TranslationKey } from '@/text';

export const JOURNEY_REEL_FEATURE_IDS = [
    'goals',
    'memorySearch',
    'editor',
    'interSession',
    'agentActions',
    'multiSelect',
    'folders',
    'prompts',
    'sharing',
    'automations',
    'handoff',
    'notifications',
    'crossPlatform',
] as const;

export type JourneyReelFeatureId = typeof JOURNEY_REEL_FEATURE_IDS[number];

export type JourneyReelItem = Readonly<{
    id: JourneyReelFeatureId;
    titleKey: TranslationKey;
    bodyKey: TranslationKey;
}>;

export type JourneyReelItemKeys = Pick<JourneyReelItem, 'titleKey' | 'bodyKey'>;

export function journeyReelItemKeys(id: JourneyReelFeatureId): JourneyReelItemKeys {
    return {
        titleKey: `journey.reel.features.${id}.title`,
        bodyKey: `journey.reel.features.${id}.body`,
    };
}

export const journeyReelItems: readonly JourneyReelItem[] = JOURNEY_REEL_FEATURE_IDS.map((id) => ({
    id,
    ...journeyReelItemKeys(id),
}));
