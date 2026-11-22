import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

// The window's own measured safe region. A phone with a notch reports it; the
// notice floats over everything and has to consume it like any other chrome.
vi.mock('@/hooks/ui/useOptionalSafeAreaInsets', () => ({
    ZERO_SAFE_AREA_INSETS: { top: 0, right: 0, bottom: 0, left: 0 },
    useOptionalSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

import { publishPresentationNotice, readPresentationNotice, retirePresentationNotice } from './presentationNotices';
import { PresentationNoticeHost } from './PresentationNoticeHost';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    retirePresentationNotice();
    standardCleanup();
});

describe('PresentationNoticeHost', () => {
    it('starts the addressed repository only when the person presses its ready notice', async () => {
        const run = vi.fn();
        publishPresentationNotice({ key: 'repo-ready', message: 'Example is ready', severity: 'info',
            action: { label: 'Start on Example', run } });
        const screen = await renderScreen(<PresentationNoticeHost />);
        expect(run).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('current-session-presentation-notice-action');
        expect(run).toHaveBeenCalledOnce();
        expect(readPresentationNotice()).toBeNull();
    });

    it('keeps a sticky inverse until exact retirement or replacement, then resumes transient expiry', async () => {
        vi.useFakeTimers();
        try {
            publishPresentationNotice({ key: 'sticky', message: 'Version replaced', severity: 'info', sticky: true,
                undo: { label: 'Undo', run: () => {} } });
            await renderScreen(<PresentationNoticeHost />);
            await React.act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
            expect(readPresentationNotice()?.key).toBe('sticky');
            await React.act(async () => {
                publishPresentationNotice({ key: 'newer', message: 'Saved', severity: 'info' });
                retirePresentationNotice('sticky');
            });
            expect(readPresentationNotice()?.key).toBe('newer');
            await React.act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
            expect(readPresentationNotice()).toBeNull();
        } finally { vi.useRealTimers(); }
    });

    it('clears the window safe region instead of resting under the notch', async () => {
        publishPresentationNotice({
            key: 'notice-safe-area',
            message: 'Added to Companion',
            severity: 'info',
        });

        const screen = await renderScreen(<PresentationNoticeHost />);
        const style = flattenTestStyle(
            screen.findByTestId('current-session-presentation-notice')?.props.style,
        );

        expect(style.top).toBeGreaterThanOrEqual(47);
    });

    it('stays out of the way of touches while its one control stays reachable', async () => {
        const run = vi.fn();
        publishPresentationNotice({
            key: 'notice-undo',
            message: 'Added to Companion',
            severity: 'info',
            undo: { label: 'Undo', run },
        });

        const screen = await renderScreen(<PresentationNoticeHost />);

        // Empty space beside the card must pass touches through to whatever the
        // app is showing, while the card's own control stays hit-testable. The
        // overlay owner picks the channel per platform — the React Native prop
        // on native, the style cascade on web — so read whichever it used. A
        // plain `none` on either channel would take Undo out of hit testing.
        const host = screen.findByTestId('current-session-presentation-notice');
        expect(host?.props.pointerEvents ?? flattenTestStyle(host?.props.style).pointerEvents)
            .toBe('box-none');
        expect(screen.findByTestId('current-session-presentation-notice-undo')?.props.accessibilityLabel)
            .toBe('Undo');

        await screen.pressByTestIdAsync('current-session-presentation-notice-undo');
        expect(run).toHaveBeenCalledOnce();
        // A used Undo retires its notice instead of lingering for the timeout.
        expect(screen.findByTestId('current-session-presentation-notice')).toBeNull();
    });

    it('lets a sticky notice be dismissed without running its inverse, and gives a transient notice no dismiss', async () => {
        const run = vi.fn();
        publishPresentationNotice({ key: 'set-aside', message: 'Your edits were set aside', severity: 'info', sticky: true,
            undo: { label: 'Undo', run } });
        const screen = await renderScreen(<PresentationNoticeHost />);
        await screen.pressByTestIdAsync('current-session-presentation-notice-dismiss');
        expect(run).not.toHaveBeenCalled();
        expect(readPresentationNotice()).toBeNull();
        await React.act(async () => { publishPresentationNotice({ key: 'saved', message: 'Saved', severity: 'info' }); });
        expect(screen.findByTestId('current-session-presentation-notice-dismiss')).toBeNull();
    });
});
