import { describe, expect, it } from 'vitest';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import {
    PROJECT_ROUTE_ROOT_SENTINEL,
    PROJECT_ROUTE_WORKTREE_ID_QUERY_PARAM,
    buildProjectRouteHref,
    migrateProjectRouteSegmentToMobileSurface,
    readProjectRouteWorktreeSelection,
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
});
