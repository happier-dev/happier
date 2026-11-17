import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';

import { createMachineFixture, renderScreen, findTestInstanceByTypeWithProps } from '@/dev/testkit';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveItemSubtitleMaxLines } from '@/components/ui/lists/itemTextClamp';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage, storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetMachinePoolSyncRuntimeForTests } from '@/sync/engine/machines/machinePoolSyncRuntime';

import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Only the navigation and HTTP boundaries are stubbed: the feature decision,
// projection owner, storage and HTTP transport below them stay real, and translation keys stand in
// for copy so the assertions describe presentation decisions rather than wording.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn() } }).module;
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({ isFocused: true });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const boundary = {
    serverId: '',
    requests: [] as string[],
    listedPools: [] as MachinePoolViewV1[],
    featureEnabled: true,
    featureFetchFails: false,
    featureFetchPending: false,
    poolListFails: false,
};
const initialStorageState = getStorage().getState();

const poolView = (id: string): MachinePoolViewV1 => ({
    pool: {
        id,
        name: 'Development',
        description: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        members: [{ machineId: 'machine-a', priorityTier: 0, enabled: true, state: 'connected' }],
    },
    availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
});

const POOL_A = poolView('00000000-0000-4000-8000-000000000001');
const POOL_B = poolView('00000000-0000-4000-8000-000000000002');

function machine(): Machine {
    const fixture = createMachineFixture({ id: 'machine-a' });
    return { ...fixture, metadata: fixture.metadata ? { ...fixture.metadata, displayName: 'Mac Studio' } : fixture.metadata };
}

function group(status: ActiveSelectionMachineGroup['status']): ActiveSelectionMachineGroup {
    return { serverId: boundary.serverId, serverName: 'Home A', status, machines: [machine()] };
}

async function publishPoolsFeature(enabled: boolean): Promise<void> {
    boundary.featureEnabled = enabled;
    resetServerFeaturesClientForTests();
    const features = buildServerFeaturesResponse();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        ...features,
        features: {
            ...features.features,
            machines: { ...features.features.machines, pools: { enabled } },
        },
    })));
    await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
}

function publishPools(pools: MachinePoolViewV1[]): void {
    boundary.listedPools = pools;
    storage.setState({
        profileScope: { serverId: boundary.serverId, accountId: 'account-a' },
        settingsScope: { serverId: boundary.serverId, accountId: 'account-a' },
        machinePoolListByServerId: { [boundary.serverId]: pools },
        machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
        machinePoolAccountIdByServerId: { [boundary.serverId]: 'account-a' },
    });
}

