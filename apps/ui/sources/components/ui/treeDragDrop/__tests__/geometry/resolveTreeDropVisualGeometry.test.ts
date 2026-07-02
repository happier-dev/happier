import { describe, expect, it } from 'vitest';

import { resolveTreeDropVisualGeometry, TREE_DROP_VISUAL_LINE_THICKNESS } from '../../geometry/resolveTreeDropVisualGeometry';
import type { TreeContentRow, TreeContentDropZone } from '../../registry/treeDropRegistryTypes';
import type { TreeViewportMetrics } from '../../geometry/treeContentGeometryTypes';

const viewport: TreeViewportMetrics = {
    viewportWindowY: 100,
    viewportWindowX: 0,
    scrollOffsetY: 200,
    viewportHeight: 600,
};

const rowAlpha: TreeContentRow = {
    id: 'session:alpha',
    parentId: null,
    containerId: 'workspace:a',
    depth: 0,
    kind: 'leaf',
    bounds: { x: 16, y: 320, width: 320, height: 56 },
};

const folderRow: TreeContentRow = {
    id: 'folder:a',
    parentId: null,
    containerId: 'workspace:a',
    depth: 1,
    kind: 'container',
    bounds: { x: 16, y: 400, width: 320, height: 48 },
};

describe('resolveTreeDropVisualGeometry', () => {
    it('returns kind none when the visual is none', () => {
        expect(resolveTreeDropVisualGeometry({
            visual: { kind: 'none' },
            rows: [rowAlpha],
            dropZones: [],
            viewport,
        })).toEqual({ kind: 'none' });
    });

    it('places a top-edge line at the content top of the target row in viewport-overlay coordinates', () => {
        // overlayTop of the row = 320 - 200 = 120; a top-edge line sits at that top.
        const result = resolveTreeDropVisualGeometry({
            visual: { kind: 'line', targetId: 'session:alpha', edge: 'top', depth: 2 },
            rows: [rowAlpha],
            dropZones: [],
            viewport,
        });
        expect(result).toEqual({
            kind: 'line',
            depth: 2,
            edge: 'top',
            targetId: 'session:alpha',
            geometry: {
                top: 120 - TREE_DROP_VISUAL_LINE_THICKNESS / 2,
                left: 16,
                width: 320,
                height: TREE_DROP_VISUAL_LINE_THICKNESS,
            },
        });
    });

    it('places a bottom-edge line at the content bottom of the target row', () => {
        // row content bottom = 320 + 56 = 376; overlay bottom = 376 - 200 = 176.
        const result = resolveTreeDropVisualGeometry({
            visual: { kind: 'line', targetId: 'session:alpha', edge: 'bottom', depth: 0 },
            rows: [rowAlpha],
            dropZones: [],
            viewport,
        });
        expect(result.kind).toBe('line');
        if (result.kind !== 'line') throw new Error('expected line');
        expect(result.geometry.top).toBe(176 - TREE_DROP_VISUAL_LINE_THICKNESS / 2);
        expect(result.geometry.height).toBe(TREE_DROP_VISUAL_LINE_THICKNESS);
    });

    it('frames the whole target row for an outline visual', () => {
        const result = resolveTreeDropVisualGeometry({
            visual: { kind: 'outline', targetId: 'folder:a' },
            rows: [folderRow],
            dropZones: [],
            viewport,
        });
        expect(result).toEqual({
            kind: 'outline',
            targetId: 'folder:a',
            geometry: {
                top: 400 - 200,
                left: 16,
                width: 320,
                height: 48,
            },
        });
    });

    it('resolves a line target that only exists as a container drop zone', () => {
        const rootZone: TreeContentDropZone = {
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 240, width: 360, height: 24 },
            role: 'root-before-first',
        };
        const result = resolveTreeDropVisualGeometry({
            visual: { kind: 'line', targetId: 'workspace:a', edge: 'top', depth: 0 },
            rows: [],
            dropZones: [rootZone],
            viewport,
        });
        expect(result.kind).toBe('line');
        if (result.kind !== 'line') throw new Error('expected line');
        // drop zone content top = 240; overlay top = 240 - 200 = 40.
        expect(result.geometry.top).toBe(40 - TREE_DROP_VISUAL_LINE_THICKNESS / 2);
    });

    it('uses the root-before-first drop-zone band for a role-scoped container-id line', () => {
        const workspaceRootRow: TreeContentRow = {
            id: 'workspace:a',
            parentId: null,
            containerId: 'workspace:a',
            depth: 0,
            kind: 'container',
            bounds: { x: 16, y: 500, width: 320, height: 48 },
        };
        const rootZone: TreeContentDropZone = {
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 240, width: 360, height: 24 },
            role: 'root-before-first',
        };
        const result = resolveTreeDropVisualGeometry({
            visual: {
                kind: 'line',
                targetId: 'workspace:a',
                edge: 'top',
                depth: 0,
                dropZoneRole: 'root-before-first',
            },
            rows: [workspaceRootRow],
            dropZones: [rootZone],
            viewport,
        });

        expect(result.kind).toBe('line');
        if (result.kind !== 'line') throw new Error('expected line');
        expect(result.geometry.top).toBe(40 - TREE_DROP_VISUAL_LINE_THICKNESS / 2);
        expect(result.geometry.left).toBe(0);
        expect(result.geometry.width).toBe(360);
    });

    it('keeps row-hit reorder lines on the row when a root drop zone shares the row id', () => {
        const workspaceRootRow: TreeContentRow = {
            id: 'workspace:a',
            parentId: null,
            containerId: 'workspace:a',
            depth: 0,
            kind: 'container',
            bounds: { x: 16, y: 500, width: 320, height: 48 },
        };
        const rootZone: TreeContentDropZone = {
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 240, width: 360, height: 24 },
            role: 'root-before-first',
        };

        const result = resolveTreeDropVisualGeometry({
            visual: { kind: 'line', targetId: 'workspace:a', edge: 'top', depth: 0 },
            rows: [workspaceRootRow],
            dropZones: [rootZone],
            viewport,
        });

        expect(result.kind).toBe('line');
        if (result.kind !== 'line') throw new Error('expected line');
        expect(result.geometry.top).toBe(300 - TREE_DROP_VISUAL_LINE_THICKNESS / 2);
        expect(result.geometry.left).toBe(16);
        expect(result.geometry.width).toBe(320);
    });

    it('uses the line visual drop-zone role when multiple implicit zones share a container id', () => {
        const rootBeforeZone: TreeContentDropZone = {
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 240, width: 360, height: 24 },
            role: 'root-before-first',
        };
        const rootAfterZone: TreeContentDropZone = {
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 520, width: 360, height: 32 },
            role: 'root-after-last',
        };

        const result = resolveTreeDropVisualGeometry({
            visual: {
                kind: 'line',
                targetId: 'workspace:a',
                edge: 'bottom',
                depth: 0,
                dropZoneRole: 'root-after-last',
            },
            rows: [],
            dropZones: [rootBeforeZone, rootAfterZone],
            viewport,
        });

        expect(result.kind).toBe('line');
        if (result.kind !== 'line') throw new Error('expected line');
        // root-after zone content bottom = 552; overlay bottom = 552 - 200 = 352.
        expect(result.geometry.top).toBe(352 - TREE_DROP_VISUAL_LINE_THICKNESS / 2);
        expect(result.geometry.left).toBe(0);
        expect(result.geometry.width).toBe(360);
    });

    it('returns kind none when the visual target is not registered', () => {
        expect(resolveTreeDropVisualGeometry({
            visual: { kind: 'line', targetId: 'session:missing', edge: 'top', depth: 0 },
            rows: [rowAlpha],
            dropZones: [],
            viewport,
        })).toEqual({ kind: 'none' });
        expect(resolveTreeDropVisualGeometry({
            visual: { kind: 'outline', targetId: 'folder:missing' },
            rows: [folderRow],
            dropZones: [],
            viewport,
        })).toEqual({ kind: 'none' });
    });

    it('prefers a row over a drop zone when both share the target id', () => {
        const containerRow: TreeContentRow = {
            id: 'folder:a',
            parentId: null,
            containerId: 'folder:a',
            depth: 0,
            kind: 'container',
            bounds: { x: 16, y: 500, width: 320, height: 48 },
        };
        const bodyZone: TreeContentDropZone = {
            containerId: 'folder:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 1,
            bounds: { x: 16, y: 548, width: 320, height: 120 },
            role: 'container-body',
        };
        const result = resolveTreeDropVisualGeometry({
            visual: { kind: 'outline', targetId: 'folder:a' },
            rows: [containerRow],
            dropZones: [bodyZone],
            viewport,
        });
        expect(result.kind).toBe('outline');
        if (result.kind !== 'outline') throw new Error('expected outline');
        // The row (height 48), not the body zone (height 120), should be framed.
        expect(result.geometry.height).toBe(48);
    });
});
