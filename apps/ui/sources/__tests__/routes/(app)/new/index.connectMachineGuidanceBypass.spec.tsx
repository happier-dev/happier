import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { View } from 'react-native';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
}));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: '/new',
        params: () => routeState.params,
    }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

vi.mock('@/sync/domains/state/persistence', () => ({
    loadNewSessionDraft: () => null,
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => ({ kind: 'connect_machine' }),
    SessionGettingStartedGuidance: (props: { variant: string }) => (
        <View testID={`guidance:${props.variant}`} />
    ),
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: () => <View testID="new-session-inner" />,
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: () => <View testID="new-session-inner" />,
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: () => ({ variant: 'simple', simpleProps: {} }),
}));

describe('/new connect-machine guidance bypass', () => {
    it('renders the new-session screen when a machine+directory intent is present', async () => {
        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/new');

        routeState.params = {};
        const screen = await renderScreen(<Screen key="initial" />);
        await act(async () => {});

        expect(screen.findAllByTestId('guidance:newSessionBlocking')).toHaveLength(1);
        expect(screen.findAllByTestId('new-session-inner')).toHaveLength(0);

        routeState.params = {
            machineId: 'machine-123',
            directory: '/Users/leeroy/wsrepl-qa-fixtures/large-repo-k8s',
        };

        act(() => {
            screen.tree.update(<Screen key="with-intent" />);
        });
        await act(async () => {});

        expect(screen.findAllByTestId('guidance:newSessionBlocking')).toHaveLength(0);
        expect(screen.findAllByTestId('new-session-inner')).toHaveLength(1);
    });
});
