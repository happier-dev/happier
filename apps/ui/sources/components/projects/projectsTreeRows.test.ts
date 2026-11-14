import { describe, expect, it } from 'vitest';

import { buildProjectsTreeProjects, buildProjectsTreeRows, buildProjectsPhoneTreeRows, projectsTreeRowOpenTarget, projectsTreeRowSubtitle, type ProjectsTreeCheckout, type ProjectsTreeProject } from './projectsTreeRows';

const checkout = (refId: string, machineId: string, label: string, extra: Partial<ProjectsTreeCheckout> = {}): ProjectsTreeCheckout => ({
    refId, machineId, machineName: machineId === 'devbox' ? 'devbox' : machineId === 'mbp' ? 'MacBook Pro' : machineId,
    label, branch: label, path: `~/src/${label}`, attention: null, ...extra,
});
const project = (key: string, checkouts: ProjectsTreeCheckout[], teamLabel: string | null = null): ProjectsTreeProject => ({ key, name: key, teamLabel, checkouts });
const shape = (rows: ReturnType<typeof buildProjectsTreeRows>) => rows.map((row) => `${'  '.repeat(row.level)}${row.title}${row.titleQualifier ? ` (${row.titleQualifier})` : ''}${row.expandable ? (row.expanded ? ' v' : ' >') : ''}`);

