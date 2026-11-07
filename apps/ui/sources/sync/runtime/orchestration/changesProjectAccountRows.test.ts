import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowChangeHintV1Schema, ProjectAccountRowReadRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { createProjectAccountRowsSync, type ProjectAccountRowsTransport } from '@/sync/engine/projects/projectAccountRowsSync';
import { createApiProjectAccountRowsTransport } from '@/sync/api/account/apiProjectAccountRows';
import { createProjectAccountRowsDomain, type ProjectAccountRowsDomain } from '@/sync/store/domains/projectAccountRows';
import { applyPlannedChangeActions } from './changesApplier';
import { planSyncActionsFromChanges } from './changesPlanner';

const scope = { serverId: 'home', accountId: 'account' };
const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'ref' };
const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);

function hintChange(hint: unknown = { projectAccountRow: true, key, revision: 1 }, entityId = physicalKey): ApiChangeEntry {
    return { cursor: 7, changedAt: 1, kind: 'account', entityId, hint };
}

function applyBase(planned: ReturnType<typeof planSyncActionsFromChanges>, refreshed: string[] = []) {
    return {
        planned, credentials: { token: 'token' }, isSessionMessagesLoaded: () => false,
        invalidate: { settings: async () => { refreshed.push('settings'); }, profile: async () => { refreshed.push('profile'); } },
        invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
        applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
    };
}

