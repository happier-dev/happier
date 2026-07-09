import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import {
    TRANSCRIPT_NAVIGATION_RAIL_SOFT_EXIT_MS,
    useTranscriptNavigationRailSoftPresence,
} from './useTranscriptNavigationRailSoftPresence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
