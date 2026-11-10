import { describe, expect, it } from 'vitest';

import { resolveCockpitTrackRevealTarget, resolveCockpitTrackRevealX } from './cockpitTrackReveal';

describe('a scrolling phone bar keeps its selected tab in view', () => {
    const viewport = 300;
    const fade = 16;
    it('scrolls just enough to show a selected tab cut off at the end, clear of the edge fade', () => {
        expect(resolveCockpitTrackRevealX({ x: 270, width: 60, offset: 0, viewport, fade })).toBe(46);
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
