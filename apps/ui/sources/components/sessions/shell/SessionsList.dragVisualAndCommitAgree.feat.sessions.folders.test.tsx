import { describe, expect, it, vi } from 'vitest';

import type { TreeDropResult, WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import type { SessionSection } from '@/sync/domains/session/organization/sections';

import { applySessionListTreeDropOperation } from './commit/applySessionListTreeDropOperation';
import { buildSessionListDragSource } from './drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from './drop-resolution/buildSessionListTreeRows';
import { resolveSessionListInstruction } from './drop-resolution/resolveSessionListInstruction';
import { treeRowId } from './drop-resolution/treeRowId';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { buildSessionSectionGroupKey } from '@/sync/domains/session/organization/sections';

function sessionOrderKey(sessionId: string): string {
    return sessionAddressKey({ serverId: 'server-a', sessionId });
}


const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

const workspaceB: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-b',
    rootPath: '/repo/b',
};
const projectAGroupKey = 'project-a';
const rootAGroupKey = projectAGroupKey;
const folderAGroupKey = buildSessionSectionGroupKey({ serverId: 'server-a', sectionId: 'folder-a' });
const childAGroupKey = buildSessionSectionGroupKey({ serverId: 'server-a', sectionId: 'child-a' });
const folderBGroupKey = buildSessionSectionGroupKey({ serverId: 'server-a', sectionId: 'folder-b' });
const folderCGroupKey = buildSessionSectionGroupKey({ serverId: 'server-a', sectionId: 'folder-c' });

function bounds(y: number): WindowBounds {
    return { x: 0, y, width: 320, height: 40 };
}

function projectHeader(groupKey: string, workspace: SessionFolderWorkspaceRefV1): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: groupKey,
        headerKind: 'project',
        groupKey,
        workspaceKey: groupKey,
        workspace,
        serverId: 'server-a',
    };
}

function folderHeader(params: Readonly<{
    id: string;
    groupKey: string;
    depth: number;
    workspace: SessionFolderWorkspaceRefV1;
}>): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: params.id,
        headerKind: 'folder',
        folderId: params.id,
        folderDepth: params.depth,
        groupKey: params.groupKey,
        workspace: params.workspace,
        serverId: 'server-a',
    };
}

function sessionItem(params: Readonly<{
    id: string;
    groupKey: string;
    folderId: string | null;
    depth: number;
    workspace: SessionFolderWorkspaceRefV1;
}>): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: params.id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey: params.groupKey,
        groupKind: params.folderId ? 'folder' : 'project',
        folderId: params.folderId,
        folderDepth: params.depth,
        workspace: params.workspace,
    };
}

function items(): SessionListIndexItem[] {
    return [
        projectHeader(projectAGroupKey, workspaceA),
        sessionItem({ id: 'root-a', groupKey: rootAGroupKey, folderId: null, depth: 0, workspace: workspaceA }),
        folderHeader({ id: 'folder-a', groupKey: folderAGroupKey, depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'inside-a', groupKey: folderAGroupKey, folderId: 'folder-a', depth: 1, workspace: workspaceA }),
        folderHeader({ id: 'child-a', groupKey: childAGroupKey, depth: 0, workspace: workspaceA }),
        folderHeader({ id: 'folder-b', groupKey: folderBGroupKey, depth: 0, workspace: workspaceA }),
        folderHeader({ id: 'folder-c', groupKey: folderCGroupKey, depth: 0, workspace: workspaceB }),
    ];
}

function sections(): readonly SessionSection[] {
    return ['folder-a', 'child-a', 'folder-b', 'folder-c'].map((sectionId, index) => ({
        address: { serverId: 'server-a', sectionId },
        display: { status: 'available', value: { name: sectionId, icon: null } }, sortKey: String(index),
    }));
}

