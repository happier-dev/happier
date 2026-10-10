import { describe, expect, it, vi } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

import { commitSessionListDragIntent, resolveSessionListDragIntent } from './commitSessionListDragIntent';
import { createSessionListOrganizationActionAdapter, invokeSessionListOrganizationAction,
    registerMountedSessionListOrganizationAction } from './sessionListOrganizationAction';
import { listSessionListEntityDropDestinations, readSessionListFolderAssignmentDestination, resolveSessionListFolderAssignmentDrop, resolveSessionListEntityDrop } from './resolveSessionListEntityDrop';
import { buildSessionListIndexWithServerScope } from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import { buildSessionFolderAssignmentKey, resolveFolderAwareSessionListSourceForLayout } from '@/sync/domains/session/folders';
import { projectSessionListIndexForLayout } from '@/sync/domains/session/listing/sessionListLayout';
import { createSessionFixture } from '@/dev/testkit';
import { resolvePutUnderEligibility } from '@/components/sessions/work/putUnderCandidates';
import { createSessionReportsToEligibilitySnapshot } from '@/sync/ops/relations/sessionReportsToEligibility';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import type { SessionListDragIntent } from './_types';
import { resolveWorkspaceRootTreeRowId, treeRowId } from '../drop-resolution/treeRowId';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { buildSessionWorkspaceOrderAfterTreeDrop } from '../commit/applyWorkspaceOrderUpdate';
import {
    buildSessionProjectGroupingIdentity,
    sessionProjectGroupingIdentityKey,
} from '@/sync/domains/session/listing/sessionListProjectGroupingKeys';
import { buildSessionWorkspaceOrderItemKey } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';

const mutationScope = { credentials: { token: 'domain-boundary-token', secret: 'secret' }, serverId: 'server-a', serverUrl: 'https://home.test', serverIdAliases: [] };

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

const projectGroupKey = 'project-a';
const folderAGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-a';
const folderBGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-b';

function projectHeader(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: projectGroupKey,
        headerKind: 'project',
        groupKey: projectGroupKey,
        workspaceKey: projectGroupKey,
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function folderHeader(id: string, groupKey: string, depth: number): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: id,
        headerKind: 'folder',
        folderId: id,
        folderDepth: depth,
        groupKey,
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function sessionItem(id: string, groupKey: string, folderId: string | null, depth: number): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey,
        groupKind: folderId ? 'folder' : 'project',
        folderId,
        folderDepth: depth,
        workspace: workspaceA,
    };
}

/** Project with two root sessions and a folder. */
function items(): SessionListIndexItem[] {
    return [
        projectHeader(),
        folderHeader('folder-a', folderAGroupKey, 0),
        sessionItem('inside-a', folderAGroupKey, 'folder-a', 1),
        sessionItem('root-a', projectGroupKey, null, 0),
        sessionItem('root-b', projectGroupKey, null, 0),
    ];
}

