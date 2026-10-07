import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import {
    createConfiguredBackendRouteParams, createNavigationMock, createRouterMock,
    createStackOptionsCapture, enableReactActEnvironment, installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const router = createRouterMock();
const navigation = createNavigationMock();
const capture = createStackOptionsCapture();
let params: Record<string, string> = {};

installPickerCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative'))
        .createReactNativeNativeMock({ platformOS: 'ios' }),
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        navigation, params: () => params, router, stackOptionsCapture: capture,
    }).module,
});
const runtime = installSessionPaneRuntimeTestHarness();

beforeEach(async () => {
    params = {};
    capture.reset();
    router.back.mockClear(); router.replace.mockClear(); router.setParams.mockClear();
    navigation.dispatch.mockClear(); navigation.goBack.mockClear(); navigation.setParams.mockClear();
    navigation.getState = () => ({
        index: 0, routes: [{ key: 'secret-requirement-route', name: '(app)/new/pick/secret-requirement', path: '/new/pick/secret-requirement' }],
    });
    storage.getState().applySettingsLocal({ profiles: [] });
    const { clearTempData } = await import('@/utils/sessions/tempDataStore');
    clearTempData();
});

async function renderPicker() {
    const Screen = (await import('@/app/(app)/new/pick/secret-requirement')).default;
    return renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(Screen)));
}

describe('SecretRequirementPickerScreen invalid route state', () => {
    it('dismisses itself when required route params are missing', async () => {
        await renderPicker();
        expect(router.replace).toHaveBeenCalledWith({ pathname: '/new', params: {} });
    });

    it('returns a one-shot cancel result with the current backend and exact Home when the profile is unavailable', async () => {
        params = {
            agentType: 'customAcp', ...createConfiguredBackendRouteParams('review-bot'),
            dataId: 'draft-1', machineId: 'machine-1', profileId: 'missing-profile',
            spawnServerId: runtime.serverId,
        };
        await renderPicker();
        expect(router.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredBackendRouteParams('review-bot'),
                dataId: 'draft-1', machineId: 'machine-1', profileId: 'missing-profile',
                secretRequirementResultId: expect.any(String), spawnServerId: runtime.serverId,
            },
        });
        const href = router.replace.mock.calls[0]?.[0];
        if (!href || typeof href !== 'object' || !('params' in href) || !href.params || typeof href.params !== 'object'
            || !('secretRequirementResultId' in href.params) || typeof href.params.secretRequirementResultId !== 'string') {
            throw new Error('Expected a result handoff in the new-session return route');
        }
        const { getTempData } = await import('@/utils/sessions/tempDataStore');
        const id = href.params.secretRequirementResultId;
        expect(getTempData<{ profileId: string; revertOnCancel: boolean; result: { action: string } }>(id)).toEqual({
            profileId: 'missing-profile', revertOnCancel: false, result: { action: 'cancel' },
        });
        expect(getTempData(id)).toBeNull();
    });
});