function buildTree() {
    return buildSessionListTreeRows({
        items: items(),
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot(projectAGroupKey), bounds(0)],
            [treeRowId.session('server-a', 'root-a'), bounds(40)],
            [treeRowId.folder('server-a', 'folder-a'), bounds(160)],
            [treeRowId.session('server-a', 'inside-a'), bounds(200)],
            [treeRowId.folder('server-a', 'child-a'), bounds(240)],
            [treeRowId.folder('server-a', 'folder-b'), bounds(280)],
            [treeRowId.folder('server-a', 'folder-c'), bounds(360)],
        ]),
        dropZoneBounds: [
            {
                containerId: treeRowId.workspaceRoot(projectAGroupKey),
                role: 'root-before-first',
                bounds: { x: 0, y: 20, width: 320, height: 16 },
            },
            {
                containerId: treeRowId.workspaceRoot(projectAGroupKey),
                role: 'root-after-last',
                bounds: { x: 0, y: 84, width: 320, height: 16 },
            },
            {
                containerId: treeRowId.folder('server-a', 'folder-b'),
                role: 'container-body',
                bounds: { x: 0, y: 284, width: 320, height: 24 },
            },
        ],
    });
}

function expectVisualToMatchInstruction(result: TreeDropResult): void {
    const { instruction, visual } = result;
    if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
        expect(visual).toEqual({
            kind: 'line',
            targetId: instruction.targetId,
            edge: instruction.kind === 'reorder-before' ? 'top' : 'bottom',
            depth: instruction.depth,
        });
        return;
    }
    if (instruction.kind === 'nest-into') {
        expect(visual).toEqual({ kind: 'outline', targetId: instruction.targetId });
        return;
    }
    if (instruction.kind === 'move-to-root') {
        expect(visual.kind).not.toBe('outline');
        if (visual.kind === 'line') {
            expect(visual.targetId).toBe(instruction.containerId);
            expect(visual.depth).toBe(instruction.depth);
        }
        return;
    }
    expect(visual).toEqual({ kind: 'none' });
}

describe('SessionsList drag result consistency', () => {
    it.each([
        {
            name: 'session into sibling folder',
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 300,
            expectedAssignment: { serverId: 'server-a', sessionId: 'inside-a', folderId: 'folder-b' },
            expectedOrder: { [folderBGroupKey]: [sessionOrderKey('inside-a')] },
        },
        {
            name: 'session out to workspace root',
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 90,
            expectedAssignment: { serverId: 'server-a', sessionId: 'inside-a', folderId: null },
            expectedOrder: { [rootAGroupKey]: [sessionOrderKey('root-a'), sessionOrderKey('inside-a')] },
        },
        {
            name: 'Section header before another Section',
            sourceRowId: treeRowId.folder('server-a', 'folder-b'),
            y: 162,
            expectedSectionOrder: { serverId: 'server-a', sectionId: 'folder-b', beforeSectionId: 'folder-a' },
        },
        {
            name: 'refused Section header around an ordinary Project Session',
            sourceRowId: treeRowId.folder('server-a', 'folder-b'),
            y: 44,
            expectedBlocked: true,
        },
        {
            name: 'same-Home Section across machines',
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 380,
            expectedAssignment: { serverId: 'server-a', sessionId: 'inside-a', folderId: 'folder-c' },
            expectedOrder: { [folderCGroupKey]: [sessionOrderKey('inside-a')] },
        },
    ])('uses one result for $name', async (scenario) => {
        const tree = buildTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: scenario.sourceRowId });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: scenario.y },
            foldersFeatureEnabled: true,
        });

        expectVisualToMatchInstruction(result);

        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const reorderSessionSection = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionSections: sections(),
                sessionListGroupOrderV1: {},
                sessionListLayoutV1: 'projects',
                reorderSessionSection,
                setSessionListGroupOrderV1,
                setSessionFolderAssignment,
            },
        });

        if (scenario.expectedBlocked) {
            expect(applied.ok).toBe(false);
            expect(setSessionFolderAssignment).not.toHaveBeenCalled();
            expect(reorderSessionSection).not.toHaveBeenCalled();
            expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
            return;
        }

        expect(applied.ok).toBe(true);
        if (scenario.expectedAssignment) {
            expect(setSessionFolderAssignment).toHaveBeenCalledWith(scenario.expectedAssignment);
        }
        if (scenario.expectedOrder) {
            expect(setSessionListGroupOrderV1).toHaveBeenCalledWith(scenario.expectedOrder);
        }
        if (scenario.expectedSectionOrder) {
            expect(reorderSessionSection).toHaveBeenCalledWith(scenario.expectedSectionOrder);
            expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
            expect(setSessionFolderAssignment).not.toHaveBeenCalled();
        }
    });
});
