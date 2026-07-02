import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installRestoreRouteCommonModuleMocks } from './restoreRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

installRestoreRouteCommonModuleMocks();

vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: () => React.createElement('RestoreQrView', { testID: 'restore-show-qr-view' }),
}));

vi.mock('@/components/onboarding', () => ({
    WizardModalShell: (props: { children?: React.ReactNode }) =>
        React.createElement('WizardModalShell', { testID: 'restore-show-qr-wizard' }, props.children),
}));

vi.mock('@/components/onboarding/unauthShell', async () => {
    const React = await import('react');
    return {
        UnauthenticatedSplitShell: (props: {
            children?: React.ReactNode;
            stepId: string;
            isWelcomeStep: boolean;
            allowMobileBrandHero?: boolean;
            onOpenRelayCustomFlow: () => void;
            onBrandHeroGetStarted: () => void;
            onBack?: () => void;
        }) =>
            React.createElement(
                'UnauthenticatedSplitShell',
                {
                    stepId: props.stepId,
                    isWelcomeStep: props.isWelcomeStep,
                    allowMobileBrandHero: props.allowMobileBrandHero,
                    hasBack: typeof props.onBack === 'function',
                    testID: `unauth-shell-route-${props.stepId}`,
                },
                props.children,
            ),
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    standardCleanup();
});

describe('/restore/show-qr', () => {
    it('renders forced QR restore inside the unauthenticated split shell without mobile hero', async () => {
        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/restore/show-qr');
        const screen = await renderScreen(<Screen />);

        const shell = screen.findByTestId('unauth-shell-route-restore-show-qr');
        expect(shell).toBeTruthy();
        expect(shell?.props.stepId).toBe('restore-show-qr');
        expect(shell?.props.isWelcomeStep).toBe(false);
        expect(shell?.props.allowMobileBrandHero).toBe(false);
        expect(shell?.props.hasBack).toBe(true);
        expect(screen.findByTestId('restore-show-qr-view')).toBeTruthy();
    });
});
