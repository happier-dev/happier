import { describe, expect, it } from 'vitest';

import { resolveDetailPhoneBarFit, resolveDetailPhonePlacement, type PhonePlacementItem } from './detailPhoneNavigationProjection';

const items = (count: number): PhonePlacementItem[] => Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`, navigation: { kind: 'page' as const },
}));

describe('phone detail bar fit', () => {
    it('counts the room the selected tab’s name takes when labels are off, so a bar that only fits as icons scrolls', () => {
        const placement = resolveDetailPhonePlacement(items(8), undefined, 'bottom');
        // Eight icons and More fit nine slots exactly.
        expect(resolveDetailPhoneBarFit(placement, 9).mode).toBe('fit');
        // The selected tab says its name (owner 11-06), which takes one more slot: the bar scrolls instead of clipping it.
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { selectedLabelSlots: 1 }).mode).toBe('scroll');
        expect(resolveDetailPhoneBarFit(placement, 10, 'scroll', { selectedLabelSlots: 1 }).mode).toBe('fit');
    });
});
