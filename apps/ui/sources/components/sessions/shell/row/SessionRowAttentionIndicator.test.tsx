import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { lightTheme } from '@/theme';

import { SessionRowAttentionIndicator } from './SessionRowAttentionIndicator';
import type { SessionRowAttentionIndicator as IndicatorKind } from './resolveSessionRowPresentation';

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

    it('draws the working spinner at 16 px so it reads beside the row\'s agent icons', async () => {
        const screen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="sess_size"
                attentionState="working"
                workingMode="spinner"
                animationEnabled={false}
            />,
        );

        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-sess_size');
        const style = [spinner?.props.style].flat(Infinity).reduce((acc, item) => Object.assign(acc, item), {});
        expect(style).toMatchObject({ width: 16, height: 16 });
    });

    it('speaks the one status vocabulary: needs-you in attention amber, failure in rose, everything else in the ink', async () => {
        const ink = lightTheme.colors.text.secondary;
        const amber = lightTheme.colors.state.attention.foreground;
        const rose = lightTheme.colors.state.danger.foreground;
        const markColor = async (indicator: IndicatorKind, workingMode?: 'spinner' | 'pulse') => {
            const screen = await renderScreen(
                <SessionRowAttentionIndicator
                    indicator={indicator}
                    sessionId={`sess_${indicator}`}
                    attentionState="ready"
                    workingMode={workingMode}
                    animationEnabled={false}
                />,
            );
            // The spinner or dot the indicator draws, as the indicator hands it its colour.
            const mark = screen.tree.root.findAll((node) => (
                typeof node.props.color === 'string'
                && typeof node.props.testID === 'string'
                && /^session-row-attention-indicator-(spinner|dot)-/.test(node.props.testID)
            ))[0];
            return mark?.props.color as string | undefined;
        };

        expect(await markColor('working', 'spinner')).toBe(ink);
        expect(await markColor('working', 'pulse')).toBe(ink);
        expect(await markColor('ready')).toBe(ink);
        expect(await markColor('unread')).toBe(ink);
        expect(await markColor('pending')).toBe(ink);
        expect(await markColor('standing')).toBe(ink);
        expect(await markColor('attention')).toBe(amber);
        expect(await markColor('permission')).toBe(amber);
        expect(await markColor('action')).toBe(amber);
        expect(await markColor('failed')).toBe(rose);
    });
});
