import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
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
});
