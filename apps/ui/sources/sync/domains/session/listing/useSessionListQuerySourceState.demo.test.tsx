import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { clearDemoWorld, seedDemoWorld } from '@/demoMode/seed/seedDemoWorld';
import { getDemoFirewallDenyLog, installDemoFirewall, uninstallDemoFirewall } from '@/demoMode/guards/demoFirewall';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { useSessionListQueryHomeStates, useSessionListQuerySourceState } from './useSessionListQuerySourceState';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('seeded demo Session query reads', () => {
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
    beforeEach(async () => { browser = await installBrowserRuntimeForTests({ url: 'https://demo-query.test' }); });
    afterEach(async () => {
        uninstallDemoFirewall();
        await clearDemoWorld({ residuePolicy: 'diagnostic' });
        browser.restore();
    });

    it('settles the exact demo Home from its complete local corpus without credentials or egress', async () => {
        const world = await seedDemoWorld({ residuePolicy: 'diagnostic' });
        const serverId = getActiveServerSnapshot().serverId;
        const homes = [{ serverId, queryMembership: 'rowOnly' as const, query: {
            v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
            attention: 'any' as const, audiences: [], tagIds: [],
        } }];
        installDemoFirewall();
        const source = await renderHook(() => useSessionListQuerySourceState({ enabled: true, homes }));
        let membershipRenders = 0;
        const membership = await renderHook(() => {
            membershipRenders += 1;
            return useSessionListQueryHomeStates({ enabled: true, homes });
        });
        try {
            expect(source.getCurrent().coverageComplete).toBe(true);
            expect(source.getCurrent().statesByServerId[serverId]).toMatchObject({ phase: 'ready', hasNext: false });
            const expected = world.sessions.filter(session => session.archivedAt == null).map(session => session.id);
            expect(new Set(source.getCurrent().source?.flatMap(item => item.type === 'session' ? [item.sessionId] : [])))
                .toEqual(new Set(expected));
            expect(new Set(membership.getCurrent().membershipByServerId[serverId]?.map(address => address.sessionId)))
                .toEqual(new Set(expected));
            const before = { result: membership.getCurrent(), renders: membershipRenders };
            const sessionId = expected[0]!;
            const row = storage.getState().sessionListRowsByServerId[serverId]![sessionId]!;
            await act(async () => storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId,
                patch: { metadata: { ...row.metadata!, name: 'Updated demo title' }, metadataVersion: row.metadataVersion + 1 },
            }]));
            expect(membershipRenders).toBe(before.renders);
            expect(membership.getCurrent()).toBe(before.result);
            await act(async () => storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId,
                patch: { archivedAt: 1 },
            }]));
            expect(membership.getCurrent().membershipByServerId[serverId]?.map(address => address.sessionId)).not.toContain(sessionId);
            expect(source.getCurrent().coverageComplete).toBe(true);
            await act(async () => {
                await source.getCurrent().loadNext();
                await source.getCurrent().refresh();
                await source.getCurrent().retry();
            });
            expect(await TokenStorage.getCredentials()).toBeNull();
            expect(storage.getState().sessionListQueryMembershipByKey).toEqual({});
            expect(getDemoFirewallDenyLog()).toEqual([]);
            const ordinary = await renderHook(() => useSessionListQueryHomeStates({ enabled: true, homes: [{
                ...homes[0]!, query: { ...homes[0]!.query, scope: 'my_work' as const },
            }] }));
            try {
                expect(ordinary.getCurrent().coverageComplete).toBe(true);
                expect(ordinary.getCurrent().statesByServerId[serverId]?.appliedSourceKind).toBe('ordinary');
            } finally { await ordinary.unmount(); }
            await act(async () => { await clearDemoWorld({ residuePolicy: 'diagnostic' }); });
            expect(source.getCurrent().coverageComplete).toBe(false);
            expect(membership.getCurrent().coverageComplete).toBe(false);
        } finally {
            await membership.unmount();
            await source.unmount();
        }
        await clearDemoWorld();
        const outside = await renderHook(() => useSessionListQuerySourceState({ enabled: true, homes }));
        try {
            expect(outside.getCurrent().coverageComplete).toBe(false);
            expect(outside.getCurrent().source).toBeNull();
        } finally { await outside.unmount(); }
    });

    it('does not certify a broad demo corpus for an unrepresented organization selector', async () => {
        await seedDemoWorld({ residuePolicy: 'diagnostic' });
        const serverId = getActiveServerSnapshot().serverId;
        const homes = [{ serverId, query: {
            v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
            attention: 'any' as const, audiences: [], tagIds: ['not-in-the-demo-world'],
        } }];
        installDemoFirewall();
        const source = await renderHook(() => useSessionListQuerySourceState({ enabled: true, homes }));
        try {
            expect(source.getCurrent().coverageComplete).toBe(false);
            expect(source.getCurrent().statesByServerId[serverId]).toMatchObject({ phase: 'error', failureReason: 'unsupported' });
            expect(source.getCurrent().source).toEqual([]);
            expect(getDemoFirewallDenyLog()).toEqual([]);
        } finally { await source.unmount(); }
    });
});
