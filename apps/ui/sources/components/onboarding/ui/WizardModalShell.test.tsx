import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { SoftSlideTransitionFrame } from '@/components/ui/motion/SoftSlideTransitionFrame';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/onboarding/ui/WizardCardLayout', () => ({
    WizardCardLayout: ({ children, testID, showScrim, scrollable }: { children: React.ReactNode; testID?: string; showScrim?: boolean; scrollable?: boolean }) =>
        React.createElement('WizardCardLayout', { testID, showScrim, scrollable }, children),
    useWizardCardLayoutMetrics: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('WizardModalShell', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not retain a routine slide frame for first-run wizard steps', async () => {
        const { WizardModalShell } = await import('./WizardModalShell');
        const screen = await renderScreen(
            <WizardModalShell
                testID="wizard-shell"
                stepIndex={0}
                stepCount={2}
                title="Title"
                contentTransitionKey="step-one"
            >
                <Text testID="step-body">Body</Text>
            </WizardModalShell>,
        );

        expect(screen.findAllByType(SoftSlideTransitionFrame as never)).toHaveLength(0);
        expect(screen.findByTestId('step-body')).toBeTruthy();
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

    it('renders structured footer hints unchanged so their canonical component owns truncation', async () => {
        const { WizardModalShell } = await import('./WizardModalShell');

        const footerHint = React.createElement(
            'View',
            { testID: 'wizard-shell-relay-hint' },
                React.createElement(
                    Text,
                    { testID: 'wizard-shell-relay-hint-line' },
                'Active server: https://relay.example.test/this/is/a/very/long/url/that/should/not/wrap'
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
        expect(relayLine.props.numberOfLines).toBeUndefined();
        expect(relayLine.props.ellipsizeMode).toBeUndefined();
    });

    it('disables the internal WizardCardLayout scrim when nested in a BaseModal even on the first render', async () => {
        const { WizardModalShell } = await import('./WizardModalShell');

        const screen = await renderScreen(
            React.createElement(
                ModalBoundaryProvider,
                {
                    children: React.createElement(WizardModalShell, {
                        testID: 'wizard-shell',
                        stepIndex: 0,
                        stepCount: 1,
                        title: 'Title',
                        subtitle: 'Subtitle',
                        onPrimary: () => {},
                        children: React.createElement('View', { testID: 'wizard-shell-body' }),
                    }),
                },
            ),
        );

        const layout = screen.findByType('WizardCardLayout' as never);
        expect(layout.props.showScrim).toBe(false);
        expect(layout.props.scrollable).toBe(false);
    });

    it('allows callers to disable the internal scrim even when not nested in a BaseModal (for embedded window surfaces)', async () => {
        const { WizardModalShell } = await import('./WizardModalShell');

        const screen = await renderScreen(
            React.createElement(WizardModalShell, {
                testID: 'wizard-shell',
                stepIndex: 0,
                stepCount: 1,
                title: 'Title',
                subtitle: 'Subtitle',
                showScrim: false,
                onPrimary: () => {},
                children: React.createElement('View', { testID: 'wizard-shell-body' }),
            }),
        );

        const layout = screen.findByType('WizardCardLayout' as never);
        expect(layout.props.showScrim).toBe(false);
    });
});
