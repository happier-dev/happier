import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 0, height: 0 }),
    });
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function flattenStyleProp(styleProp: unknown): Record<string, unknown> {
    const mergeInto = (out: Record<string, unknown>, value: unknown) => {
        if (!value) return;
        if (Array.isArray(value)) {
            for (const entry of value) mergeInto(out, entry);
            return;
        }
        if (typeof value === 'object') {
            Object.assign(out, value as Record<string, unknown>);
        }
    };
    const out: Record<string, unknown> = {};
    mergeInto(out, styleProp);
    return out;
}

describe('WizardCardLayout (windowWidth=0)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('still renders a non-zero card width instead of switching to fullscreen', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            scrollable: false,
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const scrim = screen.findByTestId('wizard-card-scrim');
        expect(scrim).toBeTruthy();

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }
        const flattenedCard = flattenStyleProp(card.props.style as unknown);
        expect(flattenedCard.width).toBeTruthy();
        expect(flattenedCard.width).not.toBe(0);
    });
});
