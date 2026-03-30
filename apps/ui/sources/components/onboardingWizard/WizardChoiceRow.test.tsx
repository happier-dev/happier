import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
});
