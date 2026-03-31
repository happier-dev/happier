import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';

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

    it('forces the relay footer hint to render as a single ellipsized line (so long URLs do not wrap)', async () => {
        const { WizardModalShell } = await import('./WizardModalShell');

        const footerHint = React.createElement(
            'View',
            { testID: 'wizard-shell-relay-hint' },
            React.createElement(
                Text,
                { testID: 'wizard-shell-relay-hint-line' },
                'Active relay: https://relay.example.test/this/is/a/very/long/url/that/should/not/wrap'
            )
        );

        const screen = await renderScreen(
            React.createElement(
                WizardModalShell,
                {
                    testID: 'wizard-shell',
                    stepIndex: 0,
                    stepCount: 3,
                    title: 'Title',
                    subtitle: 'Subtitle',
                    footerHint,
                    onPrimary: () => {},
                    children: React.createElement('View', { testID: 'wizard-shell-body' }),
                },
            ),
        );

        const relayLine = screen.findByTestId('wizard-shell-relay-hint-line')!;
        expect(relayLine.props.numberOfLines).toBe(1);
        expect(relayLine.props.ellipsizeMode).toBe('middle');
    });
});
