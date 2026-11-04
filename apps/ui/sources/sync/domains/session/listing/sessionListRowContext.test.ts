import { describe, expect, it } from 'vitest';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { resolveSessionListRowContext } from './sessionListRowContext';

const project = { serverId: 'home', projectKey: 'project' };
const refs = [
    { serverId: 'home', id: 'first', machineId: 'laptop', rootPath: '/repo', createdAtMs: 1, projectKey: 'project' },
    { serverId: 'home', id: 'other', machineId: 'devbox', rootPath: '/worktree', createdAtMs: 2, projectKey: 'project' },
];
const displays = buildProjectGroupDisplayIndex(refs);
const baseline = displays.get(projectGroupIdentityKey(project))?.baseline ?? null;
const facts = { serverId: 'home', project, machineId: 'laptop', workspaceId: 'first', path: '/repo', branch: 'main' };

describe('Session list row context', () => {
    it('names an admitted fallback outside its exact group without inventing an accepted Project or baseline', () => {
        const fallbackGroupKey = JSON.stringify(['home', 'laptop', '/repo']);
        const keyless = { ...facts, project: null, fallbackGroupKey };
        expect(resolveSessionListRowContext({ facts: keyless }).showProject).toBe(true);
        expect(resolveSessionListRowContext({ facts: keyless, groupFallbackKey: fallbackGroupKey }))
            .toMatchObject({ showProject: false, showCheckout: true });
        expect(resolveSessionListRowContext({ facts: keyless, parent: keyless }))
            .toMatchObject({ showProject: false, showCheckout: false });
        expect(resolveSessionListRowContext({ facts: keyless, parent: { ...keyless, fallbackGroupKey: 'different-exact-group' } }))
            .toMatchObject({ showProject: true, showCheckout: true });
        expect(resolveSessionListRowContext({ facts: keyless }).facts.project).toBeNull();
    });

    it('shows only the different checkout among baseline rows and never elects a reachable replacement', () => {
        const rows = Array.from({ length: 11 }, (_, index) => resolveSessionListRowContext({
            facts: index === 10 ? { ...facts, machineId: 'devbox', workspaceId: 'other', path: '/worktree', branch: 'feature' } : facts,
            groupProject: project, baseline,
        }));
        expect(rows.filter(row => row.showProject)).toHaveLength(0);
        expect(rows.filter(row => row.showCheckout)).toHaveLength(1);
        const reorderedBaseline = buildProjectGroupDisplayIndex([...refs].reverse()).get(projectGroupIdentityKey(project))?.baseline;
        expect(reorderedBaseline).toBe(baseline);
    });

    it('keeps unknown checkout context and full accessible facts when optional context is hidden', () => {
        const { branch: _branch, ...unknownBranch } = facts;
        const unknownCheckout = { ...unknownBranch, workspaceId: null, path: '/another-checkout' };
        const result = resolveSessionListRowContext({ facts: unknownCheckout, groupProject: project, baseline });
        expect(result.showCheckout).toBe(true);
        expect(result.facts).not.toHaveProperty('branch');
        const hidden = resolveSessionListRowContext({ facts: unknownCheckout, groupProject: project, baseline, enabled: false });
        expect(hidden).toMatchObject({ showProject: false, showCheckout: false });
        expect(hidden.facts).toBe(unknownCheckout);
    });

    it('shows Project outside its group and never hides a nested child’s different Project or checkout', () => {
        expect(resolveSessionListRowContext({ facts, baseline }).showProject).toBe(true);
        expect(resolveSessionListRowContext({ facts, parent: facts })).toMatchObject({ showProject: false, showCheckout: false });
        const other = { ...facts, project: { ...project, projectKey: 'other' }, machineId: 'devbox' };
        expect(resolveSessionListRowContext({ facts: other, parent: facts })).toMatchObject({ showProject: true, showCheckout: true });
        expect(resolveSessionListRowContext({ facts: { ...facts, branch: null }, baseline }).facts).toHaveProperty('branch', null);
        const keyless = { ...facts, project: null };
        expect(resolveSessionListRowContext({ facts: keyless, parent: keyless }).showCheckout).toBe(false);
        expect(resolveSessionListRowContext({ facts: keyless, parent: { ...keyless, serverId: 'another-home' } }))
            .toMatchObject({ showCheckout: true });
        expect(resolveSessionListRowContext({ facts, parent: { ...facts, project: { ...project, projectKey: 'different' } } }).showCheckout).toBe(true);
        expect(resolveSessionListRowContext({ facts: { ...keyless, workspaceId: null }, parent: { ...keyless, workspaceId: null } }).showCheckout).toBe(true);
    });

    it('derives every authored mark mode from the same implied Project and shared favicon fact', () => {
        const own = resolveSessionListRowContext({ facts, groupProject: project, baseline });
        expect(own.identity).toEqual({ leadingMark: 'agent', projectPlacement: 'none', showProjectName: false });
        const outside = (identityDisplay: 'auto' | 'agentLogo' | 'project' | 'projectWithAgent' | 'agentWithTrailingProject' | 'avatar' | 'none', hasProjectFavicon = true) =>
            resolveSessionListRowContext({ facts, baseline, identityDisplay, hasProjectFavicon }).identity;
        expect(outside('auto')).toEqual({ leadingMark: 'projectWithAgent', projectPlacement: 'none', showProjectName: false });
        expect(outside('agentLogo')).toEqual({ leadingMark: 'agent', projectPlacement: 'context', showProjectName: true });
        expect(outside('project')).toEqual({ leadingMark: 'project', projectPlacement: 'none', showProjectName: false });
        expect(outside('projectWithAgent')).toEqual({ leadingMark: 'projectWithAgent', projectPlacement: 'none', showProjectName: false });
        expect(outside('agentWithTrailingProject')).toEqual({ leadingMark: 'agent', projectPlacement: 'trailing', showProjectName: false });
        expect(outside('avatar')).toEqual({ leadingMark: 'avatar', projectPlacement: 'context', showProjectName: true });
        expect(outside('none')).toEqual({ leadingMark: 'none', projectPlacement: 'context', showProjectName: true });
        expect(outside('auto', false)).toEqual({ leadingMark: 'projectWithAgent', projectPlacement: 'context', showProjectName: true });
    });
});
