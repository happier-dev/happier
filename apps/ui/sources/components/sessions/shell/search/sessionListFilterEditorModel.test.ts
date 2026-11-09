import { describe, expect, it } from 'vitest';

import {
    buildSessionListFilterEditorModel,
    reduceSessionListFilterEditorSelection,
    resolveSessionListFilterEditorSelectionChange,
} from './sessionListFilterEditorModel';
import {
    buildQualifiedAudienceSelectionKey,
    buildSessionListFilterQueryHomes,
    createSessionListViewFilterDefaults,
} from './sessionListViewFilters';

const labels = {
    search: 'Search filters', show: 'Show', myWork: 'My work', assignedToMe: 'Assigned to me',
    scope: 'Scope', sessions: 'Sessions', runs: 'Runs', both: 'Both', startedBy: 'Started by',
    startedByYou: 'You', startedByTriggers: 'Triggers', startedByAgents: 'Agents',
    following: 'Following', involvingMe: 'Involving me', allAccessible: 'All accessible',
    attention: 'Attention', anyAttention: 'Any', needsMyAttention: 'Only sessions that need me',
    inactiveSessions: 'Inactive sessions', showInactive: 'Show', hideInactive: 'Hide', homes: 'Homes',
    sharedWith: 'Shared with', outsideTeams: 'Personal & direct', tags: 'Tags', source: 'Source',
    allSources: 'All', persistedSource: 'Saved in Happier', directSource: 'External', noOptions: 'No options',
    onlyCoordinators: 'Only coordinators', onlyCoordinatorsDescription: 'Sessions that manage others or follow by a rule',
    status: 'Status', statusWorking: 'Working', statusNeedsYou: 'Needs you', statusFailed: 'Failed',
    statusIdle: 'Idle', statusOffline: 'Offline', project: 'Project', projectIs: 'Is', projectIsNot: "Isn't",
} as const;

