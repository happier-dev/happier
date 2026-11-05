import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installRestoreRouteCommonModuleMocks } from './restoreRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({ params: {} as Record<string, string> }));

installRestoreRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeState.params }).module;
    },
});

vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: (props: { targetProfileId?: string; entryIntent?: string }) => React.createElement('RestoreQrView', {
        testID: 'restore-show-qr-view',
        targetProfileId: props.targetProfileId,
        entryIntent: props.entryIntent,
    }),
}));

vi.mock('@/components/onboarding/ui/AuthRouteStepFrame', async () => {
    const React = await import('react');
    return {
        AuthRouteStepFrame: (props: {
            children?: React.ReactNode;
            testID: string;
            title: string;
            onBack?: () => void;
        }) =>
            React.createElement(
                'AuthRouteStepFrame',
                {
                    testID: props.testID,
                    title: props.title,
                    hasBack: typeof props.onBack === 'function',
                },
                props.children,
            ),
    };
});

const { default: Screen } = await import('@/app/(app)/restore/show-qr');

afterEach(() => {
    routeState.params = {};
    vi.restoreAllMocks();
    standardCleanup();
});

describe('/restore/show-qr', () => {
    it('does not mount reverse QR without an explicit target profile', async () => {
        const screen = await renderScreen(<Screen />);

        expect(screen.findByTestId('restore-show-qr-view')).toBeNull();
    });

    it('renders reverse QR for the exact requested profile in the titled step frame', async () => {
        routeState.params = { serverId: 'home-b-profile', entryIntent: 'add_home' };
        const screen = await renderScreen(<Screen />);

        const frame = screen.findByTestId('restore-show-qr');
        expect(frame).toBeTruthy();
        expect(frame?.props.title).toBeTruthy();
        expect(frame?.props.hasBack).toBe(true);
        expect(screen.findByTestId('restore-show-qr-view')?.props.targetProfileId).toBe('home-b-profile');
        expect(screen.findByTestId('restore-show-qr-view')?.props.entryIntent).toBe('add_home');
    });
});
