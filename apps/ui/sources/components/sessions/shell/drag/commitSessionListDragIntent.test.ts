import { describe, expect, it, vi } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

import { commitSessionListDragIntent, resolveSessionListDragIntent } from './commitSessionListDragIntent';
import { createSessionListOrganizationActionAdapter, invokeSessionListOrganizationAction,
    registerMountedSessionListOrganizationAction } from './sessionListOrganizationAction';
import { listSessionListEntityDropDestinations, readSessionListFolderAssignmentDestination, resolveSessionListFolderAssignmentDrop,
    readSessionListSpaceMembershipDestination, resolveSessionListSpaceMembershipDrop, resolveSessionListEntityDrop } from './resolveSessionListEntityDrop';
import { buildSessionListIndexWithServerScope } from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import { buildSessionFolderAssignmentKey } from '@/sync/domains/session/folders';
import { buildSessionSectionGroupKey, projectSessionSectionListIndex } from '@/sync/domains/session/organization/sections';
import { projectSessionListIndexForLayout } from '@/sync/domains/session/listing/sessionListLayout';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { resolvePutUnderEligibility } from '@/components/sessions/work/putUnderCandidates';
import { createSessionManagerEligibilitySnapshot } from '@/sync/ops/relations/sessionManagerEligibility';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { SessionListDragIntent } from './_types';
import { resolveWorkspaceRootTreeRowId, treeRowId } from '../drop-resolution/treeRowId';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { resolveSessionListInstruction } from '../drop-resolution/resolveSessionListInstruction';
import { beginSessionListStagedMove, stepSessionListStagedMove, resolveSessionListStagedMoveResult } from '../keyboardMove/sessionListStagedMove';
import { buildSessionListDragIntent } from './sessionListDragIntent';
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
const folderAGroupKey = buildSessionSectionGroupKey({ serverId: 'server-a', sectionId: 'folder-a' });
const folderBGroupKey = buildSessionSectionGroupKey({ serverId: 'server-a', sectionId: 'folder-b' });

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

it('refuses an unanchored root drop into the source current place without an order write', async () => {
    const { context, spies } = makeContext();
    const tree = buildSessionListTreeRows({ items: context.latestItems });
    const sourceRowId = treeRowId.session('server-a', 'root-a');
    const source = tree.rowMetadataById.get(sourceRowId)!;
    const result = await commitSessionListDragIntent({ context, intent: {
        sourceRowId, sourceKind: 'leaf', instructionKind: 'move-to-root', targetRowId: null,
        containerId: source.rootId, parentRowId: null, depth: 0, edge: null, sourceSnapshotSignature: '',
    } });
    expect(result).toEqual({ ok: false, reason: 'no-change' });
    expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
});

function makeContext(overrides?: Partial<Parameters<typeof commitSessionListDragIntent>[0]['context']>) {
    const sessions = Object.fromEntries((overrides?.latestItems ?? items()).flatMap(item => item.type === 'session'
        ? [[item.sessionId, createSessionFixture({ id: item.sessionId, serverId: item.serverId })] as const] : []));
    const setSessionListGroupOrderV1 = vi.fn();
    const setSessionWorkspaceOrderV1 = vi.fn();
    const setSessionFolderAssignment = vi.fn(
        async (_assignment: Readonly<{ serverId: string; sessionId: string; folderId: string | null }>) => {},
    );
    return {
        context: {
            latestItems: items(),
            sessionSections: folders().folders.map(folder => ({ address: { serverId: 'server-a', sectionId: folder.id },
                display: { status: 'available' as const, value: { name: folder.name, icon: null } }, sortKey: folder.sortKey ?? null })),
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {},
            setSessionListGroupOrderV1,
            setSessionWorkspaceOrderV1,
            setSessionFolderAssignment,
            resolvePutSessionUnder: (input: Readonly<{ serverId: string; sessionId: string; managerSessionId: string }>) => {
                const facts = createSessionManagerEligibilitySnapshot({ serverId: input.serverId, accountId: 'account',
                    sessionId: input.sessionId, currentManagerSessionId: null,
                    candidates: Object.keys(sessions).map(sessionId => ({ sessionId, allowed: true })),
                    isCurrent: () => true, dispose: () => {} });
                return resolvePutUnderEligibility(sessions, input.sessionId, input.managerSessionId, facts, { serverId: input.serverId });
            },
            ...overrides,
        },
        spies: { setSessionListGroupOrderV1, setSessionWorkspaceOrderV1, setSessionFolderAssignment },
    };
}

