import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { computeVisibleSessionListIndex as computeSessionListIndex } from './computeVisibleSessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListProjectHeaderViewModels } from '@/components/sessions/shell/sessionListProjectHeaderViewModels';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionProjectGroupingIdentity, resolveSessionProjectGroupingKeyParts, sessionProjectGroupingIdentityKey } from './sessionListProjectGroupingKeys';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { buildSessionListRowFilterFacts, buildWorkflowRunFilterFacts, matchSessionListRowLocalFilter, resolveWorkflowRunUnavailableHomes } from './sessionListWorkFilter';
import { matchSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

const fixtureViewers = new Map([['home', 'account-1']]);
function computeVisibleSessionListIndex(input: Parameters<typeof computeSessionListIndex>[0]) {
    // The real collection runs under captured viewer custody; standalone projections supply that same fixture fact.
    return computeSessionListIndex({ viewerAccountIdByServerId: fixtureViewers, ...input });
}

const workspace = { t: 'workspaceScope', serverId: 'home', machineId: 'machine-1', rootPath: '/repo' } as const;
const projectGroupKey = sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity('home',
    resolveSessionProjectGroupingKeyParts({ machineId: 'machine-1', path: '/repo' })));
const source: SessionListIndexItem[] = [
    { type: 'header', headerKind: 'project', title: 'repo', groupKey: projectGroupKey, serverId: 'home', workspace,
        workspaceScopeHint: { serverId: 'home', machineId: 'machine-1', rootPath: '/repo' } },
    { type: 'session', sessionId: 'lead', serverId: 'home', groupKey: projectGroupKey, groupKind: 'project', workspace },
    { type: 'session', sessionId: 'step', serverId: 'home', groupKey: projectGroupKey, groupKind: 'project', workspace },
];
const resolveSessionRow = (_serverId: string | null | undefined, sessionId: string): SessionListRenderableSession => ({
    id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    metadataVersion: 0, agentStateVersion: 0, thinking: false, thinkingAt: 0,
    encryptionMode: 'plain',
    metadata: { machineId: 'machine-1', path: '/repo' },
    ...(sessionId === 'step' ? { origin: { kind: 'run_step', runId: 'manual' } } : {}),
});

function summary(id: string, startedBy: 'user' | 'trigger' | 'agent', attentionRequired = false) {
    return { ...createWorkflowRunSummaryFixture({ id, attentionRequired, ownerAccountId: 'account-1' }), startedBy,
        where: { machineId: 'machine-1', directory: '/repo' },
        stepProgress: { completed: 1, total: 3 },
    };
}

function compute(show: 'sessions' | 'runs' | 'both' = 'both', startedBy: ('you' | 'triggers' | 'agents')[] = ['you']) {
    return computeVisibleSessionListIndex({
        source, resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
        presentation: { enabled: false, presentation: 'grouped' },
        workFilter: normalizeSessionListFilterV1({ show, startedBy, homeServerIds: ['home'] }),
        workflowRuns: [summary('manual', 'user'), summary('quiet-trigger', 'trigger'), summary('needs-you', 'agent', true)]
            .map((run) => ({ serverId: 'home', summary: run })),
    })!;
}

