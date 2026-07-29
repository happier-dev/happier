import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { LiveStreamPlayerPhase } from '@/sync/domains/machines/peer/mediation/stream/player';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    // Interpolate reasonCode into the resolved string (mirroring production `t(...)`)
    // so any leak of a raw internal code into visible text is detectable.
    return createTextModuleMock({
        translate: (key, params) => {
            if (params && typeof params === 'object' && 'reasonCode' in params) {
                return `${key}:${String((params as { reasonCode: unknown }).reasonCode)}`;
            }
            return key;
        },
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (acc, item) => Object.assign(acc, flattenStyle(item)),
            {},
        );
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

async function renderOverlay(phase: LiveStreamPlayerPhase, reasonCode?: string) {
    const { StreamDiagnosticsOverlay } = await import('./StreamDiagnosticsOverlay');
    return renderScreen(
        <StreamDiagnosticsOverlay
            phase={phase}
            preservingLastFrame={false}
            reasonCode={reasonCode}
            testID="overlay"
        />,
    );
}

describe('StreamDiagnosticsOverlay', () => {
    it('renders a pulsing live status dot beside the playing status', async () => {
        const screen = await renderOverlay('playing');

        expect(screen.findByTestId('overlay-status-playing')).toBeTruthy();
        const dot = screen.findByTestId('overlay-status-dot:dot');
        expect(dot).not.toBeNull();
        expect(flattenStyle(dot?.props.style).animationName).toBe('happierStatusDotPulse');
    });

    it('renders a non-pulsing dot while reconnecting (stale, not live)', async () => {
        const screen = await renderOverlay('reconnecting');

        expect(screen.findByTestId('overlay-status-reconnecting')).toBeTruthy();
        const dot = screen.findByTestId('overlay-status-dot:dot');
        expect(dot).not.toBeNull();
        expect(flattenStyle(dot?.props.style).animationName).toBeUndefined();
    });

    it('renders a non-pulsing dot on error', async () => {
        const screen = await renderOverlay('error', 'stream_error');

        expect(screen.findByTestId('overlay-status-error')).toBeTruthy();
        const dot = screen.findByTestId('overlay-status-dot:dot');
        expect(flattenStyle(dot?.props.style).animationName).toBeUndefined();
    });

    it('does not leak an unknown internal reason code into the visible error label (D-RC4)', async () => {
        const screen = await renderOverlay('error', 'external_url_unavailable');

        expect(screen.findByTestId('overlay-status-error')).toBeTruthy();
        // The catch-all error path renders a stream-local generic string, NOT the raw code.
        expect(screen.getTextContent()).toContain('streamPlayer.status.errorGeneric');
        expect(screen.getTextContent()).not.toContain('external_url_unavailable');
    });

    it('keeps the existing per-code mappings (narrow fix — only the catch-all stops interpolating)', async () => {
        const leaseScreen = await renderOverlay('error', 'input_lease_expired');
        expect(leaseScreen.getTextContent()).toContain('streamPlayer.status.leaseExpired');

        const permissionScreen = await renderOverlay('error', 'permission_expired');
        expect(permissionScreen.getTextContent()).toContain('streamPlayer.status.permissionExpired');

        const codecScreen = await renderOverlay('error', 'h264_renderer_unavailable');
        expect(codecScreen.getTextContent()).toContain('streamPlayer.status.degradedCodec');

        const bandwidthScreen = await renderOverlay('degraded', 'slow_consumer');
        expect(bandwidthScreen.getTextContent()).toContain('streamPlayer.status.lowBandwidth');
    });
});
