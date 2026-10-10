import { describe, expect, it } from 'vitest';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { buildProjectRouteHref, readProjectAttachedDashboardSelection, readProjectCodeRouteLocation, readProjectFileRouteTarget, readProjectRouteCheckoutRootPath, readProjectRouteWorktreeSelection, resolveProjectOpenHref, resolveProjectRouteHeaderTitle, resolveProjectAuthoringReturn, readProjectSessionAuthoringOrigin } from './projectRouteState';

const workspaceRef: WorkspaceRefV1 = { id: 'wr_1', serverId: 'home-a', machineId: 'machine-a',
    rootPath: '/repo', label: 'Project Alpha', createdAtMs: 1, lastOpenedAtMs: null };

describe('project route state', () => {
    it.each([{ kind: 'folder', path: '' }, { kind: 'folder', path: 'folder.with.dot' }, { kind: 'file', path: ' leading /LICENSE ' }] as const)('retains the literal Code page independently of Details: %j', location => {
        const href = buildProjectRouteHref({ workspaceRefId: workspaceRef.id, serverId: workspaceRef.serverId,
            segment: 'code', activeRootPath: '/feature', defaultRootPath: '/repo', activeWorktreeId: 'feature',
            routeParams: { layoutId: 'dashboard', initialFile: 'old.ts' }, initialResource: null, codeLocation: location });
        const params = Object.fromEntries(new URL(href, 'https://happier.test').searchParams);
        expect(params).toMatchObject({ codePath: location.path, codeKind: location.kind });
        expect(readProjectCodeRouteLocation(params)).toEqual(location);
        expect(params).toMatchObject({ serverId: 'home-a', worktreeId: 'feature', layoutId: 'dashboard' });
        expect(params.initialFile).toBeUndefined();
    });
    it('preserves an attached dashboard across page and checkout navigation and clears it on personal selection', () => {
        const href = buildProjectRouteHref({ workspaceRefId: workspaceRef.id, serverId: 'home-a', segment: 'overview',
            activeRootPath: '/repo', defaultRootPath: '/repo', attachedDashboard: { sourceId: 'team-source', artifactId: 'shared-artifact' } });
        const params = Object.fromEntries(new URL(href, 'https://happier.test').searchParams);
        expect(params).toMatchObject({ dashboardSourceId: 'team-source', dashboardArtifactId: 'shared-artifact' });
        const next = buildProjectRouteHref({ workspaceRefId: workspaceRef.id, serverId: 'home-a', segment: 'code',
            activeRootPath: '/repo/feature', defaultRootPath: '/repo', activeWorktreeId: 'feature', routeParams: params });
        expect(Object.fromEntries(new URL(next, 'https://happier.test').searchParams)).toMatchObject({
            dashboardSourceId: 'team-source', dashboardArtifactId: 'shared-artifact', worktreeId: 'feature' });
        const personal = buildProjectRouteHref({ workspaceRefId: workspaceRef.id, serverId: 'home-a', segment: 'overview',
            activeRootPath: '/repo', defaultRootPath: '/repo', layoutId: null, attachedDashboard: null, routeParams: params });
        expect(new URL(personal, 'https://happier.test').searchParams.has('dashboardArtifactId')).toBe(false);
        expect(new URL(personal, 'https://happier.test').searchParams.has('dashboardSourceId')).toBe(false);
        expect(readProjectAttachedDashboardSelection({ dashboardArtifactId: 'shared-artifact' })).toEqual({ sourceId: '', artifactId: 'shared-artifact' });
    });
    it('requires root proof for a worktree hint, but accepts explicit or matching persisted base checkout roots', () => {
        const input = { defaultRootPath: '/repo', rawWorktreeId: 'worktree' };
        expect(readProjectRouteCheckoutRootPath(input)).toBeNull();
        expect(readProjectRouteCheckoutRootPath({ ...input, rawLegacyActiveRootPath: '/repo' })).toBe('/repo');
        expect(readProjectRouteCheckoutRootPath({ ...input, persistedActiveRootPath: '/repo', persistedWorktreeId: 'worktree' })).toBe('/repo');
        expect(readProjectRouteCheckoutRootPath({ ...input, persistedActiveRootPath: '/repo', persistedWorktreeId: 'other' })).toBeNull();
        expect(readProjectRouteCheckoutRootPath({ ...input, persistedActiveRootPath: '/feature', persistedWorktreeId: 'worktree' })).toBe('/feature');
        expect(readProjectRouteCheckoutRootPath({ ...input, rawWorktreeId: '@root' })).toBe('/repo');
    });
    it.each([' leading /line\nbreak /name ', ' '])('preserves literal file route identity %j', path => {
        const href = buildProjectRouteHref({ workspaceRefId: workspaceRef.id, serverId: workspaceRef.serverId,
            segment: 'code', activeRootPath: '/repo', defaultRootPath: '/repo', initialResource: { kind: 'file', path } });
        const params = Object.fromEntries(new URL(href, 'https://happier.test').searchParams);
        expect(readProjectFileRouteTarget(params)).toEqual({ kind: 'file', path });
        expect(readProjectFileRouteTarget({ initialFile: ['', path] })).toEqual({ kind: 'file', path });
    });
    it('returns to the original exact Scripts or Changes checkout and comparison, not an edited launch target', () => {
        const origin = { kind: 'project', accountId: 'account-a', workspace: {
            serverId: 'home-a', workspaceId: workspaceRef.id, machineId: workspaceRef.machineId, rootPath: workspaceRef.rootPath,
        }, page: 'changes', comparisonId: 'comparison-original' } as const;
        const metadata = { machineId: 'edited-machine', path: '/edited-checkout', work: { authoringOriginV1: origin } };
        const result = resolveProjectAuthoringReturn(readProjectSessionAuthoringOrigin(metadata), {
            scope: { serverId: 'home-a', accountId: 'account-a' }, workspaceRefs: [workspaceRef],
        });
        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') throw new Error('Return was refused');
        const url = new URL(result.href, 'https://happier.test');
        expect(url.pathname).toBe('/projects/wr_1/changes');
        expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: 'home-a', worktreeId: '@root', comparisonId: 'comparison-original' });
        const scripts = resolveProjectAuthoringReturn({ ...origin, page: 'scripts', comparisonId: undefined }, {
            scope: { serverId: 'home-a', accountId: 'account-a' }, workspaceRefs: [workspaceRef],
        });
        expect(scripts).toMatchObject({ kind: 'ready', href: '/projects/wr_1/scripts?worktreeId=%40root&serverId=home-a' });
    });
    it('refuses missing, wrong-Account, wrong-Home and replaced workspace origins instead of opening a fallback', () => {
        const origin = { kind: 'project', accountId: 'account-a', workspace: {
            serverId: 'home-a', workspaceId: workspaceRef.id, machineId: workspaceRef.machineId, rootPath: workspaceRef.rootPath,
        }, page: 'scripts' } as const;
        expect(resolveProjectAuthoringReturn(origin, { scope: null, workspaceRefs: [workspaceRef] }).kind).toBe('unavailable');
        expect(resolveProjectAuthoringReturn(origin, { scope: { serverId: 'home-a', accountId: 'account-b' }, workspaceRefs: [workspaceRef] }).kind).toBe('unavailable');
        expect(resolveProjectAuthoringReturn(origin, { scope: { serverId: 'home-b', accountId: 'account-a' }, workspaceRefs: [workspaceRef] }).kind).toBe('unavailable');
        expect(resolveProjectAuthoringReturn(origin, { scope: { serverId: 'home-a', accountId: 'account-a' }, workspaceRefs: [] }).kind).toBe('unavailable');
        expect(resolveProjectAuthoringReturn(origin, { scope: { serverId: 'home-a', accountId: 'account-a' }, workspaceRefs: [{ ...workspaceRef, rootPath: '/replacement' }] }).kind).toBe('unavailable');
    });
    it.each(['overview', 'code', 'changes', 'scripts', 'services', 'context'] as const)('preserves qualified state on %s', (segment) => {
        const href = buildProjectRouteHref({ workspaceRefId: workspaceRef.id, segment,
            activeRootPath: '/repo/feature', defaultRootPath: '/repo', activeWorktreeId: 'checkout-a',
            serverId: 'home-a', layoutId: 'dashboard-a', comparisonId: 'comparison-a',
            initialResource: { kind: 'file', path: 'src/a.ts' } });
        const url = new URL(href, 'https://happier.test');
        expect(url.pathname).toBe(`/projects/wr_1/${segment}`);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ serverId: 'home-a', worktreeId: 'checkout-a',
            layoutId: 'dashboard-a', comparisonId: 'comparison-a', initialFile: 'src/a.ts' });
    });
    it('preserves resource and dashboard while changing checkout and explicitly exiting worktrees', () => {
        const href = buildProjectRouteHref({ workspaceRefId: 'wr_1', segment: 'changes',
            activeRootPath: '/repo', defaultRootPath: '/repo', serverId: 'home-a', showWorktrees: false,
            routeParams: { worktreeId: 'stale', activeRootPath: '/stale', layoutId: 'selected',
                initialCommit: 'sha-a', comparisonId: 'comparison-a', showWorktrees: '1' } });
        expect(Object.fromEntries(new URL(href, 'https://happier.test').searchParams)).toEqual({
            worktreeId: '@root', layoutId: 'selected', initialCommit: 'sha-a', comparisonId: 'comparison-a', serverId: 'home-a' });
    });
    it('explicit root beats persisted checkout and exact checkout can recover its known path', () => {
        expect(readProjectRouteWorktreeSelection({ rawWorktreeId: '@root', defaultRootPath: '/repo',
            persistedActiveRootPath: '/repo/feature', persistedWorktreeId: 'checkout-a' })).toEqual({
            requestedRootPath: '/repo', requestedWorktreeId: null });
        expect(readProjectRouteWorktreeSelection({ rawWorktreeId: 'checkout-a', defaultRootPath: '/repo',
            persistedActiveRootPath: '/repo/feature', persistedWorktreeId: 'checkout-a' })).toEqual({
            requestedRootPath: '/repo/feature', requestedWorktreeId: 'checkout-a' });
    });
    it('a newly selected resource replaces stale route intent instead of keeping conflicting file and commit targets', () => {
        const href = buildProjectRouteHref({ workspaceRefId: 'wr_1', segment: 'changes', activeRootPath: '/repo', defaultRootPath: '/repo',
            routeParams: { initialFile: 'stale.ts', initialCommit: 'old-sha', anchor: 'range', startLine: '7' },
            initialResource: { kind: 'commit', sha: 'current-sha' } });
        expect(Object.fromEntries(new URL(href, 'https://happier.test').searchParams)).toEqual({ worktreeId: '@root', initialCommit: 'current-sha' });
    });
    it('does not reopen a resource explicitly closed in the current pane when changing pages', () => {
        const href = buildProjectRouteHref({ workspaceRefId: 'wr_1', segment: 'changes', activeRootPath: '/repo', defaultRootPath: '/repo',
            routeParams: { initialFile: 'closed.ts', source: 'diff', anchor: 'range', startLine: '7', comparisonId: 'comparison-a' },
            initialResource: null });
        expect(Object.fromEntries(new URL(href, 'https://happier.test').searchParams)).toEqual({ worktreeId: '@root', comparisonId: 'comparison-a' });
    });
    it('replaces stale Details and initial resource intent while preserving qualified dashboard and companion state', () => {
        const href = buildProjectRouteHref({ workspaceRefId: 'wr_1', segment: 'changes', serverId: 'home-a',
            activeRootPath: '/repo/feature', defaultRootPath: '/repo', activeWorktreeId: 'feature-checkout',
            routeParams: { layoutId: 'named-dashboard', right: 'git', bottom: 'terminal', initialFile: 'old.ts', initialCommit: 'old-commit',
                details: 'file', path: 'old.ts', comparison: 'branch', head: 'old-head', base: 'old-base', comparisonId: 'old-comparison',
                anchor: 'range', startLine: '7' },
            details: { kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'files' } });
        expect(Object.fromEntries(new URL(href, 'https://happier.test').searchParams)).toEqual({ serverId: 'home-a',
            worktreeId: 'feature-checkout', layoutId: 'named-dashboard', right: 'git', bottom: 'terminal',
            details: 'scmReview', comparison: 'workingTree', view: 'files' });
    });
    it('opens the remembered canonical page with its Home and exact checkout on phone', () => {
        const href = resolveProjectOpenHref({ workspaceRef, deviceType: 'phone', cockpitEnabled: false,
            persistedMobileSurface: 'changes', persistedActiveRootPath: '/repo/feature', persistedWorktreeId: 'checkout-a' });
        const url = new URL(href, 'https://happier.test');
        expect(url.pathname).toBe('/projects/wr_1/changes');
        expect(Object.fromEntries(url.searchParams)).toEqual({ worktreeId: 'checkout-a', serverId: 'home-a' });
    });
    it('titles the selected checkout rather than the primary root', () => {
        expect(resolveProjectRouteHeaderTitle(workspaceRef, '/repo')).toBe('Project Alpha');
        expect(resolveProjectRouteHeaderTitle(workspaceRef, '/repo/feature')).toBe('Project Alpha · feature');
    });
});
