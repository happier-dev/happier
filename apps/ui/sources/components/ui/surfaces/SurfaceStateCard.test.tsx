import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

/**
 * L0-2 — behavioral contract for the ONE shared surface terminal-state card
 * (audit XS-3). Every kind renders; the action fires; the human `reason` is
 * shown; the raw `diagnosticCode` never reaches visible text (testID channel
 * only).
 */
describe('SurfaceStateCard', () => {
    it.each(['empty', 'error', 'unavailable'] as const)('renders title and reason for kind=%s', async (kind) => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind={kind}
                title="Nothing to show"
                reason="Run your dev server and it appears here."
            />,
        );
        expect(screen.findByTestId('state-card')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Nothing to show');
        expect(screen.getTextContent()).toContain('Run your dev server and it appears here.');
    });

    it('hides its decorative icon from the accessibility tree', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Preview unavailable"
                reason="Human copy."
            />,
        );
        const icon = screen.findByTestId('state-card-icon');
        expect(icon?.props.accessibilityElementsHidden).toBe(true);
        expect(icon?.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('renders a spinner (not an icon) for kind=loading', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard testID="state-card" kind="loading" title="Connecting…" animationEnabled={false} />,
        );
        expect(screen.findByTestId('state-card-loading-spinner')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Connecting…');
    });

    it('renders a caller-supplied icon node when a surface owns the glyph', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="empty"
                title="Nothing here"
                icon={React.createElement('SurfaceStateCustomIcon', { testID: 'state-card-custom-icon' })}
            />,
        );
        expect(screen.findByTestId('state-card-custom-icon')).toBeTruthy();
    });

    it('fires the primary action and supports async pending', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const onPress = vi.fn();
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="error"
                title="Something went wrong"
                action={{ label: 'Retry', onPress }}
            />,
        );
        expect(screen.getTextContent()).toContain('Retry');
        await act(async () => {
            screen.pressByTestId('state-card-action');
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('fires the secondary action independently', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const onPrimary = vi.fn();
        const onSecondary = vi.fn();
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Preview unavailable"
                action={{ label: 'Retry', onPress: onPrimary }}
                secondaryAction={{ label: 'Open in browser', onPress: onSecondary }}
            />,
        );
        await act(async () => {
            screen.pressByTestId('state-card-secondary-action');
        });
        expect(onSecondary).toHaveBeenCalledTimes(1);
        expect(onPrimary).not.toHaveBeenCalled();
    });

    it('never renders the raw diagnostic code in visible text; keeps it on the testID channel', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Stream unavailable"
                reason="The device preview is unavailable right now."
                diagnosticCode="webcodecs_decoder_unavailable"
            />,
        );
        expect(screen.getTextContent()).not.toContain('webcodecs_decoder_unavailable');
        expect(screen.findByTestId('state-card-diagnostic-webcodecs_decoder_unavailable')).toBeTruthy();
    });

    it('does not use the raw diagnostic code as an accessibility label (XS-4 inversion guard)', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Stream unavailable"
                reason="Human copy."
                diagnosticCode="stream_error"
            />,
        );
        const withRawLabel = screen.findAll((node) => node.props?.accessibilityLabel === 'stream_error');
        expect(withRawLabel).toHaveLength(0);
    });
});
