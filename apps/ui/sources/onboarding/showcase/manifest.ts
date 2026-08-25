import type { StoryDeckCard } from '@/changelog/releaseNotes';
import { PRODUCT_STORY_FEATURES } from '@happier-dev/brand/product-story';

import type { OnboardingShowcaseManifest } from './types';

type Feature = Readonly<{
    id: string;
    iconId: string;
    titleKey: string;
    bodyKey: string;
    imageKey?: string;
}>;

const PLANET_BACKDROP = {
    lightLocalAssetKey: 'onboarding-planet-backdrop-light',
    darkLocalAssetKey: 'onboarding-planet-backdrop-dark',
} as const;

const authoredFeatures: readonly Feature[] = [
    { id: 'anywhere', iconId: 'devices', titleKey: 'journey.beats.a1.title', bodyKey: 'journey.beats.a1.body', imageKey: 'onboarding-anywhere' },
    { id: 'existingSessions', iconId: 'sessions', titleKey: 'journey.beats.a2.title', bodyKey: 'journey.beats.a2.body', imageKey: 'onboarding-existing-sessions' },
    { id: 'terminalTuis', iconId: 'terminal', titleKey: 'journey.beats.a3.title', bodyKey: 'journey.beats.a3.body', imageKey: 'onboarding-terminal' },
    { id: 'cockpit', iconId: 'cockpit', titleKey: 'releaseNotes.onboardingShowcase.cards.cockpit.title', bodyKey: 'releaseNotes.onboardingShowcase.cards.cockpit.body', imageKey: 'onboarding-one-tap-away' },
    { id: 'sessionTeam', iconId: 'team', titleKey: 'journey.beats.a5.title', bodyKey: 'journey.beats.a5.body', imageKey: 'onboarding-sessions-team' },
    { id: 'queue', iconId: 'queue', titleKey: 'journey.beats.a6.title', bodyKey: 'journey.beats.a6.body' },
    { id: 'attention', iconId: 'attention', titleKey: 'journey.beats.a7.title', bodyKey: 'journey.beats.a7.body', imageKey: 'onboarding-what-needs-you' },
    { id: 'review', iconId: 'review', titleKey: 'journey.beats.a8.title', bodyKey: 'journey.beats.a8.body', imageKey: 'onboarding-review' },
    { id: 'agentSwitching', iconId: 'switching', titleKey: 'releaseNotes.onboardingShowcase.cards.subagents.title', bodyKey: 'releaseNotes.onboardingShowcase.cards.subagents.body', imageKey: 'onboarding-agent-switching' },
    { id: 'navigation', iconId: 'navigation', titleKey: 'journey.reel.features.handoff.title', bodyKey: 'journey.reel.features.handoff.body', imageKey: 'onboarding-navigation' },
    { id: 'voice', iconId: 'voice', titleKey: 'journey.beats.a10.title', bodyKey: 'journey.beats.a10.body', imageKey: 'onboarding-voice' },
    { id: 'machines', iconId: 'machines', titleKey: 'journey.reel.features.crossPlatform.title', bodyKey: 'journey.reel.features.crossPlatform.body' },
    { id: 'surfaces', iconId: 'surfaces', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.everywhereTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.everywhereBody' },
    { id: 'mcp', iconId: 'globe', titleKey: 'journey.beats.a11.title', bodyKey: 'journey.beats.a11.body', imageKey: 'onboarding-mcp' },
    { id: 'subscriptions', iconId: 'subscriptions', titleKey: 'releaseNotes.onboardingShowcase.cards.accounts.title', bodyKey: 'releaseNotes.onboardingShowcase.cards.accounts.body', imageKey: 'onboarding-subscriptions' },
    { id: 'accounts', iconId: 'accounts', titleKey: 'journey.beats.a12.title', bodyKey: 'journey.beats.a12.body', imageKey: 'onboarding-sail-past-limits' },
    { id: 'customization', iconId: 'customization', titleKey: 'journey.beats.a13.title', bodyKey: 'journey.beats.a13.body' },
    { id: 'privacy', iconId: 'privacy', titleKey: 'releaseNotes.onboardingShowcase.cards.privacy.title', bodyKey: 'releaseNotes.onboardingShowcase.cards.privacy.body' },
    { id: 'automations', iconId: 'automations', titleKey: 'journey.reel.features.automations.title', bodyKey: 'journey.reel.features.automations.body' },
    { id: 'prompts', iconId: 'prompts', titleKey: 'journey.reel.features.prompts.title', bodyKey: 'journey.reel.features.prompts.body' },
    { id: 'pets', iconId: 'pets', titleKey: 'releaseNotes.onboardingShowcase.cards.pets.title', bodyKey: 'releaseNotes.onboardingShowcase.cards.pets.body' },
];

const authoredFeatureById = new Map(authoredFeatures.map((feature) => [feature.id, feature]));
const features: readonly Feature[] = PRODUCT_STORY_FEATURES
    .filter((feature) => feature.placements.onboarding != null)
    .map((storyFeature) => {
        const authored = authoredFeatureById.get(storyFeature.id);
        if (!authored) {
            throw new Error(`Missing onboarding translation mapping for product story feature: ${storyFeature.id}`);
        }
        return {
            ...authored,
            iconId: storyFeature.semantics.iconId,
            imageKey: storyFeature.semantics.artworkId ?? undefined,
        };
    });

function detailCard(feature: Feature): StoryDeckCard {
    if (feature.imageKey) {
        return {
            kind: 'image',
            titleKey: feature.titleKey,
            wideTitleKey: `releaseNotes.onboardingShowcase.details.${feature.id}.wideTitle`,
            bodyKey: feature.bodyKey,
            paragraphKeys: [
                feature.bodyKey,
                `releaseNotes.onboardingShowcase.details.${feature.id}.body`,
            ],
            media: {
                localAssetKey: feature.imageKey,
                altKey: feature.titleKey,
                aspectRatio: 1.36,
                contentFit: 'contain',
                backdrop: PLANET_BACKDROP,
            },
        };
    }
    return {
        kind: 'list',
        titleKey: feature.titleKey,
        wideTitleKey: `releaseNotes.onboardingShowcase.details.${feature.id}.wideTitle`,
        rows: [{
            iconId: feature.iconId,
            titleKey: feature.titleKey,
            bodyKey: `releaseNotes.onboardingShowcase.details.${feature.id}.body`,
        }],
    };
}

export const ONBOARDING_SHOWCASE_MANIFEST: OnboardingShowcaseManifest = {
    schemaVersion: 'v1',
    // Keep the last shipped version so users who already completed this one-time tour are not
    // re-onboarded merely because its content and artwork were refreshed while it was unwired.
    showcaseVersion: 'v4',
    titleKey: 'releaseNotes.onboardingShowcase.title',
    subtitleKey: 'releaseNotes.onboardingShowcase.subtitle',
    cards: [
        {
            kind: 'list',
            titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.title',
            rows: features.map((feature) => ({
                iconId: feature.iconId,
                titleKey: feature.titleKey,
                bodyKey: feature.bodyKey,
            })),
        },
        ...features.filter((feature) => feature.imageKey).map(detailCard),
    ],
};