describe('computeVisibleSessionListIndex workflow Runs', () => {
    it('keeps existing project order and appends new Run groups in first-seen order', () => {
        const group = (path: string) => sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity('home',
            resolveSessionProjectGroupingKeyParts({ machineId: 'machine-1', path })));
        const input: SessionListIndexItem[] = ['/a', '/b'].flatMap(path => [
            { type: 'header', headerKind: 'project', title: path, serverId: 'home', groupKey: group(path) },
            { type: 'session', sessionId: path, serverId: 'home', groupKey: group(path), groupKind: 'project' },
        ]);
        const result = computeVisibleSessionListIndex({ source: input,
            resolveSessionRow: (_server, id) => ({ ...resolveSessionRow('home', id),
                metadata: { machineId: 'machine-1', path: id } }),
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListAttentionPlacementV1: 'inPlace',
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
            workflowRuns: ['/b', '/c', '/a', '/c', '/d', '/b'].map((directory, index) => ({
                serverId: 'home', summary: { ...summary(`run-${index}`, 'user'),
                    where: { machineId: 'machine-1', directory } },
            })),
        })!;
        expect(result.map(item => item.type === 'header' ? `header:${item.title}`
            : item.type === 'session' ? item.sessionId : item.runId)).toEqual([
            'header:/a', '/a', 'run-2',
            'header:/b', '/b', 'run-0', 'run-5',
            'header:/c', 'run-1', 'run-3',
            'header:/d', 'run-4',
        ]);
    });

    it('merges Runs with one pass over Session groups and preserves every row in input order', () => {
        // F24's audit reproduced this at 1,000 Sessions and 1,000 Runs.
        const sessionCount = 1_000;
        const runCount = 1_000;
        let groupVisits = 0;
        const sessions: SessionListIndexItem[] = Array.from({ length: sessionCount }, (_, index) => ({
            type: 'session', sessionId: `session-${index}`, serverId: 'home', groupKind: 'project',
            get groupKey() { groupVisits += 1; return projectGroupKey; },
        }));
        const params = {
            source: [source[0]!, ...sessions], resolveSessionRow,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListAttentionPlacementV1: 'inPlace' as const,
            presentation: { enabled: false, presentation: 'grouped' as const },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
        };
        computeVisibleSessionListIndex({ ...params, workflowRuns: [] });
        const sessionProjectionVisits = groupVisits;
        groupVisits = 0;
        const result = computeVisibleSessionListIndex({ ...params,
            workflowRuns: Array.from({ length: runCount }, (_, index) => ({
                serverId: 'home', summary: summary(`run-${index}`, 'user'),
            })),
        })!;
        expect(result.filter(item => item.type !== 'header').map(item =>
            item.type === 'session' ? item.sessionId : item.runId)).toEqual([
            ...Array.from({ length: sessionCount }, (_, index) => `session-${index}`),
            ...Array.from({ length: runCount }, (_, index) => `run-${index}`),
        ]);
        // Observe actual row accesses, independently of the insertion implementation.
        console.info('F24 workflow Run group visits', {
            sessionCount, runCount, sessionProjectionVisits, withRuns: groupVisits,
            addedByRuns: groupVisits - sessionProjectionVisits,
        });
        expect(groupVisits - sessionProjectionVisits).toBeLessThanOrEqual(2 * sessionCount);
    });

    it('does not turn another Account\'s readable Team Run into your start or participation', () => {
        const run = { ...summary('shared', 'user'), ownerAccountId: 'other', visibleTeamId: 'team' };
        const own = buildWorkflowRunFilterFacts({ ...run, ownerAccountId: 'me' }, 'home', 'me');
        const foreign = buildWorkflowRunFilterFacts(run, 'home', 'me');
        const unknownViewer = buildWorkflowRunFilterFacts(run, 'home');
        expect(foreign.startedBy).toBe('other_account');
        expect(own).toMatchObject({ startedBy: 'you', scopeMatches: { my_work: true, involving_me: true } });
        expect(unknownViewer.startedBy).toBeUndefined();
        expect(foreign.scopeMatches?.my_work).toBeUndefined();
        expect(foreign.scopeMatches?.involving_me).toBeUndefined();
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        expect(matchSessionListFilterV1(filter, foreign)).toBe('miss');
        expect(matchSessionListFilterV1(filter, unknownViewer)).toBe('unavailable');
        expect(matchSessionListFilterV1({ ...filter, scope: 'involving_me', startedBy: ['you', 'agents', 'triggers'] }, foreign)).toBe('unavailable');
        const visible = computeVisibleSessionListIndex({ source: [], resolveSessionRow: () => null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' }, workFilter: { ...filter, show: 'runs' },
            viewerAccountIdByServerId: new Map([['home', 'me']]),
            workflowRuns: [{ serverId: 'home', summary: run },
                { serverId: 'home', summary: { ...run, id: 'own', ownerAccountId: 'me' } }],
        });
        expect(visible?.filter(item => item.type === 'workflow_run').map(item => item.runId)).toEqual(['own']);
    });
    it('keeps unavailable Run filter facts distinct from a complete empty Run result', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], show: 'runs', underSessionId: 'manager' });
        const input = { selectedHomeServerIds: ['home'], mountedHomeServerIds: ['home'], servedHomeServerId: 'home',
            filter, viewerAccountId: 'account-1', runs: [summary('manual', 'user')] };
        expect(resolveWorkflowRunUnavailableHomes(input)).toEqual([{ serverId: 'home', reason: 'unsupported' }]);
        expect(resolveWorkflowRunUnavailableHomes({ ...input, runs: [] })).toEqual([]);
        expect(resolveWorkflowRunUnavailableHomes({ ...input, runs: [null] })).toEqual([{ serverId: 'home', reason: 'unsupported' }]);
        expect(resolveWorkflowRunUnavailableHomes({ ...input, filter: { ...filter, underSessionId: undefined } })).toEqual([]);
        // A known nonmatching kind does not require unavailable subtree evidence.
        expect(resolveWorkflowRunUnavailableHomes({ ...input, filter: { ...filter, show: 'sessions' } })).toEqual([]);
        expect(resolveWorkflowRunUnavailableHomes({ ...input, runUnderSessionId: 'manager' })).toEqual([]);
    });
    it('uses an Under-filtered Run page as server-proved membership in the list projection', () => {
        const run = summary('descendant-origin', 'user');
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], show: 'runs', underSessionId: 'manager' });
        const base = { source: [], resolveSessionRow: () => null, hideInactiveSessions: false,
            pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, presentation: { enabled: false, presentation: 'grouped' as const },
            workFilter: filter, workflowRuns: [{ serverId: 'home', summary: run }] };
        expect(computeVisibleSessionListIndex(base)?.filter(item => item.type === 'workflow_run')).toEqual([]);
        expect(computeVisibleSessionListIndex({ ...base, workflowRunUnderSessionId: 'manager' })
            ?.filter(item => item.type === 'workflow_run').map(item => item.runId)).toEqual([run.id]);
    });
    it('uses protected starter identity for current rows without treating legacy list admission as rule proof', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        const options = { nowMs: 1000, viewerAccountId: 'me' };
        const row = { ...resolveSessionRow('home', 'lead'), origin: { kind: 'none' as const }, ownerAccountId: 'me',
            metadata: { path: '/repo', bot: { kind: 'bot' as const } } };
        expect(matchSessionListRowLocalFilter(row, 'home', filter, options)).toBe('match');
        expect(matchSessionListRowLocalFilter({ ...row, ownerAccountId: 'other' }, 'home', filter, options)).toBe('miss');
        const legacy = { ...row, ownerAccountId: undefined };
        expect(matchSessionListRowLocalFilter(legacy, 'home', filter, options)).toBe('match');
        expect(matchSessionListFilterV1(filter, buildSessionListRowFilterFacts(legacy, 'home', options))).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, buildSessionListRowFilterFacts(null, 'home', options))).toBe('unavailable');
    });
    it('uses the opened owner view for hydrated rule facts as well as compact list rows', () => {
        const session = createSessionFixture({ metadataLayoutVersion: 1, metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
            ownerMetadataView: { path: '/private', host: 'host', projectId: 'payments', bot: { kind: 'bot' } } });
        const facts = buildSessionListRowFilterFacts(session, 'home', { nowMs: 1000 });
        expect(facts.projectMetadata).toMatchObject({ projectId: 'payments' });
        expect(facts.metadata).toEqual({ bot: { kind: 'bot' } });
    });
    it('keeps cold loading placeholders unless a selected local facet requires their unavailable facts', () => {
        const params = {
            source: [{ type: 'session' as const, sessionId: 'loading', serverId: 'home', groupKind: 'loading' as const }],
            resolveSessionRow: () => null, sessionListLayoutChoice: 'recent_activity' as const,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' as const },
        };
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'] });
        expect(computeVisibleSessionListIndex({ ...params, workFilter: filter })?.some(item => item.type === 'session' && item.sessionId === 'loading')).toBe(true);
        expect(computeVisibleSessionListIndex({ ...params, workFilter: { ...filter,
            projects: { include: [{ serverId: 'home', projectKey: 'payments' }], exclude: [] },
        } })?.some(item => item.type === 'session')).toBe(false);
    });
    it('retains producer-proved direct storage when a compact row has no opened source material', () => {
        const result = computeVisibleSessionListIndex({
            source: [{ ...source[1]!, type: 'session', sessionId: 'lead', storageKind: 'direct' }],
            resolveSessionRow: () => ({ ...resolveSessionRow('home', 'lead'), metadata: null }),
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ source: 'direct', homeServerIds: ['home'] }),
        })!;
        expect(result.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['lead']);
    });
    it('applies the canonical project exclusion and status to list rows without admitting locked facts', () => {
        const row = { ...resolveSessionRow('home', 'lead'), encryptionMode: 'plain' as const, encryptedContentAvailability: 'ready' as const,
            presence: 'online' as const, latestTurnStatus: 'failed' as const, latestTurnStatusObservedAt: 1000, origin: { kind: 'none' as const },
            viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' } }) };
        const rows = { lead: { ...row, projectKey: 'payments' }, step: { ...row, id: 'step', projectKey: 'other' } };
        const result = computeVisibleSessionListIndex({ source, resolveSessionRow: (_server, id) => rows[id as keyof typeof rows] ?? null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 1000,
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'], statuses: ['failed'], projects: { include: [], exclude: [{ serverId: 'home', projectKey: 'payments' }] } }),
        })!;
        expect(result.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['step']);
    });
    it('distinguishes the same Run project on two machines without any Sessions, and refreshes cached identity', () => {
        const machines = ['machine-1111', 'machine-2222'].map(id => createMachineFixture({
            id, metadata: { ...createMachineFixture().metadata!, displayName: 'Dev box', host: 'dev.local', homeDir: '/home' },
        }));
        const rows = computeVisibleSessionListIndex({ source: [], resolveSessionRow: () => null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListLayoutChoice: 'projects', presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
            workflowRuns: machines.map(machine => ({ serverId: 'home', summary: {
                ...summary(machine.id, 'user'), where: { machineId: machine.id, directory: '/home/happier' },
            } })),
        })!;
        const input = { listItems: rows, workspaceLabels: undefined, workspaceRefs: [],
            machinesById: new Map(machines.map(machine => [machine.id, machine])) };
        const projected = buildSessionListProjectHeaderViewModels(input);
        const models = projected.projectHeaderViewModelByGroupKey;
        const headers = rows.filter(item => item.type === 'header');
        const names = resolveMachineDisplayNames(machines);
        expect(headers.map(header => models.get(header.groupKey!)?.machineSubtitle))
            .toEqual(machines.map(machine => names.get(machine.id)));
        expect(new Set([...models.values()].map(model => model.machineSubtitle)).size).toBe(2);
        expect(buildSessionListProjectHeaderViewModels({ ...input,
            machinesById: new Map(machines.map(machine => [machine.id, { ...machine, activeAt: 200 }])),
        })).toBe(projected);
        const renamed = { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Laptop' } };
        const refreshed = buildSessionListProjectHeaderViewModels({ ...input,
            machinesById: new Map([[renamed.id, renamed], [machines[1]!.id, machines[1]!]]),
        });
        expect(refreshed.projectHeaderViewModelByGroupKey.get(headers[0]!.groupKey!)?.machineSubtitle).toBe('Laptop');

    });
    it('groups Runs without a Session corpus by their accepted project and uses its canonical workspace name', () => {
        const workspaceRefs = [{
            id: 'project-happier', serverId: 'home', machineId: 'machine-1', rootPath: '/repo/happier',
            label: 'Happier workspace', createdAtMs: 1, lastOpenedAtMs: null,
        }];
        const runs = [
            { ...summary('release', 'user'), where: { machineId: 'machine-1', directory: '/repo/happier', workspaceRefId: 'project-happier' } },
            { ...summary('payments-review', 'user'), where: { machineId: 'machine-1', directory: '/repo/payments' } },
        ];
        const rows = computeVisibleSessionListIndex({ source: [], resolveSessionRow,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListLayoutChoice: 'projects', presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
            // P5's canonical Project resolver consumes only this Home's admitted census.
            workspaceRefsServerId: 'home', workspaceRefs,
            workflowRuns: runs.map(run => ({ serverId: 'home', summary: run })),
        })!;
        const headers = rows.filter(item => item.type === 'header' && item.headerKind === 'project');
        expect(headers).toHaveLength(2);
        const models = buildSessionListProjectHeaderViewModels({ listItems: rows, workspaceLabels: undefined, workspaceRefs,
            workspaceRefsServerId: 'home' }).projectHeaderViewModelByGroupKey;
        expect(Object.fromEntries(rows.filter(item => item.type === 'workflow_run').map(item =>
            [item.runId, models.get(item.groupKey!)?.displayTitle]))).toEqual({
            release: 'Happier workspace', 'payments-review': 'payments',
        });
        expect(rows.filter(item => item.type === 'workflow_run').map(item => item.groupKey))
            .toEqual(headers.map(header => header.groupKey));
    });
    it('projects Bots from authorized metadata independently of pin, title, Run and locked neighbors', () => {
        const rows: Record<string, SessionListRenderableSession> = {
            lead: { ...resolveSessionRow('home', 'lead'), metadata: { path: '/repo', bot: { kind: 'bot' } } },
            step: { ...resolveSessionRow('home', 'step'), origin: undefined,
                metadata: { path: '/repo', summaryText: 'Bot' } },
            locked: { ...resolveSessionRow('home', 'locked'), metadata: null },
        };
        const params = {
            source: [...source, { ...source[1], sessionId: 'locked' } as SessionListIndexItem],
            resolveSessionRow: (_home: string | null | undefined, id: string) => rows[id] ?? null,
            hideInactiveSessions: false, pinnedSessionKeysV1: ['home:step'], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' as const },
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
        };
        for (const [bot, expected] of [['bot', ['lead']], ['ordinary', ['step']]] as const) {
            const visible = computeVisibleSessionListIndex({ ...params,
                workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'], bot }),
            })!;
            expect(visible.filter((item) => item.type !== 'header').map((item) =>
                item.type === 'session' ? item.sessionId : item.runId)).toEqual(expected);
        }
    });
    it.each(['projects', 'recent_activity'] as const)('preserves incumbent attention placement in the mixed %s projection', (sessionListLayoutChoice) => {
        const params = {
            source: source.slice(0, 2),
            resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => ({
                ...resolveSessionRow(serverId, sessionId),
                presence: 'online' as const,
                latestTurnStatus: 'in_progress' as const,
                latestTurnStatusObservedAt: 1_000,
                hasPendingPermissionRequests: true,
                pendingRequestObservedAt: 1_000,
            }),
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListLayoutChoice,
            sessionListAttentionPlacementV1: 'top' as const,
            attentionPlacement: { mode: 'global' as const },
            presentation: { enabled: false, presentation: 'grouped' as const },
            nowMs: 1_000,
        };
        const incumbent = computeVisibleSessionListIndex(params);
        expect(incumbent).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'session', groupKind: 'attention', attentionPlacementReason: 'permission_required' }),
        ]));
        expect(computeVisibleSessionListIndex({ ...params, workflowRuns: [],
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
        })).toEqual(incumbent);
        const withRun = computeVisibleSessionListIndex({ ...params,
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
        })!;
        expect(withRun.slice(0, incumbent!.length)).toEqual(incumbent);
        expect(withRun).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'workflow_run', runId: 'manual' })]));
    });

    it.each(['projects', 'recent_activity'] as const)('keeps working and pinned bands ahead of ordinary Runs in %s', (sessionListLayoutChoice) => {
        const params = {
            source: [...source.slice(0, 2), { ...source[1], sessionId: 'pinned' } as SessionListIndexItem],
            resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => ({
                ...resolveSessionRow(serverId, sessionId),
                presence: 'online' as const,
                thinking: sessionId === 'lead', thinkingAt: 1_000, activeAt: 1_000,
                latestTurnStatus: sessionId === 'lead' ? 'in_progress' as const : 'completed' as const,
                latestTurnStatusObservedAt: 1_000,
            }),
            hideInactiveSessions: false, pinnedSessionKeysV1: ['home:pinned'], sessionListGroupOrderV1: {},
            sessionListLayoutChoice, sessionListAttentionPlacementV1: 'top' as const, workingPlacement: { mode: 'global' as const },
            presentation: { enabled: false, presentation: 'grouped' as const }, nowMs: 1_000,
        };
        const incumbent = computeVisibleSessionListIndex(params)!;
        expect(incumbent.filter((item) => item.type === 'header').map((item) => item.headerKind)).toEqual(['working', 'pinned']);
        const mixed = computeVisibleSessionListIndex({ ...params,
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
        })!;
        expect(mixed.slice(0, incumbent.length)).toEqual(incumbent);
    });

    it('defaults to your Runs plus every attention Run, with step Sessions only under their Run', () => {
        const rows = compute().filter((item) => item.type !== 'header');
        expect(rows.map((item) => item.type === 'session' ? item.sessionId : item.runId)).toEqual(['lead', 'manual', 'step', 'needs-you']);
        expect(rows.find((item) => item.type === 'session' && item.sessionId === 'step')?.reportsDepth).toBe(1);
        expect(rows.filter((item) => item.type === 'workflow_run').every((item) => item.groupKey === projectGroupKey)).toBe(true);
    });

    it('retains an unresolved Session in the canonical Recent loading tail when Runs arrive', () => {
        const rows = computeVisibleSessionListIndex({
            source: source.slice(0, 2), resolveSessionRow: () => null,
            hideInactiveSessions: true, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListLayoutChoice: 'recent_activity',
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
        })!;
        expect(rows.slice(-2)).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'loading', groupKey: 'recent:loading' }),
            expect.objectContaining({ type: 'session', sessionId: 'lead', groupKind: 'loading', groupKey: 'recent:loading' }),
        ]);
    });

    it('Runs-only keeps their nested step Sessions, and an empty starter selection admits no Runs', () => {
        const rows = compute('runs').filter((item) => item.type !== 'header');
        expect(rows.map((item) => item.type === 'session' ? item.sessionId : item.runId)).toEqual(['manual', 'step', 'needs-you']);
        expect(compute('runs', []).filter((item) => item.type !== 'header')).toEqual([]);
    });

    it('Runs-only drops Session folders and projects that hold no Run (Workflows › Runs is not the Sessions tree)', () => {
        const rows = computeVisibleSessionListIndex({
            source: [
                ...source,
                { type: 'header', headerKind: 'project', title: 'scratch', groupKey: 'scratch', serverId: 'home' },
                { type: 'header', headerKind: 'folder', title: 'Notes', groupKey: 'scratch', folderId: 'notes', serverId: 'home' },
                { type: 'header', headerKind: 'folder', title: 'No folder', groupKey: 'scratch', folderId: 'none', serverId: 'home' },
            ],
            resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
        })!;
        expect(rows.filter((item) => item.type === 'header').map((item) => item.type === 'header' ? item.title : null)).toEqual(['repo']);
    });

    it('Runs-only drops a project that holds no Run even when a project with Runs follows it', () => {
        const rows = computeVisibleSessionListIndex({
            source: [
                { type: 'header', headerKind: 'project', title: 'scratch', groupKey: 'scratch', serverId: 'home' },
                { type: 'header', headerKind: 'project', title: 'notes', groupKey: 'notes', serverId: 'home' },
                ...source,
            ],
            resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
        })!;
        expect(rows.filter((item) => item.type === 'header').map((item) => item.type === 'header' ? item.title : null)).toEqual(['repo']);
    });

    it('Runs-only drops the single-section "Sessions" label, which Sessions and Both keep', () => {
        const sessionsHeader: SessionListIndexItem = { type: 'header', headerKind: 'sessions', title: 'Sessions', groupKey: 'sessions' };
        const headerKinds = (show: 'sessions' | 'runs' | 'both') => computeVisibleSessionListIndex({
            source: [sessionsHeader, ...source],
            resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ show, homeServerIds: ['home'] }),
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
        })!.filter((item) => item.type === 'header').map((item) => item.type === 'header' ? item.headerKind : null);
        expect(headerKinds('runs')).toEqual(['project']);
        expect(headerKinds('both')).toEqual(['sessions', 'project']);
        expect(headerKinds('sessions')).toEqual(['sessions', 'project']);
    });

    it('Sessions-only removes Runs and their step Sessions rather than leaving the steps at top level', () => {
        expect(compute('sessions').filter((item) => item.type !== 'header').map((item) => item.type === 'session' ? item.sessionId : item.runId)).toEqual(['lead']);
    });

    it('keeps completed step Sessions beneath their Run while hiding ordinary inactive Sessions', () => {
        const rows = computeVisibleSessionListIndex({
            source, resolveSessionRow: (serverId, sessionId) => ({ ...resolveSessionRow(serverId, sessionId), active: false }),
            hideInactiveSessions: true, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
            workflowRuns: [{ serverId: 'home', summary: summary('manual', 'user') }],
        })!.filter((item) => item.type !== 'header');
        expect(rows.map((item) => [item.type === 'session' ? item.sessionId : item.runId, item.reportsDepth ?? 0]))
            .toEqual([['manual', 0], ['step', 1]]);
    });

    it('retains terminal Run activity facts in Projects without retired active and inactive headings', () => {
        const rows = computeVisibleSessionListIndex({
            source: [], resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListLayoutChoice: 'projects',
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
            workflowRuns: [{ serverId: 'home', summary: { ...summary('running', 'user'), state: 'running' } },
                { serverId: 'home', summary: { ...summary('done', 'user'), state: 'succeeded' } }],
        })!;
        expect(rows.filter((item) => item.type === 'workflow_run').map((item) => [item.runId, item.section]))
            .toEqual([['running', 'active'], ['done', 'inactive']]);
        expect(rows.filter((item) => item.type === 'header' && ['active', 'inactive'].includes(item.headerKind ?? ''))
            .map((item) => item.type === 'header' ? item.headerKind : null)).toEqual([]);
    });

    it('moves step Sessions under their run across groups, and nests only explicitly agent-started Runs under an origin', () => {
        const runs = [
            { ...summary('manual', 'user'), origin: { kind: 'direct' as const, originSessionId: 'lead' } },
            { ...summary('agent', 'agent'), origin: { kind: 'direct' as const, originSessionId: 'lead' } },
        ];
        const rows = computeVisibleSessionListIndex({
            source: [...source.slice(0, 2), { type: 'header', title: 'other', groupKey: 'other' },
                { ...source[2], groupKey: 'other' } as SessionListIndexItem],
            resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ startedBy: ['you', 'agents'], homeServerIds: ['home'] }),
            workflowRuns: runs.map((run) => ({ serverId: 'home', summary: run })),
        })!.filter((item) => item.type !== 'header');
        expect(rows.map((item) => [item.type === 'session' ? item.sessionId : item.runId, item.reportsDepth ?? 0]))
            .toEqual([['lead', 0], ['agent', 1], ['manual', 0], ['step', 1]]);
        expect(rows.find((item) => item.type === 'session' && item.sessionId === 'step')?.groupKey).toBe(projectGroupKey);
    });

    it('ignores retired folder focus for manual and agent-started Runs', () => {
        const folder = { id: 'f', name: 'Focused', parentId: null, workspace, createdAt: 1, updatedAt: 1 };
        const runs = [summary('manual', 'user'),
            { ...summary('agent', 'agent'), origin: { kind: 'direct' as const, originSessionId: 'lead' } },
            { ...summary('absent-origin', 'agent'), origin: { kind: 'direct' as const, originSessionId: 'elsewhere' } }];
        const rows = computeVisibleSessionListIndex({ source: source.slice(0, 2), resolveSessionRow,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            ...{ folderFocus: { folder, folderIds: new Set(['f']), breadcrumbs: [folder] } },
            workFilter: normalizeSessionListFilterV1({ startedBy: ['you', 'agents'], homeServerIds: ['home'] }),
            workflowRuns: runs.map((run) => ({ serverId: 'home', summary: run })),
        })!.filter((item) => item.type !== 'header');
        expect(rows.map((item) => [item.type === 'session' ? item.sessionId : item.runId, item.reportsDepth ?? 0]))
            .toEqual([['lead', 0], ['agent', 1], ['manual', 0], ['absent-origin', 0]]);
    });
});
