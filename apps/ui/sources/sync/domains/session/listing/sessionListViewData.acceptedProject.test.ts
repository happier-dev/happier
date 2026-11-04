import { describe, expect, it } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListViewData, type SessionListViewItem } from './sessionListViewData';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession, didSessionListRenderableProjectGroupingFieldsChange } from './sessionListRenderable';
import { buildSessionListCacheEntryFromRenderable, buildSessionListRenderableFromCacheEntry } from '@/sync/domains/state/warmCacheAdapters';
import { buildSessionListIndexWithServerScope } from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import { applySessionWorkspaceOrderV1ToIndex, buildSessionWorkspaceOrderScopeKey, normalizeSessionWorkspaceOrderV1ForSource, retainSessionProjectGroupOrder } from './sessionWorkspaceOrderStateV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectSessionListAcceptedProjects } from './sessionListProjectProjection';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildSessionWorkspaceFallbackOrderKey } from './sessionWorkspaceOrderKeys';
import { normalizeSessionListGroupOrderV1ForIndexSource } from './sessionListOrderingStateV1';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';

const row = (id: string, projectKey: string | null, machineId: string, path: string, createdAt: number) => ({
    ...createSessionListRenderableSessionFixture({ id, createdAt, ownerAccountId: 'viewer-account', metadata: { host: 'test.local', machineId, path } }), projectKey,
});
const headers = (rows: ReturnType<typeof row>[], serverId = 'home-a', workspaceRefs?: readonly WorkspaceRefV1[]) => buildSessionListViewData(
    Object.fromEntries(rows.map(item => [item.id, item])), {},
    { serverScope: { serverId }, layoutV1: 'projects', workspaceRefs,
        workspaceRefsServerId: 'home-a', viewerAccountId: 'viewer-account' },
).filter((item): item is Extract<SessionListViewItem, { type: 'header' }> => item.type === 'header' && item.headerKind === 'project');

