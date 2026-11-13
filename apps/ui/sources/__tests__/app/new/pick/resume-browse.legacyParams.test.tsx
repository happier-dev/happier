import { applyPickerFixtureSettings } from './testHarness';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createNavigationMock,
    createProjectionDescribeMock,
    createRouterMock,
    createSupportedClaudeProjection,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const describeProjection = createProjectionDescribeMock();
const routeParamsState = vi.hoisted(() => ({
    value: {
        providerId: ['claude', 'ignored'],
        machineId: ['machine-9', 'ignored'],
        serverId: ['server-4', 'ignored'],
        dataId: ['draft-7', 'ignored'],
    } as Record<string, string | string[]>,
}));
await installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }),
    reactNavigationNative: async () => ({
        ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        useNavigation: () => navigationMock,
    }),
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
    projectionSeam: {
        describe: describeProjection,
        serverProfiles: [{ id: 'server-4', serverUrl: 'https://server-4.example.test' }],
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
});

// Resolve the real runtime graph during collection, before the lifecycle hook's deadline.
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
await import('@/app/(app)/new/pick/resume-browse');

describe('ResumeBrowsePickerScreen legacy param compatibility', () => {
    beforeEach(async () => {
        routeParamsState.value = {
            providerId: ['claude', 'ignored'],
            machineId: ['machine-9', 'ignored'],
            serverId: ['server-4', 'ignored'],
            dataId: ['draft-7', 'ignored'],
        };
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        await applyPickerFixtureSettings(settingsParse({ lastUsedAgent: 'claude' }));
        describeProjection.mockResolvedValue({ supported: true, projection: createSupportedClaudeProjection() });
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
    });

    afterEach(async () => {
        await standardCleanup();
    });

    it('accepts legacy providerId/serverId array params and uses them as the browse lock scope', async () => {
        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        const { ExternalSessionsBrowseScreen } = await import('@/components/sessions/external/browse/ExternalSessionsBrowseScreen');

        const screen = await renderScreen(React.createElement(ResumeBrowsePickerScreen));

        await vi.waitFor(() => expect(screen.findAllByType(ExternalSessionsBrowseScreen).at(0)?.props.lockScope).toEqual(expect.objectContaining({
            machineId: 'machine-9',
            serverId: 'server-4',
            providerId: 'claude',
        })));
    });
});
