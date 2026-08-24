import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { View } from 'react-native';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
    screenModel: { variant: 'simple', simpleProps: {} } as any,
    lastWizardProps: null as any,
    shouldBlockGuidance: true,
    screenModelMounts: 0,
    screenModelUnmounts: 0,
    draftSnapshot: null as any,
    draftListeners: new Set<() => void>(),
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

vi.mock('@/sync/store/hooks', () => ({
    useActiveServerAccountScope: () => ({ serverId: 'server-a', accountId: 'account-a' }),
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    deleteSessionDraft: vi.fn(),
    getSessionDraftSnapshot: () => routeState.draftSnapshot,
    setOrdinaryEntryDraftId: vi.fn(),
    subscribeSessionDraft: (_scope: unknown, _address: unknown, listener: () => void) => {
        routeState.draftListeners.add(listener);
        return () => routeState.draftListeners.delete(listener);
    },
}));

vi.mock('@/sync/domains/actionOperations/useActionOperations', () => ({
    useAllActionOperations: () => [],
}));

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/persistence')>();
    return {
        ...actual,
        loadNewSessionDraft: () => null,
    };
});

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    useShouldBlockNewSessionWithGettingStartedGuidance: () => routeState.shouldBlockGuidance,
    useSessionGettingStartedGuidanceBaseModel: () => ({ kind: 'connect_machine' }),
    SessionGettingStartedGuidance: (props: { variant: string }) => (
        <View testID={`guidance:${props.variant}`} />
    ),
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: () => <View testID="new-session-inner" />,
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: (props: any) => {
        routeState.lastWizardProps = props;
        return <View testID="new-session-inner" />;
    },
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: () => {
        React.useEffect(() => {
            routeState.screenModelMounts += 1;
            return () => {
                routeState.screenModelUnmounts += 1;
            };
        }, []);
        return routeState.screenModel;
    },
}));

vi.mock('@/components/sessions/new/navigation/newSessionContainedModalScreen', () => ({
    NewSessionScreenPortalScope: ({ children }: { children: React.ReactNode }) => (
        <React.Fragment>{children}</React.Fragment>
    ),
}));

describe('/new connect-machine guidance bypass', () => {
    it('renders the new-session screen when a machine+directory intent is present', async () => {
        vi.resetModules();
        routeState.shouldBlockGuidance = true;
        routeState.draftSnapshot = null;
        routeState.screenModel = { variant: 'simple', simpleProps: {} };
        routeState.lastWizardProps = null;
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

    it('keeps the live composer owner mounted when the draft becomes seeded', async () => {
        vi.resetModules();
        routeState.shouldBlockGuidance = false;
        routeState.screenModel = { variant: 'simple', simpleProps: {} };
        routeState.screenModelMounts = 0;
        routeState.screenModelUnmounts = 0;
        routeState.draftSnapshot = null;
        routeState.params = {};
        const { default: Screen } = await import('@/app/(app)/new');

        const screen = await renderScreen(<Screen />);
        await act(async () => {});
        expect(routeState.screenModelMounts).toBe(1);

        // First local persistence changes this same presentation decision from
        // unseeded to seeded. That transition must not recreate the prompt store.
        act(() => {
            routeState.draftSnapshot = {
                address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000001' },
                document: {
                    target: { kind: 'newSession', authoring: {} },
                    composer: { text: { mutationId: 'text-1', value: '' } },
                },
                materialized: true,
                conflict: null,
                localSupplement: {},
            };
            for (const listener of routeState.draftListeners) listener();
        });
        await act(async () => {});

        expect(routeState.screenModelMounts).toBe(1);
        expect(routeState.screenModelUnmounts).toBe(0);
    });

    it('forwards wizard section presentation settings to the wizard', async () => {
        vi.resetModules();
        routeState.shouldBlockGuidance = true;
        routeState.draftSnapshot = null;
        const sectionPresentation = {
            machines: 'dropdown',
            paths: 'dropdown',
        };
        routeState.params = {
            machineId: 'machine-123',
            directory: '/Users/leeroy/project',
        };
        routeState.lastWizardProps = null;
        routeState.screenModel = {
            variant: 'wizard',
            popoverBoundaryRef: { current: null },
            wizardProps: {
                layout: {},
                sectionPresentation,
                profiles: {},
                agent: {},
                machine: {},
                footer: {},
            },
        };
        const { default: Screen } = await import('@/app/(app)/new');

        await renderScreen(<Screen />);

        expect(routeState.lastWizardProps?.sectionPresentation).toBe(sectionPresentation);
    });
});
