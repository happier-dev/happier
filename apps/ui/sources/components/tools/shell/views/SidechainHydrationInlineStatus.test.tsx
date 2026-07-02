import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    SidechainHydrationInlineStatus,
    shouldShowSidechainHydrationInlineStatus,
} from './SidechainHydrationInlineStatus';

describe('SidechainHydrationInlineStatus', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('shows the inline status for pending and terminal-failure statuses but not for idle/loaded/non-empty', () => {
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: 'c1', status: 'loading' })).toBe(true);
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: 'c1', status: 'in_flight' })).toBe(true);
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: 'c1', status: 'retrying' })).toBe(true);
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: 'c1', status: 'not_ready' })).toBe(true);
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: 'c1', status: 'error' })).toBe(true);

        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: 'c1', status: 'idle' })).toBe(false);
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: 'c1', status: 'loaded' })).toBe(false);
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 3, sidechainId: 'c1', status: 'loading' })).toBe(false);
        expect(shouldShowSidechainHydrationInlineStatus({ messageCount: 0, sidechainId: null, status: 'loading' })).toBe(false);
    });

    it('renders a spinner with loading copy while pending', async () => {
        const screen = await renderScreen(
            <SidechainHydrationInlineStatus status="loading" testID="sidechain-hydration-status" />,
        );

        expect(screen.findByTestId('sidechain-hydration-status')).not.toBeNull();
        const loadingText = screen.getTextContent();

        // in_flight is also a pending status and must show the same loading copy.
        await screen.update(
            <SidechainHydrationInlineStatus status="in_flight" testID="sidechain-hydration-status" />,
        );
        expect(screen.getTextContent()).toBe(loadingText);
    });

    it('uses a terminal unavailable affordance (no spinner, distinct copy) for error and not_ready', async () => {
        const loadingScreen = await renderScreen(
            <SidechainHydrationInlineStatus status="loading" testID="sidechain-hydration-status" />,
        );
        const loadingText = loadingScreen.getTextContent();
        standardCleanup();

        const screen = await renderScreen(
            <SidechainHydrationInlineStatus status="error" testID="sidechain-hydration-status" />,
        );
        const unavailableText = screen.getTextContent();

        // No spinner on a terminal-failure status.
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
        // Unavailable copy differs from the loading copy.
        expect(unavailableText).not.toBe(loadingText);

        await screen.update(
            <SidechainHydrationInlineStatus status="not_ready" testID="sidechain-hydration-status" />,
        );
        expect(screen.findByTestId('sidechain-hydration-status')).not.toBeNull();
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
        expect(screen.getTextContent()).toBe(unavailableText);
    });
});
