import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import { ConnectedServiceQuotaMeterRow } from './ConnectedServiceQuotaMeterRow';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (key === 'connectedServices.quota.remainingWithReset') {
                return `${String(params?.percent)} left · resets in ${String(params?.reset)}`;
            }
            if (key === 'connectedServices.quota.usageCount') {
                return `${String(params?.used)}/${String(params?.limit)} used`;
            }
            if (key === 'connectedServices.quota.duration.hoursMinutesSeconds') {
                return `translated-${String(params?.hours)}h ${String(params?.minutes)}m ${String(params?.seconds)}s`;
            }
            return key;
        },
    });
});

describe('ConnectedServiceQuotaMeterRow', () => {
    it('renders remaining quota text and a remaining-filled bar state', async () => {

        const nowMs = 1_000_000;
        const screen = await renderScreen(
            <ConnectedServiceQuotaMeterRow
                meter={{
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: nowMs + 2 * 60 * 60 * 1000,
                    status: 'ok',
                    details: {},
                }}
                nowMs={nowMs}
                pinned={false}
                onTogglePin={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('18% left · resets in translated-2h 0m 0s');
        expect(screen.getTextContent()).toContain('82/100 used');

        const bar = screen.findByTestId('connected-service-quota-meter-row:remaining-bar:fill');
        const style = flattenStyle(bar?.props?.style);
        // Remaining-first fill: the label says "18% left", so the bar fills 18% (battery model;
        // user decision 2026-07-10 reverting the consumption-fill flip in 5ad4d06be).
        expect(style.width).toBe('18%');
        expect(style.backgroundColor).toBe(lightTheme.colors.state.warning.foreground);
    });

    it('renders unavailable reported numbers without usage counts or critical capacity', async () => {
        const screen = await renderScreen(<ConnectedServiceQuotaMeterRow meter={{
            meterId: 'disabled', label: 'Disabled', used: 100, limit: 100, unit: 'count',
            utilizationPct: 100, remainingPct: 0, resetsAt: null, status: 'unavailable', details: {},
        }} nowMs={1_000_000} pinned onTogglePin={() => {}} />);
        expect(screen.getTextContent()).toContain('—');
        expect(screen.getTextContent()).not.toContain('100/100 used');
        const bar = screen.findByTestId('connected-service-quota-meter-row:remaining-bar:fill');
        expect(flattenStyle(bar?.props?.style).backgroundColor).toBe(lightTheme.colors.state.neutral.foreground);
    });

    it('renders unknown remaining quota as an unavailable dash without a remaining suffix', async () => {

        const screen = await renderScreen(
            <ConnectedServiceQuotaMeterRow
                meter={{
                    meterId: 'oauth_apps',
                    label: 'Weekly (OAuth apps)',
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: {},
                }}
                nowMs={1_000_000}
                pinned={false}
                onTogglePin={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('—');
        expect(screen.getTextContent()).not.toContain('— left');
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
