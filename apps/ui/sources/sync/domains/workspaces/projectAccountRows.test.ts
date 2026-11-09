import { afterEach, describe, expect, it } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { StorageState } from '@/sync/store/types';
import { registerStorageStateReader, registerStorageStateSubscribe } from '@/sync/domains/state/storageStateReaderBridge';
import { readProjectAccountWorkspaceRefs, useProjectAccountWorkspaceRef, useProjectAccountWorkspaceRefs, useProjectWorkerCopyStatusRevisions, type ProjectAccountRowsSnapshot } from './projectAccountRows';
import { createProjectAccountRowsDomain, type ProjectAccountRowsDomain } from '@/sync/store/domains/projectAccountRows';
import { scopeStorageSubscriptions } from '@/sync/domains/state/scopedStorage';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

const scope = { serverId: 'home-a', accountId: 'account-a' };
afterEach(() => {
    standardCleanup();
    registerStorageStateSubscribe(() => () => {});
});

describe('Project workspace-ref subscription', () => {
    it('routes copy pushes by exact source and worker: 20 unrelated changes render zero times, one commit renders once', async () => {
        const state = createStore<ProjectAccountRowsDomain & { profileScope: typeof scope }>()((set, get) => ({
            ...createProjectAccountRowsDomain({ set, get }), profileScope: scope,
        }));
        // This real domain store supplies every field consumed by the storage path owner and query.
        scopeStorageSubscriptions(state as unknown as StoreApi<StorageState>);
        registerStorageStateReader(() => state.getState() as unknown as StorageState);
        state.getState().activateProjectAccountRowsScope(scope);
        const refs = ['source', 'worker', 'other'].map(id => ({ id, serverId: scope.serverId, machineId: id, rootPath: `/${id}`, createdAtMs: 1 }));
        const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const copies: WorkspaceSyncRelationshipV1[] = ['worker', 'other'].map(id => ({ v: 1, relationshipId: id,
            controllerMachineId: 'source', alphaWorkspaceRefId: 'source', betaWorkspaceRefId: id, mode: 'keep_synced', enabled: true,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1,
            provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: 'source', targetWorkspaceRefId: id } }));
        const publish = (relationships: readonly WorkspaceSyncRelationshipV1[]) => state.getState().applyProjectAccountRowsForScope(scope,
            createProjectAccountRowsFixture(scope, { workspaceRefs: refs, relationships }));
        publish(copies);
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useProjectWorkerCopyStatusRevisions(scope, 'source', '["worker"]');
        });
        try {
            const initial = renders;
            const initialRevision = hook.getCurrent().get('worker')!;
            for (let index = 0; index < 20; index++) await act(async () => publish([
                copies[0]!, { ...copies[1]!, updatedAtMs: index + 2 },
            ]));
            expect(renders - initial).toBe(0);
            await act(async () => publish([{ ...copies[0]!, committedAtMs: 2 }, copies[1]!]));
            expect(renders - initial).toBe(1);
            expect(hook.getCurrent().get('worker')).toBe(initialRevision + 1);
            await act(async () => publish([{ ...copies[0]!, committedAtMs: 2 }, copies[1]!]));
            expect(renders - initial).toBe(1);
            await act(async () => state.setState({ profileScope: { ...scope, accountId: 'retired' } }));
            expect(hook.getCurrent().get('worker')).toBe(0);
        } finally { await hook.unmount(); }
    });
    it('keeps a complete admitted census during transient refresh but withdraws private authority', () => {
        const rows: ProjectAccountRowsSnapshot = { scope, status: 'ready', coverage: 'complete', workspaceRefs: [
            { id: 'accepted', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 },
        ], relationships: [], organizations: [], revisionsByPhysicalKey: {} };
        for (const status of ['ready', 'loading', 'error'] as const) expect(readProjectAccountWorkspaceRefs({
            profileScope: scope, projectAccountRows: { ...rows, status },
        })).toBe(rows.workspaceRefs);
        for (const status of ['locked', 'refused', 'idle'] as const) expect(readProjectAccountWorkspaceRefs({
            profileScope: scope, projectAccountRows: { ...rows, status },
        })).toBeUndefined();
        expect(readProjectAccountWorkspaceRefs({ profileScope: { ...scope, accountId: 'other' }, projectAccountRows: rows })).toBeUndefined();
    });
    it('subscribes only on demand to ready refs and ignores unrelated catalog records', async () => {
        const storage = createStore<{ projectAccountRows: ProjectAccountRowsSnapshot | null; profileScope: typeof scope; isDataReady: boolean }>()(() => ({
            projectAccountRows: null, profileScope: scope, isDataReady: false,
        }));
        // Real Zustand store with exactly the fields this registered bridge reader consumes.
        registerStorageStateReader(() => storage.getState() as unknown as StorageState);
        let subscriptions = 0;
        registerStorageStateSubscribe(listener => {
            subscriptions += 1;
            // The application reader is typed to its full store; this fixture supplies its actual Project slice.
            const unsubscribe = storage.subscribe(state => listener(state as unknown as StorageState));
            return () => { subscriptions -= 1; unsubscribe(); };
        });
        let identityReads = 0;
        const rows: ProjectAccountRowsSnapshot = { scope, status: 'ready', coverage: 'complete',
            workspaceRefs: Array.from({ length: 1_000 }, (_, index) => ({
                get id() { identityReads += 1; return index === 0 ? 'checkout' : `other-${index}`; },
                serverId: scope.serverId, projectKey: 'project', machineId: 'machine', rootPath: `/repo-${index}`, createdAtMs: 1,
            })),
            relationships: [], organizations: [], revisionsByPhysicalKey: {} };
        storage.setState({ profileScope: scope, projectAccountRows: rows });
        let renders = 0;
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
            renders += 1;
            return useProjectAccountWorkspaceRefs(enabled);
        }, { initialProps: { enabled: false } });
        expect(hook.getCurrent()).toBeUndefined();
        expect(subscriptions).toBe(0);
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent()).toBe(rows.workspaceRefs);
        expect(subscriptions).toBe(1);
        const before = renders;
        await act(async () => storage.setState({ projectAccountRows: { ...rows, organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'project' }, revision: 1, value: { pinned: true } }] } }));
        expect(renders).toBe(before);
        await act(async () => storage.setState({ projectAccountRows: { ...rows, coverage: 'partial' } }));
        expect(hook.getCurrent()).toBeUndefined();
        await act(async () => storage.setState({ projectAccountRows: rows, profileScope: { ...scope, accountId: 'other' } }));
        expect(hook.getCurrent()).toBeUndefined();
        await hook.rerender({ enabled: false });
        expect(subscriptions).toBe(0);
        await act(async () => storage.setState({ projectAccountRows: rows, profileScope: scope }));
        const exact = await renderHook(() => useProjectAccountWorkspaceRef('checkout', scope.serverId));
        expect(exact.getCurrent()).toBe(rows.workspaceRefs[0]);
        identityReads = 0;
        await act(async () => storage.setState({ isDataReady: true }));
        // A root notification outside Project rows must not revisit even the exact lookup's candidates.
        expect(identityReads).toBe(0);
        await exact.unmount();
        expect(subscriptions).toBe(0);
    });
});
