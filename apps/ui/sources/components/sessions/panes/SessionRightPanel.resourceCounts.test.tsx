import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createMachineFixture, createSessionFixture, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import type { RightSidebarRailAction } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { createSessionPaneScopeId } from './sessionPaneScopeId';

installSessionDetailsPanelCommonModuleMocks();

let boardCount = 2;
let scalarReads = 0;
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
    features: () => {
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Board feature fixture unavailable');
        return features;
    },
    request: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/v2/sessions/s1/system-records' && parsed.searchParams.get('projection') === 'count') {
            scalarReads++;
            return Response.json({ count: boardCount });
        }
        return null;
    },
});

// Collect the renderer graph before the timed Account harness setup.
const { SessionActionRail, SessionRightSidebarProvider } = await import('./SessionRightPanel');

it('mounts numeric Services and Board badge leaves without rereading or rebuilding positive rail placement', async () => {
    const { RightSidebarActionRail } = await import('@/components/appShell/rightSidebar/RightSidebarActionRail');
    const { TabBadge } = await import('@/components/ui/navigation/tabBadge/TabBadge');
    const { storage } = await import('@/sync/domains/state/storage');
    const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', daemonStateVersion: 1,
        daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0,
            localServices: { v: 1, state: 'ready', runningCount: 3 } } });
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId,
        metadata: { path: '/repo', host: 'test', homeDir: '/home/test', machineId: machine.id } })]);
    storage.getState().applyMachines([machine], false, { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' });
    await publishMachineInventoryForTest({ serverId: runtime.serverId, accountId: 'account-a' }, [machine]);
    boardCount = 2;
    scalarReads = 0;
    const screen = await renderScreen(<runtime.Wrapper>
        <SessionRightSidebarProvider sessionId="s1" scopeId={createSessionPaneScopeId('s1', runtime.serverId)}><SessionActionRail /></SessionRightSidebarProvider>
    </runtime.Wrapper>);
    try {
        const actions = (): readonly RightSidebarRailAction[] => screen.tree.findByType(RightSidebarActionRail).props.actions;
        await expect.poll(() => actions().filter(action => action.hasContent === true).map(action => action.id)).toEqual(
            expect.arrayContaining(['services', 'board']),
        );
        const badgeCount = (id: string) => {
            const badge = screen.findAllByType(TabBadge)
                .find(candidate => candidate.props.testID === `session-action-rail:${id}:badge`);
            return badge?.props.variant === 'count' ? badge.props.value : undefined;
        };
        expect(badgeCount('services')).toBe(3);
        expect(badgeCount('board')).toBe(2);
        expect(scalarReads).toBe(1);
        const placed = actions();
        boardCount = 9;
        await act(async () => {
            await getSyncSingleton().withSessionSystemRecordRuntime({ serverId: runtime.serverId, sessionId: 's1' },
                current => current.repository.fetchBoardItemCount({ serverId: runtime.serverId, sessionId: 's1' }));
        });
        expect(badgeCount('board')).toBe(9);
        expect(actions()).toBe(placed);
        await act(async () => storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2,
            daemonState: { ...machine.daemonState, localServices: { v: 1, state: 'ready', runningCount: 5 } } }], false,
        { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' }));
        expect(badgeCount('services')).toBe(5);
        expect(actions()).toBe(placed);
        await act(async () => storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: {
            sessionRail: { orderedIds: [], placements: { services: 'overflow', board: 'overflow' } },
        } }, { persist: false }));
        expect(screen.findByTestId('session-action-rail:more')?.props.accessibilityLabel).toContain('9');
        expect(scalarReads).toBe(2); // One open read, then the explicit owner update above; placement spends nothing.
    } finally { await screen.unmount(); }
});
