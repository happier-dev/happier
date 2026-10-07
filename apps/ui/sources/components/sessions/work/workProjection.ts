import { readSessionWorkStateGroupV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import {
    resolveWorkStatusTone,
    type WorkStatusBucket,
    type WorkStatusPresentation,
} from '@/components/work/status/resolveWorkStatusTone';
import { withOutstandingReports, type SessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';

/**
 * The one Work projection of a Session (ORC R-09, §3.8): every unit of work the Session leads, read from
 * its four sources and counted once.
 *
 * - **Sessions** — the `reportsTo` subtree, from the Session rows the store already holds.
 * - **Agent activity** (`useSessionAgentActivity`) — background runs, in-session agents and the
 *   workflow runs an agent reported.
 * - **Workflow activity** (`useSessionWorkflowActivity`) — the live progress of in-session workflow runs.
 * - **Managed workflow runs** (`useSessionManagedWorkflowRuns`) — FIN runs this Session started, with the
 *   server's attention predicate.
 *
 * The same workflow run reaches this projection through up to three sources; it is one item, keyed by
 * its run id, and the managed run (server truth) wins its state. The Session's own trigger runs are not
 * work it delegated: they belong to the Triggers slot and never reach an item or a count.
 *
 * Classification is not decided here. Sessions, workflow runs and agent activity (in its own
 * vocabulary: `waiting` is a person blocking, in-progress is working) are all read through INT I3's
 * `resolveWorkStatusTone`. The header strip, the Work tab and the "never Finished" rule all
 * read `summary`, so they cannot disagree about how much is outstanding.
 */

export type WorkBucket = WorkStatusBucket;
export type WorkStatus = WorkStatusPresentation;

/** Unknown or stale source content is never evidence that this Session started nothing. */
export function resolveWorkReadPresentation(input: Readonly<{
    projection: WorkProjection | null;
    managedRuns: Readonly<{ phase: 'idle' | 'loading' | 'loaded' | 'failed'; refreshFailed: boolean }> | null;
    transcriptLoaded: boolean;
}>) {
    const managedLoading = input.managedRuns?.phase === 'loading';
    const managedUnavailable = input.managedRuns?.phase === 'failed';
    const itemCount = input.projection ? input.projection.sessions.length + input.projection.workflows.length
        + input.projection.backgroundRuns.length + input.projection.agents.length : 0;
    return {
        nothingYet: input.projection !== null && input.transcriptLoaded && itemCount === 0
            && !managedLoading && !managedUnavailable && !input.managedRuns?.refreshFailed,
        managedLoading,
        managedUnavailable,
    };
}

export type WorkItemKind = 'session' | 'workflow_run' | 'background_run' | 'agent';

/** Where a row leads. The peek (details pane) or the phone push resolves each target. */
export type WorkOpenTarget =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'workflow_run'; runId: string }>
    | Readonly<{ kind: 'agent_activity'; entryId: string; subagentId: string | null; runId: string | null }>;

export type WorkItem = Readonly<{
    /** Stable across refreshes: `session:<id>`, `run:<runId>` or `agent:<entryId>`. */
    key: string;
    kind: WorkItemKind;
    title: string;
    /** The Agent whose mark the row carries, when known. */
    agentId: string | null;
    /** Quiet secondary facts in reading order (engine · machine, "Reports to …", "7 of 12"). */
    facts: readonly string[];
    /** The item this one reports to inside the projection (session nesting only). */
    parentKey: string | null;
    /** 0 for a direct report, 1 for a report of a report, … */
    level: number;
    status: WorkStatus;
    /** Workflow progress, when a source reported one. */
    progress: Readonly<{ completed: number; total: number }> | null;
    open: WorkOpenTarget;
}>;

/**
 * The narrow summary every closed surface reads (header strip, tab badge, "never Finished").
 *
 * `outstanding` is everything not settled, once each: working, waiting on a person, or stalled.
 */
export type WorkSummary = Readonly<{
    outstanding: number;
    needsYou: number;
    stalled: number;
    sessions: number;
    runs: number;
}>;

export type WorkProjection = Readonly<{
    sessions: readonly WorkItem[];
    workflows: readonly WorkItem[];
    backgroundRuns: readonly WorkItem[];
    /** In-session agents (Task subagents, teammates): work the Session runs inside itself. */
    agents: readonly WorkItem[];
    summary: WorkSummary;
}>;

/** A Session in the store, reduced to what the projection reads. */
export type WorkReportSessionSource = Readonly<{
    sessionId: string;
    /** The Session it reports to (`reportsTo.sessionId`), or null for a root. */
    leadSessionId: string | null;
    title: string;
    agentId: string | null;
    facts: readonly string[];
    /** Awareness, state word and "settled", from the one Session facts owner (`readSessionWorkStatusFacts`). */
    statusFacts: SessionWorkStatusFacts;
    /** Offline with a turn in flight (`readSessionWorkStalled`); never inferred from the bucket. */
    stalled: boolean;
    archived: boolean;
}>;

export type WorkManagedRunSource = Readonly<{
    run: Pick<WorkflowRunSummaryV1, 'id' | 'state'>;
    title: string;
    /** The run's state word (`describeWorkflowRunState`). */
    word: string;
    /** The server's attention predicate returned this run. */
    needsAttention: boolean;
}>;

export type WorkProjectionInput = Readonly<{
    sessionId: string;
    reportSessions: readonly WorkReportSessionSource[];
    agentEntries: readonly AgentActivityEntry[];
    workflowHeadlineRuns: readonly SessionWorkflowRunHeadlineV1[];
    managedRuns: readonly WorkManagedRunSource[];
    /** The Session's own trigger runs (FIN's Triggers section owns them). */
    ownTriggerRunIds: ReadonlySet<string>;
    /** The word for each agent-activity status (the agent presenter's label). */
    describeAgentStatus: (entry: AgentActivityEntry) => string;
    /** Workflow progress copy ("7 of 12"). */
    describeProgress: (progress: Readonly<{ completed: number; total: number }>) => string;
}>;

const EMPTY_ITEMS: readonly WorkItem[] = Object.freeze([]);

export const EMPTY_WORK_SUMMARY: WorkSummary = Object.freeze({
    outstanding: 0,
    needsYou: 0,
    stalled: 0,
    sessions: 0,
    runs: 0,
});

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function classifyAgentActivity(entry: AgentActivityEntry, word: string): WorkStatus {
    return resolveWorkStatusTone({ kind: 'agent_activity', facts: { status: entry.status, word } });
}

function classifyManagedRun(source: WorkManagedRunSource): WorkStatus {
    return resolveWorkStatusTone({
        kind: 'workflow_run',
        facts: {
            state: source.run.state,
            inAttentionWindow: source.needsAttention,
            word: source.word,
        },
    });
}

function isOutstanding(bucket: WorkBucket): boolean {
    return bucket === 'working' || bucket === 'needs_you' || bucket === 'offline';
}

/**
 * A report Session is outstanding while it works, needs the person, or is stalled (the owner's fact).
 * An offline lead that only waits on its own reports is not settled, but it is not extra work either:
 * its reports are counted themselves.
 */
function isOutstandingSession(bucket: WorkBucket, stalled: boolean): boolean {
    return bucket === 'working' || bucket === 'needs_you' || stalled;
}

/**
 * The `reportsTo` subtree in depth-first order, each Session under its lead, siblings in source order.
 *
 * Depth is walked from the root, never read from a Session: a cycle the store transiently holds (an
 * edge seen before its reparent landed) cannot loop, because every Session is visited once. A report's
 * own reports are classified first, so a report whose subtree still has work going is never finished
 * (R-10): this projection counts that subtree and hands the count to the Session facts owner.
 */
function projectReportSessions(input: WorkProjectionInput): Readonly<{ items: readonly WorkItem[]; stalledKeys: ReadonlySet<string> }> {
    const childrenByLead = new Map<string, WorkReportSessionSource[]>();
    for (const source of input.reportSessions) {
        const lead = normalizeId(source.leadSessionId);
        if (!lead || source.archived || source.sessionId === input.sessionId) continue;
        const siblings = childrenByLead.get(lead);
        if (siblings) siblings.push(source);
        else childrenByLead.set(lead, [source]);
    }
    const items: WorkItem[] = [];
    const stalledKeys = new Set<string>();
    const visited = new Set<string>([input.sessionId]);
    /** Places the reports of `leadSessionId` and returns how many in that subtree are still outstanding. */
    const walk = (leadSessionId: string, parentKey: string | null, level: number): number => {
        let outstanding = 0;
        for (const source of childrenByLead.get(leadSessionId) ?? []) {
            if (visited.has(source.sessionId)) continue;
            visited.add(source.sessionId);
            const key = `session:${source.sessionId}`;
            const slot = items.length;
            const subtreeOutstanding = walk(source.sessionId, key, level + 1);
            const status = resolveWorkStatusTone({
                kind: 'session',
                facts: withOutstandingReports(source.statusFacts, subtreeOutstanding),
            });
            // The report goes before its own reports, which the walk above already placed.
            items.splice(slot, 0, {
                key,
                kind: 'session',
                title: source.title,
                agentId: source.agentId,
                facts: source.facts,
                parentKey,
                level,
                status,
                progress: null,
                open: { kind: 'session', sessionId: source.sessionId },
            });
            if (source.stalled) stalledKeys.add(key);
            outstanding += subtreeOutstanding + (isOutstandingSession(status.bucket, source.stalled) ? 1 : 0);
        }
        return outstanding;
    };
    walk(input.sessionId, null, 0);
    return { items, stalledKeys };
}

function progressFacts(
    progress: Readonly<{ completed: number; total: number }> | null,
    describe: WorkProjectionInput['describeProgress'],
): readonly string[] {
    return progress && progress.total > 0 ? [describe(progress)] : [];
}

export function projectWork(input: WorkProjectionInput): WorkProjection {
    const { items: sessions, stalledKeys } = projectReportSessions(input);

    const headlineByRunId = new Map<string, SessionWorkflowRunHeadlineV1>();
    for (const run of input.workflowHeadlineRuns) {
        const runId = normalizeId(run.runId);
        if (runId && !input.ownTriggerRunIds.has(runId)) headlineByRunId.set(runId, run);
    }
    const progressFor = (runId: string) => {
        const headline = headlineByRunId.get(runId);
        return headline ? { completed: headline.completedAgents, total: headline.totalAgents } : null;
    };

    const workflows: WorkItem[] = [];
    const seenRunIds = new Set<string>();
    for (const source of input.managedRuns) {
        const runId = normalizeId(source.run.id);
        if (!runId || seenRunIds.has(runId) || input.ownTriggerRunIds.has(runId)) continue;
        seenRunIds.add(runId);
        const progress = progressFor(runId);
        workflows.push({
            key: `run:${runId}`,
            kind: 'workflow_run',
            title: source.title,
            agentId: null,
            facts: progressFacts(progress, input.describeProgress),
            parentKey: null,
            level: 0,
            status: classifyManagedRun(source),
            progress,
            open: { kind: 'workflow_run', runId },
        });
    }

    const backgroundRuns: WorkItem[] = [];
    const agents: WorkItem[] = [];
    for (const entry of input.agentEntries) {
        // A workflow's members are the run's own detail; the run is the unit of work.
        if (entry.kind === 'workflow_agent') continue;
        const runId = normalizeId(entry.runId);
        if (runId && input.ownTriggerRunIds.has(runId)) continue;
        const status = classifyAgentActivity(entry, input.describeAgentStatus(entry));
        if (entry.kind === 'workflow_run') {
            const workflowRunId = runId ?? entry.id;
            if (seenRunIds.has(workflowRunId)) continue;
            seenRunIds.add(workflowRunId);
            const progress = progressFor(workflowRunId);
            workflows.push({
                key: `run:${workflowRunId}`,
                kind: 'workflow_run',
                title: entry.title,
                agentId: null,
                facts: progressFacts(progress, input.describeProgress),
                parentKey: null,
                level: 0,
                status,
                progress,
                open: { kind: 'workflow_run', runId: workflowRunId },
            });
            continue;
        }
        if (entry.kind === 'execution_run' && runId) {
            if (seenRunIds.has(runId)) continue;
            seenRunIds.add(runId);
        }
        const item: WorkItem = {
            key: `agent:${entry.id}`,
            kind: entry.kind === 'execution_run' ? 'background_run' : 'agent',
            title: entry.title,
            agentId: null,
            facts: entry.metaDetail ? [entry.metaDetail] : [],
            parentKey: null,
            level: 0,
            status,
            progress: null,
            open: { kind: 'agent_activity', entryId: entry.id, subagentId: entry.subagentId, runId },
        };
        if (item.kind === 'background_run') backgroundRuns.push(item);
        else agents.push(item);
    }

    let outstanding = 0;
    let needsYou = 0;
    let stalled = 0;
    for (const item of [...sessions, ...workflows, ...backgroundRuns, ...agents]) {
        const itemStalled = item.kind === 'session' ? stalledKeys.has(item.key) : item.status.bucket === 'offline';
        if (item.kind === 'session' ? !isOutstandingSession(item.status.bucket, itemStalled) : !isOutstanding(item.status.bucket)) continue;
        outstanding += 1;
        if (item.status.bucket === 'needs_you') needsYou += 1;
        if (itemStalled) stalled += 1;
    }

    return {
        sessions: sessions.length === 0 ? EMPTY_ITEMS : sessions,
        workflows: workflows.length === 0 ? EMPTY_ITEMS : workflows,
        backgroundRuns: backgroundRuns.length === 0 ? EMPTY_ITEMS : backgroundRuns,
        agents: agents.length === 0 ? EMPTY_ITEMS : agents,
        summary: {
            outstanding,
            needsYou,
            stalled,
            sessions: sessions.length,
            runs: workflows.length + backgroundRuns.length,
        },
    };
}

export function areWorkSummariesEqual(a: WorkSummary, b: WorkSummary): boolean {
    return a.outstanding === b.outstanding
        && a.needsYou === b.needsYou
        && a.stalled === b.stalled
        && a.sessions === b.sessions
        && a.runs === b.runs;
}

/**
 * Where pressing a Work row or map node goes. A row never answers anything (S-1): a Session or an agent
 * opens its peek, which holds the one set of answer controls; a workflow run has no peek, so a run that
 * needs the person opens the Inbox, where its review waits — and its own page only when this viewer
 * has no Inbox. Everything else opens where it lives.
 */
export function resolveWorkItemOpenTarget(
    item: WorkItem,
    context: Readonly<{ inboxAvailable: boolean }>,
): WorkOpenTarget | Readonly<{ kind: 'inbox' }> {
    if (item.open.kind === 'workflow_run' && item.status.bucket === 'needs_you' && context.inboxAvailable) {
        return { kind: 'inbox' };
    }
    return item.open;
}

export type WorkStateGroups = Readonly<{
    needsYou: readonly WorkItem[];
    working: readonly WorkItem[];
    recent: readonly WorkItem[];
}>;

type WorkStateGroupKey = keyof WorkStateGroups;

/**
 * The Work list reads by state on every surface (INT r0.5 §6 I4, lab `convo-W1/W8full`): what needs the
 * person, what is still going, and the rest — finished, idle or offline — under Recent.
 * Each group lists every kind — Sessions, then background runs, workflow runs and the agents working
 * inside the Session — and the row's mark and subtitle say which kind it is.
 *
 * A report stays nested under its lead only when the lead sits in the same group; otherwise it starts
 * its own line there instead of hanging under a row that is elsewhere. Items whose level holds keep
 * their identity, so their rows do not re-render.
 */
export function groupWorkByState(projection: WorkProjection): WorkStateGroups {
    const groups: Record<WorkStateGroupKey, WorkItem[]> = { needsYou: [], working: [], recent: [] };
    const placed = new Map<string, Readonly<{ group: WorkStateGroupKey; level: number }>>();
    for (const item of [...projection.sessions, ...projection.backgroundRuns, ...projection.workflows, ...projection.agents]) {
        const group = readSessionWorkStateGroupV1(item.status.bucket);
        const parent = item.parentKey ? placed.get(item.parentKey) : undefined;
        const level = parent && parent.group === group ? parent.level + 1 : 0;
        placed.set(item.key, { group, level });
        groups[group].push(level === item.level ? item : { ...item, level });
    }
    return {
        needsYou: groups.needsYou.length === 0 ? EMPTY_ITEMS : groups.needsYou,
        working: groups.working.length === 0 ? EMPTY_ITEMS : groups.working,
        recent: groups.recent.length === 0 ? EMPTY_ITEMS : groups.recent,
    };
}
