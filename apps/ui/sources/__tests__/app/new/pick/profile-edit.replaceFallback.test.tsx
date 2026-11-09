import { applyPickerFixtureSettings } from './testHarness';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
    ProfileRecordV1Schema, ProfileRowsListResponseV1Schema, ProfileRowMutationV1Schema,
    ProfileRowMutationResponseV1Schema, ProfileRowReadRequestV1Schema, ProfileRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { readAiLaunchProfileCollection } from '@happier-dev/protocol/profiles/read';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { refreshProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { parseToken } from '@/utils/auth/parseToken';

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
let savedRecord: ReturnType<typeof ProfileRecordV1Schema.parse> | null = null;
let profileRevision = 3;
const profileMutations: Array<ReturnType<typeof ProfileRowMutationV1Schema.parse>> = [];
const runtime = installSessionPaneRuntimeTestHarness({ configureSocket, request: async (url, init) => {
    const parsedUrl = new URL(String(url));
    const path = parsedUrl.pathname;
    const profileRoutes: readonly string[] = [PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1,
        PROFILE_REFERENCE_GUARD_ROUTE_V1, PROFILE_TRANSFER_ROUTE_V1, ACP_CATALOG_ROWS_ROUTE_V1];
    if (!profileRoutes.includes(path)) return null;
    expect(parsedUrl.origin).toBe('https://session-pane.test');
    const bearer = new Headers(init?.headers).get('authorization');
    expect(bearer?.startsWith('Bearer ')).toBe(true);
    expect(parseToken(bearer!.slice('Bearer '.length))).toBe('account-a');
    if (path === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') {
        const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        profileMutations.push(mutation);
        if (savedRecord || mutation.content?.t !== 'plain') throw new Error('Expected a single plain Account Profile creation');
        savedRecord = ProfileRecordV1Schema.parse(mutation.content.v);
        profileRevision = 4;
        return Response.json(ProfileRowMutationResponseV1Schema.parse({ status: 'updated', revision: profileRevision,
            cursor: profileRevision, referenceGuardRevision: profileRevision }));
    }
    if (path === PROFILE_RECORD_READ_ROUTE_V1 && init?.method === 'POST') {
        const { id } = ProfileRowReadRequestV1Schema.parse(JSON.parse(String(init.body)));
        return Response.json(ProfileRowReadResponseV1Schema.parse(savedRecord?.id === id
            ? { status: 'present', revision: profileRevision, content: { t: 'plain', v: savedRecord } }
            : { status: 'absent' }));
    }
    if (path === PROFILE_ROWS_ROUTE_V1) return Response.json(ProfileRowsListResponseV1Schema.parse({
        status: 'listed', rows: savedRecord ? [{ id: savedRecord.id, revision: profileRevision, content: { t: 'plain', v: savedRecord } }] : [],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: profileRevision, transferControl: { status: 'absent' },
    }));
    if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: profileRevision });
    if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
        status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: [] } },
    }));
    throw new Error('Unexpected Profile HTTP operation');
} });

beforeEach(async () => {
    const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');
    routeParams = {
        profileData: JSON.stringify({ ...createEmptyCustomProfile(), id: 'profile-new', name: 'Draft Profile' }),
        machineId: 'machine-2', dataId: 'draft-1', agentType: 'customAcp', spawnServerId: runtime.serverId,
    };
    savedRecord = null;
    profileRevision = 3;
    profileMutations.length = 0;
    await applyPickerFixtureSettings({ lastUsedAgent: 'customAcp', lastUsedBackendTarget: null });
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
        expect(readAiLaunchProfileCollection([JSON.parse(routeParams.profileData)]).entries)
            .toEqual([expect.objectContaining({ kind: 'slim', profile: expect.objectContaining({ id: 'profile-new', name: 'Draft Profile' }) })]);
        const screen = await renderScreen(<runtime.Wrapper><ProfileEditScreen /></runtime.Wrapper>);
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        await act(async () => { await refreshAcpCatalog(scope); await refreshProfileCatalog(scope); });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(getAcpCatalogSnapshot(scope)).toMatchObject({ scope, stale: false, catalog: { status: 'ready' } });
            expect(getProfileCatalogSnapshot(scope)).toMatchObject({ scope, stale: false, catalog: { status: 'ready' } });
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-2', serverId: runtime.serverId }))
                .toMatchObject({ kind: 'ready' });
        });
        expect(describeRequests).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'machine-2' })]));
        const name = screen.findHostByTestId('profile-slim-name');
        if (!name || typeof name.props.onChangeText !== 'function') throw new Error('Expected actual profile name field');
        await act(async () => name.props.onChangeText('New Profile'));
        const rememberedProfile = storage.getState().authoringMemory.lastUsedProfile;
        const retiredProfiles = storage.getState().settings;
        const save = screen.findHostByTestId('profile-edit-save');
        if (!save || typeof save.props.onPress !== 'function') throw new Error('Expected actual profile save action');
        await act(async () => save.props.onPress());
        await waitForHomeGovernance(() => expect(profileMutations).toHaveLength(1));
        expect(profileMutations[0]).toMatchObject({ id: 'profile-new', operation: 'create', expectedRevision: 'absent',
            content: { t: 'plain', v: { id: 'profile-new', definition: { kind: 'inline', profile: { v: 2, name: 'New Profile' } } } } });
        await act(async () => { await refreshProfileCatalog(scope); });
        expect(getProfileCatalogSnapshot(scope)?.data).toEqual([expect.objectContaining({ revision: 4, record: expect.objectContaining({
            id: 'profile-new', definition: { kind: 'inline', profile: expect.objectContaining({ v: 2, name: 'New Profile' }) },
        }) })]);
        expect(storage.getState().settings).toEqual(retiredProfiles);
        expect(storage.getState().authoringMemory.lastUsedProfile).toBe(rememberedProfile);
        await waitForHomeGovernance(() => expect(routerMock.replace).toHaveBeenCalledTimes(1));
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new', params: {
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude, dataId: 'draft-1', machineId: 'machine-2',
                profileId: 'profile-new', spawnServerId: runtime.serverId,
            },
        });
    });
});
