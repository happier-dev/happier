import { describe, expect, it } from 'vitest';

import {
    readNavigationSurfacePlacements,
    reorderNavigationPlacement,
    resolveNavigationOverflow,
    resolveNavigationPlacements,
    updateNavigationPlacement,
} from './mobileSurfacePinning';

describe('navigation placements', () => {
    const items = [{ id: 'files' }, { id: 'git' }, { id: 'terminal' }, { id: 'agents', defaultPlacement: 'hidden' as const }];

    it('orders, pins, overflows and hides through one owner without dropping removed ids', () => {
        const preferences = { orderedIds: ['removed', 'terminal', 'files'], placements: { removed: 'hidden' as const, files: 'overflow' as const, git: 'hidden' as const } };
        const result = resolveNavigationPlacements(items, preferences);
        expect(result.ordered.map(item => item.id)).toEqual(['terminal', 'files', 'git', 'agents']);
        expect(result.pinned.map(item => item.id)).toEqual(['terminal']);
        expect(result.overflow.map(item => item.id)).toEqual(['files']);
        expect(result.hidden.map(item => item.id)).toEqual(['git', 'agents']);
        const changed = updateNavigationPlacement(preferences, 'files', 'pinned');
        expect(changed).toEqual({ ...preferences, placements: { ...preferences.placements, files: 'pinned' } });
        expect(resolveNavigationPlacements([...items, { id: 'removed' }], changed).hidden.map(item => item.id)).toContain('removed');
    });

    it('moves against current anchors while retaining absent ids and refuses stale membership', () => {
        const preferences = { orderedIds: ['removed', 'files', 'git', 'terminal'], placements: { git: 'overflow' as const } };
        expect(reorderNavigationPlacement(preferences, ['files', 'git', 'terminal'], 'terminal', { anchorId: 'files', placement: 'before' }))
            .toEqual({ ...preferences, orderedIds: ['removed', 'terminal', 'files', 'git'] });
        expect(reorderNavigationPlacement(preferences, ['files', 'git'], 'terminal', { anchorId: null, placement: 'before' })).toBeNull();
    });

    it('reads unknown stored fields tolerantly and seeds legacy values only when the surface is absent', () => {
        const legacy = { sessionCockpitBarSurfaceIds: [], compactAppDestinationPreferencesV1: { orderedDestinationIds: ['plugins', 'sessions'], hiddenDestinationIds: ['search'] } };
        const seeded = readNavigationSurfacePlacements(legacy);
        expect(seeded.appRail).toEqual({ orderedIds: ['plugins', 'sessions'], placements: { search: 'hidden' } });
        expect(seeded.sessionTabBar).toEqual({ orderedIds: [], placements: { browse: 'overflow', git: 'overflow', companion: 'overflow', terminal: 'overflow' } });
        expect(readNavigationSurfacePlacements({ ...legacy, navigationSurfacePlacementsV1: { sessionTabBar: { orderedIds: ['plugin:future'], placements: { 'plugin:future': 'pinned' }, future: true }, futureSurface: {} } }).sessionTabBar)
            .toEqual({ orderedIds: ['plugin:future'], placements: { 'plugin:future': 'pinned' } });
        expect(readNavigationSurfacePlacements({ sessionCockpitBarSurfaceIds: null }).sessionTabBar?.orderedIds).toEqual(['browse', 'git', 'companion', 'terminal']);
    });

    it('uses measured room and reserves a trigger only when overflow exists', () => {
        const pinned: readonly { id: string; group?: string }[] = [{ id: 'a', group: 'app' }, { id: 'b', group: 'app' }, { id: 'c', group: 'plugin' }];
        expect(resolveNavigationOverflow(pinned, [], { availableSize: 130, itemSize: 40, separatorSize: 10 })).toEqual({ shown: pinned, overflow: [] });
        expect(resolveNavigationOverflow(pinned, [], { availableSize: 129, itemSize: 40, separatorSize: 10 })).toEqual({ shown: pinned.slice(0, 2), overflow: pinned.slice(2) });
        expect(resolveNavigationOverflow(pinned, [{ id: 'd' }], { availableSize: 130, itemSize: 40, separatorSize: 10 })).toEqual({ shown: pinned.slice(0, 2), overflow: [...pinned.slice(2), { id: 'd' }] });
        expect(resolveNavigationOverflow(pinned, [], { availableSize: null, itemSize: 40 })).toEqual({ shown: pinned, overflow: [] });
        expect(resolveNavigationOverflow(pinned, [], { availableSize: 10, itemSize: 40 })).toEqual({ shown: [], overflow: pinned });
        const ungrouped = [{ id: 'a', group: 'app' }, { id: 'b' }];
        expect(resolveNavigationOverflow(ungrouped, [], { availableSize: 80, itemSize: 40, separatorSize: 10 })).toEqual({ shown: ungrouped, overflow: [] });
    });
});
