import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const routerBackSpy = vi.hoisted(() => vi.fn());
const safeRouterBackSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            back: routerBackSpy,
        },
    }).module;
});

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: unknown[]) => safeRouterBackSpy(...args),
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/components/sessions/guidance/useShouldBlockNewSessionWithGettingStartedGuidance', () => ({
    useShouldBlockNewSessionWithGettingStartedGuidance: () => false,
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: () => React.createElement('SessionGettingStartedGuidance'),
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: () => React.createElement('NewSessionSimplePanel'),
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: () => React.createElement('NewSessionWizard'),
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: () => ({
        variant: 'simple',
        simpleProps: {},
    }),
}));

vi.mock('@/components/sessions/new/navigation/newSessionContainedModalScreen', () => ({
    NewSessionScreenPortalScope: (props: { children?: React.ReactNode }) => React.createElement('NewSessionScreenPortalScope', null, props.children),
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    loadNewSessionDraft: () => null,
}));

vi.mock('@/sync/domains/state/newSessionCheckoutDraft', () => ({
    parseNewSessionCheckoutDraft: () => ({
        checkoutCreationDraft: null,
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useActiveServerAccountScope: () => null,
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

describe('NewSessionScreen web close affordance', () => {
    beforeEach(() => {
        routerBackSpy.mockReset();
        safeRouterBackSpy.mockReset();
    });

    it('renders a stable route-level close button that uses deterministic back fallback', async () => {
        const { default: NewSessionScreen } = await import('./index');

        const screen = await renderScreen(<NewSessionScreen />);

        const closeButtons = screen.tree.root
            .findAllByProps({ testID: 'new-session-cancel' })
            .filter((node) => node.props.accessibilityRole === 'button');
        expect(closeButtons).toHaveLength(1);

        await pressTestInstanceAsync(closeButtons[0]!);
        expect(safeRouterBackSpy).toHaveBeenCalledWith({
            router: expect.objectContaining({
                back: routerBackSpy,
            }),
            fallbackHref: '/',
        });
    });
});
