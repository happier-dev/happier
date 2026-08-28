import { describe, expect, it } from 'vitest';

import { hasStoryDeckBundledImageAssetKey } from '@/components/ui/storyDeck/storyDeckBundledAssetRegistry';
import { isKnownStoryDeckIconId } from '@/components/ui/storyDeck/storyDeckIconRegistry';

import { ONBOARDING_SHOWCASE_MANIFEST } from './manifest';

describe('ONBOARDING_SHOWCASE_MANIFEST', () => {
    it('starts with the complete feature overview and follows it with illustrated detail cards only', () => {
        const [overview, ...details] = ONBOARDING_SHOWCASE_MANIFEST.cards;

        expect(overview?.kind).toBe('list');
        if (overview?.kind !== 'list') return;
        // Hardcoded on purpose: adding a product-story seed adds an onboarding
        // beat, and that should be a decision someone makes rather than a count
        // that silently follows. 23 = the seeds with an onboarding placement.
        expect(overview.rows).toHaveLength(23);
        // Unchanged by `worktrees` and `handoff`: both declare `artworkId: null`,
        // so they add overview rows without adding illustrated detail cards.
        expect(details).toHaveLength(13);
        expect(details.every((card) => card.kind === 'image')).toBe(true);
    });

    it('resolves every declared bundled image through the static asset registry', () => {
        const bundledKeys = ONBOARDING_SHOWCASE_MANIFEST.cards.flatMap((card) => {
            if (card.kind !== 'image' || !card.media.localAssetKey) return [];
            return [card.media.localAssetKey];
        });

        expect(bundledKeys).toHaveLength(13);
        expect(bundledKeys.every(hasStoryDeckBundledImageAssetKey)).toBe(true);
    });

    it('uses a semantic registered icon for every feature instead of the sparkle fallback', () => {
        const overview = ONBOARDING_SHOWCASE_MANIFEST.cards[0];
        expect(overview?.kind).toBe('list');
        if (overview?.kind !== 'list') return;

        expect(overview.rows.every((row) => isKnownStoryDeckIconId(row.iconId))).toBe(true);
        expect(new Set(overview.rows.map((row) => row.iconId)).size).toBeGreaterThanOrEqual(16);
    });

    it('gives illustrated detail cards paragraph copy and a theme-aware planet backdrop', () => {
        const illustratedDetails = ONBOARDING_SHOWCASE_MANIFEST.cards.slice(1).filter((card) => card.kind === 'image');

        expect(illustratedDetails.every((card) => (card.paragraphKeys?.length ?? 0) >= 2)).toBe(true);
        expect(illustratedDetails.every((card) => Boolean(card.media.backdrop?.lightLocalAssetKey))).toBe(true);
        expect(illustratedDetails.every((card) => Boolean(card.media.backdrop?.darkLocalAssetKey))).toBe(true);
    });
});
