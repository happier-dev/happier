import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { SessionRowAttentionIndicator } from './SessionRowAttentionIndicator';

describe('SessionRowAttentionIndicator', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a stable attention-state test id for e2e selectors', async () => {
        const screen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="ready"
                sessionId="sess_ready"
                attentionState="ready"
                animationEnabled={false}
            />,
        );

        expect(screen.findByTestId('session-list-attention-indicator-sess_ready-ready')).toBeTruthy();
        expect(screen.findByTestId('session-row-attention-indicator-dot-sess_ready')).toBeTruthy();
    });

    it('renders working attention as a spinner when configured', async () => {
        const screen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="sess_working"
                attentionState="working"
                workingMode="spinner"
                animationEnabled={false}
            />,
        );

        expect(screen.findByTestId('session-list-attention-indicator-sess_working-working')).toBeTruthy();
        expect(screen.findByTestId('session-row-attention-indicator-spinner-sess_working')).toBeTruthy();
    });
});
