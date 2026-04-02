import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';

describe('WizardChoiceRow', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders the command-palette style row and invokes the press handler', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');
        const onPress = vi.fn();

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Cloud',
            subtitle: 'Hosted relay',
            icon: 'cloud-outline',
            badge: 'Recommended',
            selected: true,
            onPress,
        }));

        expect(screen.findByTestId('wizard-choice')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Cloud');
        expect(screen.getTextContent()).toContain('Hosted relay');
        expect(screen.getTextContent()).toContain('Recommended');

        await act(async () => {
            await screen.pressByTestIdAsync('wizard-choice');
        });

        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('keeps the row disabled while allowing the secondary action button to remain interactive', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');
        const onPress = vi.fn();
        const onRetry = vi.fn();

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Offline Relay',
            subtitle: 'https://unreachable.example.test',
            icon: 'link-outline',
            badge: 'Unavailable',
            selected: true,
            disabled: true,
            secondaryAction: {
                testID: 'wizard-choice-retry',
                title: 'Retry',
                onPress: onRetry,
            },
            onPress,
        }));

        const row = screen.findByType(SelectableRow as never);
        expect(row.props.disabled).toBe(true);

        await act(async () => {
            await screen.pressByTestIdAsync('wizard-choice');
        });
        expect(onPress).toHaveBeenCalledTimes(0);

        await act(async () => {
            await screen.pressByTestIdAsync('wizard-choice-retry');
        });
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not invoke the row press handler when opening the overflow menu', async () => {
        const { WizardChoiceRow } = await import('./WizardChoiceRow');
        const onPress = vi.fn();
        const onRetry = vi.fn();

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Offline Relay',
            subtitle: 'https://unreachable.example.test',
            icon: 'link-outline',
            badge: 'Unreachable',
            selected: false,
            disabled: false,
            menuActions: [{
                id: 'retry',
                title: 'Retry',
                onPress: onRetry,
            }],
            onPress,
        }));

        const row = screen.findByType(SelectableRow as never);
        const overflowTrigger = screen.findByTestId('wizard-choice-menu');
        expect(overflowTrigger).toBeTruthy();

        await act(async () => {
            overflowTrigger!.props.onPress?.({} as any);
            row.props.onPress?.();
        });

        expect(onPress).toHaveBeenCalledTimes(0);
    });

    it('avoids nested button semantics on web when rendering the overflow menu trigger', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { WizardChoiceRow } = await import('./WizardChoiceRow');

        const screen = await renderScreen(React.createElement(WizardChoiceRow, {
            testID: 'wizard-choice',
            title: 'Relay',
            subtitle: 'http://relay.example.test',
            icon: 'link-outline',
            selected: false,
            menuActions: [{
                id: 'remove',
                title: 'Remove',
                onPress: vi.fn(),
            }],
            onPress: vi.fn(),
        }));

        const overflowTrigger = screen.findByTestId('wizard-choice-menu');
        expect(overflowTrigger).toBeTruthy();
        expect(overflowTrigger?.type).toBe('Pressable');
        expect(overflowTrigger?.props.accessibilityRole).toBe('button');
    });
});