describe('Account section destinations', () => {
    it('preserves filing during pin reordering and applies Recent ordering to filed pins too', async () => {
        const { context, spies } = makeContext({ isFolderOrganizationEnabled: () => false, latestItems: [
            { type: 'header', headerKind: 'pinned', title: 'Pinned', groupKey: 'pinned', serverId: 'server-a' },
            { ...sessionItem('first-pin', 'pinned', null, 0), groupKind: 'pinned' },
            { ...sessionItem('filed-pin', 'pinned', 'launch', 0), groupKind: 'pinned' },
        ] });
        const tree = buildSessionListTreeRows({ items: context.latestItems });
        const source = tree.rowMetadataById.get(treeRowId.session('server-a', 'filed-pin'))!;
        const intent: SessionListDragIntent = { sourceRowId: source.rowId, sourceKind: 'leaf', instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'first-pin'), containerId: source.containerId,
            parentRowId: null, depth: 0, edge: 'top', sourceSnapshotSignature: '' };
        expect(await commitSessionListDragIntent({ intent, context: { ...context, sessionListLayoutV1: 'recent_activity' } }))
            .toEqual({ ok: false, reason: 'date-ordering-mode' });
        expect(await commitSessionListDragIntent({ intent, context })).toEqual({ ok: true });
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(spies.setSessionListGroupOrderV1).toHaveBeenCalledTimes(1);
    });

    it('refuses an incidental attention Session as a durable sibling-order anchor', () => {
        const { context } = makeContext({ latestItems: items().map(item => item.type === 'session' && item.sessionId === 'root-a'
            ? { ...item, supplementalAttention: true } : item) });
        expect(resolveSessionListDragIntent({ context, intent: {
            sourceRowId: treeRowId.session('server-a', 'root-b'), sourceKind: 'leaf', instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'), containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null, depth: 0, edge: 'top', sourceSnapshotSignature: '',
        } })).toEqual({ ok: false, reason: 'blocked-intent' });
    });

    it('admits a shelf-origin drop by its real Session address and refuses an unrelated carried Session', () => {
        const base = sessionItem('root-a', projectGroupKey, null, 0);
        const shelf = { ...base, groupKind: 'attention' as const, groupKey: 'attention', occurrenceRole: 'needsYou' as const };
        const scope = { serverId: 'server-a', accountId: 'account' };
        const { context } = makeContext({ scope, putSessionUnder: async () => 'applied', latestItems: [
            { type: 'header', title: 'Attention', headerKind: 'attention', groupKey: 'attention' }, shelf, ...items(),
        ] });
        const sourceRowId = treeRowId.session(scope.serverId, 'root-a', undefined, 'needsYou');
        const intent: SessionListDragIntent = { sourceRowId, sourceKind: 'leaf', instructionKind: 'nest-into',
            targetRowId: treeRowId.session(scope.serverId, 'root-b'), containerId: null, parentRowId: null,
            depth: 1, edge: null, sourceSnapshotSignature: '' };
        const resolve = (sessionId: string) => resolveSessionListEntityDrop({
            item: { kind: 'session', scope, address: { serverId: scope.serverId, sessionId } }, intent, context,
            preview: () => ({ verb: 'Move', target: 'Lead', consequence: 'Reports to Lead' }),
            reason: code => ({ code, message: code }),
        });
        expect(resolve('root-a')).toMatchObject({ status: 'allowed', effect: {
            actionId: 'session.manager.set', input: { sessionId: 'root-a', managerSessionId: 'root-b' },
        } });
        expect(resolve('inside-a')).toMatchObject({ status: 'refused' });
    });

    const section = { ...folderHeader('launch', 'section-launch', 0), workspace: undefined };
    const otherProject = { ...projectHeader(), groupKey: 'project-b', workspaceKey: 'project-b',
        workspace: { ...workspaceA, machineId: 'other-machine', rootPath: '/other' } };
    function sectionIntent(sourceId = 'root-a'): SessionListDragIntent {
        return { sourceRowId: treeRowId.session('server-a', sourceId), sourceKind: 'leaf',
            instructionKind: 'nest-into', targetRowId: treeRowId.folder('server-a', 'launch'),
            containerId: treeRowId.folder('server-a', 'launch'), parentRowId: null,
            depth: 1, edge: null, sourceSnapshotSignature: '' };
    }

    it('admits a section before any Project and moves same-Home Sessions across machines once', async () => {
        const { context, spies } = makeContext({ latestItems: [section, projectHeader(),
            sessionItem('root-a', projectGroupKey, null, 0), otherProject,
            { ...sessionItem('other', 'project-b', null, 0), workspace: otherProject.workspace }] });
        expect(await commitSessionListDragIntent({ intent: sectionIntent('other'), context })).toEqual({ ok: true });
        expect(spies.setSessionFolderAssignment.mock.calls).toEqual([[{ serverId: 'server-a', sessionId: 'other', folderId: 'launch' }]]);
    });

    it('refuses a section from another Home even when its local id matches', async () => {
        const { context, spies } = makeContext({ latestItems: [
            { ...section, serverId: 'server-b' }, projectHeader(), sessionItem('root-a', projectGroupKey, null, 0),
        ] });
        const intent = { ...sectionIntent(), targetRowId: treeRowId.folder('server-b', 'launch'),
            containerId: treeRowId.folder('server-b', 'launch') };
        expect(await commitSessionListDragIntent({ intent, context })).toEqual({ ok: false, reason: 'scope-mismatch' });
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
    });

    it('returns to its own Project and refuses another Project without a membership write', async () => {
        const { context, spies } = makeContext({ latestItems: [section,
            sessionItem('filed', 'section-launch', 'launch', 1), projectHeader(), otherProject] });
        const intent: SessionListDragIntent = { ...sectionIntent('filed'), instructionKind: 'move-to-root',
            targetRowId: null, containerId: treeRowId.workspaceRoot('project-b'), depth: 0 };
        expect(await commitSessionListDragIntent({ intent, context })).toEqual({ ok: false, reason: 'scope-mismatch' });
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(await commitSessionListDragIntent({ intent: { ...intent, containerId: treeRowId.workspaceRoot(projectGroupKey) }, context })).toEqual({ ok: true });
        expect(spies.setSessionFolderAssignment.mock.calls).toEqual([[{ serverId: 'server-a', sessionId: 'filed', folderId: null }]]);
        expect(spies.setSessionListGroupOrderV1).toHaveBeenCalledWith({ [projectGroupKey]: [
            sessionAddressKey({ serverId: 'server-a', sessionId: 'filed' }),
        ] });
    });

    it('returns a filed Session through the real accepted-Project producer across checkouts', () => {
        const source = buildSessionListIndexWithServerScope({ sessions: {
            filed: createSessionListRenderableSessionFixture({ id: 'filed', createdAt: 3, projectKey: 'accepted-project',
                metadata: { machineId: 'machine-a', path: '/repo/a' } }),
            checkout: createSessionListRenderableSessionFixture({ id: 'checkout', createdAt: 2, projectKey: 'accepted-project',
                metadata: { machineId: 'other-machine', path: '/other' } }),
            foreign: createSessionListRenderableSessionFixture({ id: 'foreign', createdAt: 1, projectKey: 'other-project',
                metadata: { machineId: 'machine-a', path: '/repo/a' } }),
        }, machines: {}, layoutV1: 'projects', serverScope: { serverId: 'server-a' } });
        const filed = source.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session' && item.sessionId === 'filed');
        const ownProject = source.find((item): item is Extract<SessionListIndexItem, { type: 'header' }> => item.type === 'header'
            && item.headerKind === 'project' && item.projectKey?.projectKey === 'accepted-project');
        const foreignProject = source.find((item): item is Extract<SessionListIndexItem, { type: 'header' }> => item.type === 'header'
            && item.headerKind === 'project' && item.projectKey?.projectKey === 'other-project');
        if (!filed || !ownProject || !foreignProject) throw new Error('Expected the accepted Project producer to preserve qualified identity');
        const scope = { serverId: 'server-a', accountId: 'account' };
        const { context, spies } = makeContext({ scope, latestItems: [section,
            { ...filed, folderId: 'launch', groupKind: 'folder', groupKey: 'section-launch' },
            ...source.filter(item => item !== filed)] });
        const resolve = (project: typeof ownProject) => resolveSessionListEntityDrop({
            item: { kind: 'session', scope, address: { serverId: 'server-a', sessionId: 'filed' } },
            intent: { ...sectionIntent('filed'), instructionKind: 'move-to-root', targetRowId: null,
                containerId: resolveWorkspaceRootTreeRowId(project), depth: 0 }, context,
            preview: () => ({ verb: 'Return', target: 'Project' }), reason: code => ({ code, message: code }),
        });
        expect(resolve(ownProject)).toMatchObject({ status: 'allowed', effect: {
            actionId: 'session.section.set', input: { sessionId: 'filed', sectionId: null },
        } });
        expect(resolve(foreignProject)).toMatchObject({ status: 'refused', reason: { code: 'scope-mismatch' } });
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
    });

    it('uses accepted Project identity across checkouts and refuses another Project at the same path', () => {
        const scope = { serverId: 'server-a', accountId: 'account' };
        const projectKey = { serverId: 'server-a', projectKey: 'accepted-project' };
        const { context, spies } = makeContext({ scope, latestItems: [section,
            { ...sessionItem('filed', 'section-launch', 'launch', 1), projectKey },
            { ...projectHeader(), projectKey, workspace: otherProject.workspace },
            { ...otherProject, workspace: workspaceA, projectKey: { ...projectKey, projectKey: 'other-project' } },
            { ...projectHeader(), groupKey: 'foreign-key-home', workspaceKey: 'foreign-key-home',
                projectKey: { ...projectKey, serverId: 'server-b' } },
        ] });
        const intent: SessionListDragIntent = { ...sectionIntent('filed'), instructionKind: 'move-to-root',
            targetRowId: null, containerId: treeRowId.workspaceRoot(projectGroupKey), depth: 0 };
        const input = { item: { kind: 'session', scope, address: { serverId: 'server-a', sessionId: 'filed' } } as const,
            intent, context, preview: () => ({ verb: 'Return', target: 'Project' }), reason: (code: string) => ({ code, message: code }) };
        expect(resolveSessionListEntityDrop(input)).toMatchObject({ status: 'allowed', effect: {
            actionId: 'session.section.set', input: { sessionId: 'filed', sectionId: null },
        } });
        expect(resolveSessionListEntityDrop({ ...input, intent: { ...intent, containerId: treeRowId.workspaceRoot('project-b') } }))
            .toMatchObject({ status: 'refused', reason: { code: 'scope-mismatch' } });
        expect(resolveSessionListEntityDrop({ ...input, intent: { ...intent, containerId: treeRowId.workspaceRoot('foreign-key-home') } }))
            .toMatchObject({ status: 'refused', reason: { code: 'scope-mismatch' } });
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
    });

    it('orders section records without writing a mixed session/folder order', async () => {
        const reorderSessionSection = vi.fn(async () => {});
        const { context, spies } = makeContext({ latestItems: [section,
            { ...section, folderId: 'next', groupKey: 'section-next' }], reorderSessionSection });
        const tree = buildSessionListTreeRows({ items: context.latestItems });
        const source = tree.rowMetadataById.get(treeRowId.folder('server-a', 'next'))!;
        expect(await commitSessionListDragIntent({ context, intent: {
            ...sectionIntent(), sourceRowId: source.rowId, sourceKind: 'container',
            instructionKind: 'reorder-before', targetRowId: treeRowId.folder('server-a', 'launch'),
            containerId: source.containerId, depth: 0, edge: 'top',
        } })).toEqual({ ok: true });
        expect(reorderSessionSection.mock.calls).toEqual([[{ serverId: 'server-a', sectionId: 'next', beforeSectionId: 'launch' }]]);
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('resolves a Section after-edge against full canonical order, including hidden Sections', async () => {
        const reorderSessionSection = vi.fn(async () => {});
        const { context } = makeContext({ latestItems: [section,
            { ...section, folderId: 'moved', groupKey: 'section-moved' }], reorderSessionSection,
            sessionSections: ['moved', 'launch', 'hidden'].map((sectionId, index) => ({
                address: { serverId: 'server-a', sectionId },
                display: { status: 'available', value: { name: sectionId, icon: null } }, sortKey: String(index),
            })),
        });
        const tree = buildSessionListTreeRows({ items: context.latestItems });
        const source = tree.rowMetadataById.get(treeRowId.folder('server-a', 'moved'))!;
        expect(await commitSessionListDragIntent({ context, intent: {
            ...sectionIntent(), sourceRowId: source.rowId, sourceKind: 'container',
            instructionKind: 'reorder-after', targetRowId: treeRowId.folder('server-a', 'launch'),
            containerId: source.containerId, depth: 0, edge: 'bottom',
        } })).toEqual({ ok: true });
        expect(reorderSessionSection.mock.calls).toEqual([[{ serverId: 'server-a', sectionId: 'moved', beforeSectionId: 'hidden' }]]);
    });

    it('admits the same section through pointer and staged keyboard movement', async () => {
        const latestItems = [section, projectHeader(), sessionItem('root-a', projectGroupKey, null, 0)];
        const tree = buildSessionListTreeRows({ items: latestItems, rowBoundsById: new Map([
            [treeRowId.folder('server-a', 'launch'), { x: 0, y: 0, width: 320, height: 40 }],
            [treeRowId.session('server-a', 'root-a'), { x: 0, y: 80, width: 320, height: 40 }],
        ]) });
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'root-a') });
        const pointerResult = resolveSessionListInstruction({ tree, source, pointer: { x: 160, y: 20 }, foldersFeatureEnabled: true });
        const state = stepSessionListStagedMove({ tree, source, state: beginSessionListStagedMove({ tree, source }), intent: 'in' });
        const keyboardResult = resolveSessionListStagedMoveResult({ tree, source, state });
        expect(keyboardResult).toMatchObject({ instruction: { kind: 'nest-into' } });
        if (!keyboardResult || !('instruction' in keyboardResult)) throw new Error('Expected a tree placement');
        expect(pointerResult.instruction.kind).toBe('nest-into');
        for (const result of [pointerResult, keyboardResult]) {
            const { context, spies } = makeContext({ latestItems });
            const intent = buildSessionListDragIntent({ result, sourceRowId: source.id, sourceKind: 'leaf', snapshotSignature: '' });
            expect(await commitSessionListDragIntent({ intent, context })).toEqual({ ok: true });
            expect(spies.setSessionFolderAssignment.mock.calls).toEqual([[{ serverId: 'server-a', sessionId: 'root-a', folderId: 'launch' }]]);
        }
    });

    it('offers an off-window Account section to the move sheet and revalidates its removal', () => {
        const scope = { serverId: 'server-a', accountId: 'account' };
        const { context } = makeContext({ scope, isFolderOrganizationEnabled: () => true,
            latestItems: [{ ...sessionItem('root-a', 'recent', null, 0), workspace: undefined }] });
        const item = { kind: 'session', scope, address: { serverId: 'server-a', sessionId: 'root-a' } } as const;
        const input = { item, folderId: 'folder-a', context, preview: () => ({ verb: 'Move', target: 'Launch' }),
            reason: (code: string) => ({ code, message: code }) };
        expect(resolveSessionListFolderAssignmentDrop(input)).toMatchObject({ status: 'allowed', effect: {
            actionId: 'session.section.set', input: { sessionId: 'root-a', sectionId: 'folder-a' },
        } });
        expect(resolveSessionListFolderAssignmentDrop({ ...input, context: { ...context, sessionSections: [] } }).status).toBe('refused');
    });
});