describe('buildProjectsTreeRows (lab p-projects RULES)', () => {
    it('names every checkout by one rule and tells same-branch siblings apart by folder (QA-PROJECTS D19)', async () => {
        const { applyProjectsTreeCheckoutFacts, labelProjectCheckouts } = await import('./projectsTreeRows');
        const folders = project('anchor', [checkout('a', 'devbox', 'happier'), checkout('b', 'devbox', 'happier-wt'), checkout('c', 'devbox', 'docs')]);
        const facts = { a: 'main', b: 'main', c: null } as Record<string, string | null>;
        const applied = applyProjectsTreeCheckoutFacts(folders, item => ({ branch: facts[item.refId] ?? null, isWorktree: null, attention: null, newFromSession: false }));
        expect(applied.checkouts.map(item => item.label)).toEqual(['main · happier', 'main · happier-wt', 'docs']);
        // The Checkouts widget's rows read the same rule: a worktree is named by its folder, never its absolute path.
        expect(labelProjectCheckouts([{ branch: 'v0.3', folder: '0.3' }, { branch: null, folder: '0.3-uiref-a2-cold-basis' }]))
            .toEqual(['v0.3', '0.3-uiref-a2-cold-basis']);
    });
    it('retains 150 unchanged Project inputs and replaces only the Project whose Machine facts changed', () => {
        const groups = Array.from({ length: 150 }, (_, index) => ({ projectKey: { projectKey: `project-${index}` },
            items: [{ id: `ref-${index}`, serverId: 'home-a', machineId: `machine-${index}`, rootPath: `/repo-${index}` }],
        }));
        const input = { groups, projectName: (ref: typeof groups[number]['items'][number]) => ref.id,
            machine: (id: string) => ({ name: id, homeDir: null, online: true }),
        };
        const before = buildProjectsTreeProjects(input);
        expect(buildProjectsTreeProjects({ ...input, previousProjects: before })).toBe(before);
        const after = buildProjectsTreeProjects({ ...input, previousProjects: before,
            machine: id => ({ name: id === 'machine-27' ? 'Renamed Machine' : id, homeDir: null, online: true }),
        });
        expect(after.filter((project, index) => project !== before[index]).map(project => project.key)).toEqual(['project-27']);
        expect(after[27]?.checkouts[0]?.machineName).toBe('Renamed Machine');
        const reordered = buildProjectsTreeProjects({ ...input, groups: [...groups].reverse(), previousProjects: before });
        expect(reordered[0]).toBe(before[149]);
        expect(reordered[149]).toBe(before[0]);
    });

    it('joins authorized Source and exact-checkout facts without changing checkout order or addresses', () => {
        const refs = [
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/first', source: { sourceId: 'source-a', revision: 1 } },
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/second', source: { sourceId: 'source-a', revision: 1 } },
        ];
        const projects = buildProjectsTreeProjects({
            groups: [{ projectKey: { projectKey: 'anchor' }, items: refs }],
            projectName: () => 'first', machine: () => ({ name: 'devbox', homeDir: null, online: null }),
            sources: [{ id: 'source-a', revision: 1, createdByAccountId: 'owner', name: 'Repository', audience: [{ principal: { kind: 'team', teamId: 'team-a' }, level: 'view' }] }],
            teamName: (teamId: string) => teamId === 'team-a' ? 'Acme' : null,
            checkoutFacts: (ref: typeof refs[number]) => ref.rootPath === '/work/first'
                ? { branch: 'main', isWorktree: false, attention: 'working' as const, newFromSession: false }
                : { branch: 'fix-modal', isWorktree: true, attention: 'needs-you' as const, newFromSession: true },
        });
        expect(projects[0]).toMatchObject({ name: 'Repository', teamLabel: 'Acme', newFromSession: true });
        expect(projects[0]).toHaveProperty('source', { serverId: 'home-a', source: {
            id: 'source-a', revision: 1, createdByAccountId: 'owner', name: 'Repository',
            audience: [{ principal: { kind: 'team', teamId: 'team-a' }, level: 'view' }],
        } });
        expect(projects[0]?.checkouts.map(row => [row.refId, row.label, row.branch, row.isWorktree, row.attention]))
            .toEqual([['same-id', 'main', 'main', false, 'working'], ['same-id', 'fix-modal', 'fix-modal', true, 'needs-you']]);
        for (const rows of [
            buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set() }),
            buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(), describe: {
                checkoutCount: String, machineCount: String, offlineCount: String,
            } }),
        ]) {
            expect(rows[0]).toMatchObject({ attention: 'needs-you', newFromSession: true });
            expect(rows[0]).toHaveProperty('source', projects[0]!.source);
        }
        expect(projects[0]?.checkouts.map(row => row.workspaceAddress?.rootPath)).toEqual(['/work/first', '/work/second']);
        const common = { groups: [{ projectKey: { projectKey: 'anchor' }, items: refs }],
            projectName: () => 'first', machine: () => ({ name: 'devbox', homeDir: null, online: null }) };
        const retained = buildProjectsTreeProjects({ ...common, sources: [projects[0]!.source!.source] });
        expect(buildProjectsTreeProjects({ ...common, sources: [projects[0]!.source!.source], previousProjects: retained })).toBe(retained);
        expect(buildProjectsTreeProjects({ ...common, sources: [], previousProjects: retained })[0]?.source).toBeUndefined();
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
            projectName: () => 'folder', machine: () => ({ name: 'devbox', homeDir: null, online: null }), sources: [], teamName: () => 'Acme' });
        expect(projects[0]).toMatchObject({ name: 'folder', teamLabel: null, newFromSession: false });
        expect(projects[0]?.checkouts[0]).toMatchObject({ label: 'folder', branch: null, isWorktree: null, attention: null });
        expect(projects[0]?.checkouts[0]?.offline).toBeUndefined();
    });

    it('says a collapsed phone Project\'s checkout count once, in its second line, and counts beside it only when open', () => {
        // Lab p-projects TREEp: "happier-plugins / devbox · 2 worktrees" with no count; the open "happier" carries "5".
        const projects = [project('plugins', [checkout('p1', 'devbox', 'main'), checkout('p2', 'devbox', 'pi-agent')])];
        const describe = { checkoutCount: (n: number) => `${n} worktrees`, machineCount: String, offlineCount: String };
        const collapsed = buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(), describe });
        expect(collapsed[0]).toMatchObject({ subtitle: 'devbox · 2 worktrees', count: null });
        const open = buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(['plugins']), describe });
        expect(open[0]).toMatchObject({ count: 2 });
    });

    it('retains exact addresses and distinct row keys when two checkouts share an id', () => {
        const refs = [
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/first' },
            { id: 'same-id', serverId: 'home-a', machineId: 'devbox', rootPath: '/work/second' },
        ];
        const projects = buildProjectsTreeProjects({ groups: [{ projectKey: { projectKey: 'anchor' }, items: refs }],
            projectName: () => 'Project', machine: () => ({ name: 'devbox', homeDir: null, online: null }) });
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

    it('says where a checkout with no known branch lives instead of repeating its folder name', () => {
        // Lab p-projects RULES 6: "scratch / MacBook Pro · ~/scratch"; never "scratch / MacBook Pro · scratch".
        const scratch = checkout('s1', 'mbp', 'scratch', { branch: null, path: '~/scratch' });
        expect(buildProjectsTreeRows({ projects: [project('scratch', [scratch])], openRefId: null, expandedKeys: new Set() })[0]?.subtitle)
            .toBe('MacBook Pro · ~/scratch');
        expect(buildProjectsPhoneTreeRows({ projects: [project('scratch', [scratch])], openRefId: null, expandedKeys: new Set(),
            describe: { checkoutCount: String, machineCount: String, offlineCount: String } })[0]?.subtitle)
            .toBe('MacBook Pro · ~/scratch');
    });

    it('folds one machine into the Project row and lists its worktrees under it', () => {
        const rows = buildProjectsTreeRows({
            projects: [project('happier-plugins', [checkout('p1', 'devbox', 'main'), checkout('p2', 'devbox', 'pi-agent')])],
            openRefId: 'p2', expandedKeys: new Set(),
        });
        expect(shape(rows)).toEqual(['happier-plugins (devbox) v', '  main', '  pi-agent']);
        // Every checkout reads like a one-checkout Project: what it is, then where it lives (owner 11-08).
        expect(rows.map((row) => row.subtitle ?? null)).toEqual([null, 'devbox · ~/src/main', 'devbox · ~/src/pi-agent']);
    });

    it('opens a Project with several checkouts from its own row, on the checkout opened most recently', () => {
        const refs = [
            { id: 'a', serverId: 'home', machineId: 'devbox', rootPath: '/src/a', lastOpenedAtMs: 10 },
            { id: 'b', serverId: 'home', machineId: 'mbp', rootPath: '/src/b', lastOpenedAtMs: 30 },
            { id: 'c', serverId: 'home', machineId: 'mbp', rootPath: '/src/c', lastOpenedAtMs: null },
        ];
        const projects = buildProjectsTreeProjects({ groups: [{ projectKey: { projectKey: 'anchor' }, items: refs }],
            projectName: () => 'Project', machine: (id) => ({ name: id, homeDir: null, online: true }) });
        const target = { refId: 'b', workspaceAddress: { serverId: 'home', workspaceId: 'b', machineId: 'mbp', rootPath: '/src/b' } };
        for (const rows of [buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set() }),
            buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(), describe: {
                checkoutCount: String, machineCount: String, offlineCount: String,
            } })]) {
            expect(rows[0]).toMatchObject({ kind: 'project', expandable: true });
            expect(projectsTreeRowOpenTarget(rows[0]!)).toEqual(target);
        }
        // On the phone, too, a checkout reads like a one-checkout Project: its label, then "Machine · path".
        const phone = buildProjectsPhoneTreeRows({ projects, openRefId: null, expandedKeys: new Set(['anchor']), describe: {
            checkoutCount: String, machineCount: String, offlineCount: String,
        } });
        expect(phone.slice(1).map(row => [row.title, row.titleQualifier ?? null, row.subtitle]))
            .toEqual([['a', null, 'devbox · /src/a'], ['b', null, 'mbp · /src/b'], ['c', null, 'mbp · /src/c']]);
        // A leaf still opens its own exact checkout.
        const open = buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set(['anchor', 'anchor/mbp']) });
        expect(open.filter(row => row.kind === 'checkout').map(row => projectsTreeRowOpenTarget(row)?.refId)).toEqual(['a', 'b', 'c']);
    });

    it('lists one checkout per machine as checkouts that name their machine and folder', () => {
        const rows = buildProjectsTreeRows({
            projects: [project('infra', [checkout('i1', 'build-01', 'main'), checkout('i2', 'studio', 'terraform-1.9', { offline: true })], 'Acme')],
            openRefId: null, expandedKeys: new Set(['infra']),
        });
        expect(shape(rows)).toEqual(['infra (Acme) v', '  main', '  terraform-1.9']);
        expect(rows.slice(1).map(row => row.subtitle)).toEqual(['build-01 · ~/src/main', 'studio · ~/src/terraform-1.9']);
        expect(rows[2]).toMatchObject({ offline: true, refId: 'i2' });
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
        // Under its machine a checkout says only where it lives there.
        expect(open[2]?.subtitle).toBe('~/src/fix-settings-modal');

        const collapsed = buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set() });
        expect(shape(collapsed)).toEqual(['happier (Acme) >']);
        // Needs you outranks working.
        expect(collapsed[0]).toMatchObject({ count: 4, attention: 'needs-you' });

        // A parent the person closed stays closed even while it holds the open checkout.
        expect(shape(buildProjectsTreeRows({ projects, openRefId: 'h1', expandedKeys: new Set(), collapsedKeys: new Set(['happier']) })))
            .toEqual(['happier (Acme) >']);
    });
});

describe('filterProjectsTreeByQuery (the Projects main screen search)', () => {
    it('keeps a Project whose name, Team, Machine or checkout matches, case-insensitively, and returns the same list for an empty query', async () => {
        const { filterProjectsTreeByQuery } = await import('./projectsTreeRows');
        const projects = [
            project('happier', [checkout('h1', 'devbox', 'main')], 'Acme'),
            project('docs', [checkout('d1', 'mbp', 'gh-pages')]),
            project('site', [checkout('s1', 'devbox', 'release')]),
        ];
        expect(filterProjectsTreeByQuery(projects, '  ')).toBe(projects);
        expect(filterProjectsTreeByQuery(projects, 'DOC').map(item => item.key)).toEqual(['docs']);
        expect(filterProjectsTreeByQuery(projects, 'acme').map(item => item.key)).toEqual(['happier']);
        expect(filterProjectsTreeByQuery(projects, 'macbook').map(item => item.key)).toEqual(['docs']);
        expect(filterProjectsTreeByQuery(projects, 'release').map(item => item.key)).toEqual(['site']);
        expect(filterProjectsTreeByQuery(projects, 'nothing')).toEqual([]);
    });
});
