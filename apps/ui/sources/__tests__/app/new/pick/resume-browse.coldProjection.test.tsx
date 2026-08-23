import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const routeParamsState = vi.hoisted(() => ({
    value: {
        agentType: 'claude',
        dataId: 'draft-1',
        machineId: 'machine-cold',
        spawnServerId: 'server-cold',
    } as Record<string, string>,
}));
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => Promise<any>>(),
);
const browseScreenPropsRef = { current: null as Record<string, unknown> | null };

installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
    reactNavigationNative: async () => ({
        ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        useNavigation: () => navigationMock,
    }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    expoRouter: async () =>
        ({
            ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
                navigation: navigationMock,
                params: () => routeParamsState.value,
                router: {
                    push: routerMock.push,
                    back: routerMock.back,
                    replace: routerMock.replace,
                    setParams: routerMock.setParams,
                },
            }).module,
            useNavigation: () => navigationMock,
        }),
    storage: async () =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
            useSettings: () => ({} as any),
        }),
});

vi.mock('@/components/sessions/external/browse/ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: (props: Record<string, unknown>) => {
        browseScreenPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({ id: 'account-1' }),
    useLocalSetting: () => undefined,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: any[]) => machineContributionRegistryProjectionDescribeMock(...args),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => ({ machineId: 'machine-cold', backendTarget: null, backendNewSessionOptionStateByTargetKey: {} }),
}));

/**
 * These run against the REAL `canBrowseExternalSessions`, which answers from the daemon
 * projection: no projection means no browse capability, for a BUNDLED Agent exactly as
 * for a plugin carrier. That is what makes a cold load of this picker a wait rather than
 * a dismissal, and it is invisible to a suite that stubs the capability resolver.
 */
describe('ResumeBrowsePickerScreen cold projection', () => {
    beforeEach(() => {
        routeParamsState.value = {
            agentType: 'claude',
            dataId: 'draft-1',
            machineId: 'machine-cold',
            spawnServerId: 'server-cold',
        };
        browseScreenPropsRef.current = null;
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        machineContributionRegistryProjectionDescribeMock.mockReset();
        navigationMock.getState = () => ({
            index: 0,
            routes: [{
                key: 'resume-browse-route',
                name: '(app)/new/pick/resume-browse',
                path: '/new/pick/resume-browse',
            }],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('retains the picker while the bundled-Agent projection is still loading', async () => {
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise(() => {}));

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        const screen = await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(routerMock.back).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        expect(browseScreenPropsRef.current).toBeNull();
        expect(screen.findByTestId('external-sessions-browse-route-loading')).not.toBeNull();
    });

    it('dismisses once the projection authoritatively answers that browse is unavailable', async () => {
        let resolveProjection: ((value: unknown) => void) | undefined;
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise((resolve) => {
            resolveProjection = resolve;
        }));

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(routerMock.replace).not.toHaveBeenCalled();

        const projectionResolver = resolveProjection;
        if (typeof projectionResolver !== 'function') throw new Error('Expected a pending projection request');
        await act(async () => {
            projectionResolver({ supported: false, reason: 'not-supported' });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(browseScreenPropsRef.current).toBeNull();
        expect(routerMock.replace).toHaveBeenCalledWith('/new');
    });
});
