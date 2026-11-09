import { describe, expect, it, vi } from 'vitest';

import { SessionWorkflowRunHeadlineV1Schema, type SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStalled, readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import { NO_SESSION_AGENT_ACTIVITY_ATTENTION } from '@/sync/domains/session/agentActivity';
import { createActionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { createActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { projectSessionWorkMap } from './workMapProducer';
import {
    captureMachinePresenceObservation,
    clearMachineRequestReachabilityForTest,
    resolveMachineReachability,
    withdrawMachinePresenceForScope,
} from '@/sync/domains/machines/reachability/machineReachability';

import {
    groupWorkByState,
    projectWork,
    resolveWorkItemContextActions,
    resolveWorkMachineNotices,
    resolveWorkReadPresentation,
    resolveWorkTitleTailStarts,
    type WorkItem,
    type WorkManagedRunSource,
    type WorkProjectionInput,
    type WorkReportSessionSource,
} from './workProjection';

const fixtureNow = Date.now();
const workingFacts = readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ active: true,
    activeAt: fixtureNow, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: fixtureNow }), fixtureNow);
const needsYouFacts = readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ active: true,
    activeAt: fixtureNow, hasPendingPermissionRequests: true, pendingRequestObservedAt: fixtureNow }), fixtureNow);
const settledFacts = readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ active: true,
    activeAt: fixtureNow, latestTurnStatus: 'completed', latestTurnStatusObservedAt: fixtureNow }), fixtureNow);

function report(overrides: Partial<WorkReportSessionSource> & Pick<WorkReportSessionSource, 'sessionId' | 'managerSessionId'>): WorkReportSessionSource {
    return {
        title: overrides.sessionId,
        agentId: 'claude',
        facts: [],
        statusFacts: workingFacts,
        stalled: false,
        archived: false,
        ...overrides,
    };
}

function agentEntry(overrides: Partial<AgentActivityEntry> & Pick<AgentActivityEntry, 'id' | 'kind' | 'status'>): AgentActivityEntry {
    return {
        title: overrides.id,
        metaDetail: null,
        startedAtMs: null,
        endedAtMs: null,
        provenance: 'local',
        detailState: 'loaded',
        parentId: null,
        runId: null,
        sidechainId: null,
        subagentId: null,
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
        ...overrides,
    };
}

function managed(id: string, state: WorkManagedRunSource['run']['state'], needsAttention = false): WorkManagedRunSource {
    return { run: createWorkflowRunSummaryFixture({ id, state, workflowCustodyState: null,
        attentionRequired: needsAttention, invocationAttentionRequired: needsAttention }), title: `Run ${id}`, word: state };
}

function headline(runId: string, completedAgents: number, totalAgents: number): SessionWorkflowRunHeadlineV1 {
    return SessionWorkflowRunHeadlineV1Schema.parse({
        runId,
        title: `Headline ${runId}`,
        status: 'active',
        updatedAt: 1,
        recordRevision: '1',
        recordUpdatedAt: 1,
        totalAgents,
        completedAgents,
    });
}

function input(overrides: Partial<WorkProjectionInput>): WorkProjectionInput {
    return {
        sessionId: 'lead',
        reportSessions: [],
        agentEntries: [],
        workflowHeadlineRuns: [],
        managedRuns: [],
        ownTriggerRunIds: new Set(),
        describeAgentStatus: (entry) => entry.status,
        describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        ...overrides,
    };
}

