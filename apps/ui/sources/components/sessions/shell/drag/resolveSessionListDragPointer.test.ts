import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import type {
    TreeContentRow,
    TreeDropContentGeometry,
    TreeViewportMetrics,
} from '@/components/ui/treeDragDrop';

import { buildSessionListDragSnapshot } from './sessionListDragSnapshot';
import { resolveSessionListDragPointer } from './resolveSessionListDragPointer';
import { treeRowId } from '../drop-resolution/treeRowId';

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

const ROW_HEIGHT = 40;

function projectHeader(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: 'project-a',
        headerKind: 'project',
        groupKey: 'project-a',
        workspaceKey: 'project-a',
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function sessionIndexItem(id: string): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey: 'project-a',
        groupKind: 'project',
        folderId: null,
        folderDepth: 0,
        workspace: workspaceA,
    };
}

function indexItems(): SessionListIndexItem[] {
    return [
        projectHeader(),
        sessionIndexItem('row-0'),
        sessionIndexItem('row-1'),
        sessionIndexItem('row-2'),
        sessionIndexItem('row-3'),
    ];
}

function viewItems(): SessionListIndexItem[] {
    return indexItems();
}

/**
 * Content-coordinate rows in stable order. contentY is fixed regardless of how
 * far the viewport is scrolled — that is the whole point of the content space.
 */
function contentRows(): TreeContentRow[] {
    const ids = [
        treeRowId.workspaceRoot('project-a'),
        treeRowId.session('server-a', 'row-0'),
        treeRowId.session('server-a', 'row-1'),
        treeRowId.session('server-a', 'row-2'),
        treeRowId.session('server-a', 'row-3'),
    ];
    return ids.map((id, index) => ({
        id,
        parentId: null,
        containerId: treeRowId.workspaceRoot('project-a'),
        depth: 0,
        kind: id.startsWith('workspace-root:') ? 'container' : 'leaf',
        bounds: { x: 0, y: index * ROW_HEIGHT, width: 320, height: ROW_HEIGHT },
    }));
}

function liveRegistry(rows: TreeContentRow[]): Readonly<{
    queryRowAtContentPointer: (pointer: { x: number; y: number }) => string | null;
    getContentGeometry: () => TreeDropContentGeometry;
}> {
    return {
        queryRowAtContentPointer: (pointer) => {
            const hit = rows.find((row) => pointer.y >= row.bounds.y && pointer.y < row.bounds.y + row.bounds.height
                && pointer.x >= row.bounds.x && pointer.x < row.bounds.x + row.bounds.width);
            return hit ? hit.id : null;
        },
        getContentGeometry: () => ({ rows, dropZones: [] }),
    };
}

function snapshotFor(sourceSessionId: string) {
    return buildSessionListDragSnapshot({
        items: indexItems(),
        viewItems: viewItems(),
        sessionDragKey: `server-a:${sourceSessionId}`,
        foldersFeatureEnabled: true,
    });
}

