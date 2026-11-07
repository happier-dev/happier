import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readOpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { createInboxApprovalArtifactFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { workflowRunRowFromAutomationRun, workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

import type { InboxSessionAttentionEntry } from './buildInboxSessionPresentation';
import { buildInboxWorkGroups, resolveInboxWorkRoot, type InboxWorkGroup } from './buildInboxWorkGroups';

function session(id: string, facts: Readonly<{ lead?: string; managedSessions?: number }> = {}): Session {
    return {
        id,
        serverId: 'home-a',
        updatedAt: 1,
        ...(facts.lead ? { manager: { sessionId: facts.lead } } : {}),
        ...(facts.managedSessions ? { managedSessions: { total: facts.managedSessions, working: facts.managedSessions, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null } } : {}),
    } as Session;
}

function entry(target: Session, originRunId: string | null = null): InboxSessionAttentionEntry {
    return {
        candidate: {
            sessionId: target.id,
            serverId: target.serverId,
            address: { serverId: target.serverId, sessionId: target.id },
            session: target,
            awareness: originRunId ? { origin: { kind: 'run_step', runId: originRunId } } : {},
            personalAttention: { reasons: ['permission_required'], presentation: 'full' },
        },
        pendingPermissions: [{ id: `permission-${target.id}` }],
        pendingUserActions: [],
    } as unknown as InboxSessionAttentionEntry;
}

function run(id: string, originSessionId?: string) {
    return workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
        id,
        state: 'running',
        origin: originSessionId ? { kind: 'direct', originSessionId } : { kind: 'automation', automationId: 'automation-1' },
    }), null);
}

function shape(groups: readonly InboxWorkGroup[]) {
    return groups.map((group) => ({
        root: group.root.kind === 'lead' ? `lead:${group.root.sessionId}`
            : group.root.kind === 'run' ? `run:${group.root.runId}`
                : group.root.kind === 'automation' ? `automation:${group.root.automationId}` : 'other',
        items: group.items.map((item) => item.key),
    }));
}

const lead = session('lead', { managedSessions: 2 });
const worker = session('worker', { lead: 'lead' });
const grandchild = session('grandchild', { lead: 'worker' });
const loose = session('loose');
const step = session('step');
const sessions = new Map([lead, worker, grandchild, loose, step].map((value) => [value.id, value]));

const EMPTY = { stalledSessions: [], landings: [], snoozed: [], automationRuns: [], openApprovals: [], automationServerId: 'home-a', workflowServerId: 'home-a' } as const;
const resolveSession = (id: string) => sessions.get(id);
const readOrigin = (value: InboxSessionAttentionEntry) => (
    (value.candidate.awareness as { origin?: { runId?: string } }).origin?.runId ?? null
);

it('orders Inbox approvals newest first without mutating the admitted collection', () => {
    const openApprovals = [300, 100, 200].map(createdAt => readOpenApprovalInboxEntry(
        createInboxApprovalArtifactFixture({ id: `ask-${createdAt}`, createdAt }))!);
    const groups = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [], workflowRuns: [], openApprovals,
        resolveSession, resolveOriginRunId: readOrigin });
    expect(groups.flatMap(group => group.items.map(item => item.key))).toEqual([
        'approval:ask-300', 'approval:ask-200', 'approval:ask-100',
    ]);
    expect(openApprovals[0]!.artifact.id).toBe('ask-300');
});

