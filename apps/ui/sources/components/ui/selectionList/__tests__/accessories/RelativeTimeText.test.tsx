import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const NOW = 1_700_000_000_000;

describe('RelativeTimeText', () => {
    it('renders the formatted relative time string', async () => {
        const { RelativeTimeText } = await import('../../accessories/RelativeTimeText');
        const screen = await renderScreen(
            <RelativeTimeText atMs={NOW - 5 * 60_000} nowMs={NOW} testID="rt" />,
        );
        expect(screen.getTextContent()).toContain('5m ago');
    });

    it('applies tabular-nums fontVariant to keep digit width stable', async () => {
        const { RelativeTimeText } = await import('../../accessories/RelativeTimeText');
        const screen = await renderScreen(
            <RelativeTimeText atMs={NOW - 5 * 60_000} nowMs={NOW} testID="rt2" />,
        );
        const node = screen.findByTestId('rt2');
        const flat = flatten(node?.props.style);
        expect(flat.fontVariant).toEqual(['tabular-nums']);
    });
});

function flatten(style: unknown): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return style.reduce<Record<string, any>>((a, s) => ({ ...a, ...flatten(s) }), {});
    if (typeof style === 'object') return style as Record<string, any>;
    return {};
}
