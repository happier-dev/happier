import { describe, expect, it } from 'vitest';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import {
    buildProjectRouteHref,
    readProjectRouteActiveRootPath,
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
    it('reads the active root path param with a fallback to the workspace root', () => {
        expect(readProjectRouteActiveRootPath('/Users/test/repo/.worktrees/feature-auth', workspaceRef.rootPath))
            .toBe('/Users/test/repo/.worktrees/feature-auth');
        expect(readProjectRouteActiveRootPath(undefined, workspaceRef.rootPath))
            .toBe('/Users/test/repo');
    });

    it('falls back to a persisted active root path before the workspace root', () => {
        expect(readProjectRouteActiveRootPath(
            undefined,
            workspaceRef.rootPath,
            '/Users/test/repo/.worktrees/feature-auth',
        )).toBe('/Users/test/repo/.worktrees/feature-auth');
    });

    it('ignores an empty persisted active root path and falls back to the workspace root', () => {
        expect(readProjectRouteActiveRootPath(
            undefined,
            workspaceRef.rootPath,
            '   ',
        )).toBe(workspaceRef.rootPath);
    });

    it('builds project route hrefs without a query param for the primary root', () => {
        expect(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment: 'git',
            activeRootPath: workspaceRef.rootPath,
            defaultRootPath: workspaceRef.rootPath,
        })).toBe('/projects/wr_1/git');
    });

    it('builds project route hrefs with an encoded active root path when a worktree is selected', () => {
        expect(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment: 'files',
            activeRootPath: '/Users/test/repo/.worktrees/feature-auth',
            defaultRootPath: workspaceRef.rootPath,
        })).toBe('/projects/wr_1/files?activeRootPath=%2FUsers%2Ftest%2Frepo%2F.worktrees%2Ffeature-auth');
    });

    it('can include the worktrees details mode query param without dropping the active root path', () => {
        expect(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment: 'details',
            activeRootPath: '/Users/test/repo/.worktrees/feature-auth',
            defaultRootPath: workspaceRef.rootPath,
            showWorktrees: true,
        })).toBe('/projects/wr_1/details?activeRootPath=%2FUsers%2Ftest%2Frepo%2F.worktrees%2Ffeature-auth&showWorktrees=1');
    });

    it('adds the selected worktree label to the mobile header title', () => {
        expect(resolveProjectRouteHeaderTitle(workspaceRef, workspaceRef.rootPath)).toBe('Project Alpha');
        expect(resolveProjectRouteHeaderTitle(workspaceRef, '/Users/test/repo/.worktrees/feature-auth'))
            .toBe('Project Alpha · feature-auth');
    });

    it('resolves the project route segment from live state, then persisted state, then files', () => {
        expect(resolveProjectRouteSegment('git', undefined)).toBe('git');
        expect(resolveProjectRouteSegment(undefined, 'git')).toBe('git');
        expect(resolveProjectRouteSegment(undefined, undefined)).toBe('files');
    });
});
