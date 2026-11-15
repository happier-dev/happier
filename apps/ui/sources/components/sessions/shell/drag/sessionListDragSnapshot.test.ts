import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';

import { buildSessionListDragSnapshot } from './sessionListDragSnapshot';
import { treeRowId } from '../drop-resolution/treeRowId';

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

function projectHeader(groupKey: string): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: groupKey,
        headerKind: 'project',
        groupKey,
        workspaceKey: groupKey,
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

function sessionIndexItem(id: string, groupKey: string, folderId: string | null, depth: number): Extract<SessionListIndexItem, { type: 'session' }> {
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

function indexItems(): SessionListIndexItem[] {
    return [
        projectHeader('project-a'),
        folderHeader('folder-a', 'project-a:folder:folder-a', 0),
        sessionIndexItem('inside-a', 'project-a:folder:folder-a', 'folder-a', 1),
        sessionIndexItem('root-a', 'project-a', null, 0),
    ];
}

function viewItems(): SessionListViewItem[] {
    return [
        { type: 'header', title: 'project-a', headerKind: 'project', groupKey: 'project-a', serverId: 'server-a' },
        { type: 'header', title: 'Folder A', headerKind: 'folder', folderId: 'folder-a', groupKey: 'project-a:folder:folder-a', serverId: 'server-a' },
        { type: 'session', session: { id: 'inside-a' } as any, groupKey: 'project-a:folder:folder-a', groupKind: 'folder', folderId: 'folder-a', serverId: 'server-a' },
        { type: 'session', session: { id: 'root-a' } as any, groupKey: 'project-a', groupKind: 'project', folderId: null, serverId: 'server-a' },
    ];
}

describe('buildSessionListDragSnapshot', () => {
    it('freezes tree topology (rows/drop zones/metadata) WITHOUT any pixel geometry', () => {
        const snapshot = buildSessionListDragSnapshot({
            items: indexItems(),
            viewItems: viewItems(),
            sessionDragKey: 'server-a:inside-a',
            folderSortMode: 'foldersFirst',
            foldersFeatureEnabled: true,
        });

        // Topology rows carry structural identity only — no `bounds` field at all.
        expect(snapshot.topology.rowsById.size).toBeGreaterThan(0);
        for (const row of snapshot.topology.rowsById.values()) {
            expect(row).not.toHaveProperty('bounds');
            expect(typeof row.rowId).toBe('string');
            expect(typeof row.depth).toBe('number');
        }
        for (const zone of snapshot.topology.dropZones) {
            expect(zone).not.toHaveProperty('bounds');
        }

        // The source row resolves from the drag key and carries its tree source.
        expect(snapshot.source.sourceRowId).toBe(treeRowId.session('server-a', 'inside-a'));
        expect(snapshot.source.kind).toBe('leaf');
        expect(snapshot.source.treeSource.id).toBe(snapshot.source.sourceRowId);

        // Metadata is present for resolution but contains no measured geometry.
        expect(snapshot.topology.rowMetadataById.get(snapshot.source.sourceRowId)).toBeTruthy();
        expect(snapshot.topology.containerMetadataById.size).toBeGreaterThan(0);
    });

    it('freezes the visible render items in their drag-start order', () => {
        const items = viewItems();
        const snapshot = buildSessionListDragSnapshot({
            items: indexItems(),
            viewItems: items,
            sessionDragKey: 'server-a:inside-a',
            folderSortMode: 'foldersFirst',
            foldersFeatureEnabled: true,
        });

        expect(snapshot.frozenViewItems).toEqual(items);
        expect(snapshot.frozenItems).toEqual(indexItems());
        expect(snapshot.folderSortMode).toBe('foldersFirst');
        expect(snapshot.foldersFeatureEnabled).toBe(true);
    });

    it('produces a stable id and a deterministic signature for the same inputs', () => {
        const a = buildSessionListDragSnapshot({
            items: indexItems(),
            viewItems: viewItems(),
            sessionDragKey: 'server-a:inside-a',
            folderSortMode: 'foldersFirst',
            foldersFeatureEnabled: true,
        });
        const b = buildSessionListDragSnapshot({
            items: indexItems(),
            viewItems: viewItems(),
            sessionDragKey: 'server-a:inside-a',
            folderSortMode: 'foldersFirst',
            foldersFeatureEnabled: true,
        });

        expect(typeof a.snapshotId).toBe('string');
        expect(a.snapshotId.length).toBeGreaterThan(0);
        expect(a.signature).toBe(b.signature);
        // Snapshot ids are unique per drag start even with identical content.
        expect(a.snapshotId).not.toBe(b.snapshotId);
    });

    it('emits structural sibling-before zones with anchor + target row ids (no bounds)', () => {
        const snapshot = buildSessionListDragSnapshot({
            items: indexItems(),
            viewItems: viewItems(),
            sessionDragKey: 'server-a:root-a',
            folderSortMode: 'mixed',
            foldersFeatureEnabled: true,
        });

        // The project container holds [folder-a, root-a]; the gap before root-a
        // is a `sibling-before` zone anchored on the preceding sibling (folder-a).
        const siblingZone = snapshot.topology.dropZones.find((zone) =>
            zone.role === 'sibling-before'
            && zone.targetRowId === treeRowId.session('server-a', 'root-a'));
        expect(siblingZone).toBeTruthy();
        expect(siblingZone?.anchorRowId).toBe(treeRowId.folder('folder-a'));
        expect(siblingZone).not.toHaveProperty('bounds');

        // Root-edge zones carry the first/last child row as their bounds anchor.
        const rootAfterLast = snapshot.topology.dropZones.find((zone) =>
            zone.role === 'root-after-last'
            && zone.containerId === treeRowId.workspaceRoot('project-a'));
        expect(rootAfterLast?.anchorRowId).toBe(treeRowId.session('server-a', 'root-a'));
        const rootBeforeFirst = snapshot.topology.dropZones.find((zone) =>
            zone.role === 'root-before-first'
            && zone.containerId === treeRowId.workspaceRoot('project-a'));
        expect(rootBeforeFirst?.anchorRowId).toBe(treeRowId.folder('folder-a'));
    });

    it('resolves a folder drag source from a folder drag key', () => {
        const snapshot = buildSessionListDragSnapshot({
            items: indexItems(),
            viewItems: viewItems(),
            sessionDragKey: treeRowId.folder('folder-a'),
            folderSortMode: 'foldersFirst',
            foldersFeatureEnabled: true,
        });

        expect(snapshot.source.sourceRowId).toBe(treeRowId.folder('folder-a'));
        expect(snapshot.source.kind).toBe('container');
        // A folder container source excludes its own descendants from drop targets.
        expect(snapshot.source.treeSource.excludedDescendantIds.has(treeRowId.session('server-a', 'inside-a'))).toBe(true);
    });
});
