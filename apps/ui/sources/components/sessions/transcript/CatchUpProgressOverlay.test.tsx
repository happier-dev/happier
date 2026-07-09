import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { TRANSCRIPT_BOTTOM_GUTTER_PX } from './_constants';
import { CatchUpProgressOverlay } from './CatchUpProgressOverlay';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OVERLAY_TEST_ID = 'transcript-catch-up-progress-overlay';
const SPINNER_DELAY_MS = 300;

type OverlayProps = React.ComponentProps<typeof CatchUpProgressOverlay>;

describe('CatchUpProgressOverlay', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    function render(props: OverlayProps) {
        return renderScreen(React.createElement(CatchUpProgressOverlay, props));
    }

    function advance(ms: number) {
        act(() => {
            vi.advanceTimersByTime(ms);
        });
    }

    it('renders nothing while not catching up', async () => {
        const screen = await render({ isCatchingUp: false, bottomInset: 80, spinnerDelayMs: SPINNER_DELAY_MS });
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeNull();
    });

    it('does not flash the spinner for a fast catch-up that settles before the delay', async () => {
        const screen = await render({ isCatchingUp: true, bottomInset: 80, spinnerDelayMs: SPINNER_DELAY_MS });
        advance(SPINNER_DELAY_MS - 50);
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeNull();

        // Catch-up settles before the delay -> spinner never appears.
        await screen.update(React.createElement(CatchUpProgressOverlay, { isCatchingUp: false, bottomInset: 80, spinnerDelayMs: SPINNER_DELAY_MS }));
        advance(500);
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeNull();
    });

    it('shows the spinner once catch-up is sustained past the delay', async () => {
        const screen = await render({ isCatchingUp: true, bottomInset: 80, spinnerDelayMs: SPINNER_DELAY_MS });
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeNull();
        advance(SPINNER_DELAY_MS + 10);
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeTruthy();
    });

    it('hides the spinner again once a sustained catch-up settles', async () => {
        const screen = await render({ isCatchingUp: true, bottomInset: 80, spinnerDelayMs: SPINNER_DELAY_MS });
        advance(SPINNER_DELAY_MS + 10);
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeTruthy();

        await screen.update(React.createElement(CatchUpProgressOverlay, { isCatchingUp: false, bottomInset: 80, spinnerDelayMs: SPINNER_DELAY_MS }));
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeNull();
    });

    it('shows the spinner immediately when the delay is zero', async () => {
        const screen = await render({ isCatchingUp: true, bottomInset: 80, spinnerDelayMs: 0 });
        expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeTruthy();
    });

    it('anchors a fixed gutter above the composer using the bottomInset prop', async () => {
        const screen = await render({ isCatchingUp: true, bottomInset: 120, spinnerDelayMs: 0 });
        const overlay = screen.findByTestId(OVERLAY_TEST_ID);
        expect(overlay).toBeTruthy();
        const style = Array.isArray(overlay!.props.style)
            ? Object.assign({}, ...overlay!.props.style)
            : overlay!.props.style;
        expect(style.position).toBe('absolute');
        expect(style.bottom).toBe(120 + TRANSCRIPT_BOTTOM_GUTTER_PX);
        expect(overlay!.props.pointerEvents).toBe('none');
    });
});