describe('MachinePoolsSection', () => {
    beforeEach(async () => {
        resetMachinePoolSyncRuntimeForTests();
        resetServerFeaturesClientForTests();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({
            serverUrl: 'https://machine-pools-section.test',
            name: 'Home A',
        })).id;
        boundary.requests.length = 0;
        boundary.featureEnabled = true;
        boundary.featureFetchFails = false;
        boundary.featureFetchPending = false;
        boundary.poolListFails = false;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        setRuntimeFetch(async (url) => {
            boundary.requests.push(String(url));
            if (String(url).endsWith('/v1/features')) {
                if (boundary.featureFetchPending) return new Promise<Response>(() => {});
                if (boundary.featureFetchFails) throw new Error('network_unreachable');
                const features = buildServerFeaturesResponse();
                return Response.json({
                    ...features,
                    features: {
                        ...features.features,
                        machines: { ...features.features.machines, pools: { enabled: boundary.featureEnabled } },
                    },
                });
            }
            if (String(url).endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (String(url).endsWith('/v2/account/settings')) return Response.json({ content: null, version: 0 });
            if (boundary.poolListFails) throw new Error('network_unreachable');
            return Response.json({ pools: boundary.listedPools });
        });
        await publishPoolsFeature(true);
        retireActiveServerAccountScopeLifetime();
        publishPools([POOL_A]);
    });

    afterEach(() => {
        resetMachinePoolSyncRuntimeForTests();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('is absent and requests nothing when the Home does not explicitly enable machine pools', async () => {
        await publishPoolsFeature(false);
        boundary.requests.length = 0;
        const { MachinePoolsSection } = await import('./MachinePoolsSection');

        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        expect(screen.tree.findAllByType(Item)).toHaveLength(0);
        expect(boundary.requests.some((url) => url.endsWith('/v1/machines/pools/list'))).toBe(false);
    });

    it('keeps feature discovery failure recoverable without treating an unknown decision as enabled', async () => {
        resetServerFeaturesClientForTests();
        boundary.featureFetchFails = true;
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        const { MachinePoolsSection } = await import('./MachinePoolsSection');

        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        expect(screen.findByTestId(`settings.machinePools.featureFailed.${boundary.serverId}`)).toBeTruthy();
        expect(screen.getTextContent()).toContain('machinePools.refreshFailed');
        const retainedRow = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${POOL_A.pool.id}` });
        expect(retainedRow?.props.title).toBe('Development');
        expect(retainedRow?.props.disabled).toBe(true);
        expect(retainedRow?.props.detail).toContain('machinePools.unavailable');
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.add.${boundary.serverId}` })).toBeUndefined();
        expect(boundary.requests.some((url) => url.endsWith('/v1/machines/pools/list'))).toBe(false);

        const callsBeforeRetry = boundary.requests.filter((url) => url.endsWith('/v1/features')).length;
        await screen.pressByTestIdAsync(`settings.machinePools.featureRetry.${boundary.serverId}`);
        await vi.waitFor(() => expect(boundary.requests.filter((url) => url.endsWith('/v1/features')).length).toBeGreaterThan(callsBeforeRetry));
    });

    it('waits for the Home Pool answer instead of flashing an empty section that then disappears', async () => {
        // No cached rows and an unresolved feature decision: most Homes resolve this to "disabled",
        // so rendering a Machine pools group here shows a section that vanishes a moment later.
        resetServerFeaturesClientForTests();
        boundary.featureFetchPending = true;
        storage.setState({
            machinePoolListByServerId: {},
            machinePoolListStatusByServerId: {},
            machinePoolAccountIdByServerId: {},
        });
        const { MachinePoolsSection } = await import('./MachinePoolsSection');

        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        expect(screen.tree.findAllByType(ItemGroup)).toHaveLength(0);
        expect(screen.findByTestId(`settings.machinePools.featureLoading.${boundary.serverId}`)).toBeFalsy();
    });

    it('does not advertise Pool administration after a cold feature-discovery failure', async () => {
        resetServerFeaturesClientForTests();
        boundary.featureFetchFails = true;
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        storage.setState({
            machinePoolListByServerId: {},
            machinePoolListStatusByServerId: {},
            machinePoolAccountIdByServerId: {},
        });
        const { MachinePoolsSection } = await import('./MachinePoolsSection');

        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        expect(screen.tree.findAllByType(ItemGroup)).toHaveLength(0);
        expect(screen.findByTestId(`settings.machinePools.featureFailed.${boundary.serverId}`)).toBeFalsy();
        expect(screen.findByTestId(`settings.machinePools.featureRetry.${boundary.serverId}`)).toBeFalsy();
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.add.${boundary.serverId}` })).toBeUndefined();
        expect(boundary.requests.some((url) => url.endsWith('/v1/machines/pools/list'))).toBe(false);
    });

    it('retains cached Pool rows inert while the Home feature decision is loading', async () => {
        resetServerFeaturesClientForTests();
        boundary.featureFetchPending = true;
        const { MachinePoolsSection } = await import('./MachinePoolsSection');

        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        await vi.waitFor(() => {
            expect(screen.findByTestId(`settings.machinePools.featureLoading.${boundary.serverId}`)).toBeTruthy();
            expect(findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${POOL_A.pool.id}` })).toBeDefined();
        });
        const retainedRow = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${POOL_A.pool.id}` });
        expect(retainedRow?.props.title).toBe('Development');
        expect(retainedRow?.props.disabled).toBe(true);
        expect(retainedRow?.props.detail).toContain('machinePools.unavailable');
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.add.${boundary.serverId}` })).toBeUndefined();
        expect(boundary.requests.some((url) => url.endsWith('/v1/machines/pools/list'))).toBe(false);
    });

    it('keeps cached rows readable but presents them as unavailable while the Home is signed out', async () => {
        const { MachinePoolsSection } = await import('./MachinePoolsSection');
        const screen = await renderScreen(<MachinePoolsSection groups={[group('signedOut')]} />);

        const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${POOL_A.pool.id}` });
        expect(row?.props.title).toBe('Development');
        expect(row?.props.disabled).toBe(true);
        expect(row?.props.detail).toContain('machinePools.unavailable');
        expect(row?.props.accessibilityLabel).toContain('machinePools.unavailable');
        expect(screen.findByTestId(`settings.machinePools.unavailable.${boundary.serverId}`)).toBeTruthy();
        expect(screen.getTextContent()).toContain('machinePools.homeOffline');
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.add.${boundary.serverId}` })?.props.disabled).toBe(true);
    });

    it('reports a refresh failure truthfully with an explicit Retry instead of claiming the Home is offline', async () => {
        // The read boundary fails, so the canonical projection records a failed status rather than
        // an offline Home. Everything below it stays real.
        boundary.poolListFails = true;
        storage.getState().setMachinePoolListStatus(boundary.serverId, 'error');
        const { MachinePoolsSection } = await import('./MachinePoolsSection');

        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        await vi.waitFor(() => {
            expect(screen.findByTestId(`settings.machinePools.refreshFailed.${boundary.serverId}`)).toBeTruthy();
        });
        expect(screen.findByTestId(`settings.machinePools.unavailable.${boundary.serverId}`)).toBeFalsy();
        expect(screen.getTextContent()).toContain('machinePools.refreshFailed');
        // Retained rows stay readable, but their connection summary is not presented as current.
        const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${POOL_A.pool.id}` });
        expect(row?.props.title).toBe('Development');
        expect(row?.props.detail).toContain('machinePools.unavailable');
        // Administration remains reachable: a failed read is not a write authority decision.
        expect(row?.props.disabled).toBe(false);
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.add.${boundary.serverId}` })?.props.disabled).toBe(false);

        boundary.requests.length = 0;
        await screen.pressByTestIdAsync(`settings.machinePools.retry.${boundary.serverId}`);
        await vi.waitFor(() => expect(boundary.requests.some((url) => url.endsWith('/v1/machines/pools/list'))).toBe(true));
    });

    it('lists only the Pools a search matches, through the collection\'s own query match (TH MB-5)', async () => {
        const staging: MachinePoolViewV1 = { pool: { ...POOL_A.pool, id: '00000000-0000-4000-8000-000000000004', name: 'Staging', members: [] },
            availability: { state: 'known', connectedCount: 0, enabledCount: 0 } };
        const builds: MachinePoolViewV1 = { pool: { ...POOL_A.pool, id: '00000000-0000-4000-8000-000000000005', name: 'Builds', members: [] },
            availability: { state: 'known', connectedCount: 0, enabledCount: 0 } };
        await act(async () => publishPools([staging, builds]));
        const { MachinePoolsSection } = await import('./MachinePoolsSection');
        const row = (screen: Awaited<ReturnType<typeof renderScreen>>, pool: MachinePoolViewV1) =>
            findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${pool.pool.id}` });
        const searched = await renderScreen(<MachinePoolsSection groups={[group('idle')]} variant="rail" query="  STAG " />);
        expect(row(searched, staging)).toBeTruthy();
        expect(row(searched, builds)).toBeFalsy();
        await searched.unmount();
        const unmatched = await renderScreen(<MachinePoolsSection groups={[group('idle')]} variant="rail" query="nothing-like-it" />);
        expect(row(unmatched, staging)).toBeFalsy();
        expect(unmatched.getTextContent()).not.toContain('machinePools.title');
    });

    it('describes a saved Pool that has no machines instead of reusing the empty-list copy', async () => {
        const memberless: MachinePoolViewV1 = {
            pool: {
                ...POOL_A.pool,
                id: '00000000-0000-4000-8000-000000000003',
                name: 'Staging',
                members: [],
            },
            availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
        };
        await act(async () => publishPools([memberless]));
        const { MachinePoolsSection } = await import('./MachinePoolsSection');
        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${memberless.pool.id}` });
        expect(row?.props.title).toBe('Staging');
        // An empty Pool is a valid saved configuration. Saying "no machine pools yet" under its own
        // name tells the user their Pool does not exist.
        expect(row?.props.subtitle).toBe('machinePools.noMembers');
    });

    it('describes Team pool roster privacy without claiming the pool is empty', async () => {
        const shared: MachinePoolViewV1 = { ...POOL_A, pool: { ...POOL_A.pool,
            audience: { kind: 'team', teamId: 'team-build' }, members: [] },
            availability: { state: 'unknown' }, access: { canManage: false, canResolve: false, canViewMembers: false } };
        await act(async () => publishPools([shared]));
        const { MachinePoolsSection } = await import('./MachinePoolsSection');
        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);
        const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${shared.pool.id}` });
        expect(row?.props.subtitle).toBe('machinePools.membersPrivate');
    });

    it('previews enabled members even when disabled members appear first', async () => {
        const view: MachinePoolViewV1 = {
            ...POOL_A,
            pool: {
                ...POOL_A.pool,
                members: [
                    { machineId: 'disabled-a', priorityTier: 0, enabled: false, state: 'offline' },
                    { machineId: 'disabled-b', priorityTier: 0, enabled: false, state: 'offline' },
                    { machineId: 'machine-a', priorityTier: 1, enabled: true, state: 'connected' },
                    { machineId: 'enabled-b', priorityTier: 1, enabled: true, state: 'offline' },
                ],
            },
            availability: { state: 'known', connectedCount: 1, enabledCount: 2 },
        };
        await act(async () => publishPools([view]));
        const { MachinePoolsSection } = await import('./MachinePoolsSection');
        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} />);

        const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${view.pool.id}` });
        // A member this Home no longer lists is named by the state the pool reports, never as locked.
        expect(row?.props.subtitle).toBe('Mac Studio, machine.unlistedMachine');
        expect(row?.props.accessibilityLabel).toContain('Mac Studio, machine.unlistedMachine');
        expect(row?.props.accessibilityLabel).not.toContain('disabled-');
    });

    it.each(['page', 'rail'] as const)('exposes distinct visible pool identities in %s when names and member previews match', async (variant) => {
        await act(async () => publishPools([POOL_A, POOL_B]));
        const { MachinePoolsSection } = await import('./MachinePoolsSection');
        const screen = await renderScreen(<MachinePoolsSection groups={[group('idle')]} variant={variant} />);

        for (const pool of [POOL_A, POOL_B]) {
            const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.machinePools.row.${boundary.serverId}.${pool.pool.id}` });
            expect(row?.props.title).toBe('Development');
            const visibleText = [row?.props.title, row?.props.subtitle, row?.props.detail].filter(Boolean).join(' ');
            // These IDs differ only in their final character: a common short prefix is not identity.
            expect(visibleText).toContain(pool.pool.id);
            expect(row?.props.accessibilityLabel).toContain(pool.pool.id);
            if (variant === 'rail') {
                // Item's actual text owner must allow the distinguishing suffix to wrap in a narrow rail.
                expect(resolveItemSubtitleMaxLines({
                    text: row?.props.subtitle,
                    subtitleLines: row?.props.subtitleLines,
                })).toBeNull();
            }
        }
    });

    it('chooses the next, then previous, then Add row after deleting the originating Pool', async () => {
        const { resolveMachinePoolDeleteFocusTargetTestId } = await import('./MachinePoolsSection');
        const serverId = boundary.serverId;

        expect(resolveMachinePoolDeleteFocusTargetTestId(serverId, [POOL_A, POOL_B], POOL_A.pool.id))
            .toBe(`settings.machinePools.row.${serverId}.${POOL_B.pool.id}`);
        expect(resolveMachinePoolDeleteFocusTargetTestId(serverId, [POOL_A, POOL_B], POOL_B.pool.id))
            .toBe(`settings.machinePools.row.${serverId}.${POOL_A.pool.id}`);
        expect(resolveMachinePoolDeleteFocusTargetTestId(serverId, [POOL_A], POOL_A.pool.id))
            .toBe(`settings.machinePools.add.${serverId}`);
    });
});
