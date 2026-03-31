import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('./WizardCardLayout', () => ({
    WizardCardLayout: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
        React.createElement('WizardCardLayout', { testID }, children),
    useWizardCardLayoutMetrics: () => null,
}));

describe('WizardModalShell', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders the body without an internal scroll view (the wizard layout owns scrolling)', async () => {
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

        expect(screen.findAllByType('ScrollView' as never)).toHaveLength(0);
        expect(screen.findByTestId('wizard-shell-body')).toBeTruthy();
    });
});
