import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844 }),
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

describe('WizardCardLayout (narrow viewport)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('auto-switches to fullscreen presentation on narrow web/mobile widths', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(
            React.createElement(WizardCardLayout, {
                testID: 'wizard-card',
                presentation: 'auto',
                scrollable: false,
                children: React.createElement('View', { testID: 'wizard-child' }),
            }),
        );

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }

        const root = (card as any).parent as { props?: Record<string, unknown> } | null;
        if (!root) {
            throw new Error('Expected WizardCardLayout root container to be present.');
        }

        const flattenedRoot = flattenStyleProp(root.props?.style);
        expect(flattenedRoot.backgroundColor).toBeTruthy();

        const flattenedCard = flattenStyleProp(card.props.style as unknown);
        expect(flattenedCard.borderRadius).toBe(0);
        expect(flattenedCard.maxWidth).toBe('100%');
    });
});
