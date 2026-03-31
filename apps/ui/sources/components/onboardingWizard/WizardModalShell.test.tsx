import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

describe('WizardModalShell', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders the body inside a scroll view so taller steps can scroll within the modal', async () => {
        const { WizardModalShell } = await import('./WizardModalShell');

        const screen = await renderScreen(
            React.createElement(
                WizardModalShell,
                {
                    testID: 'wizard-shell',
                    stepIndex: 0,
                    stepCount: 3,
                    title: 'Title',
                    subtitle: 'Subtitle',
                    onPrimary: () => {},
                    children: React.createElement('View', { testID: 'wizard-shell-body' }),
                },
            ),
        );

        expect(screen.findByType('ScrollView')).toBeTruthy();
        expect(screen.findByTestId('wizard-shell-body')).toBeTruthy();
    });
});
