import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
                options?.ios ?? options?.native ?? options?.default ?? options?.web ?? options?.android,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/onboarding/ui/WizardCardLayout', () => ({
    WizardCardLayout: ({
        children,
        testID,
        showScrim,
        scrollable,
    }: {
        children: React.ReactNode;
        testID?: string;
        showScrim?: boolean;
        scrollable?: boolean;
    }) => React.createElement('WizardCardLayout', { testID, showScrim, scrollable }, children),
    useWizardCardLayoutMetrics: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('WizardModalShell (native scrim rules)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('disables the internal WizardCardLayout scrim when nested in a BaseModal on native (avoids double-dimming)', async () => {
        const { WizardModalShell } = await import('./WizardModalShell');

        const screen = await renderScreen(
            React.createElement(
                ModalBoundaryProvider,
                {
                    children: React.createElement(WizardModalShell, {
                        testID: 'wizard-shell-native',
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
    });
});