describe('resolveSessionListDragPointer', () => {
    it('resolves the target near the pointer AFTER scrolling, not several rows away (wrong-line fix)', () => {
        const snapshot = snapshotFor('row-0');
        const registry = liveRegistry(contentRows());

        // Viewport scrolled down by 2 rows. The pointer is at window y=100, which
        // after conversion lands in content space over row-3 (contentY 160..200).
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 20,
            viewportWindowX: 0,
            scrollOffsetY: 2 * ROW_HEIGHT,
            viewportHeight: 600,
        };
        // contentY = windowY - viewportWindowY + scrollOffsetY = 100 - 20 + 80 = 160 -> row-3 top half.
        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 100 },
            viewport,
        });

        // The instruction must target row-3 (the row actually under the pointer),
        // not a stale row offset by the scroll delta.
        expect(resolved.result.instruction.kind === 'reorder-before'
            || resolved.result.instruction.kind === 'reorder-after').toBe(true);
        if (resolved.result.instruction.kind === 'reorder-before' || resolved.result.instruction.kind === 'reorder-after') {
            expect(resolved.result.instruction.targetId).toBe(treeRowId.session('server-a', 'row-3'));
        }
        // The visual targets the same row the instruction does.
        if (resolved.result.visual.kind === 'line') {
            expect(resolved.result.visual.targetId).toBe(treeRowId.session('server-a', 'row-3'));
        }
    });

    it('produces VIEWPORT-coordinate overlay geometry from content bounds + live scroll', () => {
        const snapshot = snapshotFor('row-0');
        const registry = liveRegistry(contentRows());
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: ROW_HEIGHT,
            viewportHeight: 600,
        };

        // Pointer over the top half of row-2 (content y between 80 and 100).
        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 50 },
            viewport,
        });

        expect(resolved.geometry.kind).toBe('line');
        if (resolved.geometry.kind === 'line') {
            // row-2 content top = 80; overlayTop = 80 - scrollOffset(40) = 40,
            // minus half the 2px line thickness => 39.
            expect(resolved.geometry.geometry.top).toBeCloseTo(39, 5);
            expect(resolved.geometry.geometry.left).toBe(0);
            expect(resolved.geometry.geometry.width).toBe(320);
        }
    });

    it('returns an idle/no-target result when the pointer is over an unmeasured region', () => {
        const snapshot = snapshotFor('row-0');
        const registry = liveRegistry(contentRows());
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 99999 },
            viewport,
        });

        // Over empty space the resolver yields a non-committing result (no target)
        // and the overlay draws nothing.
        expect(resolved.result.instruction.kind === 'blocked'
            || resolved.result.instruction.kind === 'idle').toBe(true);
        expect(resolved.result.visual.kind).toBe('none');
        expect(resolved.geometry.kind).toBe('none');
    });

    it('hides the overlay and idles when the pointer is null', () => {
        const snapshot = snapshotFor('row-0');
        const registry = liveRegistry(contentRows());
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: null,
            viewport,
        });

        expect(resolved.result.instruction.kind).toBe('idle');
        expect(resolved.geometry.kind).toBe('none');
    });

    // -----------------------------------------------------------------------
    // B1 BLOCKER: implicit drop zones. The live registry only registers ROWS
    // (`getContentGeometry().dropZones` is always `[]`), so dropping into a gap
    // that misses every row used to resolve to `blocked('no-target')` and
    // silently no-op. The resolver derives content-coordinate bounds for the
    // structural zones in `snapshot.topology.dropZones` from live row geometry.
    // -----------------------------------------------------------------------

    it('resolves a drop in the gap BELOW the last row of a project to move-to-root', () => {
        const snapshot = snapshotFor('row-0');
        const registry = liveRegistry(contentRows());
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        // Last session row (row-3) occupies content y 160..200. Point just below
        // it, into the implicit `root-after-last` band — it hits NO row.
        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 205 },
            viewport,
        });

        expect(resolved.result.instruction.kind).toBe('move-to-root');
        if (resolved.result.instruction.kind === 'move-to-root') {
            expect(resolved.result.instruction.rootId).toBe(treeRowId.workspaceRoot('project-a'));
        }
        // `../dev` carries the placement on the visual edge, not the instruction.
        if (resolved.result.visual.kind === 'line') {
            expect(resolved.result.visual.edge).toBe('bottom');
        }
        // A real drop indicator is shown — NOT a no-op blocked result.
        expect(resolved.result.visual.kind).toBe('line');
        expect(resolved.geometry.kind).toBe('line');
    });

    it('resolves a drop in the gap ABOVE the first row of a project to move-to-root', () => {
        // Drag row-3 so the source is not the first row.
        const snapshot = snapshotFor('row-3');
        // `contentRows()` layout: workspace-root@0..40, then row-0..3 every 40px.
        // Push the SESSION rows down 80px so a clean gap opens between the
        // workspace-root header (0..40) and row-0 — empty content space for the
        // implicit `root-before-first` band of the project container.
        const shiftedRows = contentRows().map((row) => row.kind === 'leaf'
            ? { ...row, bounds: { ...row.bounds, y: row.bounds.y + 80 } }
            : row);
        // row-0 now occupies content y 120..160; the `root-before-first` band is
        // the 40px above it: 80..120 — hits NO row.
        const shiftedRegistry = liveRegistry(shiftedRows);
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry: shiftedRegistry,
            pointer: { x: 160, y: 100 },
            viewport,
        });

        expect(resolved.result.instruction.kind).toBe('move-to-root');
        if (resolved.result.visual.kind === 'line') {
            expect(resolved.result.visual.edge).toBe('top');
        }
        expect(resolved.result.visual.kind).toBe('line');
        expect(resolved.geometry.kind).toBe('line');
    });

    it('resolves a drop in the gap BETWEEN two sibling rows as a reorder onto the lower sibling', () => {
        const snapshot = snapshotFor('row-0');
        // `contentRows()` layout: workspace-root@0..40, row-0@40..80,
        // row-1@80..120, row-2@120..160, row-3@160..200. Push row-2/row-3 down
        // 40px so a real gap (120..160) opens between row-1 and row-2.
        const gappedRows = contentRows().map((row) => {
            if (row.id === treeRowId.session('server-a', 'row-2')
                || row.id === treeRowId.session('server-a', 'row-3')) {
                return { ...row, bounds: { ...row.bounds, y: row.bounds.y + 40 } };
            }
            return row;
        });
        const registry = liveRegistry(gappedRows);
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        // Point into the gap (content y 140) — between the bottom of row-1 (120)
        // and the top of row-2 (160). It hits NO row; the `sibling-before` zone
        // (target row-2, anchor row-1) resolves it.
        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 140 },
            viewport,
        });

        expect(resolved.result.instruction.kind === 'reorder-before'
            || resolved.result.instruction.kind === 'reorder-after').toBe(true);
        if (resolved.result.instruction.kind === 'reorder-before'
            || resolved.result.instruction.kind === 'reorder-after') {
            // The gap before row-2 reorders the dragged row adjacent to row-2.
            expect(resolved.result.instruction.targetId).toBe(treeRowId.session('server-a', 'row-2'));
        }
        expect(resolved.result.visual.kind).toBe('line');
    });

    it('still resolves a normal row hit to a row target (drop zones do not shadow row hits)', () => {
        const snapshot = snapshotFor('row-0');
        const registry = liveRegistry(contentRows());
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        // Point in the TOP THIRD of row-2 (content y 120..160; top third
        // 120..133) — a direct row hit, not a gap.
        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 125 },
            viewport,
        });

        expect(resolved.result.instruction.kind === 'reorder-before'
            || resolved.result.instruction.kind === 'reorder-after').toBe(true);
        if (resolved.result.instruction.kind === 'reorder-before'
            || resolved.result.instruction.kind === 'reorder-after') {
            expect(resolved.result.instruction.targetId).toBe(treeRowId.session('server-a', 'row-2'));
        }
    });
});

