import { describe, expect, it } from 'vitest';

import {
    resolveHorizontalSafeAreaRoot,
    resolveNavigatorBleed,
    resolveScreenFrameInsets,
    resolveSidebarInsetSplit,
    type HorizontalSafeArea,
} from './horizontalSafeArea';

// Folded iPhone Duo: the system vertical bar sits in the right 84pt.
const DUO_FOLDED = { left: 0, right: 84 } as const;
// iPhone landscape: notch on one side, home-indicator margin on the other.
const IPHONE_LANDSCAPE = { left: 59, right: 59 } as const;

/** Walks the real shell chain: app root → navigator → screen. */
function screenOf(windowInsets: { left: number; right: number }, nested = 0) {
    let area: HorizontalSafeArea = resolveHorizontalSafeAreaRoot(windowInsets).child;
    const bleeds = [];
    const frames = [];
    for (let depth = 0; depth <= nested; depth += 1) {
        const bleed = resolveNavigatorBleed(area);
        bleeds.push(bleed);
        const frame = resolveScreenFrameInsets(bleed.child, { presentedOutsideNavigator: false });
        frames.push(frame);
        area = frame.child;
    }
    return { bleeds, frames, leaf: area };
}

describe('horizontal safe area ownership', () => {
    it('keeps every non-navigator surface inside the safe area from the app root', () => {
        const root = resolveHorizontalSafeAreaRoot(DUO_FOLDED);
        expect(root.padding).toEqual({ left: 0, right: 84 });
    });

    it('lets the navigator reach the window edge and pads each screen back inside the safe area', () => {
        const { bleeds, frames, leaf } = screenOf(DUO_FOLDED);
        expect(bleeds[0].margin).toEqual({ left: 0, right: -84 });
        expect(frames[0].padding).toEqual({ left: 0, right: 84 });
        // Screen content is safe; a screen inside it must not pad again.
        expect(resolveScreenFrameInsets(leaf, { presentedOutsideNavigator: false }).padding).toEqual({ left: 0, right: 0 });
    });

    it('lets a navigator nested in a screen reclaim exactly what that screen padded', () => {
        const { bleeds, frames } = screenOf(IPHONE_LANDSCAPE, 1);
        expect(bleeds[1].margin).toEqual({ left: -59, right: -59 });
        expect(frames[1].padding).toEqual({ left: 59, right: 59 });
    });

    it('reports the headers it hosts as unpadded so chrome extends while its content stays safe', () => {
        const { bleeds } = screenOf(DUO_FOLDED);
        expect(bleeds[0].child).toEqual({ left: 0, right: 84, padded: false });
    });

    it('does not inset natively presented modals, which never sit under the window edge insets', () => {
        const bleed = resolveNavigatorBleed(resolveHorizontalSafeAreaRoot(DUO_FOLDED).child);
        const frame = resolveScreenFrameInsets(bleed.child, { presentedOutsideNavigator: true });
        expect(frame.padding).toEqual({ left: 0, right: 0 });
        expect(resolveNavigatorBleed(frame.child).margin).toEqual({ left: 0, right: 0 });
    });

    it('gives the window leading edge to a docked sidebar and only the trailing edge to content', () => {
        const root = resolveHorizontalSafeAreaRoot({ left: 30, right: 84 }).child;
        const split = resolveSidebarInsetSplit(root, { sidebarShown: true });
        expect(split.sidebar).toEqual({ margin: -30, padding: 30 });
        expect(resolveNavigatorBleed(split.content).margin).toEqual({ left: 0, right: -84 });

        const hidden = resolveSidebarInsetSplit(root, { sidebarShown: false });
        expect(hidden.sidebar).toEqual({ margin: 0, padding: 0 });
        expect(hidden.content).toBe(root);
    });

    it('is a no-op wherever the window has no side insets (iPad, desktop, web, portrait phones)', () => {
        const { bleeds, frames } = screenOf({ left: 0, right: 0 }, 1);
        for (const bleed of bleeds) expect(bleed.margin).toEqual({ left: 0, right: 0 });
        for (const frame of frames) expect(frame.padding).toEqual({ left: 0, right: 0 });
    });

    it('reaches the window edge through every nested stack (root, app, settings) and pads each leaf exactly once', () => {
        const shellContent = (sidebarShown: boolean) => resolveSidebarInsetSplit(
            resolveHorizontalSafeAreaRoot({ left: 0, right: 84 }).child,
            { sidebarShown },
        ).content;
        for (const sidebarShown of [false, true]) {
            let area = shellContent(sidebarShown);
            const margins = [];
            const paddings = [];
            for (let depth = 0; depth < 3; depth += 1) {
                const bleed = resolveNavigatorBleed(area);
                margins.push(bleed.margin.right);
                const frame = resolveScreenFrameInsets(bleed.child, { presentedOutsideNavigator: false });
                paddings.push(frame.padding.right);
                area = frame.child;
            }
            // Each stack container spans to the window edge, so no ancestor clips a nested header.
            expect(margins).toEqual([-84, -84, -84]);
            // Each screen keeps its content inside the bar; a screen's own content is never padded twice.
            expect(paddings).toEqual([84, 84, 84]);
            expect(resolveScreenFrameInsets(area, { presentedOutsideNavigator: false }).padding.right).toBe(0);
        }
    });
});
