import { describe, expect, it } from 'vitest';
import { resolveDetailNavigationItems, resolveDetailNavigationProjection } from './rightSidebarTabRegistry';
import { DEPLOYMENT_ENVIRONMENT_TABS_V1 } from '@happier-dev/deployments';

describe('Session detail navigation', () => {
    it('derives Environment pages from the domain ids, reserving Overview without companions', () => {
        const items = resolveDetailNavigationItems({ scope: 'environment' });
        expect(items.map(item => item.id)).toEqual([...DEPLOYMENT_ENVIRONMENT_TABS_V1]);
        expect(items.every(item => item.navigation.kind === 'page' && item.phonePlacement === 'bar')).toBe(true);
        expect(items[0]?.allowedPlacements).toEqual(['pinned']);
    });
    it('resolves Machine core and qualified plugin pages without adding companions', () => {
        const pages = [
            { id: 'overview', title: 'Overview', icon: 'desktop' as const, disabledReason: null },
            { id: 'storage', title: 'Storage', icon: 'hard-drives' as const, disabledReason: null },
            { id: 'plugin:["acme.tools","storage"]', title: 'Plugin storage', icon: 'puzzle-piece' as const, disabledReason: 'offline' },
        ];
        const items = resolveDetailNavigationItems({ scope: 'machine', pages });
        expect(items.map(item => item.id)).toEqual(pages.map(page => page.id));
        expect(items.map(item => item.navigation)).toEqual(pages.map(page => ({ kind: 'page', page: page.id, desktop: 'tabs' })));
        expect(items[0]?.allowedPlacements).toEqual(['pinned']);
        expect(items[2]?.disabledReason).toBe('offline');
        expect(items.map(item => item.phonePlacement)).toEqual(['bar', 'bar', 'bar']);
    });
    it('resolves all Session destinations once, with only Chat as a default desktop page', () => {
        const items = resolveDetailNavigationItems({ scope: 'session', terminalTabAvailable: true, computerAvailable: true });
        const projection = resolveDetailNavigationProjection(items, 'desktop');
        expect(projection.pages.map(item => item.id)).toEqual(['chat']);
        expect(projection.companions.map(item => item.id)).toEqual(expect.arrayContaining(['review', 'terminal', 'computer']));
        expect(items.filter(item => item.id === 'terminal')).toHaveLength(1);
        expect(items.find(item => item.id === 'tabs')?.navigation).toMatchObject({ kind: 'page', desktop: 'none' });
        expect(items.find(item => item.id === 'companion')?.navigation.kind).toBe('companion');
    });

    it('decides Editor-first page eligibility at the item owner and never applies it to phone', () => {
        const editor = resolveDetailNavigationItems({ scope: 'session', arrangement: 'editor', boardFeatureEnabled: true });
        expect(editor.find(item => item.id === 'info')?.navigation.kind).toBe('both');
        expect(resolveDetailNavigationProjection(editor, 'desktop').pages.map(item => item.id)).toContain('info');
        const phone = resolveDetailNavigationItems({ scope: 'session', arrangement: 'editor', presentation: 'mobile', terminalTabAvailable: true, computerAvailable: true });
        expect(phone.find(item => item.id === 'info')?.navigation.kind).toBe('companion');
        const projection = resolveDetailNavigationProjection(phone, 'mobile');
        expect(projection.phone.map(item => item.id)).toEqual(expect.arrayContaining(['chat', 'tabs', 'companion', 'terminal']));
        expect(projection.phone.map(item => item.id)).not.toContain('review');
        expect(projection.phone.map(item => item.id)).not.toContain('computer');
    });
});