describe('accepted Project list grouping', () => {
    it('preserves the canonical execution workspace while completing Project identity', () => {
        const predecessor = createMachineFixture({ id: 'old-machine', active: false, replacedByMachineId: 'new-machine' });
        const successor = createMachineFixture({ id: 'new-machine' });
        const session = createSessionFixture({ id: 'moving', ownerAccountId: 'viewer-account', metadata: {
            host: 'test.local', machineId: predecessor.id, path: '/repo', workspaceId: 'checkout',
        } });
        const compact = buildSessionListRenderableFromSession(session);
        const source = buildSessionListIndexWithServerScope({ sessions: { moving: compact }, sessionRecords: { moving: session },
            machines: { [predecessor.id]: buildMachineDisplayRenderableFromMachine(predecessor),
                [successor.id]: buildMachineDisplayRenderableFromMachine(successor) },
            machineRecords: { [predecessor.id]: predecessor, [successor.id]: successor },
            serverScope: { serverId: 'home-a' }, layoutV1: 'projects' });
        const original = source.find(item => item.type === 'session');
        expect(original?.workspace).toMatchObject({ t: 'workspaceScope', serverId: 'home-a', machineId: successor.id, rootPath: '/repo' });
        const projected = projectSessionListAcceptedProjects({ source, censusServerId: 'home-a', viewerAccountId: 'viewer-account',
            workspaceRefs: [{ id: 'checkout', projectKey: 'anchor', serverId: 'home-a', machineId: successor.id,
                rootPath: '/repo', createdAtMs: 1 }], resolveSessionRow: () => compact });
        const moved = projected.find(item => item.type === 'session');
        expect(moved?.groupKey).toBe(JSON.stringify(['project', 'home-a', 'anchor']));
        expect(moved?.workspace).toEqual(original?.workspace);
    });
    it('keeps a recipient Run in its exact qualified fallback instead of aliasing viewer-private refs', () => {
        const result = computeVisibleSessionListIndex({ source: [], workspaceRefsServerId: 'home-a',
            workspaceRefs: [{ id: 'checkout', projectKey: 'viewer-project', serverId: 'home-a', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }],
            workflowRuns: [{ serverId: 'home-a', summary: createWorkflowRunSummaryFixture({ ownerAccountId: 'other-account',
                state: 'succeeded', where: { machineId: 'machine', directory: '/repo', workspaceRefId: 'checkout' },
            }) }], viewerAccountIdByServerId: new Map([['home-a', 'viewer-account']]),
            sessionListLayoutChoice: 'projects', sessionListAttentionPlacementV1: 'inPlace', hideInactiveSessions: false,
            pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, presentation: { enabled: false, presentation: 'grouped' },
            resolveSessionRow: () => null,
        });
        expect(result?.filter(item => item.type === 'workflow_run')).toHaveLength(1);
        const header = result?.find((item): item is Extract<SessionListIndexItem, { type: 'header' }> => item.type === 'header' && item.headerKind === 'project');
        expect(header?.projectKey).toBeUndefined();
        expect(header?.workspaceKey).toBe(buildSessionWorkspaceFallbackOrderKey(['home-a', 'machine', '/repo']));
    });

    it('seeds Run-only Projects after Session creation seeds and keeps mounted and saved order final', () => {
        const known = { ...row('known', 'z-known', 'machine', '/known', 20), ownerAccountId: 'account-1' };
        const source = buildSessionListIndexWithServerScope({ sessions: { known }, machines: {},
            serverScope: { serverId: 'home-a' }, layoutV1: 'projects' });
        const workspaceRefs = ['b-run', 'a-run'].map((key, index) => ({ id: key, projectKey: key, serverId: 'home-a',
            machineId: 'machine', rootPath: `/${key}`, createdAtMs: index + 1 }));
        const run = (key: string) => ({ serverId: 'home-a', summary: createWorkflowRunSummaryFixture({ id: `run-${key}`,
            ownerAccountId: 'account-1', state: 'succeeded', where: { machineId: 'machine', directory: `/${key}`, workspaceRefId: key },
            createdAt: key === 'b-run' ? '2020-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z',
        }) });
        const build = (keys: string[], previousPresentedIndex?: ReturnType<typeof computeVisibleSessionListIndex>,
            sessionWorkspaceOrderV1 = {}) => computeVisibleSessionListIndex({ source, workspaceRefs,
            workspaceRefsServerId: 'home-a', workflowRuns: keys.map(run), previousPresentedIndex, sessionWorkspaceOrderV1,
            viewerAccountIdByServerId: new Map([['home-a', 'account-1']]),
            sessionListLayoutChoice: 'projects', sessionListAttentionPlacementV1: 'inPlace', hideInactiveSessions: false,
            pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, presentation: { enabled: false, presentation: 'grouped' },
            resolveSessionRow: (_home, id) => id === known.id ? known : null,
        });
        const projectKeys = (index: ReturnType<typeof build>) => index?.flatMap(item =>
            item.type === 'header' && item.headerKind === 'project' && item.projectKey ? [item.projectKey.projectKey] : []);
        expect(projectKeys(build(['b-run', 'a-run']))).toEqual(['z-known', 'a-run', 'b-run']);
        expect(projectKeys(build(['b-run', 'a-run'], build(['b-run'])))).toEqual(['z-known', 'b-run', 'a-run']);
        expect(projectKeys(build(['b-run', 'a-run'], undefined, { [buildSessionWorkspaceOrderScopeKey('home-a')]: [
            JSON.stringify(['project', 'home-a', 'b-run']), JSON.stringify(['project', 'home-a', 'z-known']),
        ] }))).toEqual(['b-run', 'z-known', 'a-run']);
    });
    it('retains accepted non-content identity through compact projection and cold cache while content is locked', () => {
        const session = { ...createSessionFixture({ metadata: null, encryptedContentAvailability: 'encrypted_content_unavailable' }), projectKey: 'anchor' };
        const projected = buildSessionListRenderableFromSession(session);
        expect(projected).toMatchObject({ projectKey: 'anchor', metadata: null });
        expect(buildSessionListRenderableFromCacheEntry(buildSessionListCacheEntryFromRenderable(projected)))
            .toMatchObject({ projectKey: 'anchor', metadata: null });
        expect(didSessionListRenderableProjectGroupingFieldsChange({ ...projected, projectKey: null }, projected)).toBe(true);
        expect(buildSessionListRenderableFromSession(session, projected)).toBe(projected);
    });
    it('groups the accepted anchor across machines and worktrees without private refs', () => {
        const result = headers([
            row('first', 'anchor', 'laptop', '/repo', 10),
            row('worktree', 'anchor', 'devbox', '/worktrees/topic', 20),
            { ...row('published-managed', 'anchor', 'devbox', '/private/chat', 25),
                metadata: { host: 'test.local', machineId: 'devbox', path: '/private/chat', sessionDirectoryV1: { v: 1 as const, kind: 'managed' as const } } },
            row('other', 'different', 'laptop', '/another/repo', 30),
        ]);
        expect(result).toHaveLength(2);
        expect(result.map(item => item.projectKey)).toEqual([
            { serverId: 'home-a', projectKey: 'anchor' }, { serverId: 'home-a', projectKey: 'different' },
        ]);
    });

    it('keeps a keyless exact checkout separate until its accepted key arrives', () => {
        const first = row('first', 'anchor', 'laptop', '/repo', 10);
        const keyless = row('old', null, 'devbox', '/worktrees/topic', 20);
        expect(headers([first, keyless])).toHaveLength(2);
        expect(headers([first, { ...keyless, projectKey: 'anchor' }])).toHaveLength(1);
        expect(headers([first], 'home-b')[0]?.projectKey).toEqual({ serverId: 'home-b', projectKey: 'anchor' });
        expect(headers([first])[0]?.projectKey).toEqual({ serverId: 'home-a', projectKey: 'anchor' });
    });

    it('uses the one accepted resolver for keyless rows only when the open Home census is admitted', () => {
        const first = row('first', 'anchor', 'laptop', '/repo', 10);
        const keyless = row('old', null, 'devbox', '/worktrees/topic', 20);
        const refs = [{ id: 'checkout', serverId: 'home-a', machineId: 'devbox', rootPath: '/worktrees/topic', projectKey: 'anchor', createdAtMs: 1 }];
        expect(headers([first, keyless], 'home-a', refs)).toHaveLength(1);
        expect(headers([first, keyless], 'home-b', refs)).toHaveLength(2);
        const recipient = { ...keyless, access: createSessionAccessFixture('view'), accessLevel: 'view' as const };
        expect(headers([first, recipient], 'home-a', refs)).toHaveLength(2);
        expect(headers([first, { ...keyless, ownerAccountId: 'another-account' }], 'home-a', refs)).toHaveLength(2);
        expect(headers([first, { ...keyless, ownerAccountId: undefined, access: undefined, accessLevel: undefined }], 'home-a', refs)).toHaveLength(2);
        expect(headers([first, { ...keyless, ownerAccountId: undefined, access: createSessionAccessFixture('owner') }], 'home-a', refs)).toHaveLength(1);
    });

    it('keeps the admitted host path mapping in compact rows for keyless sandbox association', () => {
        const metadata = { host: 'test.local', path: '/container/repo', machineId: 'devbox', sessionWorkspaceLocationV1: {
            v: 1 as const, machineId: 'devbox', agentPath: '/container/repo', machinePath: '/host/repo',
        } };
        const compact = buildSessionListRenderableFromSession(createSessionFixture({ metadata, ownerAccountId: 'viewer-account' }));
        expect(buildSessionListRenderableFromCacheEntry(buildSessionListCacheEntryFromRenderable(compact)).metadata)
            .toMatchObject({ sessionWorkspaceLocationV1: metadata.sessionWorkspaceLocationV1 });
        expect(didSessionListRenderableProjectGroupingFieldsChange(compact, {
            ...compact, metadata: { ...compact.metadata!, sessionWorkspaceLocationV1: {
                ...metadata.sessionWorkspaceLocationV1, machinePath: '/host/different',
            } },
        })).toBe(true);
        const first = row('first', 'anchor', 'laptop', '/repo', 10);
        const refs = [{ id: 'sandbox', serverId: 'home-a', machineId: 'devbox', rootPath: '/host/repo', projectKey: 'anchor', createdAtMs: 1 }];
        expect(headers([first, { ...compact, projectKey: null }], 'home-a', refs)).toHaveLength(1);
    });

    it('seeds each group by its earliest creation and ignores new work and activity', () => {
        const early = row('early', 'a', 'laptop', '/a', 1);
        const later = row('later', 'b', 'laptop', '/b', 2);
        const initial = headers([later, early]).map(item => item.projectKey);
        const refreshed = headers([{ ...later, updatedAt: 1000 }, early, row('new', 'a', 'devbox', '/new-a', 900)])
            .map(item => item.projectKey);
        expect(initial).toEqual([{ serverId: 'home-a', projectKey: 'a' }, { serverId: 'home-a', projectKey: 'b' }]);
        expect(refreshed).toEqual(initial);
    });

    it('retains explicit accepted checkout association through the private cold cache', () => {
        const compact = buildSessionListRenderableFromSession(createSessionFixture({ ownerAccountId: 'viewer-account', metadata: {
            host: 'test.local', workspaceId: 'checkout', projectId: 'anchor', machineId: 'machine', path: '/repo/subdirectory',
        } }));
        const restored = buildSessionListRenderableFromCacheEntry(buildSessionListCacheEntryFromRenderable(compact));
        expect(restored.ownerAccountId).toBe('viewer-account');
        const refs = [{ id: 'checkout', serverId: 'home-a', machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 }];
        expect(headers([row('first', 'anchor', 'laptop', '/repo', 10), { ...restored, projectKey: null }], 'home-a', refs))
            .toHaveLength(1);
        const access = normalizeSessionAccessProjection({ effectiveAccess: {
            v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture('owner').capabilities,
        } });
        if (!access) throw new Error('Expected canonical current owner access');
        for (const ownerAccountId of [undefined, '', 'another-account']) {
            const restoredSubject = buildSessionListRenderableFromCacheEntry(buildSessionListCacheEntryFromRenderable({
                ...compact, ownerAccountId, access,
            }));
            expect(restoredSubject.ownerAccountId).toBe(ownerAccountId);
            expect(headers([row('first', 'anchor', 'laptop', '/repo', 10), { ...restoredSubject, projectKey: null }], 'home-a', refs))
                .toHaveLength(ownerAccountId === undefined ? 1 : 2);
        }
    });

    it('appends newly presented groups while mounted and places unsaved groups after manual order', () => {
        const a = row('a', 'a', 'machine', '/a', 20);
        const b = row('b', 'b', 'machine', '/b', 10);
        const build = (rows: ReturnType<typeof row>[], previousIndex?: ReturnType<typeof buildSessionListIndexWithServerScope>) => buildSessionListIndexWithServerScope({
            sessions: Object.fromEntries(rows.map(item => [item.id, item])), machines: {},
            serverScope: { serverId: 'home-a' }, layoutV1: 'projects', previousIndex,
        });
        const initial = build([a]);
        const source = build([a, b], initial);
        const appended = retainSessionProjectGroupOrder(source, initial);
        const projectHeaders = (items: typeof initial) => items.flatMap(item => item.type === 'header' && item.headerKind === 'project' ? [item.projectKey] : []);
        const aKey = JSON.stringify(['project', 'home-a', 'a']);
        const aProject = { serverId: 'home-a', projectKey: 'a' };
        const bProject = { serverId: 'home-a', projectKey: 'b' };
        // The store is view-neutral: changing spaces must be able to seed a fresh presentation.
        expect(projectHeaders(source)).toEqual([bProject, aProject]);
        expect(projectHeaders(appended)).toEqual([aProject, bProject]);
        const ordered = applySessionWorkspaceOrderV1ToIndex(build([a, b]), { [buildSessionWorkspaceOrderScopeKey('home-a')]: [aKey] });
        expect(projectHeaders(ordered)).toEqual([aProject, bProject]);
    });

    it('translates complete legacy tuple order in memory and retains unseen saved groups', () => {
        const scopeKey = buildSessionWorkspaceOrderScopeKey('home-a');
        const first = JSON.stringify(['home-a', 'm1', '/first']);
        const second = JSON.stringify(['home-a', 'm2', '/second']);
        const unseen = JSON.stringify(['project', 'home-a', 'unseen']);
        const rows = [row('a', 'anchor', 'm1', '/first', 1), row('b', 'anchor', 'm2', '/second', 2)];
        const source = buildSessionListIndexWithServerScope({ sessions: Object.fromEntries(rows.map(item => [item.id, item])),
            machines: {}, serverScope: { serverId: 'home-a' }, layoutV1: 'projects' });
        const workspaceRefs = [
            { id: 'one', serverId: 'home-a', machineId: 'm1', rootPath: '/first', projectKey: 'anchor', createdAtMs: 1 },
            { id: 'two', serverId: 'home-a', machineId: 'm2', rootPath: '/second', projectKey: 'anchor', createdAtMs: 2 },
        ];
        const input = { source, sessionWorkspaceOrderV1: { [scopeKey]: [first, unseen, second] }, workspaceRefs,
            workspaceRefsServerId: 'home-a' };
        expect(normalizeSessionWorkspaceOrderV1ForSource(input)[scopeKey])
            .toEqual([JSON.stringify(['project', 'home-a', 'anchor']), unseen]);
        expect(normalizeSessionWorkspaceOrderV1ForSource({ ...input, workspaceRefs: undefined })[scopeKey])
            .toEqual([JSON.stringify(['project', 'home-a', 'anchor']), unseen]);
        const foreignScope = buildSessionWorkspaceOrderScopeKey('home-b');
        expect(normalizeSessionWorkspaceOrderV1ForSource({ ...input,
            workspaceRefs: [{ ...workspaceRefs[0]!, serverId: 'home-b' }],
            sessionWorkspaceOrderV1: { [foreignScope]: [JSON.stringify(['home-b', 'm1', '/first'])] },
        })[foreignScope]).toEqual(['wl_e539b108']);
        // ../0.2 413054f17c... sessionWorkspacePresentation.ts: JS multiplication over id:<machine>:<path>.
        const predecessor = { ...input, sessionWorkspaceOrderV1: { [scopeKey]: ['wl_e539b108', unseen, 'wl_71fb0700'] } };
        expect(normalizeSessionWorkspaceOrderV1ForSource(predecessor)[scopeKey])
            .toEqual([JSON.stringify(['project', 'home-a', 'anchor']), unseen]);
        expect(normalizeSessionWorkspaceOrderV1ForSource({ ...predecessor, workspaceRefs: undefined })[scopeKey])
            .toEqual([JSON.stringify(['project', 'home-a', 'anchor']), unseen]);
        const conflictingRows = [row('a', 'anchor', 'm1', '/first', 1), row('b', 'other', 'm1', '/first', 2)];
        const conflictingSource = buildSessionListIndexWithServerScope({
            sessions: Object.fromEntries(conflictingRows.map(item => [item.id, item])), machines: {},
            serverScope: { serverId: 'home-a' }, layoutV1: 'projects',
        });
        expect(normalizeSessionWorkspaceOrderV1ForSource({ ...predecessor,
            source: conflictingSource,
            sessionWorkspaceOrderV1: { [scopeKey]: ['wl_e539b108'] },
        })[scopeKey]).toEqual(['wl_e539b108']);
        expect(normalizeSessionWorkspaceOrderV1ForSource({ ...input,
            source: conflictingSource, sessionWorkspaceOrderV1: { [scopeKey]: [first] },
        })[scopeKey]).toEqual(['wl_e539b108']);
        const collidingRows = [row('a', 'anchor', 'm29645', '/repo', 1), row('b', 'other', 'm41845', '/repo', 2)];
        const collidingSource = buildSessionListIndexWithServerScope({
            sessions: Object.fromEntries(collidingRows.map(item => [item.id, item])), machines: {},
            serverScope: { serverId: 'home-a' }, layoutV1: 'projects',
        });
        const collision = buildSessionWorkspaceFallbackOrderKey(['home-a', 'm29645', '/repo']);
        expect(collision).toBe(buildSessionWorkspaceFallbackOrderKey(['home-a', 'm41845', '/repo']));
        expect(normalizeSessionWorkspaceOrderV1ForSource({ source: collidingSource,
            sessionWorkspaceOrderV1: { [scopeKey]: [collision] } })[scopeKey]).toEqual([collision]);
    });

    it('keeps predecessor saved order for exact keyless fallback groups before a Project census is available', () => {
        const scopeKey = buildSessionWorkspaceOrderScopeKey('home-a');
        const source = headers([row('first', null, 'm1', '/first', 1), row('second', null, 'm2', '/second', 2)]);
        const unseen = 'wl_unseen';
        const normalized = normalizeSessionWorkspaceOrderV1ForSource({ source, workspaceRefs: undefined,
            sessionWorkspaceOrderV1: { [scopeKey]: ['wl_71fb0700', unseen, 'wl_e539b108'] } });
        expect(normalized[scopeKey]).toEqual(['wl_71fb0700', unseen, 'wl_e539b108']);
        expect(applySessionWorkspaceOrderV1ToIndex(source, normalized).map(item => item.type === 'header' ? item.workspaceKey : null))
            .toEqual(['wl_71fb0700', 'wl_e539b108']);
    });

    it('reads the canonical opaque sibling scope ahead of the raw dev scope and retains saved unseen rows', () => {
        const session = row('first', null, 'm1', '/first', 1);
        const source = buildSessionListIndexWithServerScope({ sessions: { first: session }, machines: {},
            serverScope: { serverId: 'home-a' }, layoutV1: 'projects' });
        const internal = JSON.stringify(['home-a', 'm1', '/first']);
        const sessionKey = normalizeSessionListKeyParts('home-a', session.id).sessionKey!;
        const unseen = normalizeSessionListKeyParts('home-a', 'unseen').sessionKey!;
        expect(normalizeSessionListGroupOrderV1ForIndexSource({ source, pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [internal]: [unseen, sessionKey],
                'server:home-a:project:e539b108': [sessionKey, unseen] },
        })).toEqual({ [internal]: [sessionKey, unseen] });
    });

    it('completes only the open Home and preserves missing-row frontiers through the visible projection', () => {
        const owner = row('owner', 'anchor', 'm1', '/repo', 1);
        const keyless = row('old', null, 'm2', '/checkout', 2);
        const foreign = row('foreign', null, 'm2', '/checkout', 3);
        const localIndex = buildSessionListIndexWithServerScope({ sessions: { owner, old: keyless }, machines: {}, serverScope: { serverId: 'home-a' } });
        const foreignIndex = buildSessionListIndexWithServerScope({ sessions: { foreign }, machines: {}, serverScope: { serverId: 'home-b' } });
        const source = [...localIndex,
            { type: 'header' as const, headerKind: 'loading' as const, groupKey: 'frontier', title: 'Loading', serverId: 'home-a' },
            { type: 'session' as const, groupKind: 'loading' as const, groupKey: 'frontier', sessionId: 'missing', serverId: 'home-a' },
            ...foreignIndex];
        const localRows: Record<string, ReturnType<typeof row>> = { owner, old: keyless };
        const projected = projectSessionListAcceptedProjects({ source, censusServerId: 'home-a', viewerAccountId: 'viewer-account', workspaceRefs: [
            { id: 'checkout', serverId: 'home-a', machineId: 'm2', rootPath: '/checkout', projectKey: 'anchor', createdAtMs: 1 },
            { id: 'foreign-checkout', serverId: 'home-b', machineId: 'm2', rootPath: '/checkout', projectKey: 'foreign-anchor', createdAtMs: 1 },
        ], resolveSessionRow: (home, id) => home === 'home-a' ? (localRows[id] ?? null) : id === foreign.id ? foreign : null });
        expect(projected.find(item => item.type === 'session' && item.sessionId === 'old')?.groupKey)
            .toBe(JSON.stringify(['project', 'home-a', 'anchor']));
        expect(projected.find(item => item.type === 'session' && item.sessionId === 'foreign'))
            .toBe(foreignIndex.find(item => item.type === 'session'));
        expect(projected).toContain(source.find(item => item.type === 'session' && item.sessionId === 'missing'));
        expect(projected).toContain(source.find(item => item.type === 'header' && item.groupKey === 'frontier'));
    });
});
