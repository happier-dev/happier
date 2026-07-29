import { describe, expect, it } from 'vitest';

import {
    resolveProjectMobileSurfaceIntent,
    resolveProjectCockpitRouteFromPathname,
    resolveProjectRoutePathForSurface,
    resolveProjectRightTabIdForSurface,
} from './projectCockpitState';

describe('projectCockpitState', () => {
    it('builds route paths for project cockpit surfaces while preserving worktree selection', () => {
        expect(resolveProjectRoutePathForSurface({
            workspaceRefId: 'wr_1',
            surface: 'overview',
            rawWorktreeId: 'gitwt_feature',
        })).toBe('/projects/wr_1?worktreeId=gitwt_feature&mobileSurface=overview');

        expect(resolveProjectRoutePathForSurface({
            workspaceRefId: 'wr_1',
            surface: 'browse',
            rawWorktreeId: 'gitwt_feature',
        })).toBe('/projects/wr_1/files?worktreeId=gitwt_feature');

        expect(resolveProjectRoutePathForSurface({
            workspaceRefId: 'wr_1',
            surface: 'terminal',
            rawWorktreeId: '@root',
        })).toBe('/projects/wr_1/terminal?worktreeId=%40root');

        expect(resolveProjectRoutePathForSurface({
            workspaceRefId: 'wr_1',
            surface: 'browser',
            rawWorktreeId: 'gitwt_feature',
        })).toBe('/projects/wr_1?worktreeId=gitwt_feature&mobileSurface=browser');

        expect(resolveProjectRoutePathForSurface({
            workspaceRefId: 'wr_1',
            surface: 'services',
            rawActiveRootPath: '/repo',
        })).toBe('/projects/wr_1?activeRootPath=%2Frepo&mobileSurface=services');
    });

    it('resolves cockpit routes from pathname and persisted root-surface state', () => {
        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1/files')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'browse',
        });

        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1', 'git')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'git',
        });

        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1/details')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'tabs',
        });

        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1', null, 'browser')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'browser',
        });

        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1', null, 'services')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'services',
        });
    });

    it('lets files routes honor explicit hosted-surface hints so the route model matches the rendered surface', () => {
        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1/files', null, 'browser')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'browser',
        });

        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1/files', null, 'services')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'services',
        });
    });

    it('lets an explicit root-route surface hint override stale persisted surface state', () => {
        expect(resolveProjectCockpitRouteFromPathname('/projects/wr_1', 'terminal', 'overview')).toEqual({
            workspaceRefId: 'wr_1',
            surface: 'overview',
        });
    });

    it('lets an explicit root-route surface hint override stale right-tab state', () => {
        expect(resolveProjectMobileSurfaceIntent({
            routeKind: 'index',
            activeRightTabId: 'files',
            explicitSurfaceHint: 'overview',
        })).toBe('overview');
    });

    it('prefers the persisted root surface over stale right-tab state on the index route', () => {
        expect(resolveProjectMobileSurfaceIntent({
            routeKind: 'index',
            activeRightTabId: 'files',
            persistedSurface: 'terminal',
        })).toBe('terminal');
    });

    it('maps built-in Browser and Services mobile surfaces back to right-sidebar tabs', () => {
        expect(resolveProjectMobileSurfaceIntent({
            routeKind: 'index',
            activeRightTabId: 'browser',
        })).toBe('browser');
        expect(resolveProjectMobileSurfaceIntent({
            routeKind: 'index',
            activeRightTabId: 'services',
        })).toBe('services');
        expect(resolveProjectRightTabIdForSurface('browser')).toBe('browser');
        expect(resolveProjectRightTabIdForSurface('services')).toBe('services');
    });
});