describe('Project Account row durable changes', () => {
    it('checkpoints only applied exact reads, including absent and deleted rows, while retaining unrelated rows', async () => {
        const keys = ['changed', 'unavailable', 'absent', 'deleted', 'untouched'].map(projectKey => ({
            kind: 'project-organization' as const, serverId: 'home', projectKey,
        }));
        const ids = keys.map(buildProjectAccountRowPhysicalKeyV1);
        const rows = keys.filter(item => item.projectKey !== 'absent').map(rowKey => ({ key: rowKey, revision: 0,
            content: { t: 'plain' as const, v: { key: rowKey, value: { label: 'Before' } } },
        }));
        const requests: string[] = [];
        let offline = true;
        const transport = createApiProjectAccountRowsTransport({ request: async (path, init) => {
            requests.push(path);
            if (path.endsWith('/list')) return Response.json({ status: 'listed', coverage: 'complete', rows });
            const { key: rowKey } = ProjectAccountRowReadRequestV1Schema.parse(JSON.parse(String(init?.body)));
            if (rowKey.kind !== 'project-organization') throw new Error('Expected organization row');
            if (rowKey.projectKey === 'unavailable' && offline) return Response.json({}, { status: 503 });
            if (rowKey.projectKey === 'absent' || rowKey.projectKey === 'unavailable') return Response.json({ status: 'absent' });
            if (rowKey.projectKey === 'deleted') return Response.json({ status: 'deleted', revision: 1 });
            return Response.json({ status: 'present', row: { key: rowKey, revision: 1,
                content: { t: 'plain', v: { key: rowKey, value: { label: 'After' } } } } });
        } });
        const store = createStore<ProjectAccountRowsDomain>()((set, get) => createProjectAccountRowsDomain({ set, get }));
        store.getState().activateProjectAccountRowsScope(scope);
        const owner = createProjectAccountRowsSync({ scope, transport,
            cipher: createProjectAccountRowCipherV1({ mode: 'plain', material: null,
                randomBytes: () => { throw new Error('Plain rows remain keyless'); } }), isCurrent: () => true,
            apply: (...args) => store.getState().applyProjectAccountRowsForScope(scope, ...args),
            onRefreshFailure: () => store.getState().setProjectAccountRowsStatusForScope(scope, 'error') });
        await owner.refresh();
        const untouched = store.getState().projectAccountRows?.organizations.find(row => row.key.projectKey === 'untouched');
        const changes = keys.slice(0, 4).map((rowKey, index) => ({ ...hintChange({ projectAccountRow: true, key: rowKey, revision: 1 }, ids[index]), cursor: index + 1 }));
        const base = applyBase(planSyncActionsFromChanges(changes));
        const apply = () => applyPlannedChangeActions({ ...base, materializeProjectAccountRows: keys => owner.refreshKeys(keys) });
        expect(await apply()).toMatchObject({ status: 'partial', safeAdvanceCursor: '1', blockedCursor: '2' });
        expect(store.getState().projectAccountRows?.organizations.find(row => row.key.projectKey === 'changed')?.value.label).toBe('After');
        expect(store.getState().projectAccountRows?.organizations.some(row => row.key.projectKey === 'deleted')).toBe(false);
        expect(store.getState().projectAccountRows?.organizations.find(row => row.key.projectKey === 'untouched')).toBe(untouched);
        expect(requests.filter(path => path.endsWith('/read'))).toHaveLength(4);
        expect(requests.filter(path => path.endsWith('/list'))).toHaveLength(1);
        offline = false;
        expect(await apply()).toMatchObject({ status: 'complete', safeAdvanceCursor: '4' });
        expect(store.getState().projectAccountRows?.organizations.some(row => row.key.projectKey === 'unavailable')).toBe(false);
        expect(store.getState().projectAccountRows?.revisionsByPhysicalKey[ids[1]!]).toBeUndefined();
        expect(requests.filter(path => path.endsWith('/read'))).toHaveLength(8);
        expect(requests.filter(path => path.endsWith('/list'))).toHaveLength(1);
    });
    it('retains a failed census through recency pushes and recovers only after materializing the row change', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        onTestFinished(() => { clock.mockRestore(); });
        const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null,
            randomBytes: () => { throw new Error('Plain rows must remain keyless'); } });
        const rows = new Map<string, ProjectAccountRowV1>([[physicalKey, { key, revision: 0,
            authoringSession: { serverId: 'author-home', sessionId: 'author-session' }, content: cipher.seal({ key,
            value: { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1, projectKey: 'anchor', label: 'Before' } }) }]]);
        const changes: ApiChangeEntry[] = [];
        let offline = false;
        let listReads = 0;
        const exactReads: unknown[] = [];
        // This boundary models the server's canonical row responses and content-free publication;
        // both UI clients run the real cipher, row sync owner, store, planner, and applier.
        const boundary: ProjectAccountRowsTransport = {
            read: async rowKey => {
                exactReads.push(rowKey);
                if (offline) throw new Error('offline');
                const row = rows.get(buildProjectAccountRowPhysicalKeyV1(rowKey));
                return row ? { status: 'present', row } : { status: 'absent' };
            },
            list: async () => {
                listReads++;
                if (offline) throw new Error('offline');
                return { status: 'listed', coverage: 'complete', rows: [...rows.values()] };
            },
            mutate: async (request) => {
                const updated: ProjectAccountRowV1[] = [];
                for (const mutation of request.mutations) {
                    const id = buildProjectAccountRowPhysicalKeyV1(mutation.key);
                    const prior = rows.get(id);
                    if ((prior?.revision ?? 'absent') !== mutation.expectedRevision) return { status: 'conflict', key: mutation.key, revision: prior?.revision ?? -1 };
                    const row = { key: mutation.key, revision: (prior?.revision ?? -1) + 1, content: mutation.content };
                    rows.set(id, row); updated.push(row);
                    changes.push(hintChange(ProjectAccountRowChangeHintV1Schema.parse({ projectAccountRow: true, key: row.key, revision: row.revision }), id));
                }
                return { status: 'updated', rows: updated, cursor: 7 };
            },
        };
        const transport = createApiProjectAccountRowsTransport({ request: async (path, init) => {
            const body = JSON.parse(String(init?.body));
            if (path.endsWith('/list')) return Response.json(await boundary.list());
            if (path.endsWith('/read')) return Response.json(await boundary.read(body.key));
            if (path.endsWith('/mutate')) return Response.json(await boundary.mutate(body));
            throw new Error(`Unexpected Project row request: ${path}`);
        } });
        function client() {
            const store = createStore<ProjectAccountRowsDomain>()((set, get) => createProjectAccountRowsDomain({ set, get }));
            store.getState().activateProjectAccountRowsScope(scope);
            const owner = createProjectAccountRowsSync({ scope, transport, cipher, isCurrent: () => true,
                apply: (...args) => store.getState().applyProjectAccountRowsForScope(scope, ...args),
                onRefreshFailure: () => store.getState().setProjectAccountRowsStatusForScope(scope, 'error') });
            return { store, owner };
        }
        const first = client();
        const second = client();
        second.owner.refreshRecency(() => 41);
        expect(second.store.getState().projectAccountRows).toMatchObject({ status: 'idle', coverage: 'unknown', workspaceRefs: [] });
        expect(second.store.getState().projectAccountRows?.lastReadyAtMs).toBeUndefined();
        await second.owner.refresh();
        const ready = second.store.getState().projectAccountRows!;
        expect(second.store.getState().projectAccountRows?.workspaceRefs[0]?.label).toBe('Before');
        expect(ready).toMatchObject({ status: 'ready', coverage: 'complete', lastReadyAtMs: 1_000 });
        clock.mockReturnValue(2_000);
        expect(await first.owner.mutateRef({ kind: 'set_label', serverId: 'home', workspaceRefId: 'ref', label: 'After' })).toEqual({ ok: true });
        const planned = planSyncActionsFromChanges(changes);
        expect(planned.projectAccountRowKeys).toEqual([physicalKey]);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
        const refreshed: string[] = [];
        const base = applyBase(planned, refreshed);
        const listsBeforeHint = listReads;
        offline = true;
        expect(await applyPlannedChangeActions({ ...base, materializeProjectAccountRows: keys => second.owner.refreshKeys(keys) }))
            .toMatchObject({ status: 'partial', safeAdvanceCursor: null, blockedCursor: '7', blockedReason: 'partial-materialization' });
        expect(second.store.getState().projectAccountRows?.workspaceRefs[0]?.label).toBe('Before');
        expect(second.store.getState().projectAccountRows).toMatchObject({ status: 'error', coverage: 'complete', lastReadyAtMs: 1_000 });
        expect(second.store.getState().projectAccountRows?.workspaceRefs).toBe(ready.workspaceRefs);
        clock.mockReturnValue(3_000);
        const readsBeforeRecency = listReads;
        second.owner.refreshRecency(() => 42);
        expect(listReads).toBe(readsBeforeRecency);
        expect(second.store.getState().projectAccountRows).toMatchObject({ status: 'error', coverage: 'complete', lastReadyAtMs: 1_000,
            workspaceRefs: [{ id: 'ref', label: 'Before', lastOpenedAtMs: 42 }] });
        const stale = second.store.getState();
        second.owner.refreshRecency();
        expect(second.store.getState()).toBe(stale);
        clock.mockReturnValue(4_000);
        offline = false;
        expect(await applyPlannedChangeActions({ ...base, materializeProjectAccountRows: keys => second.owner.refreshKeys(keys) }))
            .toMatchObject({ status: 'complete', safeAdvanceCursor: '7' });
        expect(second.store.getState().projectAccountRows?.workspaceRefs[0]?.label).toBe('After');
        expect(second.store.getState().projectAccountRows).toMatchObject({ status: 'ready', coverage: 'complete', lastReadyAtMs: 1_000,
            workspaceRefs: [{ id: 'ref', label: 'After', lastOpenedAtMs: 42 }] });
        clock.mockReturnValue(5_000);
        second.owner.refreshRecency(() => 43);
        expect(second.store.getState().projectAccountRows).toMatchObject({ status: 'ready', coverage: 'complete', lastReadyAtMs: 1_000,
            workspaceRefs: [{ id: 'ref', label: 'After', lastOpenedAtMs: 43 }] });
        expect(refreshed).toEqual([]);
        expect(changes).toEqual([hintChange()]);
        expect(listReads).toBe(listsBeforeHint);
        expect(exactReads).toEqual([key, key]);
        expect(second.store.getState().projectAccountRows?.authoringSessionsByPhysicalKey?.[physicalKey])
            .toEqual({ serverId: 'author-home', sessionId: 'author-session' });
        rows.delete(physicalKey);
        expect(await applyPlannedChangeActions({ ...base, materializeProjectAccountRows: keys => second.owner.refreshKeys(keys) }))
            .toMatchObject({ status: 'complete', safeAdvanceCursor: '7' });
        expect(second.store.getState().projectAccountRows?.workspaceRefs).toEqual([]);
        expect(second.store.getState().projectAccountRows?.revisionsByPhysicalKey[physicalKey]).toBeUndefined();
        expect(second.store.getState().projectAccountRows?.authoringSessionsByPhysicalKey?.[physicalKey]).toBeUndefined();
        expect(listReads).toBe(listsBeforeHint);
        expect(exactReads).toEqual([key, key, key]);
    });

    it('holds the durable cursor when the row materialization owner is unavailable', async () => {
        const planned = planSyncActionsFromChanges([hintChange()]);
        const refreshed: string[] = [];
        expect(await applyPlannedChangeActions(applyBase(planned, refreshed)))
            .toMatchObject({ status: 'partial', safeAdvanceCursor: null, blockedCursor: '7', blockedReason: 'partial-materialization' });
        expect(refreshed).toEqual([]);
    });

    it.each([
        hintChange({ projectAccountRow: true, key: { ...key, id: 'other' }, revision: 1 }),
        hintChange({ projectAccountRow: true, key, revision: 1, settingsVersion: 9 }),
        hintChange({ projectAccountRow: false, key, revision: 1 }),
        hintChange(undefined, 'self'),
        hintChange(null),
    ])('refuses malformed or unbound row hints before any Account privilege', async change => {
        const planned = planSyncActionsFromChanges([change]);
        expect(planned.projectAccountRowKeys).toEqual([]);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
        const refreshed: string[] = [];
        expect(await applyPlannedChangeActions({ ...applyBase(planned, refreshed),
            materializeProjectAccountRows: async () => { refreshed.push('row'); return new Set<string>(); } }))
            .toMatchObject({ status: 'partial', safeAdvanceCursor: null, blockedCursor: '7', blockedReason: 'unsupported-hint' });
        expect(refreshed).toEqual([]);
    });
});
