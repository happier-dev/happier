import { describe, expect, it } from 'vitest';
import { matchWorkspaceRoutePatterns } from './workspaceRouteMatch';
import { matchWorkspaceDestinationRoute } from './workspaceRoutes';

describe('Expo destination route matching', () => {
    it('loads the connect journey instead of interpreting connect as a legacy service id', () => {
        expect(matchWorkspaceDestinationRoute('/settings/connected-services/connect')?.routeKey).toBe('settings/connected-services/connect');
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
});
