import { describe, expect, it } from 'vitest';
import { resolveDetailNavigationItems, resolveDetailNavigationProjection } from './detailNavigationItems';
import { resolveDetailPhoneNavigationItem } from './detailNavigationItems';
import { resolveNavigationPlacements } from '@/sync/domains/settings/mobileSurfacePinning';

describe('plugin page Items through the detail navigation owner', () => {
    it('hides only the active both launcher and restores it without mutating its placement or catalog', () => {
        const items = resolveDetailNavigationItems({ scope: 'plugin', items: [
            { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'bar' },
            { value: 'notes', title: 'Notes', kind: 'both', companion: { pluginId: 'acme.review', localId: 'notes' }, phonePlacement: 'bar' },
            { value: 'tools', title: 'Tools', kind: 'companion', companion: { pluginId: 'acme.review', localId: 'tools' }, phonePlacement: 'more' },
        ] });
        const placements = { orderedIds: ['notes', 'tools'], placements: { notes: 'overflow' as const } };
        const before = resolveNavigationPlacements(items, placements);
        expect(resolveDetailNavigationProjection(items, 'desktop', 'notes').companions.map(item => item.id)).toEqual(['tools']);
        expect(resolveDetailNavigationProjection(items, 'desktop', 'overview').companions).toEqual([items[1], items[2]]);
        expect(resolveDetailNavigationProjection(items, 'mobile', 'notes').phone.map(item => item.id)).toEqual(['overview', 'notes', 'tools']);
        expect(resolveNavigationPlacements(items, placements)).toEqual(before);
        expect(items[1]?.navigation).toMatchObject({ kind: 'both', companion: 'acme.review/notes' });
    });
    it('projects portable page, companion and both declarations without a second catalog', () => {
        const companion = { pluginId: 'acme.review', localId: 'notes' };
        const items = resolveDetailNavigationItems({ scope: 'plugin', items: [
                { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'bar', glyph: 'info' },
                { value: 'notes', title: 'Notes', kind: 'both', companion, phonePlacement: 'more', badge: '3' },
                { value: 'tools', title: 'Tools', kind: 'companion', companion, phonePlacement: 'none', disabled: true },
            ] });
        expect(items.map(item => [item.id, item.navigation.kind, item.phonePlacement])).toEqual([
            ['overview', 'page', 'bar'], ['notes', 'both', 'more'], ['tools', 'companion', 'none'],
        ]);
        expect(items[0]?.icon).toBe('info');
        expect(items[1]).toMatchObject({ count: '3', navigation: { companion: 'acme.review/notes' }, defaultPlacement: 'pinned' });
        expect(items[2]?.disabledReason).toBeTruthy();
    });
    it('keeps phone-hidden pages available in the desktop strip', () => {
        const items = resolveDetailNavigationItems({ scope: 'plugin', items: [
            { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'bar' },
            { value: 'files', title: 'Files', kind: 'page', phonePlacement: 'none' },
        ] });
        expect(items.map(item => item.defaultPlacement)).toEqual(['pinned', 'pinned']);
        expect(items.map(item => item.phonePlacement)).toEqual(['bar', 'none']);
    });
    it('reserves the primary desktop page without manufacturing unsupported phone access', () => {
        const items = resolveDetailNavigationItems({ scope: 'plugin', items: [
            { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'none' },
            { value: 'files', title: 'Files', kind: 'page', phonePlacement: 'bar' },
        ] });
        expect(resolveNavigationPlacements(items, { orderedIds: [], placements: { overview: 'hidden' } })
            .pinned.map(item => item.id)).toEqual(['overview', 'files']);
        expect(resolveNavigationPlacements(items.map(resolveDetailPhoneNavigationItem),
            { orderedIds: [], placements: { overview: 'pinned' } }).hidden.map(item => item.id)).toEqual(['overview']);
    });
});
