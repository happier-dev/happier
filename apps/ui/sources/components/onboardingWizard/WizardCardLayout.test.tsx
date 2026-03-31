import React from 'react';
import { Platform, StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

function flattenStyleProp(styleProp: unknown): Record<string, unknown> {
    const flattened = ReactNativeStyleSheet.flatten(styleProp as never);
    if (!flattened || typeof flattened !== 'object') return {};
    return flattened as Record<string, unknown>;
}

describe('WizardCardLayout', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not apply a fixed height clamp to the card container', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }

        const flattened = flattenStyleProp(card.props.style as unknown);

        expect(flattened.height).toBeUndefined();
        expect(flattened.maxHeight).toBeUndefined();
    });

    it('centers the wizard card using flexGrow instead of a percentage minHeight (so the outer container can scroll naturally)', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const scrollViews = screen.findAllByType('ScrollView' as never);
        expect(scrollViews).toHaveLength(1);
        const scrollView = scrollViews[0];

        if (Platform.OS === 'web') {
            const flattenedRoot = flattenStyleProp(scrollView.props.style as unknown);
            expect(flattenedRoot.position).toBe('fixed');
            expect(flattenedRoot.top).toBe(0);
            expect(flattenedRoot.left).toBe(0);
            expect(flattenedRoot.right).toBe(0);
            expect(flattenedRoot.bottom).toBe(0);
        }

        const flattened = flattenStyleProp(scrollView.props.contentContainerStyle as unknown);

        expect(flattened.flexGrow).toBe(1);
        expect(flattened.minHeight).toBeUndefined();
        expect(flattened.justifyContent).toBe('center');
        expect(flattened.alignItems).toBe('center');
    });

    it('uses a full-screen container layout when presentation=fullscreen (no chrome; content starts at the top)', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            presentation: 'fullscreen',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const scrollViews = screen.findAllByType('ScrollView' as never);
        expect(scrollViews).toHaveLength(1);
        const scrollView = scrollViews[0];

        const flattened = flattenStyleProp(scrollView.props.contentContainerStyle as unknown);

        expect(flattened.flexGrow).toBe(1);
        expect(flattened.minHeight).toBeUndefined();
        expect(flattened.justifyContent).toBe('flex-start');
        expect(flattened.alignItems).toBe('stretch');
    });

    it('supports a full-screen presentation variant for narrow/mobile layouts', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            presentation: 'fullscreen',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }

        const flattened = flattenStyleProp(card.props.style as unknown);

        expect(flattened.borderRadius).toBe(0);
    });
});