// ---------------------------------------------------------------------------
// Folder topology: nesting + empty-folder body. A folder header is a `container`
// row; dropping on its middle third nests into it.
// ---------------------------------------------------------------------------

const FOLDER_ROW_HEIGHT = 40;

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

/**
 * A project with an empty folder followed by a root session. The empty folder
 * has a header row but no child rows, so nesting into it is a folder-header row
 * hit (middle third).
 */
function folderIndexItems(): SessionListIndexItem[] {
    return [
        projectHeader(),
        folderHeader('folder-a', 'project-a:folder:folder-a', 0),
        sessionIndexItem('root-a'),
    ];
}

function folderViewItems(): SessionListIndexItem[] {
    return folderIndexItems();
}

function folderContentRows(): TreeContentRow[] {
    const entries: ReadonlyArray<Readonly<{ id: string; kind: 'container' | 'leaf' }>> = [
        { id: treeRowId.workspaceRoot('project-a'), kind: 'container' },
        { id: treeRowId.folder('folder-a'), kind: 'container' },
        { id: treeRowId.session('server-a', 'root-a'), kind: 'leaf' },
    ];
    return entries.map((entry, index) => ({
        id: entry.id,
        parentId: null,
        containerId: treeRowId.workspaceRoot('project-a'),
        depth: 0,
        kind: entry.kind,
        bounds: { x: 0, y: index * FOLDER_ROW_HEIGHT, width: 320, height: FOLDER_ROW_HEIGHT },
    }));
}

describe('resolveSessionListDragPointer — folder topology', () => {
    it('nests into a folder when the pointer hits the folder-header middle third', () => {
        const snapshot = buildSessionListDragSnapshot({
            items: folderIndexItems(),
            viewItems: folderViewItems(),
            sessionDragKey: 'server-a:root-a',
            foldersFeatureEnabled: true,
        });
        const registry = liveRegistry(folderContentRows());
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        // Folder header row occupies content y 40..80; its middle third is
        // ~53..67. Point at y=60 — a nest hit on the folder.
        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 60 },
            viewport,
        });

        expect(resolved.result.instruction.kind).toBe('nest-into');
        if (resolved.result.instruction.kind === 'nest-into') {
            expect(resolved.result.instruction.targetId).toBe(treeRowId.folder('folder-a'));
        }
        expect(resolved.result.visual.kind).toBe('outline');
    });

    it('resolves a drop below the last row of a project that contains a folder to move-to-root', () => {
        const snapshot = buildSessionListDragSnapshot({
            items: folderIndexItems(),
            viewItems: folderViewItems(),
            sessionDragKey: treeRowId.folder('folder-a'),
            foldersFeatureEnabled: true,
        });
        const registry = liveRegistry(folderContentRows());
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY: 0,
            viewportHeight: 600,
        };

        // Last row (root-a session) occupies content y 80..120. Point below it.
        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: 130 },
            viewport,
        });

        expect(resolved.result.instruction.kind).toBe('move-to-root');
        if (resolved.result.visual.kind === 'line') {
            expect(resolved.result.visual.edge).toBe('bottom');
        }
        expect(resolved.result.visual.kind).toBe('line');
    });
});
