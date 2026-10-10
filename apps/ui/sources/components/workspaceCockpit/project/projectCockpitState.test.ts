import { describe, expect, it } from 'vitest';
import { resolveProjectCockpitRouteFromPathname, resolveProjectMobileSurfaceIntent,
    resolveProjectRoutePathForSurface, resolveProjectRightTabIdForSurface } from './projectCockpitState';

describe('projectCockpitState', () => {
    it.each(['/projects/open', '/projects/open/?sourceId=source', '/projects/sources', '/projects/sources/'])('does not treat the static selection route as an accepted checkout (%s)', (pathname) => {
        expect(resolveProjectCockpitRouteFromPathname(pathname)).toBeNull();
    });

    it('keeps the full phone route intent while changing the canonical page', () => {
        const href = resolveProjectRoutePathForSurface({ workspaceRefId: 'wr_1', page: 'scripts', surface: 'scripts',
            serverId: 'home-a', rawWorktreeId: 'checkout-a', routeParams: { layoutId: 'dashboard-a', comparisonId: 'comparison-a',
                initialFile: 'src/a.ts', source: 'diff', anchor: 'range', startLine: '7', endLine: '12' } });
        const url = new URL(href, 'https://happier.test');
        expect(url.pathname).toBe('/projects/wr_1/scripts');
        expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: 'home-a', worktreeId: 'checkout-a', layoutId: 'dashboard-a',
            comparisonId: 'comparison-a', initialFile: 'src/a.ts', source: 'diff', anchor: 'range', startLine: '7', endLine: '12' });
    });
    it('returns to the default dashboard without losing the captured page, Home, checkout or resource', () => {
        const href = resolveProjectRoutePathForSurface({ workspaceRefId: 'wr_1', page: 'overview', surface: 'overview',
            serverId: 'home-a', rawWorktreeId: 'checkout-a', layoutId: null,
            routeParams: { layoutId: 'stale', initialFile: 'src/a.ts', comparisonId: 'comparison-a' } });
        expect(Object.fromEntries(new URL(href, 'https://happier.test').searchParams)).toEqual({
            serverId: 'home-a', worktreeId: 'checkout-a', initialFile: 'src/a.ts', comparisonId: 'comparison-a' });
    });
    it.each(['overview', 'code', 'changes', 'scripts', 'services', 'context'] as const)('preserves the %s page and exact checkout', (surface) => {
        const href = resolveProjectRoutePathForSurface({ workspaceRefId: 'wr_1', surface,
            rawWorktreeId: 'checkout-a', serverId: 'home-a', layoutId: 'dashboard-a', comparisonId: 'comparison-a' });
        const url = new URL(href, 'https://app.happier.test');
        expect(url.pathname).toBe(`/projects/wr_1/${surface}`);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ worktreeId: 'checkout-a', serverId: 'home-a',
            layoutId: 'dashboard-a', comparisonId: 'comparison-a' });
        expect(resolveProjectCockpitRouteFromPathname(href)).toEqual({ workspaceRefId: 'wr_1', page: surface, surface });
    });

    it('keeps companion selection on its captured page without introducing an alias route', () => {
        const href = resolveProjectRoutePathForSurface({ workspaceRefId: 'wr_1', page: 'context', surface: 'browser',
            rawActiveRootPath: '/repo', serverId: 'home-a' });
        expect(href).toBe('/projects/wr_1/context?activeRootPath=%2Frepo&serverId=home-a&mobileSurface=browser');
        expect(resolveProjectCockpitRouteFromPathname(href)).toEqual({ workspaceRefId: 'wr_1', page: 'context', surface: 'browser' });
    });

    it('does not admit unpublished three-tab aliases', () => {
        for (const alias of ['details', 'files', 'git']) expect(resolveProjectCockpitRouteFromPathname(`/projects/wr_1/${alias}`)).toBeNull();
    });

    it('an explicit page wins over stale persisted companion selection', () => {
        expect(resolveProjectMobileSurfaceIntent({ routeKind: 'context', persistedSurface: 'browser', activeRightTabId: 'files' })).toBe('context');
        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1/context', 'browser')).toEqual({ workspaceRefId: 'wr_1', page: 'context', surface: 'context' });
    });
    it('projects a Services companion without replacing the Context page decision', () => {
        const href = resolveProjectRoutePathForSurface({ workspaceRefId: 'wr_1', page: 'context', surface: 'services' });
        expect(href).toBe('/projects/wr_1/context?mobileSurface=services');
        expect(resolveProjectCockpitRouteFromPathname(href)).toEqual({ workspaceRefId: 'wr_1', page: 'context', surface: 'services' });
    });

    it('maps existing companion domain ids through the canonical page owner', () => {
        expect(resolveProjectMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'scripts' })).toBe('scripts');
        expect(resolveProjectMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'terminal' })).toBe('terminal');
        expect(resolveProjectMobileSurfaceIntent({ routeKind: 'context', activeRightTabId: 'terminal' })).toBe('context');
        expect(resolveProjectRightTabIdForSurface('terminal')).toBe('terminal');
        expect(resolveProjectRightTabIdForSurface('code')).toBe('files');
        expect(resolveProjectRightTabIdForSurface('changes')).toBe('git');
        expect(resolveProjectRightTabIdForSurface('browser')).toBe('browser');
        expect(resolveProjectRightTabIdForSurface('services')).toBe('services');
    });
});