describe('projectWork', () => {
    it('says what each report is doing and who it reports to, never the lead\'s own machine (lab convo-W8full)', () => {
        const projection = projectWork(input({
            describeReportsTo: (lead) => `reports to ${lead}`,
            reportSessions: [
                report({ sessionId: 'api', managerSessionId: 'lead', title: 'Idempotent retries', activity: 'Runbook drafted', atMs: 1_000 }),
                report({ sessionId: 'ledger', managerSessionId: 'api', title: 'Backfill intent ledger', facts: ['Studio Mac'] }),
            ],
        }));
        const [api, ledger] = projection.sessions;
        // A report of the lead says what it did; nothing repeats "reports to" down a list where every row does.
        expect(api?.facts).toEqual(['Runbook drafted']);
        expect(api?.atMs).toBe(1_000);
        // A report of a report names its lead, and keeps a machine that is not the lead's.
        expect(ledger?.facts).toEqual(['reports to Idempotent retries', 'Studio Mac']);
    });

    it('uses owner-projected Workflow failure and hold facts', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', attentionRequired: false,
            failureUnseen: false, invocationAttentionRequired: false });
        const project = (flags: Partial<typeof run>) => projectWork(input({ managedRuns: [{
            run: { ...run, ...flags }, title: 'Failed run', word: 'Failed',
        }] }));
        expect(project({}).workflows[0]?.status).toMatchObject({ tone: 'neutral', bucket: 'finished', attentionType: null });
        const unseen = project({ failureUnseen: true, attentionRequired: true });
        expect(unseen.workflows[0]?.status)
            .toMatchObject({ tone: 'danger', bucket: 'needs_you', attentionType: 'update' });
        expect(unseen.summary).toMatchObject({ outstanding: 0, needsYou: 0 });
        expect(groupWorkByState(unseen)).toMatchObject({ needsYou: [], working: [] });
        expect(groupWorkByState(unseen).recent.map(item => item.key)).toEqual([`run:${run.id}`]);
        expect(project({ invocationAttentionRequired: true, attentionRequired: true }).workflows[0]?.status)
            .toMatchObject({ tone: 'attention', bucket: 'needs_you', attentionType: 'decision' });
    });
    it('keeps an idle retained Run inspectable without counting it as outstanding work', () => {
        const idle = agentEntry({ id: 'run:writer', kind: 'execution_run', status: 'running', runId: 'writer', isActive: false });
        const settled = projectWork(input({ agentEntries: [idle] }));
        expect(settled.backgroundRuns).toHaveLength(1);
        expect(settled.backgroundRuns[0]?.status.bucket).toBe('idle');
        expect(settled.summary).toMatchObject({ outstanding: 0, needsYou: 0, runs: 1 });
        const busy = projectWork(input({ agentEntries: [{ ...idle, isActive: true }] }));
        expect(busy.summary.outstanding).toBe(1);
        const awaitingPerson = projectWork(input({ agentEntries: [{ ...idle, status: 'waiting' }] }));
        expect(awaitingPerson.summary).toMatchObject({ outstanding: 1, needsYou: 1 });
    });

    it.each([
        { active: false, latestTurnStatus: 'failed' as const, needsYou: 0, stalled: 0, outstanding: 0, group: 'recent' as const },
        { active: true, latestTurnStatus: 'failed' as const, needsYou: 0, stalled: 0, outstanding: 0, group: 'recent' as const },
        { active: false, latestTurnStatus: 'in_progress' as const, needsYou: 0, stalled: 1, outstanding: 1, group: 'recent' as const },
    ])('agrees with direct-report counts and lead settlement for $active / $latestTurnStatus', ({ active, latestTurnStatus, needsYou, stalled, outstanding, group }) => {
        const now = Date.now();
        const child = createSessionListRenderableSessionFixture({ id: 'child', active, activeAt: now,
            presence: active ? 'online' : 0, latestTurnStatus, latestTurnStatusObservedAt: now });
        const projection = projectWork(input({ reportSessions: [report({ sessionId: child.id, managerSessionId: 'lead',
            statusFacts: readSessionWorkStatusFacts(child, now), stalled: readSessionWorkStalled(child, now) })] }));
        expect(projection.summary).toMatchObject({ needsYou, stalled, outstanding });
        expect(groupWorkByState(projection)[group].map(item => item.key)).toEqual(['session:child']);
        const lead = createSessionListRenderableSessionFixture({ active: true, activeAt: now, latestTurnStatus: 'completed',
            managedSessions: { total: 1, working: 0, needsYou, stalled, finished: 0, attentionPrimary: null } });
        expect(readSessionWorkStatusFacts(lead, now).settled).toBe(outstanding === 0);
    });

    it('retains unchanged work identities when unrelated work updates', () => {
        const a = report({ sessionId: 'a', managerSessionId: 'lead' });
        const b = report({ sessionId: 'b', managerSessionId: 'lead' });
        const first = projectWork(input({ reportSessions: [a, b], managedRuns: [managed('run', 'running')] }));
        const next = projectWork(input({ reportSessions: [a, { ...b, title: 'Updated B' }], managedRuns: [managed('run', 'running')] }), first);
        expect(next.sessions[0]).toBe(first.sessions[0]);
        expect(next.sessions[1]).not.toBe(first.sessions[1]);
        expect(next.sessions[1]?.title).toBe('Updated B');
        expect(next.workflows).toBe(first.workflows);
        expect(next.summary).toBe(first.summary);
        expect(projectWork(input({ reportSessions: [a, b], managedRuns: [managed('run', 'running')] }), first)).toBe(first);
    });
    it('retains a report flattened into a different state group when unrelated work changes', () => {
        const parent = report({ sessionId: 'parent', managerSessionId: 'lead', statusFacts: needsYouFacts });
        const child = report({ sessionId: 'child', managerSessionId: 'parent' });
        const other = report({ sessionId: 'other', managerSessionId: 'lead' });
        const first = projectWork(input({ reportSessions: [parent, child, other] }));
        const groups = groupWorkByState(first);
        const next = groupWorkByState(projectWork(input({ reportSessions: [parent, child, { ...other, title: 'Changed' }] }), first), groups);
        expect(next.working.find((item) => item.key === 'session:child')).toBe(groups.working.find((item) => item.key === 'session:child'));
        expect(next.working.find((item) => item.key === 'session:child')?.level).toBe(0);
    });
    it('projects an admitted Script once before output exists, retaining its exact target after failure and cancellation', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        // The process/output target may differ from the authenticated operation's custody Home and Machine.
        const attachment = { kind: 'projectCommand', purpose: 'script', serverId: 'target-home', machineId: 'target-machine', workspaceRefId: 'workspace', cwd: '/repo' } as const;
        const snapshot: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'command', revision: 1, actionId: 'projects.script.run',
            state: 'accepted', scope: { accountId: 'account', machineId: 'machine', sessionId: 'lead' },
            title: 'Build', createdAt: 1, cancellation: 'supported',
            domainRef: attachment,
        };
        const read = () => projectWork(input({ serverId: 'home', accountId: 'account',
            actionOperations: selectors.selectForSession(store.getSnapshot(), { serverId: 'home', accountId: 'account', sessionId: 'lead' }),
            describeOperationStatus: (operation) => resolveActionOperationStatus(operation.snapshot, operation.observation).label.value }));
        store.mergeSnapshots({ serverId: 'home', snapshots: [snapshot] });
        let projection = read();
        expect(projection.projectCommands).toHaveLength(1);
        expect(projection.projectCommands[0].operation?.snapshot.domainRef).toEqual(attachment);
        const key = projection.projectCommands[0].key;
        expect(groupWorkByState(projection).working.map((item) => item.key)).toEqual([key]);
        expect(projection.summary).toMatchObject({ outstanding: 1, runs: 1 });
        expect(projection.projectCommands[0].open).toEqual({ kind: 'action_operation', serverId: 'home', operationId: 'command' });
        expect(resolveWorkItemContextActions(projection.projectCommands[0])).toEqual({
            open: { kind: 'action_operation', serverId: 'home', operationId: 'command' },
            transcript: { serverId: 'home', sessionId: 'lead' },
            stop: { serverId: 'home', machineId: 'machine', operationId: 'command' },
        });
        expect(projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection }).nodesById.get(key)?.open)
            .toEqual(projection.projectCommands[0].open);
        store.mergeSnapshots({ serverId: 'home', snapshots: [{ ...snapshot, revision: 2,
            setupReview: { kind: 'pendingApproval', code: 'project_setup_effect_changed', reviewedEffectDigest: 'reviewed', reviewedEffect: {} },
        }] });
        projection = read();
        expect(projection.projectCommands[0].status).toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'needs_review' });
        expect(groupWorkByState(projection).needsYou.map((item) => item.key)).toEqual([key]);
        expect(projection.summary).toMatchObject({ outstanding: 1, needsYou: 1, runs: 1 });
        expect(projection.projectCommands[0].operation?.snapshot.state).toBe('accepted');
        expect(resolveWorkItemContextActions(projection.projectCommands[0]).stop)
            .toEqual({ serverId: 'home', machineId: 'machine', operationId: 'command' });
        for (const [revision, kind] of [[3, 'outcome_uncertain'], [4, 'stop_unconfirmed']] as const) {
            store.mergeSnapshots({ serverId: 'home', snapshots: [{ ...snapshot, revision, state: 'running', startedAt: 2,
                observation: { kind, code: 'owner_not_observed' } }] });
            projection = read();
            // A lost acknowledgement is named as such; an unconfirmed stop is the owner being unavailable.
            expect(projection.projectCommands[0].status).toMatchObject({ bucket: 'working', tone: 'attention',
                word: kind === 'outcome_uncertain' ? 'outcome_uncertain' : 'unavailable' });
            expect(projection.summary.outstanding).toBe(1);
            expect(projection.projectCommands[0].operation?.snapshot.state).toBe('running');
            expect(resolveWorkItemContextActions(projection.projectCommands[0]).stop)
                .toEqual(kind === 'stop_unconfirmed' ? { serverId: 'home', machineId: 'machine', operationId: 'command' } : null);
            expect(selectors.selectForSession(store.getSnapshot(), { serverId: 'home', accountId: 'account', sessionId: 'lead' })[0].observation)
                .toBe('unavailable');
        }
        store.setMachineObservation({ serverId: 'home', machineId: 'machine' }, 'unavailable');
        expect(read().projectCommands[0].status).toMatchObject({ bucket: 'working', tone: 'attention' });
        for (const [revision, state] of [[2, 'failed'], [3, 'cancelled']] as const) {
            const terminal = { ...snapshot, revision, state, startedAt: 2, settledAt: 3,
                ...(state === 'failed' ? { error: { errorCode: 'exit', error: 'Exit 1' } } : {}),
                domainRef: { ...attachment, terminalId: 'terminal' },
            };
            // A new store models each independent owner settlement (terminal outcomes never transition).
            const settledStore = createActionOperationStore();
            settledStore.mergeSnapshots({ serverId: 'home', snapshots: [terminal] });
            projection = projectWork(input({ serverId: 'home', accountId: 'account', actionOperations: selectors.selectForSession(
                settledStore.getSnapshot(), { serverId: 'home', accountId: 'account', sessionId: 'lead' }) }));
            expect(groupWorkByState(projection).recent.map((item) => item.key)).toEqual([key]);
            expect(projection.projectCommands[0].operation?.snapshot.domainRef).toMatchObject({ terminalId: 'terminal' });
            expect(projection.summary.outstanding).toBe(0);
            expect(resolveWorkItemContextActions(projection.projectCommands[0]).stop).toBeNull();
        }
    });

    it('keeps workflow command leaves in the represented run and excludes own trigger, foreign Home, Account and sessionless work', () => {
        const store = createActionOperationStore();
        const command = (id: string, runId?: string): ActionOperationSnapshotV1 => ({
            version: 1, operationId: id, revision: 1, actionId: 'projects.script.run', state: 'accepted',
            scope: { accountId: 'account', machineId: 'machine', sessionId: 'lead' }, title: id,
            createdAt: 1, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
                serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/repo',
                ...(runId ? { originRun: { kind: 'workflow_run', serverId: 'home', runId } } : {}),
            },
        });
        store.mergeSnapshots({ serverId: 'home', snapshots: [command('leaf', 'run'), command('trigger-leaf', 'trigger'),
            { ...command('other-account'), scope: { accountId: 'other', machineId: 'machine', sessionId: 'lead' } },
            { ...command('no-session'), scope: { accountId: 'account', machineId: 'machine' } }] });
        store.mergeSnapshots({ serverId: 'elsewhere', snapshots: [command('leaf')] });
        const operations = createActionOperationSelectors().selectAll(store.getSnapshot());
        const projection = projectWork(input({ serverId: 'home', accountId: 'account', actionOperations: operations,
            managedRuns: [managed('run', 'running')], ownTriggerRunIds: new Set(['trigger']) }));
        expect(projection.projectCommands).toEqual([]);
        expect(projection.workflows[0].projectCommands?.map((item) => item.title)).toEqual(['leaf']);
        expect(projection.summary).toMatchObject({ outstanding: 1, runs: 1 });
        const elsewhere = projectWork(input({ serverId: 'elsewhere', accountId: 'account', actionOperations: operations }));
        expect(elsewhere.projectCommands.map((item) => item.open)).toEqual([
            { kind: 'action_operation', serverId: 'elsewhere', operationId: 'leaf' },
        ]);
    });

    it('distinguishes an unreadable first managed read from proven empty work and quiet disabled work', () => {
        const projection = projectWork(input({}));
        const read = (phase: 'idle' | 'loading' | 'loaded' | 'failed', refreshFailed = false) =>
            resolveWorkReadPresentation({ projection, managedRuns: { phase, refreshFailed }, transcriptLoaded: true });
        expect(read('failed', true)).toEqual({ nothingYet: false, holdWorkingPlace: false, managedUnavailable: true });
        expect(read('loading')).toEqual({ nothingYet: false, holdWorkingPlace: true, managedUnavailable: false });
        expect(read('loaded')).toEqual({ nothingYet: true, holdWorkingPlace: false, managedUnavailable: false });
        expect(read('idle')).toEqual({ nothingYet: true, holdWorkingPlace: false, managedUnavailable: false });
        // A failed refresh, including one of a known empty window, is not proof of current emptiness.
        expect(read('loaded', true).nothingYet).toBe(false);
    });

    it('does not turn withdrawn unknown presence into a definite offline warning', () => {
        const scope = { serverId: 'work-notice-home', accountId: 'work-notice-account' };
        const machine = { id: 'work-notice-machine', active: true, activeAt: Date.now() };
        const notices = () => {
            const machineReachability = resolveMachineReachability(scope, machine);
            return resolveWorkMachineNotices({
                machineReachability,
                nothingYet: false,
                unavailableReason: 'machineOffline',
                managedUnavailable: false,
            });
        };
        try {
            expect(notices().offline).toBe(false);
            withdrawMachinePresenceForScope(scope);
            expect(resolveMachineReachability(scope, machine)).toBe('unknown');
            expect(notices()).toEqual({ offline: false, unavailable: false, runsUnavailable: false, runsStale: false });
            captureMachinePresenceObservation(scope)([machine.id]);
            expect(resolveMachineReachability(scope, machine)).toBe('reachable');
            expect(notices().offline).toBe(false);
        } finally { clearMachineRequestReachabilityForTest(); }
    });

    it('says an offline machine once: the pane notice carries it, so no second "needs this machine online" line', () => {
        // Work is listed and the machine is down: the pane's offline notice alone (lab `convo-ST`).
        expect(resolveWorkMachineNotices({ machineReachability: 'unreachable', nothingYet: false, unavailableReason: 'machineOffline', managedUnavailable: false }))
            .toEqual({ offline: true, unavailable: false, runsUnavailable: false, runsStale: false });
        // Another reason agents cannot start is its own message beside the offline notice.
        expect(resolveWorkMachineNotices({ machineReachability: 'unreachable', nothingYet: false, unavailableReason: 'sessionInactive', managedUnavailable: false }))
            .toEqual({ offline: true, unavailable: true, runsUnavailable: false, runsStale: false });
        expect(resolveWorkMachineNotices({ machineReachability: 'reachable', nothingYet: false, unavailableReason: 'machineOffline', managedUnavailable: false }))
            .toEqual({ offline: false, unavailable: true, runsUnavailable: false, runsStale: false });
        // With nothing started, the empty state explains it instead of either line.
        expect(resolveWorkMachineNotices({ machineReachability: 'unreachable', nothingYet: true, unavailableReason: 'machineOffline', managedUnavailable: false }))
            .toEqual({ offline: false, unavailable: false, runsUnavailable: false, runsStale: false });
    });

    it('does not stack an "Unavailable" runs line with its own Retry under the offline notice that already says why', () => {
        // Runs cannot be read while the machine is not answering: the pane's one offline line says so (and retries).
        expect(resolveWorkMachineNotices({ machineReachability: 'unreachable', nothingYet: false, unavailableReason: null, managedUnavailable: true }))
            .toEqual({ offline: true, unavailable: false, runsUnavailable: false, runsStale: false });
        // A runs read that failed on its own, with the machine answering, still says what failed and offers Retry.
        expect(resolveWorkMachineNotices({ machineReachability: 'reachable', nothingYet: false, unavailableReason: null, managedUnavailable: true }))
            .toEqual({ offline: false, unavailable: false, runsUnavailable: true, runsStale: false });
    });

    it('uses the combined offline recovery for retained runs, keeping a runs-only failure when reachable', () => {
        for (const machineReachability of ['unreachable', 'reachable'] as const) {
            expect(resolveWorkMachineNotices({ machineReachability, nothingYet: false, unavailableReason: null,
                managedUnavailable: false, managedStale: true })).toEqual({
                offline: machineReachability === 'unreachable', unavailable: false, runsUnavailable: false, runsStale: machineReachability === 'reachable',
            });
        }
    });

    it('keeps the words that tell sibling titles apart, with one word of context, and leaves distinct titles alone', () => {
        expect(resolveWorkTitleTailStarts(['ORC QA seed 13 child A', 'ORC QA seed 13 child B', 'Webhook replay tool']))
            .toEqual([15, 15, null]);
        // Titles that already differ in their first words truncate at the end as usual.
        expect(resolveWorkTitleTailStarts(['Fix login bug', 'Fix logout bug'])).toEqual([null, null]);
        // The difference already sits in the first words (kept by an ordinary end truncation); identical titles have none to show.
        expect(resolveWorkTitleTailStarts(['Deploy', 'Deploy the staging stack'])).toEqual([null, null]);
        expect(resolveWorkTitleTailStarts(['Nightly deploy of the payments api', 'Nightly deploy of the billing api']))
            .toEqual([18, 18]);
        expect(resolveWorkTitleTailStarts(['Same name', 'Same name'])).toEqual([null, null]);
    });

    it('holds Working\'s place while runs arrive only when nothing else is shown, so known rows never jump up', () => {
        const withReports = projectWork(input({ reportSessions: [report({ sessionId: 'child', managerSessionId: 'lead' })] }));
        const loading = resolveWorkReadPresentation({
            projection: withReports, managedRuns: { phase: 'loading', refreshFailed: false }, transcriptLoaded: true,
        });
        // The Sessions under the lead already fill the list: no placeholder above them that later collapses.
        expect(loading).toEqual({ nothingYet: false, holdWorkingPlace: false, managedUnavailable: false });
    });

    it('does not invite a Session to start work while its archived reports are still being read', () => {
        const projection = projectWork(input({}));
        const read = (archivedLoading: boolean) => resolveWorkReadPresentation({
            projection, managedRuns: { phase: 'loaded', refreshFailed: false }, transcriptLoaded: true, archivedLoading,
        });
        // An archived child is something the Session did: the invitation waits for that answer, holding the place.
        expect(read(true)).toEqual({ nothingYet: false, holdWorkingPlace: true, managedUnavailable: false });
        expect(read(false)).toEqual({ nothingYet: true, holdWorkingPlace: false, managedUnavailable: false });
    });

    it('lists the manager subtree once, each session under its lead, and ignores unrelated sessions', () => {
        const projection = projectWork(input({
            reportSessions: [
                report({ sessionId: 'api', managerSessionId: 'lead' }),
                report({ sessionId: 'ledger', managerSessionId: 'api' }),
                report({ sessionId: 'checkout', managerSessionId: 'lead', statusFacts: needsYouFacts }),
                report({ sessionId: 'elsewhere', managerSessionId: 'other-lead' }),
                report({ sessionId: 'root', managerSessionId: null }),
            ],
        }));

        expect(projection.sessions.map((item) => [item.key, item.parentKey, item.level])).toEqual([
            ['session:api', null, 0],
            ['session:ledger', 'session:api', 1],
            ['session:checkout', null, 0],
        ]);
        expect(projection.sessions[2]?.status.bucket).toBe('needs_you');
    });

    it('lists archived direct reports apart from live work and its counts, so an archived child is never "nothing started"', () => {
        const projection = projectWork(input({
            reportSessions: [
                report({ sessionId: 'api', managerSessionId: 'lead' }),
                report({ sessionId: 'old-child', managerSessionId: 'lead', archived: true }),
                report({ sessionId: 'old-grandchild', managerSessionId: 'old-child', archived: true }),
                report({ sessionId: 'elsewhere', managerSessionId: 'other-lead', archived: true }),
            ],
        }));

        expect(projection.sessions.map((item) => item.key)).toEqual(['session:api']);
        expect(projection.summary).toMatchObject({ sessions: 1, outstanding: 1 });
        expect(projection.archivedSessions.map((item) => [item.key, item.level, item.status.word, item.open])).toEqual([
            ['session:old-child', 0, 'sessionWork.states.archived', { kind: 'session', sessionId: 'old-child' }],
        ]);
        expect(groupWorkByState(projection).archived).toBe(projection.archivedSessions);
        expect(projectWork(input({ reportSessions: [] })).archivedSessions).toEqual([]);
    });

    it('never loops on a cycle the store transiently holds', () => {
        const projection = projectWork(input({
            reportSessions: [
                report({ sessionId: 'a', managerSessionId: 'lead' }),
                report({ sessionId: 'b', managerSessionId: 'a' }),
                report({ sessionId: 'a', managerSessionId: 'b' }),
            ],
        }));
        expect(projection.sessions.map((item) => item.key)).toEqual(['session:a', 'session:b']);
    });

    it('keeps live grandchildren reachable through archived intermediates without counting archived work', () => {
        const projection = projectWork(input({ reportSessions: [
            report({ sessionId: 'api', managerSessionId: 'lead', statusFacts: settledFacts }),
            report({ sessionId: 'old-worker', managerSessionId: 'api', archived: true }),
            report({ sessionId: 'approval', managerSessionId: 'old-worker', statusFacts: needsYouFacts }),
            report({ sessionId: 'old-direct', managerSessionId: 'lead', archived: true }),
            report({ sessionId: 'live-worker', managerSessionId: 'old-direct' }),
            // An archived edge may participate in the same transient cycles as live edges.
            report({ sessionId: 'old-direct', managerSessionId: 'live-worker', archived: true }),
        ] }));
        expect(projection.sessions.map(item => [item.key, item.parentKey, item.level, item.status.bucket])).toEqual([
            ['session:api', null, 0, 'idle'],
            ['session:approval', 'session:api', 1, 'needs_you'],
            ['session:live-worker', null, 0, 'working'],
        ]);
        expect(projection.archivedSessions.map(item => item.key)).toEqual(['session:old-direct']);
        expect(projection.summary).toMatchObject({ sessions: 3, outstanding: 2, needsYou: 1 });
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection });
        expect(map.nodesById.get('session:approval')?.parentNodeId).toBe('session:api');
        expect(map.nodesById.get('session:live-worker')?.parentNodeId).toBe('session:lead');
    });

    it('agrees with History while Stop custody is pending and after it settles', () => {
        const run = createWorkflowRunSummaryFixture({ id: 'stopping', state: 'cancelled', workflowCustodyState: 'pending' });
        const read = (workflowCustodyState: typeof run.workflowCustodyState) => {
            const current = { ...run, workflowCustodyState };
            const history = describeWorkflowRunState(current.state, { workflowCustodyState });
            const projection = projectWork(input({ managedRuns: [{
                run: current, title: 'Stopping run', word: history.label,
            }] }));
            expect(projection.workflows[0]?.status.word).toBe(history.label);
            return { history, projection, groups: groupWorkByState(projection) };
        };
        const pending = read('pending');
        expect(pending.history.terminal).toBe(false);
        expect(pending.groups.working.map(item => item.key)).toEqual(['run:stopping']);
        expect(pending.projection.summary.outstanding).toBe(1);
        const settled = read('settled');
        expect(settled.history.terminal).toBe(true);
        expect(settled.groups.recent.map(item => item.key)).toEqual(['run:stopping']);
        expect(settled.projection.summary.outstanding).toBe(0);
    });

    it('classifies each report from the Session owner\'s work-status facts, with no settled rule of its own', () => {
        const NOW = 1_000_000;
        const sessions = [
            // Its latest turn completed and the owner says Ready: settled, so it is finished, not stalled.
            createSessionListRenderableSessionFixture({ id: 'settled', active: false, activeAt: 1, latestTurnStatus: 'completed' }),
            createSessionListRenderableSessionFixture({
                id: 'asks', active: true, activeAt: NOW, hasPendingPermissionRequests: true, pendingRequestObservedAt: NOW,
            }),
            createSessionListRenderableSessionFixture({ id: 'busy', active: true, activeAt: NOW, thinking: true, thinkingAt: NOW }),
        ];
        const projection = projectWork(input({
            reportSessions: sessions.map((session) => report({
                sessionId: session.id,
                managerSessionId: 'lead',
                statusFacts: readSessionWorkStatusFacts(session, NOW),
            })),
        }));

        expect(projection.sessions.map((item) => item.status)).toEqual(sessions.map((session) => (
            resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(session, NOW) })
        )));
        expect(projection.sessions.map((item) => item.status.bucket)).toEqual(['finished', 'needs_you', 'working']);
        expect(projection.summary).toMatchObject({ outstanding: 2, needsYou: 1 });
    });

    it('never finishes a report while its own reports are still working (R-10), however deep', () => {
        const projection = projectWork(input({
            reportSessions: [
                report({ sessionId: 'api', managerSessionId: 'lead', statusFacts: settledFacts }),
                report({ sessionId: 'ledger', managerSessionId: 'api', statusFacts: settledFacts }),
                report({ sessionId: 'probe', managerSessionId: 'ledger' }),
                report({ sessionId: 'docs', managerSessionId: 'lead', statusFacts: settledFacts }),
            ],
        }));

        expect(projection.sessions.map((item) => [item.key, item.status.bucket])).toEqual([
            ['session:api', 'idle'],
            ['session:ledger', 'idle'],
            ['session:probe', 'working'],
            ['session:docs', 'finished'],
        ]);
        // Only the working report is outstanding work; its leads are not counted twice.
        expect(projection.summary.outstanding).toBe(1);
        // Not finished, so not counted done; an idle lead waits in Recent while its report works on.
        const groups = groupWorkByState(projection);
        expect(groups.working.map((item) => item.key)).toEqual(['session:probe']);
        expect(groups.recent.map((item) => [item.key, item.status.bucket])).toEqual([
            ['session:api', 'idle'], ['session:ledger', 'idle'], ['session:docs', 'finished'],
        ]);
    });

    it('counts a report as stalled only from the owner\'s stalled fact, not because it is offline and unsettled', () => {
        const offline = readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({
            active: false, presence: 0,
        }), fixtureNow);
        const projection = projectWork(input({
            reportSessions: [
                // Offline with a turn in flight: stalled.
                report({ sessionId: 'cut-off', managerSessionId: 'lead', stalled: true, statusFacts: { ...offline, settled: false } }),
                // Offline, no turn in flight, its own report still working: not settled, not stalled.
                report({ sessionId: 'waiting-on-reports', managerSessionId: 'lead', statusFacts: { ...offline, settled: true } }),
                report({ sessionId: 'probe', managerSessionId: 'waiting-on-reports' }),
            ],
        }));

        expect(projection.sessions.find((item) => item.key === 'session:waiting-on-reports')?.status.bucket).not.toBe('finished');
        expect(projection.summary.stalled).toBe(1);
    });

    it('counts one workflow run once across agent activity, workflow activity and the managed run list', () => {
        const projection = projectWork(input({
            managedRuns: [managed('run-1', 'running', true)],
            agentEntries: [
                agentEntry({ id: 'wf:run-1', kind: 'workflow_run', status: 'running', runId: 'run-1' }),
                agentEntry({ id: 'wf:run-1:agent-a', kind: 'workflow_agent', status: 'running', runId: 'run-1', parentId: 'wf:run-1' }),
                agentEntry({ id: 'wf:run-2', kind: 'workflow_run', status: 'running', runId: 'run-2' }),
            ],
            workflowHeadlineRuns: [headline('run-1', 7, 12)],
        }));

        expect(projection.workflows.map((item) => item.key)).toEqual(['run:run-1', 'run:run-2']);
        // The managed run is the server truth for state and attention; the headline adds progress.
        expect(projection.workflows[0]).toMatchObject({
            title: 'Run run-1',
            progress: { completed: 7, total: 12 },
            facts: ['7 of 12'],
            status: { bucket: 'needs_you' },
        });
        expect(projection.summary).toMatchObject({ runs: 2, outstanding: 2, needsYou: 1 });
    });

    it('excludes the session\'s own trigger runs from items and counts', () => {
        const projection = projectWork(input({
            managedRuns: [managed('trigger-run', 'running'), managed('delegated', 'running')],
            agentEntries: [agentEntry({ id: 'wf:trigger-run', kind: 'workflow_run', status: 'running', runId: 'trigger-run' })],
            ownTriggerRunIds: new Set(['trigger-run']),
        }));

        expect(projection.workflows.map((item) => item.key)).toEqual(['run:delegated']);
        expect(projection.summary.runs).toBe(1);
        expect(projection.summary.outstanding).toBe(1);
    });

    it('splits background runs from in-session agents and counts only outstanding work', () => {
        const projection = projectWork(input({
            reportSessions: [
                report({ sessionId: 'done', managerSessionId: 'lead', statusFacts: settledFacts }),
                report({ sessionId: 'busy', managerSessionId: 'lead' }),
            ],
            agentEntries: [
                agentEntry({ id: 'run:scout', kind: 'execution_run', status: 'succeeded', runId: 'scout' }),
                agentEntry({ id: 'run:second', kind: 'execution_run', status: 'waiting', runId: 'second' }),
                agentEntry({ id: 'task:1', kind: 'subagent', status: 'running' }),
            ],
        }));

        expect(projection.backgroundRuns.map((item) => item.key)).toEqual(['agent:run:scout', 'agent:run:second']);
        expect(projection.agents.map((item) => item.key)).toEqual(['agent:task:1']);
        expect(projection.summary).toEqual({ outstanding: 3, needsYou: 1, stalled: 0, sessions: 2, runs: 2 });
    });

    it('reports nothing outstanding when every report has settled', () => {
        const projection = projectWork(input({
            reportSessions: [report({ sessionId: 'done', managerSessionId: 'lead', statusFacts: settledFacts })],
            agentEntries: [agentEntry({ id: 'run:x', kind: 'execution_run', status: 'failed', runId: 'x' })],
        }));
        expect(projection.summary.outstanding).toBe(0);
        expect(projection.backgroundRuns[0]?.status).toMatchObject({ bucket: 'finished', tone: 'danger' });
    });

    it('groups every item by state, Needs you / Working / Recent, an idle or offline item in Recent', () => {
        const idleFacts = readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ active: true,
            activeAt: fixtureNow }), fixtureNow);
        const offlineFacts = readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ active: false,
            presence: 1 }), fixtureNow);
        const projection = projectWork(input({
            reportSessions: [
                report({ sessionId: 'checkout', managerSessionId: 'lead', statusFacts: needsYouFacts }),
                report({ sessionId: 'done', managerSessionId: 'lead', statusFacts: settledFacts }),
                report({ sessionId: 'quiet', managerSessionId: 'lead', statusFacts: idleFacts }),
                report({ sessionId: 'gone', managerSessionId: 'lead', statusFacts: offlineFacts }),
            ],
            managedRuns: [managed('paused-run', 'paused'), managed('live-run', 'running')],
            agentEntries: [
                agentEntry({ id: 'run:x', kind: 'execution_run', status: 'succeeded', runId: 'x' }),
                agentEntry({ id: 'run:ask', kind: 'execution_run', status: 'waiting', runId: 'ask' }),
                agentEntry({ id: 'run:delegate', kind: 'execution_run', status: 'running', runId: 'delegate' }),
                agentEntry({ id: 'team:writer', kind: 'agent_team_member', status: 'running' }),
            ],
        }));
        const groups = groupWorkByState(projection);

        // One list, every kind in it (lab convo-W1/W8full): sessions, then background runs, then workflow
        // runs, then the agents working inside the session; the row's mark and subtitle carry the kind.
        expect(groups.needsYou.map((item) => item.key)).toEqual(['session:checkout', 'agent:run:ask']);
        // Working is only what is still going; the group is titled with that bucket's word, so an idle or
        // offline row there would read as working. They wait in Recent with their own word and tone.
        expect(groups.working.map((item) => item.key)).toEqual([
            'agent:run:delegate',
            'run:live-run',
            'agent:team:writer',
        ]);
        expect(groups.recent.map((item) => item.key)).toEqual([
            'session:done', 'session:quiet', 'session:gone', 'agent:run:x', 'run:paused-run',
        ]);
        expect(Object.keys(groups)).toEqual(['needsYou', 'working', 'recent', 'archived']);
    });

    it('nests a report under its lead only inside the same state group', () => {
        const projection = projectWork(input({
            reportSessions: [
                report({ sessionId: 'api', managerSessionId: 'lead' }),
                report({ sessionId: 'ledger', managerSessionId: 'api' }),
                report({ sessionId: 'ledger-probe', managerSessionId: 'ledger' }),
                report({ sessionId: 'checkout', managerSessionId: 'lead', statusFacts: needsYouFacts }),
                report({ sessionId: 'retry-copy', managerSessionId: 'checkout' }),
            ],
        }));
        const groups = groupWorkByState(projection);

        expect(groups.working.map((item) => [item.key, item.level])).toEqual([
            ['session:api', 0],
            ['session:ledger', 1],
            ['session:ledger-probe', 2],
            // Its lead waits in Needs you: here it starts its own line rather than hanging under nothing.
            ['session:retry-copy', 0],
        ]);
        expect(groups.needsYou.map((item) => [item.key, item.level])).toEqual([['session:checkout', 0]]);
        // Unchanged items keep their identity, so their rows do not re-render.
        expect(groups.working[0]).toBe(projection.sessions[0]);
    });
});