describe('buildInboxWorkGroups (ORC R-10)', () => {
    it('keeps same-id leads distinct and preserves same-id passive rows from another Home', () => {
        const a = session('same-worker', { lead: 'same-lead' });
        const b = { ...a, serverId: 'home-b' };
        const aLead = session('same-lead', { managedSessions: 1 });
        const bLead = { ...aLead, serverId: 'home-b' };
        const lookup = (id: string, home?: string | null) =>
            [a, b, aLead, bLead].find(row => row.id === id && row.serverId === home);
        const groups = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [entry(a)], workflowRuns: [],
            snoozed: [{ session: b, remindAt: 5_000 }], resolveSession: lookup, resolveOriginRunId: readOrigin });
        expect(groups.map(group => ({ root: group.root, kinds: group.items.map(item => item.kind) }))).toEqual([
            { root: { kind: 'lead', serverId: 'home-a', sessionId: aLead.id, session: aLead }, kinds: ['session'] },
            { root: { kind: 'lead', serverId: 'home-b', sessionId: bLead.id, session: bLead }, kinds: ['snoozed'] },
        ]);
        expect(new Set(groups.map(group => group.key)).size).toBe(2);
        const landings = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [entry(a)], workflowRuns: [],
            landings: [{ session: b, link: { number: 1, url: 'https://example.test/pull/1' } }],
            resolveSession: lookup, resolveOriginRunId: readOrigin });
        expect(landings.flatMap(group => group.items.map(item => item.kind))).toEqual(['session', 'landing']);
        const both = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [entry(a), entry(b)], workflowRuns: [],
            resolveSession: lookup, resolveOriginRunId: readOrigin });
        expect(both.map(group => group.items)).toHaveLength(2);
        const passive = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [], workflowRuns: [],
            stalledSessions: [a, b], resolveSession: lookup, resolveOriginRunId: readOrigin });
        expect(new Set(passive.flatMap(group => group.items.map(item => item.key))).size).toBe(2);
    });

    it('uses the workflow attention Home for ancestry and folds only that Homes step', () => {
        const a = session('origin', { lead: 'lead-a' });
        const b = { ...a, serverId: 'home-b', manager: { sessionId: 'lead-b' } };
        const groups = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [entry(a, 'same-run'), entry(b, 'same-run')],
            workflowRuns: [run('same-run', 'origin')], workflowServerId: 'home-a',
            resolveSession: (id, home) => [a, b].find(row => row.id === id && row.serverId === home),
            resolveOriginRunId: readOrigin });
        expect(groups.map(group => ({ root: group.root, items: group.items.map(item => item.kind === 'session'
            ? { home: item.entry.candidate.serverId, folded: item.foldedUnderRunId } : item.kind) }))).toEqual([
            { root: { kind: 'lead', serverId: 'home-b', sessionId: 'lead-b', session: null },
                items: [{ home: 'home-b', folded: null }] },
            { root: { kind: 'lead', serverId: 'home-a', sessionId: 'lead-a', session: null },
                items: ['workflow_run', { home: 'home-a', folded: 'same-run' }] },
        ]);
    });

    it('provides the held step label from the existing Run summary and clears it when no hold remains', () => {
        const row = run('held-run');
        const heldRow = { ...row, summary: { ...row.summary!, heldStep: {
            invocationId: 'held-review', label: 'Review the changelog', laneLabel: 'Changelog',
        } } };
        const input = { ...EMPTY, sessionEntries: [], workflowRuns: [heldRow], resolveSession, resolveOriginRunId: readOrigin };
        const first = buildInboxWorkGroups(input);
        expect(first[0]?.items[0]).toMatchObject({ heldStepLabel: 'Review the changelog', heldStepLaneLabel: 'Changelog' });
        expect(buildInboxWorkGroups(input, first)[0]?.items[0]).toBe(first[0]?.items[0]);
        const settled = buildInboxWorkGroups({ ...input, workflowRuns: [row] }, first);
        expect(settled[0]?.items[0]).toMatchObject({ heldStepLabel: null, heldStepLaneLabel: null });
    });
    it('puts decisions and approvals before passive attention in Other sessions', () => {
        const base = entry(session('passive'));
        const passive = { ...base, candidate: { ...base.candidate, personalAttention: { ...base.candidate.personalAttention, reasons: ['manual' as const] } }, pendingPermissions: [], pendingUserActions: [] };
        const decision = entry(loose);
        const approval = createInboxApprovalArtifactFixture({ id: 'approval', title: 'Review' });
        const groups = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [passive, decision], workflowRuns: [],
            openApprovals: [readOpenApprovalInboxEntry(approval)!], resolveSession, resolveOriginRunId: readOrigin });
        expect(shape(groups)).toEqual([{ root: 'other', items: ['session:home-a:loose', 'approval:approval', 'session:home-a:passive'] }]);
    });
    it('folds an automation-run approval under its Automation and leaves an unrelated approval in Other', () => {
        const request = ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'step' }, requestedSurface: 'agent',
            actionId: 'session.title.set', actionArgs: { sessionId: 'step', title: 'New title' }, summary: 'Set session title',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId: 'home-a',
                caller: { kind: 'automationRun', automationId: 'automation-1', runId: 'weekly-run',
                    cause: { kind: 'manual', invokedAt: 1 } }, runId: 'weekly-run', sessionId: 'step',
                actionId: 'session.title.set', requestId: 'request-1' },
        });
        const approval: DecryptedArtifact = { id: 'weekly-approval', header: buildApprovalRequestArtifactHeaderV1(request),
            body: JSON.stringify(request), title: 'Set session title', sessions: ['step'],
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true };
        const unrelatedRequest = ApprovalRequestV2Schema.parse({ ...request,
            executionOriginV1: { ...request.executionOriginV1, caller: { kind: 'host' }, runId: undefined } });
        const unrelated: DecryptedArtifact = { ...approval, id: 'other-approval',
            header: buildApprovalRequestArtifactHeaderV1(unrelatedRequest), body: JSON.stringify(unrelatedRequest) };
        const groups = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [], workflowRuns: [],
            automationRuns: [workflowRunRowFromAutomationRun(createAutomationRunFixture({ id: 'weekly-run' }))],
            openApprovals: [readOpenApprovalInboxEntry(approval)!, readOpenApprovalInboxEntry(unrelated)!], resolveSession, resolveOriginRunId: readOrigin });
        expect(shape(groups)).toEqual([
            { root: 'automation:automation-1', items: ['automation-run:weekly-run', 'approval:weekly-approval'] },
            { root: 'other', items: ['approval:other-approval'] },
        ]);
    });
    it('retains an unchanged row when another Inbox item updates', () => {
        const stable = entry(worker);
        const changing = entry(grandchild);
        const first = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [stable, changing], workflowRuns: [], resolveSession, resolveOriginRunId: readOrigin });
        const next = buildInboxWorkGroups({ ...EMPTY, sessionEntries: [stable, { ...changing, candidate: { ...changing.candidate, title: 'Changed' } }], workflowRuns: [], resolveSession, resolveOriginRunId: readOrigin }, first);
        expect(next[0]?.items.find((item) => item.key === 'session:home-a:worker')).toBe(first[0]?.items.find((item) => item.key === 'session:home-a:worker'));
        expect(next[0]?.items.find((item) => item.key === 'session:home-a:grandchild')).not.toBe(first[0]?.items.find((item) => item.key === 'session:home-a:grandchild'));
    });
    it('orders pending sessions by the oldest question or permission inside each existing work group', () => {
        const olderQuestion = { ...entry(grandchild), pendingPermissions: [], pendingUserActions: [{ id: 'question', kind: 'user_action' as const, tool: 'AskUserQuestion', arguments: {}, createdAt: 100 }] };
        const newerPermission = { ...entry(worker), pendingPermissions: [{ id: 'permission', kind: 'permission' as const, tool: 'Bash', arguments: {}, createdAt: 200 }] };
        const oldestLoose = { ...entry(loose), pendingPermissions: [{ id: 'loose', kind: 'permission' as const, tool: 'Bash', arguments: {}, createdAt: 1 }] };
        const groups = buildInboxWorkGroups({
            ...EMPTY, sessionEntries: [newerPermission, oldestLoose, olderQuestion], workflowRuns: [], resolveSession, resolveOriginRunId: readOrigin,
        });
        expect(shape(groups)).toEqual([
            { root: 'lead:lead', items: ['session:home-a:grandchild', 'session:home-a:worker'] },
            { root: 'other', items: ['session:home-a:loose'] },
        ]);
    });

    it('groups a whole manager tree under its work root and puts loose sessions last under Other', () => {
        const groups = buildInboxWorkGroups({
            ...EMPTY,
            sessionEntries: [entry(loose), entry(grandchild), entry(worker)],
            workflowRuns: [],
            resolveSession,
            resolveOriginRunId: readOrigin,
        });

        expect(shape(groups)).toEqual([
            { root: 'lead:lead', items: ['session:home-a:grandchild', 'session:home-a:worker'] },
            { root: 'other', items: ['session:home-a:loose'] },
        ]);
    });

    it('places a run under the lead that started it, and a run with no orchestrator under itself', () => {
        const groups = buildInboxWorkGroups({
            ...EMPTY,
            sessionEntries: [],
            workflowRuns: [run('run-from-worker', 'worker'), run('library-run')],
            resolveSession,
            resolveOriginRunId: readOrigin,
        });

        expect(shape(groups)).toEqual([
            { root: 'lead:lead', items: ['run:run-from-worker'] },
            { root: 'run:library-run', items: ['run:library-run'] },
        ]);
    });

    it("folds a step session's permission row once under its listed run, never also on its own", () => {
        const groups = buildInboxWorkGroups({
            ...EMPTY,
            sessionEntries: [entry(step, 'library-run'), entry(loose)],
            workflowRuns: [run('library-run')],
            resolveSession,
            resolveOriginRunId: readOrigin,
        });

        expect(shape(groups)).toEqual([
            { root: 'run:library-run', items: ['run:library-run', 'session:home-a:step'] },
            { root: 'other', items: ['session:home-a:loose'] },
        ]);
        const folded = groups[0]?.items[1];
        expect(folded?.kind === 'session' ? folded.foldedUnderRunId : null).toBe('library-run');
        // A step whose run left the attention window is an ordinary row again (it recedes with the run).
        const afterRunLeft = buildInboxWorkGroups({
            ...EMPTY,
            sessionEntries: [entry(step, 'library-run')],
            workflowRuns: [],
            resolveSession,
            resolveOriginRunId: readOrigin,
        });
        expect(shape(afterRunLeft)).toEqual([{ root: 'other', items: ['session:home-a:step'] }]);
    });

    it('lists stalled, Landing and snoozed rows under their work root once, after what needs the person', () => {
        const groups = buildInboxWorkGroups({
            ...EMPTY,
            sessionEntries: [entry(worker)],
            workflowRuns: [],
            stalledSessions: [grandchild, worker],
            landings: [{ session: lead, link: { sessionId: 'lead', number: 2490, url: 'https://github.com/acme/widgets/pull/2490', state: 'open', title: 'Retries' } }],
            snoozed: [{ session: loose, remindAt: 5_000 }],
            resolveSession,
            resolveOriginRunId: readOrigin,
        });

        expect(shape(groups)).toEqual([
            // `worker` needs the person, so it is not repeated as stalled.
            { root: 'lead:lead', items: ['session:home-a:worker', `stalled:${sessionAddressKey({ serverId: 'home-a', sessionId: 'grandchild' })}`, `landing:${sessionAddressKey({ serverId: 'home-a', sessionId: 'lead' })}`] },
            { root: 'other', items: [`snoozed:${sessionAddressKey({ serverId: 'home-a', sessionId: 'loose' })}`] },
        ]);
    });

    it('walks a transiently cyclic store once and stops at an unreadable lead', () => {
        const cyclic = new Map<string, Session>([
            ['a', session('a', { lead: 'b' })],
            ['b', session('b', { lead: 'a' })],
            ['c', session('c', { lead: 'hidden-lead' })],
        ]);
        expect(resolveInboxWorkRoot('a', (id) => cyclic.get(id))).toBe('b');
        expect(resolveInboxWorkRoot('c', (id) => cyclic.get(id))).toBe('hidden-lead');
        expect(resolveInboxWorkRoot('loose', resolveSession)).toBeNull();
        expect(resolveInboxWorkRoot('lead', resolveSession)).toBe('lead');
    });
});
