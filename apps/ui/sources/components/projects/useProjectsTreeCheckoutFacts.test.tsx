import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook, renderScreen, standardCleanup, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { projectLastMobileSurfaceState } from '@/sync/domains/state/navigationUiState';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { readSessionRuntimePresentationFreshnessExpirations } from '@/sync/domains/session/attention/runtimePresentation';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { useProjectsTreeCheckoutFacts, useProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import { buildProjectsTreeProjects, buildProjectsTreeRows, projectsTreeCheckoutKey } from './projectsTreeRows';
import { ProjectsTree } from './ProjectsTree';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({});
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => {
    standardCleanup();
    replacePersistentUiStateForTest(projectLastMobileSurfaceState, {});
    vi.useRealTimers();
});

function arrange() {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000);
    const refs: readonly WorkspaceRefV1[] = Array.from({ length: 150 }, (_, index) => ({
        id: `workspace-${index}`, serverId: 'home-a', machineId: 'machine', rootPath: `/repo-${index}`, createdAtMs: 1,
    }));
    storage.setState({ sessions: {}, sessionListRowsByServerId: {}, machines: {}, machineListByServerId: {},
        profileScope: { serverId: 'home-a', accountId: 'account-a' },
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    return refs;
}

describe('Projects tree checkout fact demand', () => {
    it('clears viewed arrival memory live and ignores navigation state for an unrelated Project', async () => {
        const refs = arrange();
        storage.setState({ sessionListRowsByServerId: { 'home-a': { session: createSessionListRenderableSessionFixture({
            id: 'session', active: true, activeAt: 1_000, thinkingAt: 1_000,
            metadata: { machineId: 'machine', path: '/repo-0' },
        }) } } });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useProjectsTreeCheckoutFacts(refs); });
        const before = hook.getCurrent();
        const initialRenders = renders;
        expect([...before.values()][0]?.newFromSession).toBe(true);
        const pageKey = (id: string) => buildRealmQualifiedMobileSurfaceStorageKey('project', {
            serverId: 'home-a', accountId: 'account-a',
        }, id)!;
        await act(async () => projectLastMobileSurfaceState.set(pageKey('unrelated'), 'context'));
        expect(renders).toBe(initialRenders);
        await act(async () => projectLastMobileSurfaceState.set(pageKey('workspace-0'), 'code'));
        expect([...hook.getCurrent().values()][0]?.newFromSession).toBe(false);
        expect(renders).toBe(initialRenders + 1);
        expect([...hook.getCurrent().values()].slice(1)).toEqual([...before.values()].slice(1));
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('renders only the changed row body among 150 Projects after a real checkout-fact change', async () => {
        const refs = arrange();
        const groups = refs.map(ref => ({ projectKey: { projectKey: ref.id }, items: [ref] }));
        const rowBodies = new Map<string, number>();
        // The production composition (`ProjectsColumn`): structural rows from Projects built without
        // facts, and each Project section reads its own checkouts' facts below the tree.
        function Tree() {
            const source = useProjectsTreeCheckoutFactsSource(refs);
            const projects = buildProjectsTreeProjects({ groups, projectName: ref => ref.id,
                machine: () => ({ name: 'Machine', homeDir: null, online: true }) });
            const expandedKeys = new Set<string>();
            return <ProjectsTree rows={buildProjectsTreeRows({ projects, openRefId: null, expandedKeys })}
                live={{ source, projects, openRefId: null, expandedKeys }}
                onToggle={() => {}} onOpenRef={() => {}} renderRowMenu={row => {
                    // This is the production row-body render slot, not an internal mock.
                    rowBodies.set(row.key, (rowBodies.get(row.key) ?? 0) + 1);
                    return null;
                }} />;
        }
        const screen = await renderScreen(<Tree />);
        expect(rowBodies.size).toBe(150);
        rowBodies.clear();
        const row = createSessionListRenderableSessionFixture({ id: 'session', active: true, activeAt: 1_000,
            thinking: true, thinkingAt: 1_000, metadata: { machineId: 'machine', path: '/repo-0' } });
        await act(async () => storage.setState({ sessionListRowsByServerId: { 'home-a': { session: row } },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: ['session'], removedSessionIds: [], rebuiltSessionListIndex: false },
        }));
        expect(rowBodies.get('workspace-0')).toBe(1);
        expect([...rowBodies.keys()].filter(id => id !== 'workspace-0')).toEqual([]);
        await act(async () => screen.tree.unmount());
    });

    it('does not retain the shared clock while there are no checkout rows', async () => {
        arrange();
        const refs: readonly WorkspaceRefV1[] = [];
        const hook = await renderHook(() => useProjectsTreeCheckoutFacts(refs));
        expect(hook.getCurrent().size).toBe(0);
        vi.setSystemTime(20_000);
        expect(sessionListRuntimeClock.getNowMs()).toBe(20_000);
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not render a 150-checkout tree for five unrelated shared-clock arrivals', async () => {
        const refs = arrange();
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useProjectsTreeCheckoutFacts(refs);
        });
        const before = hook.getCurrent();
        const initialRenders = renders;
        const otherSurface = {};
        for (let index = 0; index < 5; index += 1) {
            sessionListRuntimeClock.requestWake(otherSurface, Date.now() + 1_000);
            await act(async () => { vi.advanceTimersByTime(1_000); });
        }
        expect(renders - initialRenders).toBe(0);
        expect(hook.getCurrent()).toBe(before);
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps selected Session changes and their own freshness expiry live without unrelated wakes', async () => {
        const refs = arrange();
        const hook = await renderHook(() => useProjectsTreeCheckoutFacts(refs));
        const before = hook.getCurrent();
        const row = createSessionListRenderableSessionFixture({ id: 'session', active: true, activeAt: 1_000,
            thinking: true, thinkingAt: 1_000, metadata: { machineId: 'machine', path: '/repo-0' } });
        await act(async () => storage.setState({ sessionListRowsByServerId: { 'home-a': { session: row } },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: ['session'], removedSessionIds: [], rebuiltSessionListIndex: false },
        }));
        const key = (ref: WorkspaceRefV1) => projectsTreeCheckoutKey({ refId: ref.id, workspaceAddress: {
            serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath,
        } });
        expect(hook.getCurrent().get(key(refs[0]!))?.attention).toBe('working');
        for (const ref of refs.slice(1)) expect(hook.getCurrent().get(key(ref))).toBe(before.get(key(ref)));
        await act(async () => { vi.advanceTimersByTime(121_000); });
        expect(hook.getCurrent().get(key(refs[0]!))?.attention).toBeNull();
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('re-arms an unchanged working fact when a real heartbeat extends its freshness', async () => {
        const refs = arrange();
        const row = createSessionListRenderableSessionFixture({ id: 'session', active: true, activeAt: 1_000,
            thinking: true, thinkingAt: 1_000, metadata: { machineId: 'machine', path: '/repo-0' } });
        const firstExpiry = Math.min(...readSessionRuntimePresentationFreshnessExpirations({ ...row,
            hasPendingUserMessages: false, nowMs: Date.now() }, Date.now()));
        expect(Number.isFinite(firstExpiry)).toBe(true);
        storage.setState({ sessionListRowsByServerId: { 'home-a': { session: row } } });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useProjectsTreeCheckoutFacts(refs); });
        const before = hook.getCurrent();
        const initialRenders = renders;
        await act(async () => { vi.advanceTimersByTime(1_000); });
        await act(async () => storage.setState({ sessionListRowsByServerId: { 'home-a': { session: {
            ...row, activeAt: Date.now(), thinkingAt: Date.now(),
        } } }, sessionListRenderableDelta: { revision: 1, changedSessionIds: ['session'], removedSessionIds: [], rebuiltSessionListIndex: false } }));
        expect(hook.getCurrent()).toBe(before);
        expect(renders - initialRenders).toBe(0);
        await act(async () => { vi.advanceTimersByTime(firstExpiry - Date.now()); });
        expect(hook.getCurrent()).toBe(before);
        expect(renders - initialRenders).toBe(0);
        await act(async () => { vi.advanceTimersByTime(121_000); });
        expect([...hook.getCurrent().values()][0]?.attention).toBeNull();
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