describe('admitted session-list destination identity', () => {
    function destinationKey(intent: SessionListDragIntent, context: Parameters<typeof resolveSessionListDragIntent>[0]['context']) {
        const admission = resolveSessionListDragIntent({ intent, context });
        expect(admission.ok).toBe(true);
        if (!admission.ok) throw new Error(`Unexpected refusal: ${admission.reason}`);
        expect(admission.destinationKey).toEqual(expect.any(String));
        return admission.destinationKey;
    }

    function sessionPlacement(targetSessionId: string, instructionKind: 'reorder-before' | 'reorder-after'): SessionListDragIntent {
        return {
            sourceRowId: treeRowId.session('server-a', 'inside-a'), sourceKind: 'leaf', instructionKind,
            targetRowId: treeRowId.session('server-a', targetSessionId),
            containerId: treeRowId.workspaceRoot(projectGroupKey), parentRowId: null, depth: 0,
            edge: instructionKind === 'reorder-before' ? 'top' : 'bottom', sourceSnapshotSignature: 'snapshot',
        };
    }

    it('shares one key for the same effective gap and changes it for another placement', () => {
        const { context } = makeContext();
        const afterA = destinationKey(sessionPlacement('root-a', 'reorder-after'), context);
        expect(destinationKey(sessionPlacement('root-b', 'reorder-before'), context)).toBe(afterA);
        expect(destinationKey(sessionPlacement('root-a', 'reorder-before'), context)).not.toBe(afterA);
        expect(destinationKey(sessionPlacement('root-b', 'reorder-after'), context)).not.toBe(afterA);
        const rootEdge = { ...sessionPlacement('root-a', 'reorder-before'),
            instructionKind: 'move-to-root' as const, targetRowId: null };
        expect(destinationKey(rootEdge, context)).toBe(destinationKey(sessionPlacement('root-a', 'reorder-before'), context));
        expect(destinationKey({ ...rootEdge, edge: 'bottom' }, context)).toBe(destinationKey(sessionPlacement('root-b', 'reorder-after'), context));
        const renamedItems = context.latestItems.map(item => item.type === 'header' ? { ...item, title: 'Renamed' } : item);
        expect(destinationKey({ ...sessionPlacement('root-a', 'reorder-after'), sourceSnapshotSignature: 'new-snapshot' }, {
            ...context, latestItems: renamedItems, sessionListGroupOrderV1: { unrelated: ['unrelated-session'] },
        })).toBe(afterA);
    });

    it('normalizes gaps against the canonical current order rather than rendered sibling order', () => {
        const { context } = makeContext({ latestItems: [
            ...items(), sessionItem('root-c', projectGroupKey, null, 0),
        ] });
        const tree = buildSessionListTreeRows({ items: context.latestItems });
        const orderKey = (id: string) => tree.rowMetadataById.get(treeRowId.session('server-a', id))!.orderKey!;
        const current = { ...context, sessionListGroupOrderV1: {
            [projectGroupKey]: [orderKey('root-b'), orderKey('root-a'), orderKey('root-c')],
        } };
        const afterB = destinationKey(sessionPlacement('root-b', 'reorder-after'), current);
        expect(destinationKey(sessionPlacement('root-a', 'reorder-before'), current)).toBe(afterB);
        expect(destinationKey(sessionPlacement('root-a', 'reorder-after'), current)).not.toBe(afterB);
    });

    it('shares nesting and anchored placement keys for the same effective folder position', async () => {
        const { context } = makeContext({ latestItems: [
            projectHeader(), folderHeader('folder-b', folderBGroupKey, 0),
            folderHeader('folder-a', folderAGroupKey, 0), sessionItem('inside-a', folderAGroupKey, 'folder-a', 1),
            sessionItem('root-a', projectGroupKey, null, 0),
        ] });
        const tree = buildSessionListTreeRows({ items: context.latestItems });
        const folderA = tree.rowMetadataById.get(treeRowId.folder('server-a', 'folder-a'))!;
        const sourceRowId = treeRowId.session('server-a', 'root-a');
        const nest: SessionListDragIntent = {
            sourceRowId, sourceKind: 'leaf', instructionKind: 'nest-into', targetRowId: folderA.rowId,
            containerId: folderA.childContainerId, parentRowId: folderA.rowId, depth: 1,
            edge: null, sourceSnapshotSignature: '',
        };
        const placement: SessionListDragIntent = { ...nest, instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'inside-a'), edge: 'top' };
        expect(destinationKey(placement, context)).toBe(destinationKey(nest, context));
        const sessionNest = { ...nest, sourceRowId: treeRowId.session('server-a', 'root-a'), sourceKind: 'leaf' as const };
        const firstSlot = destinationKey(sessionNest, context);
        expect(destinationKey({ ...sessionNest, instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'inside-a'), edge: 'top' }, context)).toBe(firstSlot);
        expect(destinationKey({ ...sessionNest, instructionKind: 'reorder-after',
            targetRowId: treeRowId.session('server-a', 'inside-a'), edge: 'bottom' }, context)).not.toBe(firstSlot);
        const folderB = tree.rowMetadataById.get(treeRowId.folder('server-a', 'folder-b'))!;
        expect(destinationKey({ ...sessionNest, targetRowId: folderB.rowId, containerId: folderB.childContainerId,
            parentRowId: folderB.rowId }, context)).not.toBe(firstSlot);
    });

    it('identifies the manager target without treating changing CAS anchors as another destination', () => {
        const { context } = makeContext({ putSessionUnder: async () => 'applied',
            latestItems: [...items(), sessionItem('root-c', projectGroupKey, null, 0)] });
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'), sourceKind: 'leaf', instructionKind: 'nest-into',
            targetRowId: treeRowId.session('server-a', 'root-a'), containerId: null, parentRowId: null,
            depth: 1, edge: null, sourceSnapshotSignature: '',
        };
        const first = destinationKey(intent, context);
        expect(destinationKey(intent, { ...context, resolvePutSessionUnder: () => ({ allowed: true, expectedManagerSessionId: 'root-c' }) })).toBe(first);
        expect(destinationKey({ ...intent, targetRowId: treeRowId.session('server-a', 'root-b') }, context)).not.toBe(first);
        expect(destinationKey(sessionPlacement('root-a', 'reorder-after'), context)).not.toBe(first);
    });

    it('normalizes workspace reorder gaps through the workspace order owner', () => {
        const headers = ['a', 'b', 'c', 'd'].map(id => ({ ...projectHeader(),
            groupKey: `workspace-${id}`, workspaceKey: `workspace-${id}`,
            workspace: { ...workspaceA, rootPath: `/repo/${id}` },
        }));
        const { context } = makeContext({ latestItems: headers });
        const tree = buildSessionListTreeRows({ items: headers });
        const rows = headers.map(header => tree.rowMetadataById.get(resolveWorkspaceRootTreeRowId(header))!);
        const intent: SessionListDragIntent = {
            sourceRowId: rows[0]!.rowId, sourceKind: 'container', instructionKind: 'reorder-after',
            targetRowId: rows[1]!.rowId, containerId: rows[0]!.containerId, parentRowId: null,
            depth: 0, edge: 'bottom', sourceSnapshotSignature: '',
        };
        const gap = destinationKey(intent, context);
        expect(destinationKey({ ...intent, instructionKind: 'reorder-before', targetRowId: rows[2]!.rowId, edge: 'top' }, context)).toBe(gap);
        expect(destinationKey({ ...intent, targetRowId: rows[2]!.rowId }, context)).not.toBe(gap);
    });
});

