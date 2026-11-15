import { describe, expect, it } from 'vitest';

import { resolveDetailPhoneBarFit, resolveDetailPhonePlacement, type PhonePlacementItem } from './detailPhoneNavigationProjection';

const items = (count: number): PhonePlacementItem[] => Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`, navigation: { kind: 'page' as const },
}));

describe('phone detail bar fit', () => {
    it('fits a bar whose icons and More fill the slots, whatever the selected tab', () => {
        const placement = resolveDetailPhonePlacement(items(8), undefined, 'bottom');
        // Eight icons and More fit nine slots exactly; one more item scrolls. No slot is held for a selected tab's
        // name: labels follow the one setting (owner 11-15, MOBILE-FIX-1115 H1).
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tab-0' }).mode).toBe('fit');
        expect(resolveDetailPhoneBarFit(resolveDetailPhonePlacement(items(9), undefined, 'bottom'), 9).mode).toBe('scroll');
    });

    // Owner 11-10: More is never replaced. An item opened from More rides the bar just before More while it is open.
    it('puts the open item from More on the bar just before More, and keeps it listed behind More', () => {
        const placement = resolveDetailPhonePlacement(items(6), { orderedIds: [], placements: { 'tab-4': 'overflow', 'tab-5': 'hidden' } }, 'bottom');
        const resting = resolveDetailPhoneBarFit(placement, 9);
        expect(resting.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3']);
        expect(resting.visitor).toBeNull();

        const visiting = resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tab-4' });
        expect(visiting.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-4']);
        expect(visiting.visitor?.id).toBe('tab-4');
        expect(visiting.behindMore.map(item => item.id)).toEqual(['tab-4']);
        // A hidden item reached another way still shows where the person is.
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tab-5' }).shown.at(-1)?.id).toBe('tab-5');
        // An item already on the bar is not repeated.
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tab-1' }).visitor).toBeNull();
    });

    it('keeps an open page off the bottom bar when pages sit at the top, where only companions ride it', () => {
        const mixed: PhonePlacementItem[] = [
            { id: 'chat', navigation: { kind: 'page' } }, { id: 'files', navigation: { kind: 'page' } },
            { id: 'notes', navigation: { kind: 'page' } }, { id: 'tools', navigation: { kind: 'companion' } },
        ];
        const placement = resolveDetailPhonePlacement(mixed, { orderedIds: [], placements: { notes: 'overflow', tools: 'overflow' } }, 'top');
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'notes' }).visitor).toBeNull();
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tools' }).visitor?.id).toBe('tools');
    });

    it('makes room for the visitor in a bar that holds its excess in More', () => {
        const placement = resolveDetailPhonePlacement(items(6), { orderedIds: [], placements: { 'tab-5': 'overflow' } }, 'bottom');
        // Five pinned tabs and More fill six slots exactly.
        expect(resolveDetailPhoneBarFit(placement, 6, 'more').mode).toBe('fit');
        const visiting = resolveDetailPhoneBarFit(placement, 6, 'more', { activeId: 'tab-5' });
        expect(visiting.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-5']);
        expect(visiting.held.map(item => item.id)).toEqual(['tab-4']);
        // A pinned tab held in More is the visitor while it is open.
        expect(resolveDetailPhoneBarFit(placement, 5, 'more').held.map(item => item.id)).toEqual(['tab-4']);
        const held = resolveDetailPhoneBarFit(placement, 5, 'more', { activeId: 'tab-4' });
        expect(held.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-4']);
        expect(held.held.map(item => item.id)).toEqual(['tab-3', 'tab-4']);
    });
});
