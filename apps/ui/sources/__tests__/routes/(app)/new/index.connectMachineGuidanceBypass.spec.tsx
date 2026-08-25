import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { View } from 'react-native';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
    modelInputs: [] as unknown[],
    setParams: vi.fn(),
    materialized: false,
    snapshot: {
        materialized: true,
        conflict: null,
        localSupplement: { launchUserAttemptId: null },
    },
    pointer: null as string | null,
    setPointer: vi.fn(),
    draftListeners: new Set<() => void>(),
    modelMounts: 0,
    modelUnmounts: 0,
    shouldBlockGuidance: true,
    resolveOrdinary: vi.fn(() => ({
        draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
        draftOrigin: 'ordinary' as const,
        resumedPrevious: false,
    })),
}));


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
        router: { setParams: routeState.setParams },
    }).module;
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => '4a506d8a-85bd-4c42-a662-6f502f3acc45',
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    deleteSessionDraft: vi.fn(),
    getSessionDraftSnapshot: () => routeState.materialized ? routeState.snapshot : null,
    subscribeSessionDraft: (_scope: unknown, _address: unknown, listener: () => void) => {
        routeState.draftListeners.add(listener);
        return () => routeState.draftListeners.delete(listener);
    },
}));
vi.mock('@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute', () => ({
    useResolveNewSessionOrdinaryEntryRoute: () => routeState.resolveOrdinary,
}));
vi.mock('@/sync/store/hooks', () => ({
    useSettingMutable: () => [routeState.pointer, routeState.setPointer],
    useActiveServerAccountScope: () => ({ serverId: 's1', accountId: 'a1' }),
}));
vi.mock('@/sync/domains/actionOperations/useActionOperations', () => ({ useAllActionOperations: () => [] }));
vi.mock('@/components/sessions/drafts/SessionDraftConflictResolution', () => ({
    SessionDraftConflictResolution: () => null,
    useSessionDraftConflictComposerBanner: () => ({ collapsed: false, statusBadge: null }),
}));
vi.mock('@/components/sessions/drafts/newSessionDraftPresentation', () => ({
    buildNewSessionDraftRowPresentation: () => ({ title: 'Draft' }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLaunchSelectionMachines: () => [],
        useMachineListByServerId: () => ({ s1: [] }),
    });
});

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: null,
    }),
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        activeTarget: { kind: 'server', id: 's1' },
        activeServerId: 's1',
        allowedServerIds: ['s1'],
    }),
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    loadNewSessionDraft: () => null,
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: (props: { variant: string }) => (
        <View testID={`guidance:${props.variant}`} />
    ),
}));
vi.mock('@/components/sessions/guidance/useShouldBlockNewSessionWithGettingStartedGuidance', () => ({
    useShouldBlockNewSessionWithGettingStartedGuidance: () => routeState.shouldBlockGuidance,
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: () => <View testID="new-session-inner" />,
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: () => <View testID="new-session-inner" />,
}));

vi.mock('@/components/sessions/new/navigation/newSessionContainedModalScreen', () => ({
    NewSessionScreenPortalScope: (props: { children?: React.ReactNode }) => (
        <View testID="new-session-portal-scope">{props.children}</View>
    ),
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: (input: unknown) => {
        React.useEffect(() => {
            routeState.modelMounts += 1;
            return () => {
                routeState.modelUnmounts += 1;
            };
        }, []);
        routeState.modelInputs.push(input);
        return { variant: 'simple', simpleProps: {} };
    },
}));

describe('/new connect-machine guidance bypass', () => {
    it('resolves a bare route through the ordinary-entry owner and preserves its origin', async () => {
        vi.resetModules();
        routeState.params = {};
        routeState.materialized = false;
        routeState.setParams.mockReset();
        routeState.resolveOrdinary.mockClear();
        const { default: Screen } = await import('@/app/(app)/new');

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(routeState.resolveOrdinary).toHaveBeenCalledWith();
        expect(routeState.setParams).toHaveBeenCalledWith({
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            draftOrigin: 'ordinary',
        });
    });

    it('remembers only a materialized draft opened from ordinary entry', async () => {
        vi.resetModules();
        routeState.params = {
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            draftOrigin: 'ordinary',
        };
        routeState.materialized = true;
        routeState.pointer = null;
        routeState.setPointer.mockReset();
        const { default: Screen } = await import('@/app/(app)/new');

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(routeState.setPointer).toHaveBeenCalledWith('4a506d8a-85bd-4c42-a662-6f502f3acc45');
    });

    it('renders the new-session screen when a machine+directory intent is present', async () => {
        vi.resetModules();
        routeState.shouldBlockGuidance = true;
        const { default: Screen } = await import('@/app/(app)/new');

        routeState.params = {};
        routeState.materialized = false;
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
        expect(routeState.modelInputs.at(-1)).toMatchObject({
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
        });
    });

    it('keeps the live composer owner mounted when the draft becomes materialized', async () => {
        vi.resetModules();
        routeState.shouldBlockGuidance = false;
        routeState.params = {};
        routeState.materialized = false;
        routeState.modelMounts = 0;
        routeState.modelUnmounts = 0;
        const { default: Screen } = await import('@/app/(app)/new');
        await renderScreen(<Screen />);
        await act(async () => {});
        expect(routeState.modelMounts).toBe(1);

        act(() => {
            routeState.materialized = true;
            for (const listener of routeState.draftListeners) listener();
        });
        await act(async () => {});

        expect(routeState.modelMounts).toBe(1);
        expect(routeState.modelUnmounts).toBe(0);
    });
});
