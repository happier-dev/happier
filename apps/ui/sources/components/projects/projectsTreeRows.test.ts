import { describe, expect, it } from 'vitest';

import { buildProjectsTreeProjects, buildProjectsTreeRows, buildProjectsPhoneTreeRows, projectsTreeRowSubtitle, type ProjectsTreeCheckout, type ProjectsTreeProject } from './projectsTreeRows';

const checkout = (refId: string, machineId: string, label: string, extra: Partial<ProjectsTreeCheckout> = {}): ProjectsTreeCheckout => ({
    refId, machineId, machineName: machineId === 'devbox' ? 'devbox' : machineId === 'mbp' ? 'MacBook Pro' : machineId,
    label, path: `~/src/${label}`, attention: null, ...extra,
});
const project = (key: string, checkouts: ProjectsTreeCheckout[], teamLabel: string | null = null): ProjectsTreeProject => ({ key, name: key, teamLabel, checkouts });
const shape = (rows: ReturnType<typeof buildProjectsTreeRows>) => rows.map((row) => `${'  '.repeat(row.level)}${row.title}${row.titleQualifier ? ` (${row.titleQualifier})` : ''}${row.expandable ? (row.expanded ? ' v' : ' >') : ''}`);

describe('buildProjectsTreeRows (lab p-projects RULES)', () => {
    it('joins authorized Source and exact-checkout facts without changing checkout order or addresses', () => {
        const refs = [
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/first', source: { sourceId: 'source-a', revision: 1 } },
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/second', source: { sourceId: 'source-a', revision: 1 } },
        ];
        const projects = buildProjectsTreeProjects({
            groups: [{ projectKey: { projectKey: 'anchor' }, items: refs }],
            projectName: () => 'first', machine: () => null,
            sources: [{ id: 'source-a', name: 'Repository', audience: [{ principal: { kind: 'team', teamId: 'team-a' }, level: 'view' }] }],
            teamName: (teamId: string) => teamId === 'team-a' ? 'Acme' : null,
            checkoutFacts: (ref: typeof refs[number]) => ref.rootPath === '/work/first'
                ? { branch: 'main', isWorktree: false, attention: 'working' as const, newFromSession: false }
                : { branch: 'fix-modal', isWorktree: true, attention: 'needs-you' as const, newFromSession: true },
        });
        expect(projects[0]).toMatchObject({ name: 'Repository', teamLabel: 'Acme', newFromSession: true });
        expect(projects[0]?.checkouts.map(row => [row.refId, row.label, row.branch, row.isWorktree, row.attention]))
            .toEqual([['same-id', 'main', 'main', false, 'working'], ['same-id', 'fix-modal', 'fix-modal', true, 'needs-you']]);
        for (const rows of [
            buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set() }),
            buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(), describe: {
                checkoutCount: String, machineCount: String, offlineCount: String,
            } }),
        ]) expect(rows[0]).toMatchObject({ attention: 'needs-you', newFromSession: true });
        expect(projects[0]?.checkouts.map(row => row.workspaceAddress?.rootPath)).toEqual(['/work/first', '/work/second']);
    });

    it('leads a not-yet-viewed Project\'s second line with where it came from, in the column and on the phone', () => {
        const projects = [{ ...project('pricing', [checkout('n1', 'mbp', 'main')]), newFromSession: true }, project('web', [checkout('w1', 'mbp', 'main')])];
        for (const rows of [
            buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set() }),
            buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(), describe: {
                checkoutCount: String, machineCount: String, offlineCount: String,
            } }),
        ]) {
            expect(projectsTreeRowSubtitle(rows[0]!, 'New from your session')).toBe('New from your session · MacBook Pro · main');
            expect(projectsTreeRowSubtitle(rows[1]!, 'New from your session')).toBe('MacBook Pro · main');
        }
    });

    it('keeps unknown branch, worktree, machine presence and Team facts unknown instead of inventing them', () => {
        const ref = { id: 'ref', serverId: 'home-a', machineId: 'unknown-machine', rootPath: '/work/folder',
            source: { sourceId: 'revoked-source', revision: 1 } };
        const projects = buildProjectsTreeProjects({ groups: [{ projectKey: { projectKey: 'anchor' }, items: [ref] }],
            projectName: () => 'folder', machine: () => null, sources: [], teamName: () => 'Acme' });
        expect(projects[0]).toMatchObject({ name: 'folder', teamLabel: null, newFromSession: false });
        expect(projects[0]?.checkouts[0]).toMatchObject({ label: 'folder', branch: null, isWorktree: null, attention: null });
        expect(projects[0]?.checkouts[0]?.offline).toBeUndefined();
    });

    it('retains exact addresses and distinct row keys when two checkouts share an id', () => {
        const refs = [
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/first' },
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/second' },
        ];
        const projects = buildProjectsTreeProjects({ groups: [{ projectKey: { projectKey: 'anchor' }, items: refs }],
            projectName: () => 'Project', machine: () => null });
        for (const rows of [buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set(['anchor']) }),
            buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(['anchor']), describe: {
                checkoutCount: String, machineCount: String, offlineCount: String,
            } })]) {
            const leaves = rows.filter(row => row.refId);
            expect(new Set(leaves.map(row => row.key)).size).toBe(2);
            expect(leaves.map(row => row.workspaceAddress)).toEqual(refs.map(ref => ({
                serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath,
            })));
        }
    });
    it('draws one checkout as one row, never a disclosure, opening that exact checkout', () => {
        const rows = buildProjectsTreeRows({ projects: [project('website', [checkout('w1', 'mbp', 'main')])], openRefId: null, expandedKeys: new Set() });
        expect(shape(rows)).toEqual(['website']);
        expect(rows[0]).toMatchObject({ expandable: false, refId: 'w1', subtitle: 'MacBook Pro · main' });
    });

    it('folds one machine into the Project row and lists its worktrees under it', () => {
        const rows = buildProjectsTreeRows({
            projects: [project('happier-plugins', [checkout('p1', 'devbox', 'main'), checkout('p2', 'devbox', 'pi-agent')])],
            openRefId: 'p2', expandedKeys: new Set(),
        });
        expect(shape(rows)).toEqual(['happier-plugins (devbox) v', '  main', '  pi-agent']);
        // Only the open checkout shows where it lives.
        expect(rows.map((row) => row.subtitle ?? null)).toEqual([null, null, '~/src/pi-agent']);
    });

    it('makes machines the leaves when each holds one checkout, carrying their branch', () => {
        const rows = buildProjectsTreeRows({
            projects: [project('infra', [checkout('i1', 'build-01', 'main'), checkout('i2', 'studio', 'terraform-1.9', { offline: true })], 'Acme')],
            openRefId: null, expandedKeys: new Set(['infra']),
        });
        expect(shape(rows)).toEqual(['infra (Acme) v', '  build-01 (main)', '  studio (terraform-1.9)']);
        expect(rows[2]).toMatchObject({ glyph: 'machine', offline: true, refId: 'i2' });
    });

    it('keeps the full Project → machine → worktree tree and rolls status up when collapsed', () => {
        const projects = [project('happier', [
            checkout('h1', 'devbox', 'fix-settings-modal', { attention: 'working' }),
            checkout('h2', 'devbox', 'v0.3'),
            checkout('h3', 'mbp', 'v0.3', { attention: 'needs-you' }),
            checkout('h4', 'mbp', 'review-2481'),
        ], 'Acme')];
        const open = buildProjectsTreeRows({ projects, openRefId: 'h1', expandedKeys: new Set() });
        expect(shape(open)).toEqual(['happier (Acme) v', '  devbox v', '    fix-settings-modal', '    v0.3', '  MacBook Pro >']);
        expect(open[4]).toMatchObject({ count: 2, attention: 'needs-you' });

        const collapsed = buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set() });
        expect(shape(collapsed)).toEqual(['happier (Acme) >']);
        // Needs you outranks working.
        expect(collapsed[0]).toMatchObject({ count: 4, attention: 'needs-you' });

        // A parent the person closed stays closed even while it holds the open checkout.
        expect(shape(buildProjectsTreeRows({ projects, openRefId: 'h1', expandedKeys: new Set(), collapsedKeys: new Set(['happier']) })))
            .toEqual(['happier (Acme) >']);
    });
});
