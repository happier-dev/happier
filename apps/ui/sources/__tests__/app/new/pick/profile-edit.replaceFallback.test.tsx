import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMachineFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import {
    BUNDLED_AGENT_ROUTE_PARAMS, createDiscoveredPluginBackendDescribeResult,
    createNavigationMock, createRouterMock, enableReactActEnvironment, installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();
const routerMock = createRouterMock();
const navigationMock = {
    ...createNavigationMock(), setOptions: vi.fn(), addListener: vi.fn(() => () => {}),
};
let routeParams: Record<string, string> = {};
const describeRequests: Array<ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>> = [];
vi.mock('expo-constants', () => ({ default: { statusBarHeight: 0 } }));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));

installPickerCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            Platform: { isPad: false },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        });
    },
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        navigation: navigationMock, params: () => routeParams,
        router: { push: routerMock.push, back: routerMock.back, replace: routerMock.replace, setParams: routerMock.setParams },
    }).module,
});

function configureSocket(socket: import('socket.io-client').Socket) {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== 'rpc-call' || !payload || typeof payload !== 'object'
            || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
            throw new Error('Unexpected Socket RPC envelope');
        }
        if (payload.method === 'machine-2:' + RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(payload.params);
            describeRequests.push(request);
            return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1,
                projection: createDiscoveredPluginBackendDescribeResult().projection,
            }) };
        }
        return { ok: true, result: { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' } };
    });
}
const runtime = installSessionPaneRuntimeTestHarness({ configureSocket });

beforeEach(async () => {
    const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');
    routeParams = {
        profileData: JSON.stringify({ ...createEmptyCustomProfile(), id: 'profile-new' }),
        machineId: 'machine-2', dataId: 'draft-1', agentType: 'customAcp', spawnServerId: runtime.serverId,
    };
    storage.getState().applySettingsLocal({ profiles: [], lastUsedAgent: 'customAcp', lastUsedBackendTarget: null });
    storage.getState().applyMachines([createMachineFixture({
        id: 'machine-2', active: true, storageMode: 'plain', activeAt: Date.now(),
    })], true, { sourceServerId: runtime.serverId });
    describeRequests.length = 0;
    routerMock.replace.mockClear();
    routerMock.push.mockClear();
    routerMock.back.mockClear();
    navigationMock.dispatch.mockClear();
    navigationMock.goBack.mockClear();
    navigationMock.setParams.mockClear();
});

describe('ProfileEditScreen replace fallback', () => {
    it('uses the preferred bundled target for a legacy customAcp carrier despite admitted plugin backends', async () => {
        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
        const screen = await renderScreen(<runtime.Wrapper><ProfileEditScreen /></runtime.Wrapper>);
        await flushHookEffects();
        expect(describeRequests).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'machine-2' })]));
        const name = screen.findHostByTestId('profile-slim-name');
        if (!name || typeof name.props.onChangeText !== 'function') throw new Error('Expected actual profile name field');
        await act(async () => name.props.onChangeText('New Profile'));
        const rememberedProfile = storage.getState().authoringMemory.lastUsedProfile;
        const save = screen.findHostByTestId('profile-edit-save');
        if (!save || typeof save.props.onPress !== 'function') throw new Error('Expected actual profile save action');
        await act(async () => save.props.onPress());
        expect(storage.getState().settings.profiles).toEqual([expect.objectContaining({ id: 'profile-new', v: 2, name: 'New Profile' })]);
        expect(storage.getState().authoringMemory.lastUsedProfile).toBe(rememberedProfile);
        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new', params: {
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude, dataId: 'draft-1', machineId: 'machine-2',
                profileId: 'profile-new', spawnServerId: runtime.serverId,
            },
        });
    });
});
