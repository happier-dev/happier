import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import {
    TRANSCRIPT_NAVIGATION_RAIL_SOFT_EXIT_MS,
    resolveTranscriptNavigationRailSoftFadeStyle,
    useTranscriptNavigationRailSoftPresence,
} from './useTranscriptNavigationRailSoftPresence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The fade resolver only emits CSS transitions on web, which is the only
// platform the rail renders on.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

type PresenceProps = Readonly<{ open: boolean; reducedMotion: boolean }>;

async function renderPresence(initial: PresenceProps) {
    return renderHook(
        (props: PresenceProps) => useTranscriptNavigationRailSoftPresence(props.open, props.reducedMotion),
        { initialProps: initial },
    );
}

describe('useTranscriptNavigationRailSoftPresence', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('mounts immediately when opened and never mounts while closed', async () => {
        const closed = await renderPresence({ open: false, reducedMotion: false });
        expect(closed.getCurrent()).toEqual({ mounted: false, shown: false });

        const opened = await renderPresence({ open: true, reducedMotion: false });
        expect(opened.getCurrent().mounted).toBe(true);
    });

    it('keeps the element mounted through the exit window before unmounting', async () => {
        const presence = await renderPresence({ open: true, reducedMotion: false });
        expect(presence.getCurrent().shown).toBe(true);

        await presence.rerender({ open: false, reducedMotion: false });
        // Fade-out starts: hidden for the transition, still mounted.
        expect(presence.getCurrent().shown).toBe(false);
        expect(presence.getCurrent().mounted).toBe(true);

        await act(async () => {
            vi.advanceTimersByTime(TRANSCRIPT_NAVIGATION_RAIL_SOFT_EXIT_MS + 20);
        });
        expect(presence.getCurrent().mounted).toBe(false);
    });

    it('unmounts instantly under reduced motion', async () => {
        const presence = await renderPresence({ open: true, reducedMotion: true });
        expect(presence.getCurrent()).toEqual({ mounted: true, shown: true });

        await presence.rerender({ open: false, reducedMotion: true });
        expect(presence.getCurrent()).toEqual({ mounted: false, shown: false });
    });

    it('travels an offset element to rest as it appears, and cross-fades only under reduced motion', () => {
        const hidden = resolveTranscriptNavigationRailSoftFadeStyle(false, false, { hiddenTranslateYPx: 4 });
        expect(hidden.opacity).toBe(0);
        expect(hidden.transform).toEqual([{ translateY: 4 }]);

        const shown = resolveTranscriptNavigationRailSoftFadeStyle(true, false, { hiddenTranslateYPx: 4 });
        expect(shown.opacity).toBe(1);
        expect(shown.transform).toEqual([{ translateY: 0 }]);

        // Reduced motion drops the travel entirely rather than shortening it.
        const reduced = resolveTranscriptNavigationRailSoftFadeStyle(false, true, { hiddenTranslateYPx: 4 });
        expect(reduced.opacity).toBe(0);
        expect(reduced.transform).toBeUndefined();

        // An offset-free caller keeps the original opacity-only transition, so
        // the glass preview never gains a transform that would kill its blur.
        expect(resolveTranscriptNavigationRailSoftFadeStyle(true, false).transform).toBeUndefined();
    });

    it('cancels a pending exit when reopened during the fade-out', async () => {
        const presence = await renderPresence({ open: true, reducedMotion: false });
        await presence.rerender({ open: false, reducedMotion: false });
        expect(presence.getCurrent().mounted).toBe(true);

        await presence.rerender({ open: true, reducedMotion: false });
        await act(async () => {
            vi.advanceTimersByTime(TRANSCRIPT_NAVIGATION_RAIL_SOFT_EXIT_MS * 3);
        });
        expect(presence.getCurrent()).toEqual({ mounted: true, shown: true });
    });
});