function folders(): SessionFoldersV1 {
    return {
        v: 1,
        folders: [
            { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
            { id: 'folder-b', workspace: workspaceA, parentId: null, name: 'B', createdAt: 2, updatedAt: 2, sortKey: '000002' },
        ],
    };
}

function makeContext(overrides?: Partial<Parameters<typeof commitSessionListDragIntent>[0]['context']>) {
    const sessions = Object.fromEntries((overrides?.latestItems ?? items()).flatMap(item => item.type === 'session'
        ? [[item.sessionId, createSessionFixture({ id: item.sessionId, serverId: item.serverId })] as const] : []));
    const setSessionFoldersV1 = vi.fn();
    const setSessionListGroupOrderV1 = vi.fn();
    const setSessionWorkspaceOrderV1 = vi.fn();
    const setSessionFolderAssignment = vi.fn(
        async (_assignment: Readonly<{ serverId: string; sessionId: string; folderId: string | null }>) => {},
    );
    return {
        context: {
            latestItems: items(),
            sessionFoldersV1: folders(),
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {},
            now: () => 100,
            setSessionFoldersV1,
            setSessionListGroupOrderV1,
            setSessionWorkspaceOrderV1,
            setSessionFolderAssignment,
            resolvePutSessionUnder: (input: Readonly<{ serverId: string; sessionId: string; leadSessionId: string }>) => {
                const facts = createSessionReportsToEligibilitySnapshot({ serverId: input.serverId, accountId: 'account',
                    sessionId: input.sessionId, currentLeadSessionId: null,
                    candidates: Object.keys(sessions).map(sessionId => ({ sessionId, allowed: true })),
                    isCurrent: () => true, dispose: () => {} });
                return resolvePutUnderEligibility(sessions, input.sessionId, input.leadSessionId, facts, { serverId: input.serverId });
            },
            ...overrides,
        },
        spies: { setSessionFoldersV1, setSessionListGroupOrderV1, setSessionWorkspaceOrderV1, setSessionFolderAssignment },
    };
}

describe('session list chooser destinations independent of folder presentation', () => {
    it.each(['project', 'date'] as const)('keeps folder assignment available through the real %s producer and Recent activity projection', grouping => {
        const session = createSessionFixture({ id: 'root-a', metadata: { machineId: 'machine-a', path: '/repo/a', host: 'a' } });
        const source = buildSessionListIndexWithServerScope({ sessions: { 'root-a': session }, machines: {},
            activeGroupingV1: grouping, inactiveGroupingV1: grouping, serverScope: { serverId: 'server-a' } });
        const assigned = resolveFolderAwareSessionListSourceForLayout({ source, layoutChoice: 'recent_activity',
            foldersFeatureEnabled: true, folderViewModeV1: 'off',
            folders: { v: 1, folders: folders().folders.map(folder => ({ ...folder, serverId: 'server-a' })) },
            assignmentsBySessionKey: { [buildSessionFolderAssignmentKey('server-a', 'root-a')]: 'folder-a' },
            collapsedGroupKeys: {}, focusedFolder: null });
        const recent = projectSessionListIndexForLayout({ source: assigned.items, choice: 'recent_activity',
            resolveSessionRow: () => session, nowMs: 100 });
        const row = recent.find(item => item.type === 'session');
        expect(row).toEqual(expect.objectContaining({ workspace: workspaceA, folderId: 'folder-a' }));
        const scope = { serverId: 'server-a', accountId: 'account' };
        const { context } = makeContext({ scope, latestItems: recent.filter(item => item.type === 'session'),
            isFolderOrganizationEnabled: () => true });
        const item = { kind: 'session', scope, address: { serverId: 'server-a', sessionId: 'root-a' } } as const;
        const destinations = listSessionListEntityDropDestinations({ item, context,
            preview: () => ({ verb: 'Move', target: 'Folder' }), folderPreview: () => ({ verb: 'Move', target: 'Folder' }) });
        expect(destinations.some(entry => readSessionListFolderAssignmentDestination(entry.destination)?.folderId === 'folder-b')).toBe(true);
        const resolve = (folderId: string | null) => resolveSessionListFolderAssignmentDrop({ item, folderId, context,
            preview: () => ({ verb: 'Move', target: 'Folder' }), reason: code => ({ code, message: code }) });
        expect(resolve(null).status).toBe('allowed');
        expect(resolve('folder-a').status).toBe('refused');
    });

    it('offers a workspace folder absent from the visible list index', async () => {
        const scope = { serverId: 'server-a', accountId: 'account' };
        const { context } = makeContext({
            scope,
            isFolderOrganizationEnabled: () => true,
            latestItems: [projectHeader(), sessionItem('root-a', projectGroupKey, null, 0)],
        });
        const item = { kind: 'session', scope, address: { serverId: 'server-a', sessionId: 'root-a' } } as const;
        const destinations = listSessionListEntityDropDestinations({ item, context,
            preview: () => ({ verb: 'Move', target: 'Folder' }), folderPreview: () => ({ verb: 'Move', target: 'Folder' }) });
        const folderDestination = destinations.find(entry => readSessionListFolderAssignmentDestination(entry.destination)?.folderId === 'folder-a');
        expect(folderDestination).toBeDefined();
        const resolve = (folderId: string | null, current = context) => resolveSessionListFolderAssignmentDrop({ item,
            folderId, context: current, preview: () => ({ verb: 'Move', target: 'Folder' }),
            reason: code => ({ code, message: code }) });
        expect(resolve('folder-a')).toEqual(expect.objectContaining({ status: 'allowed', effect: expect.objectContaining({
            actionId: 'session.folder.set', input: { sessionId: 'root-a', folderId: 'folder-a' },
        }) }));
        expect(resolve(null).status).toBe('refused');
        expect(resolve('removed-folder').status).toBe('refused');
        expect(resolve('folder-a', { ...context, isFolderOrganizationEnabled: () => false }).status).toBe('refused');
        expect(resolve('folder-a', { ...context, scope: { ...scope, accountId: 'replacement' } }).status).toBe('refused');
    });
});

describe('commitSessionListDragIntent — putting a Session under a lead', () => {
    function underIntent(targetSessionId: string): SessionListDragIntent {
        const target = treeRowId.session('server-a', targetSessionId);
        return {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'nest-into',
            targetRowId: target,
            containerId: target,
            parentRowId: target,
            depth: 1,
            edge: null,
            sourceSnapshotSignature: 'sig',
        };
    }

    it('projects the canonical current relation verdict and CAS anchor without writing during hover', () => {
        const scope = { serverId: 'server-a', accountId: 'account' };
        const sessions = { 'root-a': createSessionFixture({ id: 'root-a', serverId: scope.serverId }),
            'root-b': createSessionFixture({ id: 'root-b', serverId: scope.serverId }) };
        let current = true;
        const facts = createSessionReportsToEligibilitySnapshot({ ...scope, sessionId: 'root-b', currentLeadSessionId: null,
            candidates: [{ sessionId: 'root-a', allowed: true }], isCurrent: () => current, dispose: () => { current = false; } });
        const putSessionUnder = vi.fn(async () => 'applied' as const);
        const { context } = makeContext({ scope, putSessionUnder,
            resolvePutSessionUnder: input => resolvePutUnderEligibility(sessions, input.sessionId, input.leadSessionId, facts, scope) });
        const params = { item: { kind: 'session' as const, scope, address: { serverId: scope.serverId, sessionId: 'root-b' } },
            intent: underIntent('root-a'), context, preview: () => ({ verb: 'Put under', target: 'Lead' }),
            refusedPreview: ({ target }: Readonly<{ target: { sessionId: string | null } | null }>) =>
                target?.sessionId ? { verb: 'Cannot put under', target: target.sessionId } : undefined,
            reason: (code: string) => ({ code, message: code }) };
        expect(resolveSessionListEntityDrop(params)).toMatchObject({ status: 'allowed', effect: {
            actionId: 'session.reports_to.set', input: { sessionId: 'root-b', leadSessionId: 'root-a', expectedLeadSessionId: null } } });
        expect(putSessionUnder).not.toHaveBeenCalled();
        facts.dispose();
        expect(resolveSessionListEntityDrop(params)).toMatchObject({ status: 'refused', reason: { code: 'unavailable' },
            preview: { verb: 'Cannot put under', target: 'root-a' } });
        const latestItems = context.latestItems.filter(item => item.type !== 'session' || item.sessionId !== 'root-a');
        expect(resolveSessionListEntityDrop({ ...params, context: { ...context, latestItems } }))
            .toEqual({ status: 'refused', reason: { code: 'target-missing', message: 'target-missing' } });
        expect(putSessionUnder).not.toHaveBeenCalled();
    });

    it('asks the reportsTo owner and touches no folder or order state', async () => {
        const putSessionUnder = vi.fn(async () => 'applied' as const);
        const { context, spies } = makeContext({ putSessionUnder });

        const result = await commitSessionListDragIntent({ intent: underIntent('root-a'), context });

        expect(result).toEqual({ ok: true });
        expect(putSessionUnder).toHaveBeenCalledWith({ serverId: 'server-a', sessionId: 'root-b', leadSessionId: 'root-a' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(spies.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('no-ops when the lead left the list, the drop is no longer eligible, or the server refused', async () => {
        const putSessionUnder = vi.fn(async () => 'applied' as const);
        expect(await commitSessionListDragIntent({ intent: underIntent('gone'), context: makeContext({ putSessionUnder }).context }))
            .toEqual({ ok: false, reason: 'target-missing' });
        expect(putSessionUnder).not.toHaveBeenCalled();

        expect(await commitSessionListDragIntent({
            intent: underIntent('root-a'),
            context: makeContext({ putSessionUnder: async () => 'not-eligible' as const }).context,
        })).toEqual({ ok: false, reason: 'blocked-intent' });
        expect(await commitSessionListDragIntent({
            intent: underIntent('root-a'),
            context: makeContext({ putSessionUnder: async () => 'refused' as const }).context,
        })).toEqual({ ok: false, reason: 'refused' });
        expect(await commitSessionListDragIntent({ intent: underIntent('root-a'), context: makeContext().context }))
            .toEqual({ ok: false, reason: 'blocked-intent' });
    });

    it('cannot dispatch a relation commit without authoritative current eligibility', async () => {
        const putSessionUnder = vi.fn(async () => 'applied' as const);
        const { context } = makeContext({ putSessionUnder, resolvePutSessionUnder: undefined });
        expect(await commitSessionListDragIntent({ intent: underIntent('root-a'), context }))
            .toEqual({ ok: false, reason: 'blocked-intent' });
        expect(putSessionUnder).not.toHaveBeenCalled();
    });
});

describe('commitSessionListDragIntent', () => {
    it('moves into the named folder child container rather than mistaking its parent for the destination', async () => {
        const targetRowId = treeRowId.folder('server-a', 'folder-a');
        const intent: SessionListDragIntent = { sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf', instructionKind: 'nest-into', targetRowId,
            containerId: targetRowId, parentRowId: targetRowId, depth: 1, edge: null, sourceSnapshotSignature: '' };
        const { context, spies } = makeContext();
        expect(await commitSessionListDragIntent({ intent, context })).toEqual({ ok: true });
        expect(spies.setSessionFolderAssignment).toHaveBeenCalledWith({ serverId: 'server-a', sessionId: 'root-b', folderId: 'folder-a' });
    });

    it('refuses a folder nest whose destination no longer belongs to the named target', async () => {
        const targetRowId = treeRowId.folder('server-a', 'folder-a');
        const intent: SessionListDragIntent = { sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf', instructionKind: 'nest-into', targetRowId,
            containerId: treeRowId.workspaceRoot(projectGroupKey), parentRowId: targetRowId,
            depth: 1, edge: null, sourceSnapshotSignature: '' };
        const { context, spies } = makeContext();
        expect(await commitSessionListDragIntent({ intent, context })).toEqual({ ok: false, reason: 'target-missing' });
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });
    it('keeps an organization commit pending until its canonical order write acknowledges', async () => {
        let acknowledge!: () => void;
        const persisted = new Promise<void>(resolve => { acknowledge = resolve; });
        const { context } = makeContext({ setSessionListGroupOrderV1: () => persisted });
        const intent: SessionListDragIntent = { sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf', instructionKind: 'reorder-before', targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey), parentRowId: null, depth: 0,
            edge: 'top', sourceSnapshotSignature: '' };
        let settled = false;
        const commit = commitSessionListDragIntent({ intent, context }).then(result => { settled = true; return result; });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(settled).toBe(false);
        acknowledge();
        expect(await commit).toEqual({ ok: true });
    });

    it('keeps a dispatched order write with no acknowledgement unknown instead of reporting refusal', async () => {
        const { context } = makeContext({ scope: { serverId: 'server-a', accountId: 'account' },
            setSessionListGroupOrderV1: async () => { throw new Error('transport_disconnected'); } });
        const execute = createSessionListOrganizationActionAdapter(() => context);
        const input = { scope: context.scope!, sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf', instructionKind: 'reorder-before', targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey), parentRowId: null, depth: 0, edge: 'top' };
        expect(await execute({ mutationScope, input })).toEqual({ status: 'unknown', reason: 'organization_write_outcome_unknown' });
    });

    it('uses the same qualified admission and latest membership for the Action and pointer effect', async () => {
        const scope = { serverId: 'server-a', accountId: 'account' };
        const { context, spies } = makeContext();
        const live = { ...context, scope, latestTree: buildSessionListTreeRows({ items: context.latestItems }) };
        const intent: SessionListDragIntent = { sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf', instructionKind: 'reorder-before', targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey), parentRowId: null, depth: 0,
            edge: 'top', sourceSnapshotSignature: '' };
        const item = { kind: 'session' as const, scope, address: { serverId: 'server-a', sessionId: 'root-b' } };
        const indexedAdmission = resolveSessionListDragIntent({ intent, context: live });
        expect(indexedAdmission.ok && indexedAdmission.effect === 'organization' && indexedAdmission.tree)
            .toBe(live.latestTree);
        const preview = () => ({ verb: 'Move', target: 'Root' });
        const reason = (code: string) => ({ code, message: code });
        const admission = resolveSessionListEntityDrop({ item, intent, context: live, preview, reason });
        expect(admission.status).toBe('allowed');
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(resolveSessionListEntityDrop({ item: { ...item, scope: { ...scope, accountId: 'other' } },
            intent, context: live, preview, reason })).toMatchObject({ status: 'refused', reason: { code: 'scope-mismatch' } });
        const execute = createSessionListOrganizationActionAdapter(() => live);
        if (admission.status !== 'allowed') throw new Error('expected organization admission');
        // The supplied tree becomes stale. Release must rebuild from changed current membership.
        live.latestItems = [...items(), sessionItem('new-root', projectGroupKey, null, 0)];
        // This client Action exercises the real mounted adapter and domain owner; no other execution port is reached.
        const retire = registerMountedSessionListOrganizationAction(execute);
        const actionExecutor = createActionExecutor({ sessionOrganizationMove: (request: Parameters<typeof invokeSessionListOrganizationAction>[0]) => invokeSessionListOrganizationAction({ ...request, mutationScope }) } as unknown as ActionExecutorDeps);
        try {
            expect(await actionExecutor.execute('session.organization.move', admission.effect.input,
                { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
                .toEqual({ ok: true, result: { status: 'applied' } });
        } finally { retire(); }
        expect(await actionExecutor.execute('session.organization.move', admission.effect.input,
            { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
            .toEqual({ ok: true, result: { status: 'unavailable' } });
        const tree = buildSessionListTreeRows({ items: live.latestItems });
        const destination = tree.containerMetadataById.get(intent.containerId!);
        expect(spies.setSessionListGroupOrderV1.mock.calls[0]?.[0]?.[destination!.groupKey])
            .toContain(tree.rowMetadataById.get(treeRowId.session('server-a', 'new-root'))!.orderKey);
        const beforeWrites = spies.setSessionListGroupOrderV1.mock.calls.length;
        const cancel = new AbortController(); cancel.abort();
        expect(await execute({ mutationScope, input: admission.effect.input, signal: cancel.signal })).toEqual({ status: 'refused', reason: 'cancelled' });
        expect(spies.setSessionListGroupOrderV1.mock.calls.length).toBe(beforeWrites);
        live.scope = { ...scope, accountId: 'replacement' };
        expect(await execute({ mutationScope, input: admission.effect.input })).toEqual({ status: 'refused', reason: 'scope-mismatch' });
        await expect(createSessionListOrganizationActionAdapter(() => null)({ mutationScope, input: admission.effect.input }))
            .resolves.toEqual({ status: 'unavailable' });
        expect(resolveSessionListDragIntent({ intent: { ...intent, scope }, context: live })).toEqual({ ok: false, reason: 'scope-mismatch' });
    });

    it('refuses a retained intent after the mounted Account changes', async () => {
        const intent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf' as const,
            instructionKind: 'reorder-before' as const,
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null, depth: 0, edge: 'top' as const, sourceSnapshotSignature: 'sig',
            scope: { serverId: 'server-a', accountId: 'account-before' },
        };
        const { context, spies } = makeContext();
        const result = await commitSessionListDragIntent({ intent,
            context: { ...context, scope: { serverId: 'server-a', accountId: 'account-after' } } });
        expect(result).toEqual({ ok: false, reason: 'scope-mismatch' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('treats an anchor moved out of the destination as a missing anchor', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'), sourceKind: 'leaf',
            instructionKind: 'reorder-after', targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey), parentRowId: null,
            depth: 0, edge: 'bottom', sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext({ latestItems: [projectHeader(),
            folderHeader('folder-a', folderAGroupKey, 0),
            sessionItem('root-a', folderAGroupKey, 'folder-a', 1),
            sessionItem('root-b', projectGroupKey, null, 0),
            sessionItem('new-root', projectGroupKey, null, 0)],
        });
        expect(await commitSessionListDragIntent({ intent, context })).toEqual({ ok: true });
        const tree = buildSessionListTreeRows({ items: context.latestItems });
        const container = tree.containerMetadataById.get(intent.containerId!);
        expect(spies.setSessionListGroupOrderV1.mock.calls[0]?.[0]?.[container!.groupKey])
            .toEqual([tree.rowMetadataById.get(treeRowId.session('server-a', 'new-root'))!.orderKey,
                tree.rowMetadataById.get(intent.sourceRowId)!.orderKey]);
    });

    it('commits a valid reorder intent against the latest tree (moving root-b before root-a)', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result.ok).toBe(true);
        expect(spies.setSessionListGroupOrderV1).toHaveBeenCalledTimes(1);
    });

    it('blocks same-container session reorder intents in date ordering mode', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();
        const dateModeContext = {
            ...context,
            sessionListOrderingModeV1: 'updated' as const,
            sessionListSectionModeV1: 'activity' as const,
        };

        const result = await commitSessionListDragIntent({ intent, context: dateModeContext });

        expect(result).toEqual({ ok: false, reason: 'date-ordering-mode' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
    });

    it('blocks sibling reorder when the active layout suppresses manual ordering', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext({
            sessionListOrderingModeV1: 'custom',
            manualSessionOrderingEnabled: false,
        });

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'date-ordering-mode' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
    });

    it('no-ops with source-missing when the dragged source vanished mid-drag', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'gone'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'source-missing' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('no-ops with container-missing when the destination container vanished mid-drag', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'nest-into',
            targetRowId: treeRowId.folder('server-a', 'gone'),
            containerId: treeRowId.folder('server-a', 'gone'),
            parentRowId: treeRowId.folder('server-a', 'gone'),
            depth: 1,
            edge: null,
            sourceSnapshotSignature: 'sig',
        };
        const { context } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'container-missing' });
    });

    it('no-ops blocked/idle intents without mutating any state', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'blocked',
            targetRowId: null,
            containerId: null,
            parentRowId: null,
            depth: null,
            edge: null,
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'blocked-intent' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(spies.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('degrades a reorder whose target row vanished to a safe container-edge move', async () => {
        // root-a deleted mid-drag; the project container still survives.
        const latestItems: SessionListIndexItem[] = [
            projectHeader(),
            folderHeader('folder-a', folderAGroupKey, 0),
            sessionItem('inside-a', folderAGroupKey, 'folder-a', 1),
            sessionItem('root-b', projectGroupKey, null, 0),
        ];
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context } = makeContext({ latestItems });

        const result = await commitSessionListDragIntent({ intent, context });

        // The target row is gone but the container survives: the move still
        // applies (degraded to the container top edge), it does not no-op.
        expect(result.ok).toBe(true);
    });

    it('no-ops folder moves that would create a cycle against the latest tree', async () => {
        // folder-b nested under folder-a in the latest tree; moving folder-a into
        // folder-b would cycle.
        const latestItems: SessionListIndexItem[] = [
            projectHeader(),
            folderHeader('folder-a', folderAGroupKey, 0),
            folderHeader('folder-b', folderBGroupKey, 1),
        ];
        const cyclicFolders: SessionFoldersV1 = {
            v: 1,
            folders: [
                { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
                { id: 'folder-b', workspace: workspaceA, parentId: 'folder-a', name: 'B', createdAt: 2, updatedAt: 2, sortKey: '000001' },
            ],
        };
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.folder('server-a', 'folder-a'),
            sourceKind: 'container',
            instructionKind: 'nest-into',
            targetRowId: treeRowId.folder('server-a', 'folder-b'),
            containerId: treeRowId.folder('server-a', 'folder-b'),
            parentRowId: treeRowId.folder('server-a', 'folder-b'),
            depth: 2,
            edge: null,
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext({ latestItems, sessionFoldersV1: cyclicFolders });

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'descendant-cycle' });
        expect(spies.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('commits a move-to-root intent rebased onto the latest tree', async () => {
        // A session inside folder-a moves to the project root (move-to-root).
        // `../dev` carries the root placement on the intent `edge`.
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'move-to-root',
            targetRowId: null,
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'bottom',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext({ manualSessionOrderingEnabled: false });

        const result = await commitSessionListDragIntent({ intent, context });

        // Containment remains valid while the layout suppresses sibling ordering.
        expect(result.ok).toBe(true);
        expect(spies.setSessionFolderAssignment).toHaveBeenCalledTimes(1);
        expect(spies.setSessionFolderAssignment.mock.calls[0]?.[0]).toEqual({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });
});

describe('commitSessionListDragIntent — latest-tree rebuild', () => {
    it('rebuilds the latest tree once from latestItems (geometry-free)', () => {
        // Sanity: the commit's tree input is built without measured bounds.
        const tree = buildSessionListTreeRows({ items: items() });
        expect(tree.rows).toEqual([]);
        expect(tree.rowMetadataById.size).toBeGreaterThan(0);
    });

    it('keeps legacy-FNV-colliding workspace roots as independent move targets', () => {
        const identityForMachine = (machineId: string) => sessionProjectGroupingIdentityKey(
            buildSessionProjectGroupingIdentity('home-a', { machineId, pathKey: '/repo' }),
        );
        const identityA = identityForMachine('m29645');
        const identityB = identityForMachine('m41845');
        const headerA: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header', title: 'A', headerKind: 'project', serverId: 'home-a',
            groupKey: identityA, workspaceKey: identityA,
        };
        const headerB: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header', title: 'B', headerKind: 'project', serverId: 'home-a',
            groupKey: identityB, workspaceKey: identityB,
        };
        const tree = buildSessionListTreeRows({ items: [headerA, headerB] });
        const rowA = resolveWorkspaceRootTreeRowId(headerA);
        const rowB = resolveWorkspaceRootTreeRowId(headerB);
        const metadataA = tree.rowMetadataById.get(rowA);
        const metadataB = tree.rowMetadataById.get(rowB);

        expect(rowA).not.toBe(rowB);
        expect(metadataA?.orderKey).not.toBe(metadataB?.orderKey);

        const next = buildSessionWorkspaceOrderAfterTreeDrop({
            tree,
            currentMap: {},
            movedRowId: rowB,
            containerId: metadataA!.containerId,
            beforeRowId: rowA,
        });
        expect(next?.[metadataA!.containerGroupKey]).toEqual([
            metadataB?.orderKey,
            metadataA?.orderKey,
        ]);
    });

    it('keeps one project root identity when the seed Session is removed or reordered', () => {
        const identity = sessionProjectGroupingIdentityKey(
            buildSessionProjectGroupingIdentity('home-a', { machineId: 'machine-a', pathKey: '/repo' }),
        );
        const first: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header', title: 'Repo', headerKind: 'project', serverId: 'home-a',
            groupKey: identity, workspaceKey: identity, seedSessionId: 'session-first',
        };
        const afterRemoval: Extract<SessionListIndexItem, { type: 'header' }> = {
            ...first,
            seedSessionId: 'session-second',
        };

        expect(resolveWorkspaceRootTreeRowId(first)).toBe(resolveWorkspaceRootTreeRowId(afterRemoval));
        expect(buildSessionWorkspaceOrderItemKey(first.workspaceKey)).toBe(
            buildSessionWorkspaceOrderItemKey(afterRemoval.workspaceKey),
        );
    });
});