describe('session list chooser destinations independent of folder presentation', () => {
    it('offers Space membership independently of hierarchy and preserves exact catalog scope', () => {
        const scope = { serverId: 'server-a', accountId: 'account' };
        const spaceSettingsTarget = { serverId: 'catalog-home', accountId: 'catalog-account' };
        const { context } = makeContext({ scope, latestItems: [sessionItem('root-a', projectGroupKey, null, 0)] });
        const configured = { ...context, spaceMembershipTargets: [{ spaceId: 'space-b', spaceSettingsTarget, name: 'Space B' }] };
        const item = { kind: 'session', scope, address: { serverId: 'server-a', sessionId: 'root-a' } } as const;
        const destinations = listSessionListEntityDropDestinations({ item, context: configured,
            preview: intent => ({ verb: 'Move', target: JSON.stringify(intent) }), folderPreview: name => ({ verb: 'Move', target: name ?? 'Project' }) });
        expect(destinations).toContainEqual(expect.objectContaining({ destination: {
            kind: 'space-membership', operation: 'add', spaceId: 'space-b', spaceSettingsTarget,
        } }));
        const withSource = listSessionListEntityDropDestinations({ item,
            context: { ...configured, spaceMembershipSourceSpaceId: 'space-a' },
            preview: intent => ({ verb: 'Move', target: JSON.stringify(intent) }), folderPreview: name => ({ verb: 'Move', target: name ?? 'Project' }) });
        expect(withSource).toContainEqual(expect.objectContaining({ destination: {
            kind: 'space-membership', operation: 'move', sourceSpaceId: 'space-a', spaceId: 'space-b', spaceSettingsTarget,
        } }));
        const destination = destinations.find(entry => readSessionListSpaceMembershipDestination(entry.destination, item.address.sessionId))!.destination;
        const input = readSessionListSpaceMembershipDestination(destination, item.address.sessionId);
        expect(input).not.toBeNull();
        if (!input) throw new Error('Expected a semantic membership destination');
        const resolve = (current = configured) => resolveSessionListSpaceMembershipDrop({ item, input, context: current,
            preview: name => ({ verb: name, target: name }), reason: code => ({ code, message: code }) });
        expect(resolve()).toMatchObject({ status: 'allowed', effect: {
            actionId: 'session.space_membership.set', input: { sessionId: 'root-a', operation: 'add', spaceId: 'space-b', spaceSettingsTarget },
        } });
        expect(resolve({ ...configured, spaceMembershipTargets: [] }).status).toBe('refused');
        expect(resolve({ ...configured, spaceMembershipTargets: [{ ...configured.spaceMembershipTargets[0]!,
            spaceSettingsTarget: { ...spaceSettingsTarget, accountId: 'foreign' } }] }).status).toBe('refused');
        expect(listSessionListEntityDropDestinations({ item, context,
            preview: intent => ({ verb: 'Move', target: JSON.stringify(intent) }), folderPreview: name => ({ verb: 'Move', target: name ?? 'Project' }) })
            .some(entry => readSessionListSpaceMembershipDestination(entry.destination, item.address.sessionId) !== null)).toBe(false);
    });

    it.each(['projects', 'recent_activity'] as const)('keeps folder assignment available through the real %s producer and Recent activity projection', layoutV1 => {
        const session = createSessionFixture({ id: 'root-a', metadata: { machineId: 'machine-a', path: '/repo/a', host: 'a' } });
        const source = buildSessionListIndexWithServerScope({ sessions: { 'root-a': session }, machines: {},
            layoutV1, serverScope: { serverId: 'server-a' } });
        const assigned = projectSessionSectionListIndex({ source,
            sections: folders().folders.map(folder => ({ address: { serverId: 'server-a', sectionId: folder.id },
                display: { status: 'available', value: { name: folder.name, icon: null } }, sortKey: folder.sortKey ?? null })),
            assignmentsBySessionKey: { [buildSessionFolderAssignmentKey('server-a', 'root-a')]: 'folder-a' },
        });
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
            actionId: 'session.section.set', input: { sessionId: 'root-a', sectionId: 'folder-a' },
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
        const facts = createSessionManagerEligibilitySnapshot({ ...scope, sessionId: 'root-b', currentManagerSessionId: null,
            candidates: [{ sessionId: 'root-a', allowed: true }], isCurrent: () => current, dispose: () => { current = false; } });
        const putSessionUnder = vi.fn(async () => 'applied' as const);
        const { context } = makeContext({ scope, putSessionUnder,
            resolvePutSessionUnder: input => resolvePutUnderEligibility(sessions, input.sessionId, input.managerSessionId, facts, scope) });
        const params = { item: { kind: 'session' as const, scope, address: { serverId: scope.serverId, sessionId: 'root-b' } },
            intent: underIntent('root-a'), context, preview: () => ({ verb: 'Put under', target: 'Lead' }),
            refusedPreview: ({ target }: Readonly<{ target: { sessionId: string | null } | null }>) =>
                target?.sessionId ? { verb: 'Cannot put under', target: target.sessionId } : undefined,
            reason: (code: string) => ({ code, message: code }) };
        expect(resolveSessionListEntityDrop(params)).toMatchObject({ status: 'allowed', effect: {
            actionId: 'session.manager.set', input: { sessionId: 'root-b', managerSessionId: 'root-a', expectedManagerSessionId: null } } });
        expect(putSessionUnder).not.toHaveBeenCalled();
        facts.dispose();
        expect(resolveSessionListEntityDrop(params)).toMatchObject({ status: 'refused', reason: { code: 'unavailable' },
            preview: { verb: 'Cannot put under', target: 'root-a' } });
        const latestItems = context.latestItems.filter(item => item.type !== 'session' || item.sessionId !== 'root-a');
        expect(resolveSessionListEntityDrop({ ...params, context: { ...context, latestItems } }))
            .toEqual({ status: 'refused', reason: { code: 'target-missing', message: 'target-missing' } });
        expect(putSessionUnder).not.toHaveBeenCalled();
    });

    it('asks the manager owner and touches no folder or order state', async () => {
        const putSessionUnder = vi.fn(async () => 'applied' as const);
        const { context, spies } = makeContext({ putSessionUnder });

        const result = await commitSessionListDragIntent({ intent: underIntent('root-a'), context });

        expect(result).toEqual({ ok: true });
        expect(putSessionUnder).toHaveBeenCalledWith({ serverId: 'server-a', sessionId: 'root-b', managerSessionId: 'root-a' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
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
            sessionListLayoutV1: 'recent_activity' as const,
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
            sessionListLayoutV1: 'projects',
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

    it('refuses nesting section definitions, including imported parent/child records', async () => {
        // folder-b nested under folder-a in the latest tree; moving folder-a into
        // folder-b would cycle.
        const latestItems: SessionListIndexItem[] = [
            projectHeader(),
            folderHeader('folder-a', folderAGroupKey, 0),
            folderHeader('folder-b', folderBGroupKey, 1),
        ];
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
        const { context, spies } = makeContext({ latestItems });

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'scope-mismatch' });
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
