import { describe, expect, it } from 'vitest';

import { ScopeActionInputSchemas } from '../../actions/scopeActionFamily.js';
import { SESSION_LIST_PAGE_MAX_LIMIT } from '../listing/query.js';
import { projectSessionListFilterAfterHomeQueryV1, projectSessionListFilterHomeQueriesV1 } from './sessionListFilterQueryV1.js';
import { canSessionListFilterIncludeRunsV1, matchSessionBotFilterV1, matchSessionProjectFilterV1, matchSessionListFilterV1, normalizeSessionListFilterV1, readSessionListStartedByV1, SessionListFilterV1Schema } from './sessionListFilterV1.js';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { listSessionPresentationStatesForWorkStatusFilterV1 } from '../awareness/presentationV1.js';

const CODEX_TARGET = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });

describe('SessionListFilterV1', () => {
    it('applies complete existing Work choices to canonical Run presentation without rewriting raw state selections', () => {
        const base = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        const run = { serverId: 'home', kind: 'run' as const, startedBy: 'you' as const, status: 'running' as const };
        const working = { ...base, statuses: listSessionPresentationStatesForWorkStatusFilterV1('working') };
        expect(matchSessionListFilterV1(working, { ...run, workStatus: { bucket: 'working', tone: 'neutral' } })).toBe('match');
        expect(matchSessionListFilterV1(working, run)).toBe('unavailable');
        expect(matchSessionListFilterV1({ ...base, statuses: ['thinking'] },
            { ...run, workStatus: { bucket: 'working', tone: 'neutral' } })).toBe('miss');
        const needsYou = listSessionPresentationStatesForWorkStatusFilterV1('needs_you');
        expect(matchSessionListFilterV1({ ...base, statuses: needsYou },
            { ...run, workStatus: { bucket: 'needs_you', tone: 'attention' } })).toBe('match');
        expect(matchSessionListFilterV1({ ...base, excludedStatuses: needsYou },
            { ...run, workStatus: { bucket: 'needs_you', tone: 'attention' } })).toBe('miss');
        expect(matchSessionListFilterV1({ ...base, statuses: ['failed'] },
            { ...run, status: 'dispatch_failed', workStatus: { bucket: 'finished', tone: 'neutral' } })).toBe('match');
    });
    it('matches canonical Session and Run presentation states without treating Status as Session-only', () => {
        const base = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        const failing = SessionListFilterV1Schema.parse({ ...base, statuses: ['failed'] });
        const run = { serverId: 'home', kind: 'run' as const, startedBy: 'you' as const };
        expect(canSessionListFilterIncludeRunsV1(failing)).toBe(true);
        expect(matchSessionListFilterV1(failing, { ...run, status: 'failed' })).toBe('match');
        expect(matchSessionListFilterV1(failing, run)).toBe('unavailable');
        const running = SessionListFilterV1Schema.parse({ ...base, statuses: ['running', 'stopping'] });
        expect(matchSessionListFilterV1(running, { ...run, status: 'running' })).toBe('match');
        expect(matchSessionListFilterV1(running, { ...run, status: 'stopping' })).toBe('match');
        expect(matchSessionListFilterV1(running, { ...run, status: 'disconnected' })).toBe('miss');
        const excluded = SessionListFilterV1Schema.parse({ ...base, excludedStatuses: ['failed'] });
        expect(matchSessionListFilterV1(excluded, { ...run, status: 'failed' })).toBe('miss');
        expect(matchSessionListFilterV1(excluded, run)).toBe('unavailable');
        expect(SessionListFilterV1Schema.safeParse({ ...base, statuses: ['invented_state'] }).success).toBe(false);
    });
    it('does not turn an explicit empty Home selection into a structural-query proof', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: [], scope: 'all_accessible', startedBy: ['you'] });
        const local = projectSessionListFilterAfterHomeQueryV1(filter, 'home');
        expect(local.homeServerIds).toEqual([]);
        expect(matchSessionListFilterV1(local, { serverId: 'home', kind: 'session', startedBy: 'you' })).toBe('miss');
    });
    it('admits canonical qualified Agent targets, not display names or unqualified routing ids', () => {
        const base = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        for (const target of [CODEX_TARGET, buildBackendTargetKeyV2({ kind: 'agent',
            identity: { pluginId: 'acme.assistant', localId: 'assistant' } })]) {
            const filter = SessionListFilterV1Schema.parse({ ...base, agents: { include: [target], exclude: [] } });
            expect(matchSessionListFilterV1(filter, { serverId: 'home', kind: 'session', startedBy: 'you', agent: target })).toBe('match');
        }
        for (const target of ['Codex display name', 'codex', 'backend:codex', 'agent:unqualified']) {
            expect(SessionListFilterV1Schema.safeParse({ ...base, agents: { include: [], exclude: [target] } }).success).toBe(false);
        }
    });
    it('projects qualified positive Sections before paging and removes only explicit query proof locally', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['a', 'b', 'c'], scope: 'all_accessible',
            sections: { include: [{ serverId: 'a', sectionId: 'one' }, { serverId: 'b', sectionId: 'two' }],
                exclude: [{ serverId: 'a', sectionId: 'private' }] }, includeInactive: false });
        const queries = projectSessionListFilterHomeQueriesV1(filter, { storage: 'active', includeInactive: true,
            mountedHomeServerIds: ['a', 'b', 'c'] });
        expect(queries.map(({ serverId, query }) => [serverId, query.folderIds, query.includeInactive])).toEqual([
            ['a', ['one'], false], ['b', ['two'], false],
        ]);
        expect(projectSessionListFilterAfterHomeQueryV1(filter, 'a').sections).toEqual(filter.sections);
        expect(projectSessionListFilterAfterHomeQueryV1(filter, 'a', { folderIds: ['one'] }).sections).toEqual({
            include: [], exclude: [{ serverId: 'a', sectionId: 'private' }],
        });
        expect(projectSessionListFilterAfterHomeQueryV1(filter, 'a', { folderIds: ['different'] }).sections).toEqual(filter.sections);
    });
    it('matches qualified local selections with unknown exclusions kept unavailable', () => {
        const filter = SessionListFilterV1Schema.parse({ ...normalizeSessionListFilterV1({
            homeServerIds: ['home-a'], scope: 'all_accessible',
        }), machines: { include: [{ serverId: 'home-a', machineId: 'm' }], exclude: [] },
        owners: { include: [{ serverId: 'home-a', accountId: 'a' }], exclude: [] },
        sections: { include: [], exclude: [{ serverId: 'home-a', sectionId: 'private' }] },
        agents: { include: [CODEX_TARGET], exclude: [] }, updated: { op: 'between', fromMs: 10, toMs: 20 } });
        const facts = { serverId: 'home-a', kind: 'session' as const, startedBy: 'you' as const,
            machine: { serverId: 'home-a', machineId: 'm' }, owner: { serverId: 'home-a', accountId: 'a' },
            agent: CODEX_TARGET, updatedAt: 10 };
        expect(matchSessionListFilterV1(filter, facts)).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, section: null })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, section: { serverId: 'home-a', sectionId: 'private' } })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, machine: { serverId: 'home-b', machineId: 'm' } })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, updatedAt: 21 })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, kind: 'run' })).toBe('miss');
        const excludedOtherHome = normalizeSessionListFilterV1({ homeServerIds: ['home-a'], scope: 'all_accessible',
            machines: { include: [], exclude: [{ serverId: 'home-b', machineId: 'm' }] } });
        expect(matchSessionListFilterV1(excludedOtherHome, { serverId: 'home-a', kind: 'session', startedBy: 'you' })).toBe('match');
    });

    it('keeps Branch list-only, distinguishes empty from unavailable, and validates absolute ranges', () => {
        const filter = SessionListFilterV1Schema.parse({ ...normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }),
            branches: { include: [], exclude: ['main'] } });
        const facts = { serverId: 'home', kind: 'session' as const, startedBy: 'you' as const };
        expect(matchSessionListFilterV1(filter, facts)).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, branch: null })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, branch: 'main' })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, branch: 'feature' }, 'daemonRule')).toBe('unavailable');
        for (const updated of [{ op: 'between', fromMs: 20, toMs: 10 }, { op: 'before', atMs: 1.5 }, { op: 'after', atMs: Infinity }]) {
            expect(SessionListFilterV1Schema.safeParse({ ...filter, updated }).success).toBe(false);
        }
    });
    it('qualifies accepted Project preselection by Home while retaining canonical local evaluation for unpublished identities', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['a', 'b', 'c'], scope: 'all_accessible', projects: {
            include: [{ serverId: 'a', projectKey: 'payments' }, { serverId: 'b', projectKey: 'other' }],
            exclude: [{ serverId: 'a', projectKey: 'excluded' }],
        } });
        const options = { storage: 'active' as const, includeInactive: true, mountedHomeServerIds: ['a', 'b', 'c'] };
        const queries = projectSessionListFilterHomeQueriesV1(filter, { ...options, projectFacet: 'query' });
        expect(queries.map(({ serverId, query }) => [serverId, query.projectKeys])).toEqual([
            ['a', { include: ['payments'], exclude: ['excluded'] }], ['b', { include: ['other'], exclude: [] }],
        ]);
        expect(projectSessionListFilterAfterHomeQueryV1(filter, 'a').projects).toEqual(filter.projects);
        expect(projectSessionListFilterHomeQueriesV1(filter, options).every(({ query }) => !('projectKeys' in query))).toBe(true);
    });

    it('lets exhaustive previews omit attention promotion while preserving the structural corpus and transport page bound', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
            projects: { include: [{ serverId: 'home', projectKey: 'private-project' }], exclude: [] } });
        const options = { storage: 'active' as const, includeInactive: true, mountedHomeServerIds: ['home'],
            limit: SESSION_LIST_PAGE_MAX_LIMIT, includeAttention: false };
        const [preview] = projectSessionListFilterHomeQueriesV1(filter, options);
        expect(preview?.query).toEqual({ v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible',
            attention: 'any', audiences: [], tagIds: [], includeAttention: false, limit: SESSION_LIST_PAGE_MAX_LIMIT });
        expect(projectSessionListFilterHomeQueriesV1(filter, { ...options, includeAttention: undefined })[0]?.query.includeAttention).toBe(true);
    });
    it('never uses list attention promotion as proof that a Run matches the selected starter', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], startedBy: ['you'] });
        expect(matchSessionListFilterV1(filter, { serverId: 'home', kind: 'run', startedBy: 'triggers', attentionRequired: true })).toBe('miss');
        expect(matchSessionListFilterV1({ ...filter, startedBy: [] }, { serverId: 'home', kind: 'run', startedBy: 'you', attentionRequired: true })).toBe('miss');
        expect(matchSessionListFilterV1({ ...filter, startedBy: ['you', 'you', 'you'] },
            { serverId: 'home', kind: 'run', startedBy: 'triggers', attentionRequired: false })).toBe('miss');
    });
    it('serializes Only coordinators and distinguishes positive, ordinary and unavailable relation facts', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], coordinator: 'coordinator' });
        expect(filter).toHaveProperty('coordinator', 'coordinator');
        expect(SessionListFilterV1Schema.parse(JSON.parse(JSON.stringify(filter)))).toEqual(filter);
        expect(ScopeActionInputSchemas['session.list.view.set'].parse({ filters: { coordinator: 'coordinator' } }).filters).toEqual({ coordinator: 'coordinator' });
        const facts = { serverId: 'home', kind: 'session' as const, startedBy: 'you' as const };
        expect(matchSessionListFilterV1(filter, facts)).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, managedSessions: { total: 1 } })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, receivedRuleCount: 1 })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, managedSessions: { total: 0 }, receivedRuleCount: 0 })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, managedSessions: { total: 0 } })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, kind: 'run', receivedRuleCount: 1 })).toBe('miss');
    });
    it('proves Started by me only with immutable none origin and the same owner Account', () => {
        expect(readSessionListStartedByV1({ origin: { kind: 'none' }, ownerAccountId: 'me', viewerAccountId: 'me' })).toBe('you');
        for (const facts of [
            { origin: { kind: 'none' as const }, viewerAccountId: 'me' },
            { ownerAccountId: 'me', viewerAccountId: 'me' },
            { origin: { kind: 'none' as const }, ownerAccountId: 'me' },
        ]) expect(readSessionListStartedByV1(facts)).toBeUndefined();
        const startedBy = readSessionListStartedByV1({ origin: { kind: 'none' }, ownerAccountId: 'other', viewerAccountId: 'me' });
        expect(startedBy).toBe('other_account');
        expect(matchSessionListFilterV1(normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'] }),
            { serverId: 'home', kind: 'session', startedBy })).toBe('miss');
        const automation = readSessionListStartedByV1({ origin: { kind: 'run_step', runId: 'workflow' }, ownerAccountId: 'me', viewerAccountId: 'me' });
        expect(automation).toBe('non_person');
        const match = (selection: ('you' | 'agents' | 'triggers')[]) => matchSessionListFilterV1(normalizeSessionListFilterV1({
            scope: 'all_accessible', homeServerIds: ['home'], startedBy: selection,
        }), { serverId: 'home', kind: 'session', startedBy: automation });
        expect(match(['you'])).toBe('miss');
        expect(match(['agents'])).toBe('unavailable');
    });
    it('round trips qualified include/exclude projects, canonical status and producer-owned subtree selection', () => {
        const filter = normalizeSessionListFilterV1({
            projects: { include: [{ serverId: ' home-a ', projectKey: ' payments ' }, { serverId: 'home-a', projectKey: 'payments' }], exclude: [{ serverId: 'home-b', projectKey: 'payments' }] },
            statuses: ['failed', 'thinking', 'failed'], underSessionId: ' manager ',
        });
        expect(filter).toMatchObject({ projects: { include: [{ serverId: 'home-a', projectKey: 'payments' }], exclude: [{ serverId: 'home-b', projectKey: 'payments' }] }, statuses: ['failed', 'thinking'], underSessionId: 'manager' });
        expect(SessionListFilterV1Schema.parse(JSON.parse(JSON.stringify(filter)))).toEqual(filter);
        expect(SessionListFilterV1Schema.safeParse({ ...filter, statuses: ['done'] }).success).toBe(false);
        expect(ScopeActionInputSchemas['session.list.view.set'].parse({ filters: { projects: filter.projects, statuses: ['failed'], underSessionId: 'manager' } }).filters).toMatchObject({ statuses: ['failed'], underSessionId: 'manager' });
    });

    it('uses one authorized tri-state predicate and never treats unavailable projects as satisfying exclusions', () => {
        const project = { serverId: 'home-a', projectKey: 'payments' };
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home-a'], projects: { include: [], exclude: [project] }, statuses: ['failed'] });
        const facts = { serverId: 'home-a', kind: 'session' as const, startedBy: 'you' as const, source: 'persisted' as const, status: 'failed' as const };
        expect(matchSessionListFilterV1(filter, { ...facts, metadata: null })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, metadata: { projectId: 'payments' } })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, projectKey: 'payments' })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, projectKey: 'other' })).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, projectKey: 'other', status: undefined })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, serverId: 'home-b', metadata: null })).toBe('miss');
        const under = normalizeSessionListFilterV1({ ...filter, projects: undefined, underSessionId: 'manager' });
        expect(matchSessionListFilterV1(under, facts)).toBe('unavailable');
        expect(matchSessionListFilterV1(under, { ...facts, underSessionMatches: true })).toBe('match');
        expect(matchSessionListFilterV1(under, { ...facts, underSessionMatches: false })).toBe('miss');
    });

    it('requires producer evidence for scope and qualified facets and keeps person-started sessions distinct from agent work', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home-a'], scope: 'following', attention: 'needs_my_attention',
            audiences: [{ serverId: 'home-a', kind: 'group', teamId: 'team', groupId: 'group' }], tagIds: [{ serverId: 'home-a', tagId: 'urgent' }], source: 'persisted' });
        const facts = { serverId: 'home-a', kind: 'session' as const, startedBy: 'you' as const, attentionRequired: true,
            scopeMatches: { following: true }, audiences: [{ kind: 'group' as const, teamId: 'team', groupId: 'group' }], tagIds: ['urgent'], source: 'persisted' as const };
        expect(matchSessionListFilterV1(filter, facts)).toBe('match');
        expect(matchSessionListFilterV1(filter, { ...facts, scopeMatches: undefined })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, audiences: undefined })).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, audiences: [{ kind: 'team', teamId: 'team' }] })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, tagIds: ['other'] })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, startedBy: 'agents' })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, source: undefined })).toBe('unavailable');
    });
    it('matches only a qualified explicit Project or uniquely accepted checkout, never repository/path groups', () => {
        const project = { serverId: 'home-a', projectKey: 'anchor' };
        const refs = [{ id: 'checkout', serverId: 'home-a', projectKey: 'anchor', machineId: 'machine', rootPath: 'C:\\repo', createdAtMs: 1 }];
        const match = (metadata: unknown, serverId = 'home-a') => matchSessionProjectFilterV1(metadata, serverId, project, refs);
        expect(match({ projectId: 'anchor' })).toBe('unavailable');
        expect(match({ projectId: 'anchor' }, 'home-b')).toBe('miss');
        expect(match({ projectId: 'other', workspaceId: 'checkout' })).toBe('unavailable');
        expect(match({ workspaceId: 'checkout' })).toBe('match');
        expect(match({ workspaceId: 'checkout', machineId: 'sandbox', path: '/repo/child' })).toBe('match');
        expect(matchSessionProjectFilterV1(null, 'home-a', project, undefined, { projectKey: 'anchor' })).toBe('match');
        expect(match({ machineId: 'machine', path: 'c:/repo/' })).toBe('match');
        expect(match({ machineId: 'machine', path: 'c:/repo/child' })).toBe('miss');
        expect(match({ machineId: 'foreign', path: 'c:/repo' })).toBe('miss');
        for (const path of [undefined, '', '   ']) {
            expect(match({ machineId: 'machine', ...(path === undefined ? {} : { path }) })).toBe('miss');
        }
        expect(match(null)).toBe('unavailable');
        expect(matchSessionProjectFilterV1({ workspaceId: 'checkout' }, 'home-a', project)).toBe('unavailable');
        expect(match({ projectId: '', workspaceId: 'checkout' })).toBe('unavailable');
        expect(matchSessionProjectFilterV1({ workspaceId: 'checkout' }, 'home-a', project, [...refs, { ...refs[0]!, projectKey: 'other' }])).toBe('unavailable');
    });
    it('matches Bot identity only from authorized canonical metadata and distinguishes unavailable metadata', () => {
        expect(matchSessionBotFilterV1({ bot: { kind: 'bot', future: true } }, 'bot')).toBe('match');
        expect(matchSessionBotFilterV1({ title: 'Bot', tag: 'bot', pinned: true }, 'bot')).toBe('miss');
        expect(matchSessionBotFilterV1({}, 'ordinary')).toBe('match');
        for (const bot of [{ kind: 'ordinary' }, null]) {
            expect(matchSessionBotFilterV1({ bot }, 'ordinary')).toBe('unavailable');
            expect(matchSessionBotFilterV1({ bot }, 'bot')).toBe('unavailable');
        }
        expect(matchSessionBotFilterV1({ bot: { kind: 'bot' } }, 'ordinary')).toBe('miss');
        expect(matchSessionBotFilterV1(null, 'ordinary')).toBe('unavailable');
        expect(matchSessionBotFilterV1(undefined, 'bot')).toBe('unavailable');
        expect(matchSessionBotFilterV1(null)).toBe('match');
    });
    it('retains an optional Bot facet without changing an unset selection', () => {
        expect(normalizeSessionListFilterV1()).not.toHaveProperty('bot');
        for (const bot of ['bot', 'ordinary'] as const) {
            expect(SessionListFilterV1Schema.parse({ ...normalizeSessionListFilterV1(), bot }).bot).toBe(bot);
            expect(ScopeActionInputSchemas['session.list.view.set'].parse({ filters: { bot } }).filters).toEqual({ bot });
        }
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), bot: 'pinned' }).success).toBe(false);
    });
    it('defaults to sessions and runs you started', () => {
        expect(normalizeSessionListFilterV1()).toMatchObject({ show: 'both', startedBy: ['you'] });
    });

    it('normalizes started-by selections without replacing an explicit empty selection', () => {
        expect(normalizeSessionListFilterV1({ show: 'runs', startedBy: ['agents', 'triggers', 'agents'] }))
            .toMatchObject({ show: 'runs', startedBy: ['agents', 'triggers'] });
        expect(normalizeSessionListFilterV1({ startedBy: [] }).startedBy).toEqual([]);
    });

    it('requires the current closed filter shape and rejects unknown run facets', () => {
        expect(SessionListFilterV1Schema.safeParse({
            scope: 'my_work', attention: 'any', source: 'all', homeServerIds: [], audiences: [], tagIds: [],
        }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), show: 'everything' }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), startedBy: ['host'] }).success).toBe(false);
    });

    it('does not reset run facets when an Action patches another filter facet', () => {
        expect(ScopeActionInputSchemas['session.list.view.set'].parse({
            filters: { scope: 'all_accessible' },
        }).filters).toEqual({ scope: 'all_accessible' });
    });

    it('normalizes qualified selections without collapsing identities from different Homes', () => {
        const normalized = normalizeSessionListFilterV1({
            scope: 'all_accessible',
            homeServerIds: [' home-b ', '', 'home-a', 'home-b'],
            audiences: [
                { serverId: ' home-a ', kind: 'team', teamId: ' team-a ' },
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-a' },
                { serverId: '', kind: 'outside_teams' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: ' group-a ' },
            ],
            tagIds: [
                { serverId: 'home-b', tagId: ' urgent ' },
                { serverId: 'home-b', tagId: 'urgent' },
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-a', tagId: '' },
            ],
        });
        expect(normalized).toEqual({
            scope: 'all_accessible', attention: 'any', source: 'all', show: 'both', startedBy: ['you'],
            homeServerIds: ['home-b', 'home-a'],
            audiences: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'group-a' },
            ],
            tagIds: [{ serverId: 'home-b', tagId: 'urgent' }, { serverId: 'home-a', tagId: 'urgent' }],
        });
        expect(normalizeSessionListFilterV1(normalized)).toEqual(normalized);
    });

    it('parses the serializable schema and delegates normalization to the same owner', () => {
        const filters = { ...normalizeSessionListFilterV1(), homeServerIds: [' home-a ', 'home-a'] };
        expect(SessionListFilterV1Schema.parse(JSON.parse(JSON.stringify(filters))))
            .toEqual({ ...normalizeSessionListFilterV1(), homeServerIds: ['home-a'] });
    });

    it('rejects UI-only state and unknown selection fields at the serializable boundary', () => {
        const filters = normalizeSessionListFilterV1();
        expect(SessionListFilterV1Schema.safeParse({ ...filters, searchQuery: 'draft search' }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({
            ...filters, audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a', access: 'admin' }],
        }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...filters, source: 'unknown' }).success).toBe(false);
    });

    it('treats Project as a Session fact without excluding Runs from a Status selection', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], startedBy: ['you', 'agents', 'triggers'], show: 'both' });
        const run = { serverId: 'home', kind: 'run' as const, startedBy: 'you' as const, attentionRequired: false };
        expect(canSessionListFilterIncludeRunsV1(filter)).toBe(true);
        expect(matchSessionListFilterV1(filter, run)).toBe('match');
        const failing = { ...filter, statuses: ['failed' as const] };
        const inPayments = { ...filter, projects: { include: [{ serverId: 'home', projectKey: 'payments' }], exclude: [] } };
        expect(canSessionListFilterIncludeRunsV1(failing)).toBe(true);
        expect(matchSessionListFilterV1(failing, run)).toBe('unavailable');
        expect(canSessionListFilterIncludeRunsV1(inPayments)).toBe(false);
        expect(matchSessionListFilterV1(inPayments, run)).toBe('miss');
        // An emptied facet narrows nothing and keeps Runs in the corpus.
        expect(canSessionListFilterIncludeRunsV1({ ...filter, statuses: [], projects: { include: [], exclude: [] } })).toBe(true);
    });
});
