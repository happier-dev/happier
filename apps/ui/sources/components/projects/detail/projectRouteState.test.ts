import { describe, expect, it } from 'vitest';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/resolveRepoWorktreeSelection';

import {
    PROJECT_ROUTE_ROOT_SENTINEL,
    PROJECT_ROUTE_WORKTREE_ID_QUERY_PARAM,
    buildProjectRouteHref,
    resolveProjectOpenHref,
    migrateProjectRouteSegmentToMobileSurface,
    readProjectRouteWorktreeSelection,
    resolveProjectCockpitIndexRedirectHref,
    resolveProjectRouteSegment,
    resolveProjectRouteHeaderTitle,
} from './projectRouteState';

const workspaceRef: WorkspaceRefV1 = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/Users/test/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
    lastOpenedAtMs: null,
};

describe('projectRouteState', () => {
    it.each(['browser', 'services'] as const)('settles canonical %s index routes and normalizes an omitted surface hint once', (surface) => {
        const selection = readProjectRouteWorktreeSelection({
            rawWorktreeId: PROJECT_ROUTE_ROOT_SENTINEL,
            defaultRootPath: workspaceRef.rootPath,
        });
        const input = {
            workspaceRefId: workspaceRef.id, surface,
            ...selection,
            activeRootPath: workspaceRef.rootPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: null,
        };
        expect(resolveProjectCockpitIndexRedirectHref({ ...input, explicitMobileSurfaceHint: surface })).toBeNull();
        const href = resolveProjectCockpitIndexRedirectHref({ ...input, explicitMobileSurfaceHint: null });
        expect(href).toBe(`/projects/wr_1?worktreeId=%40root&mobileSurface=${surface}`);
        const url = new URL(href!, 'https://app.happier.test');
        expect(resolveProjectCockpitIndexRedirectHref({
            ...input,
            ...readProjectRouteWorktreeSelection({
                rawWorktreeId: url.searchParams.get('worktreeId') ?? undefined,
                defaultRootPath: workspaceRef.rootPath,
            }),
            explicitMobileSurfaceHint: url.searchParams.get('mobileSurface'),
        })).toBeNull();
    });

    it.each([
        ['git', 'git'], ['browse', 'files'], ['tabs', 'details'], ['terminal', 'terminal'],
    ] as const)('continues redirecting the persisted %s index surface to its %s leaf', (surface, leaf) => {
        expect(resolveProjectCockpitIndexRedirectHref({
            workspaceRefId: workspaceRef.id, surface, explicitMobileSurfaceHint: surface,
            requestedRootPath: workspaceRef.rootPath, requestedWorktreeId: null,
            activeRootPath: workspaceRef.rootPath, defaultRootPath: workspaceRef.rootPath, activeWorktreeId: null,
        })).toBe(`/projects/wr_1/${leaf}?worktreeId=%40root`);
    });

    it('repairs an invalid worktree on a hosted index surface and settles the canonical worktree selection', () => {
        const availableWorktrees = [{ id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth' }];
        const requested = readProjectRouteWorktreeSelection({
            rawWorktreeId: 'gitwt_deleted', defaultRootPath: workspaceRef.rootPath,
        });
        const resolved = resolveRepoWorktreeSelection({ ...requested, defaultRootPath: workspaceRef.rootPath, availableWorktrees });
        const input = {
            workspaceRefId: workspaceRef.id, surface: 'browser' as const, explicitMobileSurfaceHint: 'browser',
            ...requested, activeRootPath: resolved.resolvedRootPath,
            activeWorktreeId: resolved.resolvedWorktreeId, defaultRootPath: workspaceRef.rootPath,
        };
        expect(resolveProjectCockpitIndexRedirectHref(input)).toBe('/projects/wr_1?worktreeId=%40root&mobileSurface=browser');
        expect(resolveProjectCockpitIndexRedirectHref({ ...input, requestedWorktreeId: null })).toBeNull();
        const selected = readProjectRouteWorktreeSelection({
            rawWorktreeId: 'gitwt_feature', defaultRootPath: workspaceRef.rootPath,
            persistedActiveRootPath: availableWorktrees[0].path, persistedWorktreeId: 'gitwt_feature',
        });
        const canonical = resolveRepoWorktreeSelection({ ...selected, defaultRootPath: workspaceRef.rootPath, availableWorktrees });
        expect(resolveProjectCockpitIndexRedirectHref({
            ...input, ...selected, activeRootPath: canonical.resolvedRootPath, activeWorktreeId: canonical.resolvedWorktreeId,
        })).toBeNull();
    });

    it('reads explicit root and persisted route selections', () => {
        expect(readProjectRouteWorktreeSelection({
            rawWorktreeId: PROJECT_ROUTE_ROOT_SENTINEL,
            defaultRootPath: workspaceRef.rootPath,
        })).toEqual({
            requestedRootPath: '/Users/test/repo',
            requestedWorktreeId: null,
        });
        expect(readProjectRouteWorktreeSelection({
            defaultRootPath: workspaceRef.rootPath,
            persistedActiveRootPath: '/Users/test/repo/.worktrees/feature-auth',
            persistedWorktreeId: 'gitwt_feature',
        })).toEqual({
            requestedRootPath: '/Users/test/repo/.worktrees/feature-auth',
            requestedWorktreeId: 'gitwt_feature',
        });
    });

    it('can use a persisted path to provisionally resolve an explicit worktree id', () => {
        expect(readProjectRouteWorktreeSelection({
            rawWorktreeId: 'gitwt_feature',
            defaultRootPath: workspaceRef.rootPath,
            persistedActiveRootPath: '/Users/test/repo/.worktrees/feature-auth',
            persistedWorktreeId: 'gitwt_feature',
        })).toEqual({
            requestedRootPath: '/Users/test/repo/.worktrees/feature-auth',
            requestedWorktreeId: 'gitwt_feature',
        });
    });

    it('builds project route hrefs with an explicit root sentinel for the primary root', () => {
        expect(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment: 'git',
            activeRootPath: workspaceRef.rootPath,
            defaultRootPath: workspaceRef.rootPath,
        })).toBe(`/projects/wr_1/git?${PROJECT_ROUTE_WORKTREE_ID_QUERY_PARAM}=%40root`);
    });

    it('builds project route hrefs with an encoded worktree id when a worktree is selected', () => {
        expect(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment: 'files',
            activeRootPath: '/Users/test/repo/.worktrees/feature-auth',
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: 'gitwt_feature',
        })).toBe(`/projects/wr_1/files?${PROJECT_ROUTE_WORKTREE_ID_QUERY_PARAM}=gitwt_feature`);
    });

    it('can include the worktrees details mode query param without dropping the active worktree id', () => {
        expect(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment: 'details',
            activeRootPath: '/Users/test/repo/.worktrees/feature-auth',
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: 'gitwt_feature',
            showWorktrees: true,
        })).toBe(`/projects/wr_1/details?${PROJECT_ROUTE_WORKTREE_ID_QUERY_PARAM}=gitwt_feature&showWorktrees=1`);
    });

    it('adds the selected worktree label to the mobile header title', () => {
        expect(resolveProjectRouteHeaderTitle(workspaceRef, workspaceRef.rootPath)).toBe('Project Alpha');
        expect(resolveProjectRouteHeaderTitle(workspaceRef, '/Users/test/repo/.worktrees/feature-auth'))
            .toBe('Project Alpha · feature-auth');
    });

    it('migrates legacy mobile route segments to cockpit surfaces', () => {
        expect(migrateProjectRouteSegmentToMobileSurface('files')).toBe('browse');
        expect(migrateProjectRouteSegmentToMobileSurface('git')).toBe('git');
        expect(migrateProjectRouteSegmentToMobileSurface('details')).toBe('tabs');
        expect(migrateProjectRouteSegmentToMobileSurface('unknown')).toBeNull();
    });

    it('resolves the project route segment from live state, then persisted cockpit state, then files', () => {
        expect(resolveProjectRouteSegment('git', undefined)).toBe('git');
        expect(resolveProjectRouteSegment(undefined, 'browse')).toBe('files');
        expect(resolveProjectRouteSegment(undefined, 'overview')).toBe('details');
        expect(resolveProjectRouteSegment(undefined, 'terminal')).toBe('details');
        expect(resolveProjectRouteSegment(undefined, 'git')).toBe('git');
        expect(resolveProjectRouteSegment(undefined, undefined)).toBe('files');
    });

    it('opens a project through the persisted mobile surface and worktree policy', () => {
        expect(resolveProjectOpenHref({
            workspaceRef,
            deviceType: 'phone',
            cockpitEnabled: true,
            rememberedRightTabId: null,
            persistedMobileSurface: 'git',
            persistedActiveRootPath: '/Users/test/repo/.worktrees/feature-auth',
            persistedWorktreeId: 'gitwt_feature',
        })).toBe('/projects/wr_1/git?worktreeId=gitwt_feature');

        expect(resolveProjectOpenHref({
            workspaceRef,
            deviceType: 'phone',
            cockpitEnabled: false,
            rememberedRightTabId: null,
            persistedMobileSurface: 'git',
            persistedActiveRootPath: '/Users/test/repo/.worktrees/feature-auth',
            persistedWorktreeId: 'gitwt_feature',
        })).toBe('/projects/wr_1/git?worktreeId=gitwt_feature');
    });
});