describe('sessionListFilterEditorModel', () => {
    it('narrows the pinned Team corpus to a chosen Group and restores it when cleared', () => {
        const team = { serverId: 'home-a', kind: 'team', teamId: 'team-a' } as const;
        const group = { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'group-1' } as const;
        const context = {
            fixedAudienceKeys: new Set([buildQualifiedAudienceSelectionKey(team)]),
        };
        const teamDefaults = createSessionListViewFilterDefaults({
            scope: 'all_accessible',
            homeServerIds: ['home-a'],
            audiences: [team],
        });
        const groupOptionId = `audience:${buildQualifiedAudienceSelectionKey(group)}`;

        const narrowed = reduceSessionListFilterEditorSelection(teamDefaults, groupOptionId, context);
        const queryHomes = buildSessionListFilterQueryHomes(narrowed, {
            storage: 'active',
            includeInactive: true,
            mountedHomeServerIds: ['home-a'],
        });

        // The wire contract drops a Group subsumed by its own Team, so selecting a
        // Group must replace the Team selector or the request never narrows.
        expect(queryHomes[0]?.query.audiences).toEqual([
            { kind: 'group', teamId: 'team-a', groupId: 'group-1' },
        ]);

        const restored = reduceSessionListFilterEditorSelection(narrowed, groupOptionId, context);
        expect(buildSessionListFilterQueryHomes(restored, {
            storage: 'active',
            includeInactive: true,
            mountedHomeServerIds: ['home-a'],
        })[0]?.query.audiences).toEqual([{ kind: 'team', teamId: 'team-a' }]);
    });

    it('builds one multiple-selection step with unavailable scopes disabled', () => {
        const model = buildSessionListFilterEditorModel({
            filters: createSessionListViewFilterDefaults({
                scope: 'assigned_to_me',
                homeServerIds: ['home-a'],
                tagIds: [{ serverId: 'home-a', tagId: 'urgent' }],
            }),
            includeInactive: false,
            labels,
            scopesAvailable: {
                my_work: true,
                assigned_to_me: true,
                following: false,
                involving_me: true,
                all_accessible: true,
            },
            homes: [{ serverId: 'home-a', label: 'Home A' }, { serverId: 'home-b', label: 'Home B' }],
            audiences: [],
            tags: [{ serverId: 'home-a', tagId: 'urgent', label: 'Urgent' }],
            sourceAvailable: true,
        });

        expect(model.selection.selectedIds.has('show:both')).toBe(true);
        expect(model.selection.selectedIds.has('started-by:you')).toBe(true);
        expect(model.selection.selectedIds.has('scope:assigned_to_me')).toBe(true);
        expect(model.selection.selectedIds.has('inactive:hide')).toBe(true);
        expect(model.selection.selectedIds.has('home:home-a')).toBe(true);
        expect(model.selection.selectedIds.has('tag:["home-a","urgent"]')).toBe(true);
        const show = model.rootStep.sections.find((section) => section.id === 'show');
        expect(show?.kind).toBe('static');
        if (show?.kind === 'static') {
            expect(show.options.find((option) => option.id === 'scope:following')?.disabled).toBe(true);
        }
    });

    it('offers Archived as a destination at the end of the scope choices, never as a selected facet', () => {
        const input = {
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            includeInactive: true,
            labels,
            scopesAvailable: {
                my_work: true,
                assigned_to_me: true,
                following: true,
                involving_me: true,
                all_accessible: true,
            },
            homes: [{ serverId: 'home-a', label: 'Home A' }],
            audiences: [],
            tags: [],
            sourceAvailable: false,
        } as const;
        const model = buildSessionListFilterEditorModel({ ...input, archivedLabel: 'Archived' });
        const show = model.rootStep.sections.find((section) => section.id === 'show');
        expect(show?.kind).toBe('static');
        if (show?.kind !== 'static') return;
        expect(show.options.at(-1)).toMatchObject({ id: 'destination:archived', label: 'Archived' });
        expect(model.selection.selectedIds.has('destination:archived')).toBe(false);
        // The archived corpus itself offers no way back into archived.
        const archivedCorpus = buildSessionListFilterEditorModel(input);
        const archivedShow = archivedCorpus.rootStep.sections.find((section) => section.id === 'show');
        expect(archivedShow?.kind === 'static' && archivedShow.options.some((option) => option.id === 'destination:archived')).toBe(false);
    });

    it('offers the Homes facet only when there is more than one Home to choose between', () => {
        const base = {
            includeInactive: true,
            labels,
            scopesAvailable: {
                my_work: true, assigned_to_me: true, following: true, involving_me: true, all_accessible: true,
            },
            audiences: [],
            tags: [],
            sourceAvailable: false,
        } as const;
        const single = buildSessionListFilterEditorModel({
            ...base,
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            homes: [{ serverId: 'home-a', label: 'Home A' }],
        });
        expect(single.rootStep.sections.some((section) => section.id === 'homes')).toBe(false);
        const two = buildSessionListFilterEditorModel({
            ...base,
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a', 'home-b'] }),
            homes: [{ serverId: 'home-a', label: 'Home A' }, { serverId: 'home-b', label: 'Home B' }],
        });
        expect(two.rootStep.sections.some((section) => section.id === 'homes')).toBe(true);
    });

    it('keeps Source choices enabled while omitting unavailable server-query scopes', () => {
        const model = buildSessionListFilterEditorModel({
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            includeInactive: true,
            labels,
            scopesAvailable: {
                my_work: false,
                assigned_to_me: false,
                following: false,
                involving_me: false,
                all_accessible: false,
            },
            homes: [{ serverId: 'home-a', label: 'Home A' }],
            audiences: [],
            tags: [],
            sourceAvailable: true,
        });

        const show = model.rootStep.sections.find((section) => section.id === 'show');
        const source = model.rootStep.sections.find((section) => section.id === 'source');
        expect(show).toBeUndefined();
        expect(source?.kind === 'static' ? source.options.map((option) => option.id) : []).toEqual([
            'source:all',
            'source:persisted',
            'source:direct',
        ]);
        expect(source?.kind === 'static' ? source.options.every((option) => option.disabled !== true) : false).toBe(true);
    });

    it('omits the attention facet when no selected Home can serve filtered listing', () => {
        const build = (attentionAvailable: boolean | undefined) => buildSessionListFilterEditorModel({
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            includeInactive: true,
            labels,
            scopesAvailable: {
                my_work: false,
                assigned_to_me: false,
                following: false,
                involving_me: false,
                all_accessible: false,
            },
            homes: [{ serverId: 'home-a', label: 'Home A' }],
            audiences: [],
            tags: [],
            sourceAvailable: true,
            ...(attentionAvailable === undefined ? {} : { attentionAvailable }),
        });

        expect(build(false).rootStep.sections.find((section) => section.id === 'attention')).toBeUndefined();
        expect(build(true).rootStep.sections.find((section) => section.id === 'attention')?.kind).toBe('static');
        expect(build(undefined).rootStep.sections.find((section) => section.id === 'attention')?.kind).toBe('static');
    });

    it('offers Only coordinators as a toggle where the Home answers filtered listing', () => {
        const build = (filters: ReturnType<typeof createSessionListViewFilterDefaults>, attentionAvailable: boolean) => buildSessionListFilterEditorModel({
            filters, includeInactive: true, labels,
            scopesAvailable: { my_work: true, assigned_to_me: true, following: true, involving_me: true, all_accessible: true },
            homes: [{ serverId: 'home-a', label: 'Home A' }], audiences: [], tags: [], sourceAvailable: true, attentionAvailable,
        });
        const defaults = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
        expect(build(defaults, false).rootStep.sections.find((section) => section.id === 'coordinator')).toBeUndefined();
        const section = build(defaults, true).rootStep.sections.find((candidate) => candidate.id === 'coordinator');
        expect(section?.kind === 'static' ? section.options.map((option) => option.id) : null).toEqual(['coordinator:only']);
        expect(build(defaults, true).selection.selectedIds.has('coordinator:only')).toBe(false);

        const on = reduceSessionListFilterEditorSelection(defaults, 'coordinator:only');
        expect(on.coordinator).toBe('coordinator');
        expect(build(on, true).selection.selectedIds.has('coordinator:only')).toBe(true);
        expect(reduceSessionListFilterEditorSelection(on, 'coordinator:only').coordinator).toBeUndefined();
    });

    it('applies radio facets and multi-select facets without changing unrelated state', () => {
        const initial = createSessionListViewFilterDefaults({
            scope: 'my_work',
            attention: 'any',
            homeServerIds: ['home-a', 'home-b'],
            audiences: [{ serverId: 'home-a', kind: 'outside_teams' }],
            tagIds: [{ serverId: 'home-a', tagId: 'urgent' }],
        });

        expect(reduceSessionListFilterEditorSelection(initial, 'scope:all_accessible')).toMatchObject({
            scope: 'all_accessible',
            homeServerIds: ['home-a', 'home-b'],
        });
        expect(reduceSessionListFilterEditorSelection(initial, 'home:home-a')).toMatchObject({
            homeServerIds: ['home-b'],
            audiences: [],
            tagIds: [],
        });
        expect(reduceSessionListFilterEditorSelection(initial, 'tag:["home-a","urgent"]')).toMatchObject({
            tagIds: [],
        });
        expect(reduceSessionListFilterEditorSelection(initial, 'tag:["home-b","later"]')).toMatchObject({
            tagIds: [
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-b', tagId: 'later' },
            ],
        });
    });

    it('maps inactive choices to the incumbent Account preference without creating filter state', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a'],
            searchQuery: 'kept',
        });

        expect(resolveSessionListFilterEditorSelectionChange(filters, false, 'inactive:show')).toEqual({
            filters,
            includeInactive: true,
        });
        expect(resolveSessionListFilterEditorSelectionChange(filters, true, 'inactive:hide')).toEqual({
            filters,
            includeInactive: false,
        });
    });

    it('omits the active-corpus inactive preference from archived filters', () => {
        const model = buildSessionListFilterEditorModel({
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            includeInactive: true,
            inactiveVisibilityAvailable: false,
            labels,
            scopesAvailable: {
                my_work: true,
                assigned_to_me: true,
                following: true,
                involving_me: true,
                all_accessible: true,
            },
            homes: [{ serverId: 'home-a', label: 'Home A' }],
            audiences: [],
            tags: [],
            sourceAvailable: true,
        });

        expect(model.rootStep.sections.some((section) => section.id === 'inactive')).toBe(false);
        expect([...model.selection.selectedIds].some((id) => id.startsWith('inactive:'))).toBe(false);
    });

    it('does not present semantic scope choices for a legacy owner/direct corpus', () => {
        const model = buildSessionListFilterEditorModel({
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            includeInactive: true,
            labels,
            scopesAvailable: {
                my_work: false,
                assigned_to_me: false,
                following: false,
                involving_me: false,
                all_accessible: false,
            },
            homes: [{ serverId: 'home-a', label: 'Home A' }],
            audiences: [],
            tags: [],
            sourceAvailable: false,
        });

        expect(model.rootStep.sections.some((section) => section.id === 'show')).toBe(false);
    });

    it('drills from each qualified Team into that Team selection and its qualified Groups', () => {
        const model = buildSessionListFilterEditorModel({
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a', 'home-b'] }),
            includeInactive: true,
            labels,
            scopesAvailable: {
                my_work: true,
                assigned_to_me: true,
                following: true,
                involving_me: true,
                all_accessible: true,
            },
            homes: [
                { serverId: 'home-a', label: 'Home A' },
                { serverId: 'home-b', label: 'Home B' },
            ],
            audiences: [
                { serverId: 'home-a', kind: 'outside_teams', label: 'Personal & direct · Home A' },
                { serverId: 'home-a', kind: 'team', teamId: 'team-a', label: 'Acme · Home A' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'group-a', label: 'Design' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-a', label: 'Acme · Home B' },
            ],
            audiencePresentation: 'team_drilldown',
            tags: [],
            sourceAvailable: false,
        });

        const section = model.rootStep.sections.find((candidate) => candidate.id === 'audiences');
        expect(section?.kind).toBe('static');
        if (section?.kind !== 'static') return;

        expect(section.options.map((option) => option.label)).toEqual([
            'Personal & direct · Home A',
            'Acme · Home A',
            'Acme · Home B',
        ]);
        const acmeHomeA = section.options[1];
        expect(acmeHomeA?.openStep?.sections[0]).toMatchObject({
            kind: 'static',
            options: [
                { id: 'audience:["home-a","team","team-a"]', label: 'Acme · Home A' },
                { id: 'audience:["home-a","group","team-a","group-a"]', label: 'Design' },
            ],
        });
        expect(section.options[2]?.openStep?.sections[0]).toMatchObject({
            kind: 'static',
            options: [{ id: 'audience:["home-b","team","team-a"]', label: 'Acme · Home B' }],
        });
    });

    describe('Project and status facets', () => {
        const scopesAvailable = { my_work: true, assigned_to_me: true, following: true, involving_me: true, all_accessible: true };
        const payments = { serverId: 'home-a', projectKey: 'payments' };
        const build = (filters: ReturnType<typeof createSessionListViewFilterDefaults>) => buildSessionListFilterEditorModel({
            filters, includeInactive: false, labels, scopesAvailable,
            homes: [{ serverId: 'home-a', label: 'Home A' }], audiences: [], tags: [], sourceAvailable: false,
            projects: [
                { ...payments, label: 'payments' },
                { serverId: 'home-a', projectKey: 'happier', label: 'happier' },
                { serverId: 'home-b', projectKey: 'elsewhere', label: 'elsewhere' },
            ],
        });
        const section = (model: ReturnType<typeof build>, id: string) => model.rootStep.sections.find((candidate) => candidate.id === id);

        it('builds "sessions in payments" from Project choices; Status is the shared editor\'s grouped field', () => {
            const defaults = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
            const model = build(defaults);
            const projects = section(model, 'projects');
            expect(section(model, 'status')).toBeUndefined();
            // Only the selected Homes' projects are choices.
            expect(projects?.kind === 'static' && projects.options.map((option) => option.label))
                .toEqual(['payments', 'happier']);

            const projectOption = projects?.kind === 'static' ? projects.options[0]!.id : '';
            const withProject = reduceSessionListFilterEditorSelection(defaults, projectOption);
            expect(withProject.projects).toEqual({ include: [payments], exclude: [] });
            expect(build(withProject).selection.selectedIds.has(projectOption)).toBe(true);
            expect(build(withProject).selection.selectedIds.has('project-mode:include')).toBe(true);

            // Toggling the same choice off leaves no empty facet behind.
            const cleared = reduceSessionListFilterEditorSelection(withProject, projectOption);
            expect(cleared.projects).toBeUndefined();
        });

        it('switches the chosen projects between Is and Isn\'t, and keeps an unknown retained project removable', () => {
            const defaults = createSessionListViewFilterDefaults({
                homeServerIds: ['home-a'],
                projects: { include: [payments, { serverId: 'home-a', projectKey: 'forgotten' }], exclude: [] },
            });
            const model = build(defaults);
            const projects = section(model, 'projects');
            const options = projects?.kind === 'static' ? projects.options : [];
            // A retained project that this Home no longer lists stays a selected, removable choice.
            const forgotten = options.find((option) => option.label === 'forgotten');
            expect(forgotten && model.selection.selectedIds.has(forgotten.id)).toBe(true);

            const excluded = reduceSessionListFilterEditorSelection(defaults, 'project-mode:exclude');
            expect(excluded.projects?.include).toEqual([]);
            expect(excluded.projects?.exclude.map((project) => project.projectKey)).toEqual(['payments', 'forgotten']);
            expect(build(excluded).selection.selectedIds.has('project-mode:exclude')).toBe(true);
            const removed = reduceSessionListFilterEditorSelection(excluded, forgotten!.id);
            expect(removed.projects?.exclude.map((project) => project.projectKey)).toEqual(['payments']);
        });

        it('offers no Session Project facts for Runs', () => {
            const model = build(createSessionListViewFilterDefaults({ homeServerIds: ['home-a'], show: 'runs' }));
            expect(section(model, 'projects')).toBeUndefined();
        });
    });
});
