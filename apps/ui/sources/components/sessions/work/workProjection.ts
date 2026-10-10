import { readSessionWorkStateGroupV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { shallow } from 'zustand/shallow';

import {
    resolveWorkStatusTone,
    type WorkStatusBucket,
    type WorkStatusPresentation,
} from '@/components/work/status/resolveWorkStatusTone';
import { withOutstandingReports, type SessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationAddressKey } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { resolveActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { canRequestActionOperationStop } from '@/components/inbox/actionOperations/actionOperationPresentation';

/**
 * The one Work projection of a Session (ORC R-09, §3.8): every unit of work the Session leads, read from
 * its sources and counted once.
 *
 * - **Sessions** — the `reportsTo` subtree, from the Session rows the store already holds.
 * - **Agent activity** (`useSessionAgentActivity`) — background runs, in-session agents and the
 *   workflow runs an agent reported.
 * - **Workflow activity** (`useSessionWorkflowActivity`) — the live progress of in-session workflow runs.
 * - **Managed workflow runs** (`useSessionManagedWorkflowRuns`) — FIN runs this Session started, with the
 *   server's attention predicate.
 * - **Action operations** — admitted Project commands for this exact Home, Account and Session,
 *   whether or not their output terminal exists yet. A represented workflow keeps its command leaves.
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

/**
 * Unknown or stale source content is never evidence that this Session started nothing.
 *
 * While the first managed-run read is in flight, Working holds its place only when the list has
 * nothing else to show: that is the one case where an absent section would read as "nothing is going".
 * Beside rows the pane already knows (the Sessions under the lead), a placeholder for a section that
 * may not exist would only collapse later and pull those rows up under the person's eye.
 */
export function resolveWorkReadPresentation(input: Readonly<{
    projection: WorkProjection | null;
    managedRuns: Readonly<{ phase: 'idle' | 'loading' | 'loaded' | 'failed'; refreshFailed: boolean }> | null;
    transcriptLoaded: boolean;
}>) {
    const managedLoading = input.managedRuns?.phase === 'loading';
    const managedUnavailable = input.managedRuns?.phase === 'failed';
    const itemCount = input.projection ? input.projection.sessions.length + input.projection.workflows.length
        + input.projection.backgroundRuns.length + input.projection.agents.length + input.projection.projectCommands.length : 0;
    return {
        nothingYet: input.projection !== null && input.transcriptLoaded && itemCount === 0
            && !managedLoading && !managedUnavailable && !input.managedRuns?.refreshFailed,
        holdWorkingPlace: managedLoading && itemCount === 0,
        managedUnavailable,
    };
}

/**
 * Where each title's distinguishing end starts, for a list whose rows may truncate (DESIGN.md: never
 * truncate what tells Sessions apart). Sibling work is often named from one stem ("… child A",
 * "… child B"), and an end ellipsis would cut exactly the part that differs. For a title that shares
 * its first words with another in the list, the result is the index of the last shared word before the
 * first difference, so the row can keep "child A" whole and let the shared start give way. A title
 * whose difference already sits in its first two words, or that has none, is `null`: it truncates at
 * the end as usual.
 */
export function resolveWorkTitleTailStarts(titles: readonly string[]): readonly (number | null)[] {
    return titles.map((title, index) => {
        let shared = 0;
        for (let other = 0; other < titles.length; other += 1) {
            if (other === index) continue;
            const candidate = titles[other]!;
            const limit = Math.min(title.length, candidate.length);
            let length = 0;
            while (length < limit && title[length] === candidate[length]) length += 1;
            if (length > shared) shared = length;
        }
        if (shared === 0 || shared >= title.length) return null;
        // The word that differs, then one shared word before it for context.
        const differingWordStart = title.lastIndexOf(' ', shared) + 1;
        if (differingWordStart < 2) return null;
        const tailStart = title.lastIndexOf(' ', differingWordStart - 2) + 1;
        return tailStart > 0 ? tailStart : null;
    });
}

export type WorkItemKind = 'session' | 'workflow_run' | 'background_run' | 'agent' | 'project_command';

/** Where a row leads. The peek (details pane) or the phone push resolves each target. */
export type WorkOpenTarget =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'workflow_run'; runId: string }>
    | Readonly<{ kind: 'action_operation'; serverId: string; operationId: string }>
    | Readonly<{ kind: 'agent_activity'; entryId: string; subagentId: string | null; runId: string | null }>;

export type WorkItem = Readonly<{
    /** Stable across refreshes; an operation key includes its exact Home as well as operation id. */
    key: string;
    kind: WorkItemKind;
    title: string;
    /** The Agent whose mark the row carries, when known. */
    agentId: string | null;
    /** Quiet secondary facts in reading order (engine · machine, "Reports to …", "7 of 12"). */
    facts: readonly string[];
    /** The item this one belongs under inside the projection (report Sessions or workflow commands). */
    parentKey: string | null;
    /** 0 for a direct report, 1 for a report of a report, … */
    level: number;
    status: WorkStatus;
    /** Workflow progress, when a source reported one. */
    progress: Readonly<{ completed: number; total: number }> | null;
    open: WorkOpenTarget;
    /** Actual admitted operation, including output association before and after settlement. */
    operation?: ActionOperationProjection;
    /** A represented Workflow owns its command leaves; they add no top-level Work count. */
    projectCommands?: readonly WorkItem[];
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
    projectCommands: readonly WorkItem[];
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
    /** Exact captured Home and its authenticated Account; absent evidence admits no operation rows. */
    serverId?: string | null;
    accountId?: string | null;
    actionOperations?: readonly ActionOperationProjection[];
    describeOperationStatus?: (operation: ActionOperationProjection) => string;
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

export function projectWork(input: WorkProjectionInput, previous?: WorkProjection | null): WorkProjection {
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

    const projectCommands: WorkItem[] = [];
    const seenOperations = new Set<string>();
    for (const operation of input.actionOperations ?? []) {
        const { snapshot, serverId } = operation;
        const attachment = snapshot.domainRef;
        if (attachment?.kind !== 'projectCommand' || !input.serverId || !input.accountId
            || serverId !== input.serverId
            || snapshot.scope.accountId !== input.accountId || snapshot.scope.sessionId !== input.sessionId) continue;
        const key = `operation:${actionOperationAddressKey({ serverId, operationId: snapshot.operationId })}`;
        if (seenOperations.has(key)) continue;
        seenOperations.add(key);
        const origin = attachment.originRun;
        const originRunId = origin?.serverId === serverId ? origin.runId : null;
        if (originRunId && input.ownTriggerRunIds.has(originRunId)) continue;
        const workflowIndex = originRunId ? workflows.findIndex((item) => item.open.kind === 'workflow_run' && item.open.runId === originRunId) : -1;
        const parentKey = workflowIndex >= 0 ? workflows[workflowIndex].key : null;
        const item: WorkItem = {
            key, kind: 'project_command', title: snapshot.title, agentId: null,
            facts: [attachment.cwd], parentKey, level: parentKey ? 1 : 0,
            status: resolveWorkStatusTone({ kind: 'action_operation', facts: {
                state: snapshot.state, observation: resolveActionOperationObservation(snapshot, operation.observation),
                setupReview: snapshot.setupReview,
                word: input.describeOperationStatus?.(operation) ?? snapshot.state,
            } }),
            progress: null, open: { kind: 'action_operation', serverId, operationId: snapshot.operationId }, operation,
        };
        if (workflowIndex >= 0) {
            const workflow = workflows[workflowIndex];
            workflows[workflowIndex] = { ...workflow, projectCommands: [...(workflow.projectCommands ?? []), item] };
        } else projectCommands.push(item);
    }

    let outstanding = 0;
    let needsYou = 0;
    let stalled = 0;
    for (const item of [...sessions, ...workflows, ...backgroundRuns, ...agents, ...projectCommands]) {
        const itemStalled = item.kind === 'session' ? stalledKeys.has(item.key) : item.status.bucket === 'offline';
        if (item.kind === 'session' ? !isOutstandingSession(item.status.bucket, itemStalled) : !isOutstanding(item.status.bucket)) continue;
        outstanding += 1;
        if (item.status.bucket === 'needs_you') needsYou += 1;
        if (itemStalled) stalled += 1;
    }

    const next: WorkProjection = {
        sessions: sessions.length === 0 ? EMPTY_ITEMS : sessions,
        workflows: workflows.length === 0 ? EMPTY_ITEMS : workflows,
        backgroundRuns: backgroundRuns.length === 0 ? EMPTY_ITEMS : backgroundRuns,
        agents: agents.length === 0 ? EMPTY_ITEMS : agents,
        projectCommands: projectCommands.length === 0 ? EMPTY_ITEMS : projectCommands,
        summary: {
            outstanding,
            needsYou,
            stalled,
            sessions: sessions.length,
            runs: workflows.length + backgroundRuns.length + projectCommands.length,
        },
    };
    if (!previous) return next;
    const retained: WorkProjection = {
        sessions: retainWorkItems(next.sessions, previous.sessions),
        workflows: retainWorkItems(next.workflows, previous.workflows),
        backgroundRuns: retainWorkItems(next.backgroundRuns, previous.backgroundRuns),
        agents: retainWorkItems(next.agents, previous.agents),
        projectCommands: retainWorkItems(next.projectCommands, previous.projectCommands),
        summary: areWorkSummariesEqual(next.summary, previous.summary) ? previous.summary : next.summary,
    };
    return shallow(retained, previous) ? previous : retained;
}

/** Compare the closed row projection, not its sources: fresh owner facts still reach changed rows. */
function retainWorkItems(next: readonly WorkItem[], previous: readonly WorkItem[]): readonly WorkItem[] {
    const byKey = new Map(previous.map((item) => [item.key, item]));
    const retained = next.map((item) => {
        const old = byKey.get(item.key);
        if (!old) return item;
        const projectCommands = item.projectCommands && old.projectCommands
            ? retainWorkItems(item.projectCommands, old.projectCommands) : item.projectCommands;
        if (item.kind === old.kind && item.title === old.title && item.agentId === old.agentId
            && item.parentKey === old.parentKey && item.level === old.level && item.operation === old.operation
            && shallow(item.facts, old.facts) && shallow(item.status, old.status) && shallow(item.progress, old.progress)
            && shallow(item.open, old.open) && projectCommands === old.projectCommands) return old;
        return projectCommands === item.projectCommands ? item : { ...item, projectCommands };
    });
    return shallow(retained, previous) ? previous : retained;
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

/**
 * Context-menu intents retain admitted provenance and never infer a Session from tool text.
 * Stop is a target, not settlement; its mounted consumer uses useActionOperationStopControl.
 */
export function resolveWorkItemContextActions(item: WorkItem) {
    const operation = item.operation;
    const snapshot = operation?.snapshot;
    return {
        open: item.open,
        transcript: operation && snapshot?.scope.sessionId
            ? { serverId: operation.serverId, sessionId: snapshot.scope.sessionId } : null,
        stop: operation && snapshot && canRequestActionOperationStop(snapshot, operation.observation)
            ? { serverId: operation.serverId, machineId: snapshot.scope.machineId, operationId: snapshot.operationId } : null,
    };
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
export function groupWorkByState(projection: WorkProjection, previous?: WorkStateGroups | null): WorkStateGroups {
    const groups: Record<WorkStateGroupKey, WorkItem[]> = { needsYou: [], working: [], recent: [] };
    const placed = new Map<string, Readonly<{ group: WorkStateGroupKey; level: number }>>();
    for (const item of [...projection.sessions, ...projection.backgroundRuns, ...projection.workflows, ...projection.agents, ...projection.projectCommands]) {
        const group = readSessionWorkStateGroupV1(item.status.bucket);
        const parent = item.parentKey ? placed.get(item.parentKey) : undefined;
        const level = parent && parent.group === group ? parent.level + 1 : 0;
        placed.set(item.key, { group, level });
        groups[group].push(level === item.level ? item : { ...item, level });
    }
    const next = {
        needsYou: groups.needsYou.length === 0 ? EMPTY_ITEMS : groups.needsYou,
        working: groups.working.length === 0 ? EMPTY_ITEMS : groups.working,
        recent: groups.recent.length === 0 ? EMPTY_ITEMS : groups.recent,
    };
    if (!previous) return next;
    const retained = { needsYou: retainWorkItems(next.needsYou, previous.needsYou), working: retainWorkItems(next.working, previous.working),
        recent: retainWorkItems(next.recent, previous.recent) };
    return shallow(retained, previous) ? previous : retained;
}
