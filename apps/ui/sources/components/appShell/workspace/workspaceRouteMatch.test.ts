import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceRouteMatcher, matchWorkspaceRoutePatterns } from './workspaceRouteMatch';
import { matchWorkspaceDestinationRoute, workspaceRouteHref } from './workspaceRoutes';
import { MACHINE_SUB_PAGES } from '@/components/machines/page/machineSubPages';

describe('Expo destination route matching', () => {
    it.each(MACHINE_SUB_PAGES)('canonicalizes the %s query sub-page through the same machine route owner', page => {
        for (const root of ['/machines', '/settings/machines']) {
            expect(workspaceRouteHref(`${root}/m%2F1`, { id: 'm/1', page, serverId: 'home-a' }))
                .toBe(`${root}/m%2F1/${page}?serverId=home-a`);
        }
    });
    it('keeps query-owned page state and repeated values while omitting dynamic path params', () => {
        expect(workspaceRouteHref('/machines/m1', { id: 'm1', tab: 'storage', page: 'category', categoryId: 'caches' }))
            .toBe('/machines/m1?tab=storage&page=category&categoryId=caches');
        expect(workspaceRouteHref('/machines/m1/terminal', { id: 'm1', page: 'terminal', serverId: 'home-a' }))
            .toBe('/machines/m1/terminal?serverId=home-a');
        expect(workspaceRouteHref('/plugins/acme/tools/a%2Fb/c', {
            pluginId: 'acme', localId: 'tools', subPath: ['a/b', 'c'], filter: ['one', 'two'], absent: undefined,
        })).toBe('/plugins/acme/tools/a%2Fb/c?filter=one&filter=two');
    });
    it('reuses the prepared destination registry across repeated tab identity reads', () => {
        // Observe real sorting without replacing route matching or its comparator.
        const sorting = vi.spyOn(Array.prototype, 'sort');
        try {
            for (let i = 0; i < 100; i++) {
                expect(matchWorkspaceDestinationRoute(`/session/session-${i}/runs/new`)).toEqual({
                    routeKey: 'session/[id]/runs/new', params: { id: `session-${i}` },
                });
                expect(matchWorkspaceDestinationRoute('/settings/connected-services/connect')?.routeKey)
                    .toBe('settings/connected-services/connect');
            }
            expect(sorting.mock.calls).toHaveLength(0);
        } finally {
            sorting.mockRestore();
        }
    });
    it('resolves hosted session subpages through their canonical Expo module identity', () => {
        expect(matchWorkspaceDestinationRoute('/external/browse?machineId=m')).toEqual({
            routeKey: 'external/browse', params: {},
        });
        expect(matchWorkspaceDestinationRoute('/session/a%20b/info')).toEqual({
            routeKey: 'session/[id]/info', params: { id: 'a b' },
        });
        expect(matchWorkspaceDestinationRoute('/session/a/runs/new')).toEqual({
            routeKey: 'session/[id]/runs/new', params: { id: 'a' },
        });
        expect(matchWorkspaceDestinationRoute('/session/a/message/m%2F1')).toEqual({
            routeKey: 'session/[id]/message/[messageId]', params: { id: 'a', messageId: 'm/1' },
        });
    });
    it('keeps static routes ahead of dynamic entities and decodes each identity segment once', () => {
        const routes = ['settings/agents/[agentId]', 'settings/agents/custom/[backendId]', 'settings/agents/custom/new'];
        expect(matchWorkspaceRoutePatterns(routes, '/settings/agents/custom/new')).toEqual({
            routeKey: 'settings/agents/custom/new', params: {},
        });
        expect(matchWorkspaceRoutePatterns(routes, '/settings/agents/custom/agent%20one?setting=name')).toEqual({
            routeKey: 'settings/agents/custom/[backendId]', params: { backendId: 'agent one' },
        });
        expect(matchWorkspaceRoutePatterns(routes, '/settings/agents/custom/a/extra')).toBeNull();
    });
    it('preserves required and optional plugin subpaths and malformed-path refusal in a prepared registry', () => {
        const match = createWorkspaceRouteMatcher([
            'plugins/[pluginId]/[[...path]]', 'plugins/[pluginId]/[...path]', 'plugins/[pluginId]/settings',
        ]);
        expect(match('/plugins/acme/settings')).toEqual({ routeKey: 'plugins/[pluginId]/settings', params: { pluginId: 'acme' } });
        expect(match('/plugins/acme/a%2Fb/c#view')).toEqual({
            routeKey: 'plugins/[pluginId]/[...path]', params: { pluginId: 'acme', path: 'a/b/c' },
        });
        expect(match('/plugins/acme')).toEqual({ routeKey: 'plugins/[pluginId]/[[...path]]', params: { pluginId: 'acme' } });
        expect(match('/plugins/%ZZ')).toBeNull();
        expect(match('/unregistered')).toBeNull();
    });
});
