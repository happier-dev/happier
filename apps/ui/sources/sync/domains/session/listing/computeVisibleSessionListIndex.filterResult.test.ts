import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { listSessionPresentationStatesForWorkStatusFilterV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { computeVisibleSessionListProjection } from './computeVisibleSessionListIndex';

describe('visible Session membership projection', () => {
    it('admits proven manual membership despite unknown smart facts, qualified to the current Home Account', () => {
        const row = createSessionListRenderableSessionFixture({ id: 'manual', active: true, ownerAccountId: 'me', metadata: null,
            viewer: { ...createSessionViewerFixture(), tagIds: ['member'] } });
        const source = [{ type: 'session' as const, serverId: 'home', sessionId: 'manual' }];
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], startedBy: ['you', 'triggers', 'agents'] });
        const space = { filter: { ...filter, machines: { include: [{ serverId: 'home', machineId: 'unknown' }], exclude: [] } },
            membership: { mode: 'filter_or_manual' as const, tags: [{ serverId: 'home', accountId: 'me', tagId: 'member' }] } };
        const params = { source, resolveSessionRow: () => row, workFilter: filter, spaceMembership: space,
            viewerAccountIdByServerId: new Map([['home', 'me']]), hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' as const }, nowMs: 10 };
        const first = computeVisibleSessionListProjection(params);
        expect(first.filterResult.matchedCount).toBe(1);
        const second = computeVisibleSessionListProjection({ ...params, previousMembership: first.membership });
        expect(second.membership.sessions.get(JSON.stringify(['home', 'manual']))).toBe(first.membership.sessions.get(JSON.stringify(['home', 'manual'])));
        const foreign = computeVisibleSessionListProjection({ ...params, spaceMembership: { ...space, membership: { mode: 'manual_only' as const,
            tags: [{ serverId: 'other', accountId: 'me', tagId: 'member' }, { serverId: 'home', accountId: 'other', tagId: 'member' }] } } });
        expect(foreign.filterResult.matchedCount).toBe(0);
        const refined = computeVisibleSessionListProjection({ ...params, workFilter: { ...filter, source: 'direct' as const } });
        expect(refined.filterResult.matchedCount).toBe(0);
        const runLens = { ...space, filter: { ...filter, show: 'runs' as const } };
        expect(computeVisibleSessionListProjection({ ...params, spaceMembership: runLens }).filterResult.matchedCount).toBe(1);
        expect(computeVisibleSessionListProjection({ ...params, spaceMembership: runLens,
            sessionTagIdsBySessionKey: { [JSON.stringify(['home', 'manual'])]: [] } }).filterResult.matchedCount).toBe(0);
    });
    it('admits value-count facts only while a picker is open and updates one contribution among a thousand held entities', () => {
        let reads = 0;
        const rows = new Map(Array.from({ length: 1_000 }, (_, index) => [`s${index}`,
            createSessionListRenderableSessionFixture({ id: `s${index}`, ownerAccountId: 'me', active: true,
                metadata: { path: '/repo', machineId: `m${index % 139}` } })]));
        for (const row of rows.values()) Object.defineProperty(row, 'ownerAccountId', {
            enumerable: false, get: () => { reads += 1; return 'me'; },
        });
        const source: SessionListIndexItem[] = [...rows.keys()].map(sessionId => ({ type: 'session', serverId: 'home',
            sessionId, groupKey: 'repo', groupKind: 'project' }));
        const params = { source, resolveSessionRow: (_home: string | null | undefined, id: string) => rows.get(id) ?? null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 20,
            sessionListAttentionPlacementV1: 'inPlace' as const, presentation: { enabled: false, presentation: 'grouped' as const } };
        const closed = computeVisibleSessionListProjection(params);
        expect(closed.conditionValueCounts).toBeUndefined();
        expect(reads).toBe(0);
        const request = { fieldId: 'homeServerIds', options: [{ value: 'home' }, { value: 'other' }] };
        const first = computeVisibleSessionListProjection({ ...params, previousMembership: closed.membership,
            conditionValueCountRequest: request });
        expect(first.conditionValueCounts).toEqual({ fieldId: 'homeServerIds', options: [{ value: 'home', count: 1_000 }, { value: 'other', count: 0 }] });
        expect(reads).toBe(1_000);
        rows.set('s12', { ...rows.get('s12')!, updatedAt: 2 });
        Object.defineProperty(rows.get('s12')!, 'ownerAccountId', { enumerable: false, get: () => { reads += 1; return 'me'; } });
        reads = 0;
        const changed = computeVisibleSessionListProjection({ ...params, previousMembership: first.membership,
            conditionValueCountRequest: request });
        expect(reads).toBe(1);
        expect(changed.conditionValueCounts).toBe(first.conditionValueCounts);
        expect(changed.conditionValueCounts?.options[0]).toBe(first.conditionValueCounts?.options[0]);
        expect(changed.conditionValueCounts?.options[1]).toBe(first.conditionValueCounts?.options[1]);
        reads = 0;
        const unchanged = computeVisibleSessionListProjection({ ...params, previousMembership: changed.membership,
            conditionValueCountRequest: { ...request, options: [...request.options] } });
        expect(reads).toBe(0);
        expect(unchanged.conditionValueCounts).toBe(changed.conditionValueCounts);
        rows.set('s13', { ...rows.get('s13')!, updatedAt: 3 });
        Object.defineProperty(rows.get('s13')!, 'ownerAccountId', { enumerable: false, get: () => { reads += 1; return 'me'; } });
        const stopped = computeVisibleSessionListProjection({ ...params, previousMembership: unchanged.membership });
        expect(stopped.conditionValueCounts).toBeUndefined();
        expect(reads).toBe(0);
        const unsupported = computeVisibleSessionListProjection({ ...params, previousMembership: stopped.membership,
            conditionValueCountRequest: { fieldId: 'audiences', options: [{ value: { serverId: 'home', kind: 'team', teamId: 'team' } }] } });
        expect(unsupported.conditionValueCounts).toEqual({ fieldId: 'audiences',
            options: [{ value: { serverId: 'home', kind: 'team', teamId: 'team' } }] });
        expect(reads).toBe(0);
        const machineRequest = { fieldId: 'machines', options: Array.from({ length: 140 }, (_, index) => ({
            value: { serverId: 'home', machineId: `m${index}` },
        })) };
        const machines = computeVisibleSessionListProjection({ ...params, previousMembership: stopped.membership,
            conditionValueCountRequest: machineRequest });
        expect(reads).toBe(1_000);
        expect(machines.conditionValueCounts?.options[12]?.count).toBe(8);
        expect(machines.conditionValueCounts?.options[139]?.count).toBe(0);
        rows.set('s12', { ...rows.get('s12')!, metadata: { path: '/repo', machineId: 'm139' } });
        Object.defineProperty(rows.get('s12')!, 'ownerAccountId', { enumerable: false, get: () => { reads += 1; return 'me'; } });
        reads = 0;
        const moved = computeVisibleSessionListProjection({ ...params, previousMembership: machines.membership,
            conditionValueCountRequest: machineRequest });
        expect(reads).toBe(1);
        expect(moved.conditionValueCounts?.options[12]?.count).toBe(7);
        expect(moved.conditionValueCounts?.options[139]?.count).toBe(1);
        expect(moved.conditionValueCounts?.options[13]).toBe(machines.conditionValueCounts?.options[13]);
        const removed = computeVisibleSessionListProjection({ ...params, source: source.filter(item => item.type !== 'session' || item.sessionId !== 's12'),
            previousMembership: moved.membership, conditionValueCountRequest: machineRequest });
        expect(removed.conditionValueCounts?.options[139]?.count).toBe(0);
        expect(reads).toBe(1);
    });

    it('counts protected Started-by, Source and Home facts independently of the current local filter', () => {
        const row = createSessionListRenderableSessionFixture({ id: 'own', active: true, ownerAccountId: 'me',
            origin: { kind: 'none' }, metadata: { path: '/repo' } });
        const params = { source: [{ type: 'session' as const, serverId: 'home', sessionId: 'own', storageKind: 'direct' as const }],
            resolveSessionRow: () => row, workflowRuns: [{ serverId: 'other', summary: createWorkflowRunSummaryFixture({ id: 'trigger', startedBy: 'trigger' }) }],
            viewerAccountIdByServerId: new Map([['home', 'me']]), hideInactiveSessions: false,
            pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 20,
            sessionListAttentionPlacementV1: 'inPlace' as const, presentation: { enabled: false, presentation: 'grouped' as const },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home', 'other'], startedBy: ['agents'], source: 'persisted' }) };
        for (const [fieldId, options] of [
            ['startedBy', [{ value: 'you', count: 1 }, { value: 'triggers', count: 1 }, { value: 'agents', count: 0 }]],
            ['source', [{ value: 'direct', count: 1 }, { value: 'persisted', count: 1 }]],
            ['homeServerIds', [{ value: 'home', count: 1 }, { value: 'other', count: 1 }]],
        ] as const) {
            expect(computeVisibleSessionListProjection({ ...params, conditionValueCountRequest: {
                fieldId, options: options.map(({ value }) => ({ value })),
            } }).conditionValueCounts)
                .toEqual({ fieldId, options });
        }
    });

    it('uses canonical unreadable Source presentation while keeping a missing row unavailable', () => {
        const row = createSessionListRenderableSessionFixture({ id: 'locked', metadata: null, metadataUnavailable: true });
        const params = { source: [{ type: 'session' as const, serverId: 'home', sessionId: row.id }], resolveSessionRow: () => row,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 20,
            sessionListAttentionPlacementV1: 'inPlace' as const, presentation: { enabled: false, presentation: 'grouped' as const },
            conditionValueCountRequest: { fieldId: 'source', options: [{ value: 'persisted' }, { value: 'direct' }] } };
        expect(computeVisibleSessionListProjection(params).conditionValueCounts).toEqual({ fieldId: 'source',
            options: [{ value: 'persisted', count: 1 }, { value: 'direct', count: 0 }] });
        expect(computeVisibleSessionListProjection({ ...params, resolveSessionRow: () => null }).conditionValueCounts).toEqual({ fieldId: 'source',
            options: [{ value: 'persisted' }, { value: 'direct' }] });
        expect(computeVisibleSessionListProjection({ ...params, source: [{ ...params.source[0]!, storageKind: 'direct' }] }).conditionValueCounts)
            .toEqual({ fieldId: 'source', options: [{ value: 'persisted', count: 0 }, { value: 'direct', count: 1 }] });
    });

    it('counts admitted scope, attention, Bot and Coordinator facts without inventing unavailable evidence', () => {
        const yes = createSessionListRenderableSessionFixture({ id: 'yes', active: true,
            metadata: { path: '/repo', bot: { kind: 'bot' } }, receivedRuleCount: 1,
            viewer: createSessionViewerFixture({ relevance: { relevant: true, reasons: ['responsible_for_me'] },
                attention: { needsAttention: true, primary: 'manual', reasons: ['manual'], presentation: 'full' } }) });
        const no = createSessionListRenderableSessionFixture({ id: 'no', active: true, receivedRuleCount: 0,
            managedSessions: { total: 0, working: 0, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null },
            viewer: createSessionViewerFixture() });
        const unknown = createSessionListRenderableSessionFixture({ id: 'unknown', active: true,
            metadata: null, metadataUnavailable: true });
        const rows = new Map([yes, no, unknown].map(row => [row.id, row]));
        const item = (sessionId: string): SessionListIndexItem => ({ type: 'session', serverId: 'home', sessionId });
        const params = { source: [item('yes'), item('no')],
            resolveSessionRow: (_home: string | null | undefined, id: string) => rows.get(id) ?? null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 20,
            sessionListAttentionPlacementV1: 'inPlace' as const, presentation: { enabled: false, presentation: 'grouped' as const } };
        for (const [fieldId, options] of [
            ['scope', [{ value: 'assigned_to_me', count: 1 }, { value: 'all_accessible', count: 2 }]],
            ['attention', [{ value: 'needs_my_attention', count: 1 }, { value: 'any', count: 2 }]],
            ['bot', [{ value: 'bot', count: 1 }, { value: 'ordinary', count: 1 }]],
            ['coordinator', [{ value: 'coordinator', count: 1 }]],
        ] as const) {
            const conditionValueCountRequest = { fieldId, options };
            expect(computeVisibleSessionListProjection({ ...params, conditionValueCountRequest }).conditionValueCounts)
                .toEqual({ fieldId, options });
            const unavailable = computeVisibleSessionListProjection({ ...params, source: [...params.source, item('unknown')],
                conditionValueCountRequest });
            expect(unavailable.conditionValueCounts).toEqual({ fieldId, options: options.map(option => ({ value: option.value,
                ...(option.value === 'all_accessible' || option.value === 'any' ? { count: 3 } : {}) })) });
        }
        expect(computeVisibleSessionListProjection({ ...params, conditionValueCountRequest: {
            fieldId: 'includeInactive', options: [{ value: true }, { value: false }],
        } }).conditionValueCounts).toEqual({ fieldId: 'includeInactive', options: [{ value: true }, { value: false }] });
    });

    it('counts grouped Status occurrences once across mirrors and native kinds, while omitting unheld structural and unknown facts', () => {
        const row = createSessionListRenderableSessionFixture({ id: 'request', active: true, presence: 'online',
            ownerAccountId: 'me', hasPendingPermissionRequests: true, metadata: { path: '/repo' } });
        const step = { ...row, id: 'step', origin: { kind: 'run_step' as const, runId: 'run' } };
        const outside = { ...row, id: 'outside' };
        const session = (sessionId: string, groupKind: 'project' | 'attention' = 'project'): SessionListIndexItem => ({
            type: 'session', serverId: 'home', sessionId, groupKind, groupKey: groupKind });
        const params = { source: [session('request'), session('request', 'attention'), session('step')],
            attentionSource: [session('outside')], includeNeedsYouEverywhere: true,
            resolveSessionRow: (_home: string | null | undefined, id: string) => id === 'request' ? row : id === 'step' ? step : outside,
            workflowRuns: [{ serverId: 'home', summary: createWorkflowRunSummaryFixture({ id: 'run', startedBy: 'trigger',
                state: 'waiting_for_review', attentionRequired: true, invocationAttentionRequired: true }) }],
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 20,
            sessionListAttentionPlacementV1: 'inPlace' as const, presentation: { enabled: false, presentation: 'grouped' as const } };
        const options = [{ value: 'needs_you', values: [...listSessionPresentationStatesForWorkStatusFilterV1('needs_you')] },
            { value: 'offline', values: [...listSessionPresentationStatesForWorkStatusFilterV1('offline')] }];
        const positive = computeVisibleSessionListProjection({ ...params, conditionValueCountRequest: { fieldId: 'statuses', options } });
        expect(positive.conditionValueCounts).toEqual({ fieldId: 'statuses', options: [{ value: 'needs_you', count: 2 }, { value: 'offline', count: 0 }] });
        expect(computeVisibleSessionListProjection({ ...params, conditionValueCountRequest: { fieldId: 'excludedStatuses', options } }).conditionValueCounts)
            .toEqual({ ...positive.conditionValueCounts, fieldId: 'excludedStatuses' });
        expect(computeVisibleSessionListProjection({ ...params, conditionValueCountRequest: { fieldId: 'show',
            options: [{ value: 'sessions' }, { value: 'runs' }, { value: 'both' }] } }).conditionValueCounts)
            .toEqual({ fieldId: 'show', options: [{ value: 'sessions', count: 1 }, { value: 'runs', count: 1 }, { value: 'both', count: 2 }] });
        for (const fieldId of ['audiences', 'tagIds', 'underSessionId', 'futureField']) {
            expect(computeVisibleSessionListProjection({ ...params, conditionValueCountRequest: { fieldId, options: [{ value: 'unknown' }] } }).conditionValueCounts)
                .toEqual({ fieldId, options: [{ value: 'unknown' }] });
        }
        expect(computeVisibleSessionListProjection({ ...params, conditionValueCountRequest: { fieldId: 'startedBy', options: [{ value: 'you' }] } }).conditionValueCounts)
            .toEqual({ fieldId: 'startedBy', options: [{ value: 'you' }] });
    });

    function supplementFixture() {
        const rows = new Map(['inside', 'request', 'quiet'].map(id => [id, createSessionListRenderableSessionFixture({ id,
            active: true, presence: 'online', ownerAccountId: 'me', hasPendingPermissionRequests: id === 'request',
            metadata: { path: '/repo', machineId: id === 'inside' ? 'inside-machine' : 'outside-machine' } })]));
        const item = (sessionId: string): SessionListIndexItem => ({ type: 'session', serverId: 'home', sessionId,
            groupKey: 'repo', groupKind: 'project' });
        const params = { source: [item('inside')], attentionSource: ['inside', 'request', 'quiet'].map(item),
            includeNeedsYouEverywhere: true, resolveSessionRow: (_home: string | null | undefined, id: string) => rows.get(id) ?? null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 20,
            sessionListAttentionPlacementV1: 'inPlace' as const, presentation: { enabled: false, presentation: 'grouped' as const },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
                machines: { include: [{ serverId: 'home', machineId: 'inside-machine' }], exclude: [] } }) };
        return { rows, params };
    }

    it('opts into held out-of-space Needs-you rows without admitting quiet relatives or counting them as ordinary matches', () => {
        const { params } = supplementFixture();
        const ordinary = computeVisibleSessionListProjection({ ...params, includeNeedsYouEverywhere: false });
        expect(ordinary.items?.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['inside']);
        const supplement = computeVisibleSessionListProjection(params);
        expect(supplement.items?.filter(item => item.type === 'session').map(item => item.sessionId).sort()).toEqual(['inside', 'request']);
        expect(supplement.filterResult).toEqual({ matchedCount: 1, attentionSupplementCount: 1, coverage: 'complete' });
        expect(supplement.items?.find(item => item.type === 'session' && item.sessionId === 'request')).toMatchObject({ supplementalAttention: true });
    });

    it('refuses a held Needs-you supplement whose fixed Team audience cannot be proved', () => {
        const { params } = supplementFixture();
        const fixedTeam = { ...params, fixedTeam: { serverId: 'home', teamId: 'team' } };
        const team = computeVisibleSessionListProjection(fixedTeam);
        expect(team.items?.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['inside']);
        expect(team.filterResult.attentionSupplementCount).toBe(0);
        expect(team.filterResult.coverage).toBe('partial');
    });

    it('requires exact applied Team query proof even for the main source, without confusing it with outside held rows', () => {
        const { params } = supplementFixture();
        const ordinary = { ...params, source: params.attentionSource, fixedTeam: { serverId: 'home', teamId: 'team' } };
        const unproved = computeVisibleSessionListProjection(ordinary);
        expect(unproved.items?.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['inside']);
        expect(unproved.filterResult).toEqual({ matchedCount: 1, attentionSupplementCount: 0, coverage: 'partial' });
        const proven = { ...ordinary, fixedTeamQueryServerIds: new Set(['home']) };
        const qualified = computeVisibleSessionListProjection(proven);
        expect(qualified.items?.filter(item => item.type === 'session').map(item => item.sessionId).sort()).toEqual(['inside', 'request']);
        expect(qualified.filterResult).toEqual({ matchedCount: 1, attentionSupplementCount: 1, coverage: 'complete' });
    });

    it('does not count an active Needs-you supplement in the archived corpus', () => {
        const { params } = supplementFixture();
        const archived = computeVisibleSessionListProjection({ ...params, corpusStorage: 'archived' });
        expect(archived.items?.filter(item => item.type === 'session')).toEqual([]);
        expect(archived.filterResult.attentionSupplementCount).toBe(0);
    });

    it('does not let a Needs-you supplement bypass the fixed storage source', () => {
        const { params } = supplementFixture();
        const direct = computeVisibleSessionListProjection({ ...params, workFilter: { ...params.workFilter, source: 'direct' } });
        expect(direct.items?.filter(item => item.type === 'session')).toEqual([]);
        expect(direct.filterResult.attentionSupplementCount).toBe(0);
    });

    it('retains a settled authorized shortcut during interaction without counting it as a live supplement', () => {
        const { rows, params } = supplementFixture();
        const supplement = computeVisibleSessionListProjection(params);
        rows.set('request', { ...rows.get('request')!, hasPendingPermissionRequests: false });
        const held = computeVisibleSessionListProjection({ ...params, attentionInteractionHeld: true,
            previousMembership: supplement.membership, previousPresentedIndex: supplement.items });
        expect(held.items?.filter(item => item.type === 'session').map(item => item.sessionId).sort()).toEqual(['inside', 'request']);
        expect(held.filterResult.attentionSupplementCount).toBe(0);
    });

    it('evaluates only a changed held entity across a thousand rows and preserves unrelated membership', () => {
        let factReads = 0;
        const rows = new Map(Array.from({ length: 1_000 }, (_, index) => [`s${index}`,
            createSessionListRenderableSessionFixture({ id: `s${index}`, ownerAccountId: 'me', active: true,
                metadata: { path: '/repo', machineId: `m${index % 139}`, flavor: 'codex' } })]));
        for (const row of rows.values()) Object.defineProperty(row, 'ownerAccountId', {
            // Observe direct fact admission, without charging unrelated presentation object spreads.
            enumerable: false, get: () => { factReads += 1; return 'me'; },
        });
        const source: SessionListIndexItem[] = [...rows.keys()].map(sessionId => ({ type: 'session', sessionId,
            serverId: 'home', groupKey: 'repo', groupKind: 'project' }));
        const workFilter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
            machines: { include: Array.from({ length: 139 }, (_, index) => ({ serverId: 'home', machineId: `m${index}` })), exclude: [] } });
        const params = { source, resolveSessionRow: (_home: string | null | undefined, id: string) => rows.get(id) ?? null,
            workFilter, nowMs: 20, viewerAccountIdByServerId: new Map([['home', 'me']]),
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' as const } };
        const first = computeVisibleSessionListProjection(params);
        expect(first.filterResult).toEqual({ matchedCount: 1_000, attentionSupplementCount: 0, coverage: 'complete' });
        expect(factReads).toBe(1_000);
        rows.set('s12', { ...rows.get('s12')!, metadata: { path: '/repo', machineId: 'm139', flavor: 'codex' } });
        Object.defineProperty(rows.get('s12')!, 'ownerAccountId', {
            enumerable: false, get: () => { factReads += 1; return 'me'; },
        });
        factReads = 0;
        const next = computeVisibleSessionListProjection({ ...params, previousMembership: first.membership,
            previousPresentedIndex: first.items });
        expect(next.filterResult).toEqual({ matchedCount: 999, attentionSupplementCount: 0, coverage: 'complete' });
        expect(factReads).toBe(1);
        const unchanged = JSON.stringify(['home', 's13']);
        expect(next.membership.sessions.get(unchanged)).toBe(first.membership.sessions.get(unchanged));
        expect(next.items?.find(item => item.type === 'session' && item.sessionId === 's13'))
            .toBe(first.items?.find(item => item.type === 'session' && item.sessionId === 's13'));
        factReads = 0;
        computeVisibleSessionListProjection({ ...params, previousMembership: next.membership, previousPresentedIndex: next.items });
        expect(factReads).toBe(0);
        const edited = computeVisibleSessionListProjection({ ...params, previousMembership: next.membership,
            workFilter: { ...workFilter, machines: { include: [{ serverId: 'home', machineId: 'm139' }], exclude: [] } } });
        expect(factReads).toBe(1_000);
        expect(edited.filterResult.matchedCount).toBe(1);
    });

    it('counts distinct matches before attention mirrors and reports unavailable narrowing honestly', () => {
        const row = createSessionListRenderableSessionFixture({ id: 's', ownerAccountId: 'me', active: true,
            metadata: { path: '/repo', machineId: 'm', flavor: 'codex' } });
        const params = { source: [
            { type: 'session' as const, sessionId: 's', serverId: 'home', groupKey: 'repo', groupKind: 'project' as const },
            { type: 'session' as const, sessionId: 's', serverId: 'home', groupKey: 'attention', groupKind: 'attention' as const },
        ], resolveSessionRow: () => row, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            nowMs: 20, presentation: { enabled: false, presentation: 'grouped' as const },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }) };
        expect(computeVisibleSessionListProjection(params).filterResult).toEqual({ matchedCount: 1, attentionSupplementCount: 0, coverage: 'complete' });
        const unknown = computeVisibleSessionListProjection({ ...params,
            workFilter: { ...params.workFilter, branches: { include: ['main'], exclude: [] } } });
        expect(unknown.filterResult).toEqual({ matchedCount: 0, attentionSupplementCount: 0, coverage: 'unavailable' });
    });

    it('excludes hidden inactive entities from matches without counting a visible attention mirror twice', () => {
        const rows = new Map(['active', 'inactive'].map(id => [id, createSessionListRenderableSessionFixture({ id,
            active: id === 'active', ownerAccountId: 'me', keepVisibleWhenInactive: false,
            metadata: { path: '/repo', machineId: 'm', flavor: 'codex' } })]));
        const source: SessionListIndexItem[] = [...rows.keys()].map(sessionId => ({ type: 'session', serverId: 'home',
            sessionId, groupKey: 'repo', groupKind: 'project' }));
        const projection = computeVisibleSessionListProjection({ source,
            resolveSessionRow: (_home, id) => rows.get(id) ?? null, hideInactiveSessions: true,
            pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }),
        });
        expect(projection.items?.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['active']);
        expect(projection.filterResult).toEqual({ matchedCount: 1, attentionSupplementCount: 0, coverage: 'complete' });
    });
});
