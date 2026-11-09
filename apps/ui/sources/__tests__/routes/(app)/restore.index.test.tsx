import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/onboarding/restore/RestoreIndexEmbedded', () => ({
    RestoreIndexEmbedded: () => <View testID="restore-embedded" />,
}));

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: vi.fn(),
}));

describe('/restore route', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('exposes the unauthenticated restore route selector surface', async () => {
        const { default: RestoreIndex } = await import('@/app/(app)/restore');
        const screen = await renderScreen(<RestoreIndex />);

        expect(screen.findByTestId('unauth-shell-route-restore')).toBeTruthy();
        expect(screen.findByTestId('restore-route-content')).toBeTruthy();
        expect(screen.findByTestId('restore-wizard')).toBeTruthy();
        expect(screen.findByTestId('restore-embedded')).toBeTruthy();
    });

    it('composes the signed-out restore step in the welcome split workflow pane', async () => {
        const { default: RestoreIndex } = await import('@/app/(app)/restore');
        const screen = await renderScreen(<RestoreIndex />);

        expect(screen.findByTestId('unauth-shell-restore-wizard')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeTruthy();
        expect(screen.findByTestId('restore-wizard-title')).toBeTruthy();
    });

    it('keeps the focused wizard card when a signed-in person reaches restore from Settings', async () => {
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { default: RestoreIndex } = await import('@/app/(app)/restore');
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={{ token: 'signed-in-token', secret: 'secret' }}>
                <RestoreIndex />
            </InjectedAuthProvider>,
        );

        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeNull();
        expect(screen.findByTestId('restore-wizard')).toBeTruthy();
        expect(screen.findByTestId('restore-embedded')).toBeTruthy();
    });

    it('opens on link entry when a dead terminal link sends the person to paste a new one', async () => {
        const { router } = await import('expo-router');
        const { RestoreIndexEmbedded } = await import('@/components/onboarding/restore/RestoreIndexEmbedded');
        const { RESTORE_LINK_ENTRY_HREF } = await import('@/components/terminalConnect/terminalLinkProblem');
        router.setParams({ view: new URLSearchParams(RESTORE_LINK_ENTRY_HREF.split('?')[1]).get('view') ?? '' });
        const { default: RestoreIndex } = await import('@/app/(app)/restore');
        const screen = await renderScreen(<RestoreIndex />);

        expect(screen.findByType(RestoreIndexEmbedded as never)?.props.initialView).toBe('paste');
    });
});
