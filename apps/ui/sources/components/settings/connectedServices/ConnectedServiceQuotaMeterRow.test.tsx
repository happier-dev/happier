import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        rowMeta: () => ({ fontSize: 91, lineHeight: 92 }),
        tabular: () => ({ fontVariant: ['tabular-nums'] }),
    },
}));

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
            if (key === 'connectedServices.quota.duration.hours') {
                return `translated-${String(params?.hours)}h`;
            }
            return key;
        },
    });
});

describe('ConnectedServiceQuotaMeterRow', () => {
    it('renders remaining-first labels with translated reset countdown and usage detail', async () => {
        const { ConnectedServiceQuotaMeterRow } = await import('./ConnectedServiceQuotaMeterRow');
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

        expect(screen.getTextContent()).toContain('18% left · resets in translated-2h');
        expect(screen.getTextContent()).toContain('82/100 used');
    });

    it('uses row-meta and tabular typography for quota detail text', async () => {
        const { ConnectedServiceQuotaMeterRow } = await import('./ConnectedServiceQuotaMeterRow');

        const { tree } = await renderScreen(
            <ConnectedServiceQuotaMeterRow
                meter={{
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: 1_000_000 + 2 * 60 * 60 * 1000,
                    status: 'ok',
                    details: {},
                }}
                nowMs={1_000_000}
                pinned={false}
                onTogglePin={() => {}}
            />,
        );

        const usageNode = tree.root.findAll((node) => node.props?.children === '82/100 used')[0];
        const remainingNode = tree.root.findAll((node) => node.props?.children === '18% left · resets in translated-2h')[0];

        expect(usageNode?.props.style).toEqual(expect.objectContaining({ fontSize: 91, lineHeight: 92 }));
        expect(remainingNode?.props.style).toEqual(expect.objectContaining({
            fontSize: 91,
            lineHeight: 92,
            fontVariant: ['tabular-nums'],
        }));
    });

    it('renders unknown remaining quota as a dash without a remaining suffix', async () => {
        const { ConnectedServiceQuotaMeterRow } = await import('./ConnectedServiceQuotaMeterRow');

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
