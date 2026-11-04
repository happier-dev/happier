import { describe, expect, it } from 'vitest';

import {
    readNavigationSurfacePlacements,
    reorderNavigationPlacement,
    resolveNavigationOverflow,
    resolveNavigationPlacements,
    updateNavigationPlacement,
    NavigationSurfacePlacementsV1Schema,
} from './mobileSurfacePinning';

describe('navigation placements', () => {
    it('stores one device-local Project layout, retains removed pages and clamps legal placement without rewriting intent', () => {
        const preferences = { orderedIds: ['removed', 'plugin:external:page', 'overview'], placements: { overview: 'hidden' as const, 'plugin:external:page': 'overflow' as const } };
        const parsed = NavigationSurfacePlacementsV1Schema.safeParse({ projectTabBar: preferences });
        expect(parsed.success).toBe(true);
        const stored = readNavigationSurfacePlacements({ navigationSurfacePlacementsV1: { projectTabBar: { ...preferences, future: true }, futureSurface: {} } });
        expect(stored).toMatchObject({ projectTabBar: preferences });
        const pages = [{ id: 'overview', allowedPlacements: ['pinned'] as const }, { id: 'plugin:external:page' }];
        const placed = resolveNavigationPlacements(pages, preferences);
        expect(placed.ordered.map(page => page.id)).toEqual(['plugin:external:page', 'overview']);
        expect(placed.pinned.map(page => page.id)).toEqual(['overview']);
        expect(placed.overflow.map(page => page.id)).toEqual(['plugin:external:page']);
        expect(preferences.placements.overview).toBe('hidden');
        expect(preferences.orderedIds[0]).toBe('removed');
        expect(NavigationSurfacePlacementsV1Schema.safeParse({ projectTabBar: preferences, futureSurface: {} }).success).toBe(false);
    });

    it('resolves automatic defaults from known content while saved choices win and Automatic clears only its override', () => {
        const items = [
            { id: 'positive', defaultPlacement: 'auto' as const, hasContent: true },
            { id: 'empty', defaultPlacement: 'auto' as const, hasContent: false },
            { id: 'unknown', defaultPlacement: 'auto' as const, hasContent: null },
        ];
        const defaults = resolveNavigationPlacements(items);
        expect(defaults.pinned.map(item => item.id)).toEqual(['positive']);
        expect(defaults.overflow.map(item => item.id)).toEqual(['empty', 'unknown']);
        expect(defaults.effectivePlacements).toEqual({ positive: 'pinned', empty: 'overflow', unknown: 'overflow' });
        const saved = { orderedIds: ['unknown'], placements: { positive: 'hidden' as const, empty: 'pinned' as const, unknown: 'overflow' as const } };
        const overridden = resolveNavigationPlacements(items, saved);
        expect(overridden.effectivePlacements).toEqual({ unknown: 'overflow', positive: 'hidden', empty: 'pinned' });
        const automatic = updateNavigationPlacement(saved, 'positive', 'auto');
        expect(automatic).toEqual({ ...saved, placements: { empty: 'pinned', unknown: 'overflow' } });
        expect(resolveNavigationPlacements(items, automatic).effectivePlacements.positive).toBe('pinned');
        expect(NavigationSurfacePlacementsV1Schema.safeParse({ sessionRail: { orderedIds: [], placements: { positive: 'auto' } } }).success).toBe(false);
    });
    it('resolves legal and pending placement once without rewriting saved preferences', () => {
        const preferences = { orderedIds: ['goal', 'permission'], placements: { permission: 'hidden' as const, goal: 'hidden' as const } };
        const controls = [
            { id: 'permission', defaultPlacement: 'pinned' as const, allowedPlacements: ['pinned', 'overflow'] as const },
            { id: 'goal', defaultPlacement: 'overflow' as const, pending: true },
        ];
        const result = resolveNavigationPlacements(controls, preferences);
        expect(result.pinned.map(item => item.id)).toEqual(['goal', 'permission']);
        expect(result.effectivePlacements).toEqual({ goal: 'pinned', permission: 'pinned' });
        expect(resolveNavigationPlacements(controls.map(item => ({ ...item, pending: false })), preferences).hidden.map(item => item.id)).toEqual(['goal']);
        expect(preferences.placements).toEqual({ permission: 'hidden', goal: 'hidden' });
    });

    it('admits composer and explicit empty defaults while rejecting malformed nonempty preferences', () => {
        expect(NavigationSurfacePlacementsV1Schema.parse({ composer: {} })).toEqual({ composer: { orderedIds: [], placements: {} } });
        expect(NavigationSurfacePlacementsV1Schema.safeParse({ composer: { placements: {} } }).success).toBe(false);
        expect(readNavigationSurfacePlacements({ navigationSurfacePlacementsV1: { composer: { orderedIds: ['resume'], placements: { resume: 'overflow' }, future: true } } }).composer)
            .toEqual({ orderedIds: ['resume'], placements: { resume: 'overflow' } });
    });
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

    it('reserves measured room for a permanent Customize More trigger', () => {
        const pinned = ['chat', 'participants', 'agents', 'details'].map(id => ({ id }));
        const options = { availableSize: 4, itemSize: 1, reserveOverflowSlot: true };
        expect(resolveNavigationOverflow(pinned, [], options)).toEqual({ shown: pinned.slice(0, 3), overflow: pinned.slice(3) });
        expect(resolveNavigationOverflow(pinned, [], { ...options, availableSize: 5 })).toEqual({ shown: pinned, overflow: [] });
        expect(resolveNavigationOverflow(pinned, [], { ...options, availableSize: null })).toEqual({ shown: pinned, overflow: [] });
    });
});
