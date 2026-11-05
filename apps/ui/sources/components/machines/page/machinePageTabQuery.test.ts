import { describe, expect, it } from 'vitest';

import { isMachinePageTabPushed, isMachinePageTabRoot, machinePageTabRouteParams } from './machinePageTabQuery';

describe('machinePageTabRouteParams', () => {
    it('clears every tab-owned param and writes only the next view', () => {
        const cleared = { tab: undefined, sort: undefined, page: undefined, owner: undefined, process: undefined, filter: undefined,
            view: undefined, categoryId: undefined, nodeId: undefined, files: undefined, prepare: undefined, volumeId: undefined };
        // Back from a category page to Storage itself: nothing of the category page survives.
        expect(machinePageTabRouteParams({ id: 'storage' })).toEqual({ ...cleared, tab: 'storage' });
        // Overview names nothing in the query.
        expect(machinePageTabRouteParams({ id: 'overview' })).toEqual(cleared);
        expect(machinePageTabRouteParams({ id: 'storage', page: 'category', categoryId: 'logs' })).toEqual({
            ...cleared, tab: 'storage', page: 'category', categoryId: 'logs',
        });
        // The route's own keys (machine id, Home, the destination's path) are never named.
        for (const key of ['id', 'serverId', 'workspacePathname', 'pageId']) expect(machinePageTabRouteParams({ id: 'processes' })).not.toHaveProperty(key);
    });
});

describe('isMachinePageTabRoot', () => {
    it('is the tab itself, not a page it pushes or its Whole disk view', () => {
        expect(isMachinePageTabRoot({ id: 'overview' })).toBe(true);
        expect(isMachinePageTabRoot({ id: 'storage' })).toBe(true);
        expect(isMachinePageTabRoot({ id: 'storage', view: 'happier' })).toBe(true);
        expect(isMachinePageTabRoot({ id: 'processes', sort: 'cpu' })).toBe(true);
        expect(isMachinePageTabRoot({ id: 'storage', page: 'category', categoryId: 'logs' })).toBe(false);
        expect(isMachinePageTabRoot({ id: 'storage', view: 'disk' })).toBe(false);
        expect(isMachinePageTabRoot({ id: 'processes', page: 'owner', owner: 'x' })).toBe(false);
        expect(isMachinePageTabRoot({ id: 'guard', page: 'activity' })).toBe(false);
    });
});

describe('isMachinePageTabPushed', () => {
    it('names the pages a tab pushes, never a tab root or its alternate view', () => {
        expect(isMachinePageTabPushed({ id: 'services', page: 'service', service: 'web' })).toBe(true);
        expect(isMachinePageTabPushed({ id: 'services', page: 'roles' })).toBe(true);
        expect(isMachinePageTabPushed({ id: 'services' })).toBe(false);
        expect(isMachinePageTabPushed({ id: 'storage', view: 'disk' })).toBe(false);
    });
});
