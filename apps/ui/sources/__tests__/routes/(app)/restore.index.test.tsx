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

vi.mock('@/components/onboarding', () => ({
    WizardModalShell: (props: { testID?: string; children?: React.ReactNode }) => (
        <View testID={props.testID}>{props.children}</View>
    ),
}));

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
});
