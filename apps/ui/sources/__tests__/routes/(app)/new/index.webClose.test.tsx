import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const routerBackSpy = vi.hoisted(() => vi.fn());
const safeRouterBackSpy = vi.hoisted(() => vi.fn());
const windowState = vi.hoisted(() => ({
    width: 800,
    height: 600,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: windowState.width, height: windowState.height }),
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: { draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e' },
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

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: () => React.createElement('SessionGettingStartedGuidance'),
    useShouldBlockNewSessionWithGettingStartedGuidance: () => false,
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

vi.mock('@/sync/domains/state/newSessionCheckoutDraft', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/newSessionCheckoutDraft')>()),
    parseCheckoutCreationDraft: () => null,
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    getSessionDraftSnapshot: () => null,
    subscribeSessionDraft: () => () => {},
    deleteSessionDraft: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/actionOperations/useActionOperations', () => ({
    useAllActionOperations: () => [],
}));

vi.mock('@/sync/domains/actionOperations/actionOperationReentry', () => ({
    resolvePersistedNewSessionOperationIdentity: () => null,
}));

vi.mock('@/sync/store/hooks', () => ({
    useActiveServerAccountScope: () => null,
    useSetting: (key: string) => key === 'newSessionDraftEntryMode' ? 'resumePrevious' : false,
    useLocalSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

describe('NewSessionScreen web close affordance', () => {
    beforeEach(() => {
        routerBackSpy.mockReset();
        safeRouterBackSpy.mockReset();
        windowState.width = 800;
        windowState.height = 600;
    });

    it('does not render the route-level close button on desktop web', async () => {
        const { default: NewSessionScreen } = await import('@/app/(app)/new');

        const screen = await renderScreen(<NewSessionScreen />);

        const closeButtons = screen.tree.root
            .findAllByProps({ testID: 'new-session-cancel' })
            .filter((node) => node.props.accessibilityRole === 'button');
        expect(closeButtons).toHaveLength(0);
    });

    it('renders a mobile-web route-level close button that uses deterministic back fallback', async () => {
        windowState.width = 390;
        const { default: NewSessionScreen } = await import('@/app/(app)/new');

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
