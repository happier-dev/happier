import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

const workspace = { t: 'workspaceScope', serverId: 'home', machineId: 'machine-1', rootPath: '/repo' } as const;
const source: SessionListIndexItem[] = [
    { type: 'header', headerKind: 'project', title: 'repo', groupKey: 'repo', serverId: 'home', workspace,
        workspaceScopeHint: { serverId: 'home', machineId: 'machine-1', rootPath: '/repo' } },
    { type: 'session', sessionId: 'lead', serverId: 'home', groupKey: 'repo', groupKind: 'project', workspace },
    { type: 'session', sessionId: 'step', serverId: 'home', groupKey: 'repo', groupKind: 'project', workspace },
];
const resolveSessionRow = (_serverId: string | null | undefined, sessionId: string): SessionListRenderableSession => ({
    id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    metadataVersion: 0, agentStateVersion: 0, thinking: false, thinkingAt: 0,
    metadata: { machineId: 'machine-1', path: '/repo' },
    ...(sessionId === 'step' ? { origin: { kind: 'run_step', runId: 'manual' } } : {}),
});

function summary(id: string, startedBy: 'user' | 'trigger' | 'agent', attentionRequired = false) {
    return { ...createWorkflowRunSummaryFixture({ id, attentionRequired }), startedBy,
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
    it.each(['projects', 'active_inactive', 'recent_activity'] as const)('preserves incumbent attention placement in the mixed %s projection', (sessionListLayoutChoice) => {
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

    it.each(['active_inactive', 'recent_activity'] as const)('keeps working and pinned bands ahead of ordinary Runs in %s', (sessionListLayoutChoice) => {
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
            sessionListLayoutChoice, workingPlacement: { mode: 'global' as const },
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
        expect(rows.filter((item) => item.type === 'workflow_run').every((item) => item.groupKey === 'repo')).toBe(true);
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

    it('Runs-only keeps their nested step Sessions, and an empty starter selection still keeps attention Runs', () => {
        const rows = compute('runs').filter((item) => item.type !== 'header');
        expect(rows.map((item) => item.type === 'session' ? item.sessionId : item.runId)).toEqual(['manual', 'step', 'needs-you']);
        expect(compute('runs', []).filter((item) => item.type !== 'header').map((item) => item.type)).toEqual(['workflow_run']);
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

    it('puts nonterminal and completed Runs in the existing active and inactive sections', () => {
        const rows = computeVisibleSessionListIndex({
            source: [], resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListLayoutChoice: 'active_inactive',
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
            workflowRuns: [{ serverId: 'home', summary: { ...summary('running', 'user'), state: 'running' } },
                { serverId: 'home', summary: { ...summary('done', 'user'), state: 'succeeded' } }],
        })!;
        expect(rows.filter((item) => item.type === 'workflow_run').map((item) => [item.runId, item.section]))
            .toEqual([['running', 'active'], ['done', 'inactive']]);
        expect(rows.filter((item) => item.type === 'header' && ['active', 'inactive'].includes(item.headerKind ?? ''))
            .map((item) => item.type === 'header' ? item.headerKind : null)).toEqual(['active', 'inactive']);
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
        expect(rows.find((item) => item.type === 'session' && item.sessionId === 'step')?.groupKey).toBe('repo');
    });

    it('does not invent independent folder membership for a Run in a focused Session folder', () => {
        const folder = { id: 'f', name: 'Focused', parentId: null, workspace, createdAt: 1, updatedAt: 1 };
        const runs = [summary('manual', 'user'),
            { ...summary('agent', 'agent'), origin: { kind: 'direct' as const, originSessionId: 'lead' } },
            { ...summary('absent-origin', 'agent'), origin: { kind: 'direct' as const, originSessionId: 'elsewhere' } }];
        const rows = computeVisibleSessionListIndex({ source: source.slice(0, 2), resolveSessionRow,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            folderFocus: { folder, folderIds: new Set(['f']), breadcrumbs: [folder] },
            workFilter: normalizeSessionListFilterV1({ startedBy: ['you', 'agents'], homeServerIds: ['home'] }),
            workflowRuns: runs.map((run) => ({ serverId: 'home', summary: run })),
        })!.filter((item) => item.type !== 'header');
        expect(rows.map((item) => [item.type === 'session' ? item.sessionId : item.runId, item.reportsDepth ?? 0]))
            .toEqual([['lead', 0], ['agent', 1]]);
    });
});
