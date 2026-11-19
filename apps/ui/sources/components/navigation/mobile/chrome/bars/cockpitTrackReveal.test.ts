import { describe, expect, it } from 'vitest';

import { resolveCockpitTrackViewportWidth, resolveCockpitTrackRevealTarget, resolveCockpitTrackRevealX } from './cockpitTrackReveal';

describe('a scrolling phone bar keeps its selected tab in view', () => {
    const viewport = 300;
    const fade = 16;
    it('scrolls just enough to show a selected tab cut off at the end, clear of the edge fade', () => {
        expect(resolveCockpitTrackRevealX({ x: 270, width: 60, offset: 0, viewport, fade })).toBe(46);
        expect(resolveCockpitTrackRevealX({ x: 320, width: 60, offset: 0, viewport, fade })).toBe(96);
    });
    // UI refinements 11-19 ruling (a): the selected tab is always fully visible. The track opens at its start unless
    // that shows the selected tab only partly; then it scrolls just enough to show it whole. At 390 four 50 px tabs sit
    // in a 175 px track (three whole and the next one's half): a selected end tab showing only its peek half scrolls.
    it('opens at its start while the selected tab is whole there', () => {
        expect(resolveCockpitTrackRevealX({ x: 100, width: 50, offset: 0, viewport: 175, fade })).toBeNull();
    });
    it('scrolls a selected end tab showing only its peek half just enough to show it whole', () => {
        expect(resolveCockpitTrackRevealX({ x: 150, width: 50, offset: 0, viewport: 175, fade })).toBe(41);
    });
    it('scrolls back to a selected tab hidden before the start', () => {
        expect(resolveCockpitTrackRevealX({ x: 40, width: 50, offset: 120, viewport, fade })).toBe(24);
        expect(resolveCockpitTrackRevealX({ x: 10, width: 50, offset: 60, viewport, fade })).toBe(0);
    });
    it('leaves a fully visible tab where it is', () => {
        expect(resolveCockpitTrackRevealX({ x: 100, width: 50, offset: 0, viewport, fade })).toBeNull();
    });
});

describe('what a scrolling phone bar brings into view', () => {
    const tabs = ['chat', 'files', 'git'] as const;
    it('reveals a selected tab in the track and leaves the fixed first tab alone', () => {
        expect(resolveCockpitTrackRevealTarget(tabs, 'files')).toBe('files');
        expect(resolveCockpitTrackRevealTarget(tabs, 'git')).toBe('git');
        expect(resolveCockpitTrackRevealTarget(tabs, 'chat')).toBeNull();
    });
    // Owner 11-10: More stands outside the track, always in view; nothing behind it moves the track.
    it('leaves the track alone when the selected item is behind More', () => {
        expect(resolveCockpitTrackRevealTarget(tabs, 'browser')).toBeNull();
    });
});

describe('a scrolling phone bar shows whole tabs at rest', () => {
    // MOBILE-FIX-1115 H1 (owner 11-15): a scrolling bar spaces its tabs like every other bar, at their own width; the
    // capsule takes back the remainder. Owner 11-18: the next tab visibly peeks, never a hard edge or a sliver.
    it('shows whole tabs plus the leading half of the next one, so the overflow visibly peeks (owner 11-18)', () => {
        // 390 wide with a pinned Bot: about 190 px of track for 50 px tabs held three whole tabs and hid the fourth.
        expect(resolveCockpitTrackViewportWidth({ room: 190, minWidth: 50 })).toBe(175);
        // 320 wide: 119 px of track showed two whole tabs and a 19 px stub; now one whole tab and a half-tab peek.
        expect(resolveCockpitTrackViewportWidth({ room: 119, minWidth: 50 })).toBe(75);
        expect(resolveCockpitTrackViewportWidth({ room: 125, minWidth: 50 })).toBe(125);
    });
    it('keeps one whole tab when the track has no room for a peek beside it', () => {
        expect(resolveCockpitTrackViewportWidth({ room: 70, minWidth: 50 })).toBe(50);
    });
    it('leaves the track at its own width until it is measured', () => {
        expect(resolveCockpitTrackViewportWidth({ room: 0, minWidth: 50 })).toBeNull();
    });
});
