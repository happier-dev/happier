import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import type { SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import { selectOldestPendingRequest, type SessionPendingRequest } from '@happier-dev/session-core/pending';

import {
    presentSessionAwarenessNowLineV1,
    presentSessionAwarenessV1,
    type SessionAwarenessPresentationV1,
} from '@/utils/sessions/sessionUtils';

import type { SessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import type { SessionAgentPlan } from '../plan/sessionAgentPlan';
import type { SessionCompanionDensity } from '../state/sessionCompanionPreference';
import type { SessionRecap } from './sessionRecap';

/**
 * The pure card composer for the first-party Session Summary.
 *
 * It composes canonical facts and nothing else: Lane 09A awareness decides
 * operational state and freshness, the approval selector decides how many
 * approvals are open, the SCM snapshot owner decides branch and change totals,
 * and the Session usage owner decides tokens/context. This module may omit rows,
 * order them and name an EXISTING destination — it never decides runtime status,
 * work precedence, personal relevance/attention, freshness or usage meaning, and
 * it never generates prose.
 */

/** Where a row opens. Every value is an incumbent surface, never a Companion screen. */
export type SessionSummaryDestination =
    | 'sessionInfo'
    | 'approvals'
    | 'work'
    | 'git'
    | 'usage'
    /** The Session's Work tab: everything it leads (ORC §3.8). */
    | 'workTab';

export type SessionSummaryRow =
    | Readonly<{ kind: 'approvals'; count: number; destination: 'approvals' }>
    | Readonly<{
        kind: 'activity';
        liveCount: number;
        totalCount: number;
        title: string | null;
        statusLabel: string | null;
        destination: 'workTab';
    }>
    | Readonly<{ kind: 'recap'; text: string; source: SessionRecap['source']; destination: 'workTab' }>
    | Readonly<{
        kind: 'work';
        label: string;
        status: NonNullable<SessionAwarenessProjectionV1['currentWork']>['status'] | null;
        destination: 'work';
    }>
    | Readonly<{ kind: 'workflow'; runCount: number; destination: 'workTab' }>
    | Readonly<{
        kind: 'workspace';
        label: string;
        branch: string | null;
        changedFiles: number | null;
        destination: 'git';
    }>
    | Readonly<{
        kind: 'usage';
        tokens: number | null;
        contextPercent: number | null;
        stale: boolean;
        destination: 'usage';
    }>;

export type SessionSummaryUsageFacts = Readonly<{
    tokens: number | null;
    contextPercent: number | null;
    stale: boolean;
}>;

export type SessionSummaryActivityFacts = Readonly<{
    live: number;
    total: number;
    headline: Readonly<{ title: string; statusLabel: string }> | null;
}>;

export type SessionSummaryInput = Readonly<{
    awareness: SessionAwarenessProjectionV1;
    viewer?: SessionViewerProjectionV1;
    /** From the existing Agent catalog presentation; never inferred from metadata here. */
    agentLabel: string | null;
    /** The presentation Agent id, for its mark on the status line. */
    agentId?: string | null;
    /** The canonical Lane 05 count projection; this composer derives no roster. */
    activity: SessionSummaryActivityFacts | null;
    openApprovalCount: number;
    /** `buildSessionScmSummary` output; `null` when there is no repository. */
    scm: SessionScmSummary | null;
    usage: SessionSummaryUsageFacts | null;
    /** `resolveSessionRecap` output: the latest synopsis, else the latest worker update headline. */
    recap?: SessionRecap | null;
    /**
     * Pending permission requests this viewer can answer now, as the request owner decided
     * (`isTranscriptPendingRequestAnswerable`, the same verdict the chat tray and Inbox consume).
     */
    pendingPermissions?: readonly SessionPendingRequest[];
    /** Canonical pending questions and Action confirmations this viewer can answer now. */
    pendingUserActions?: readonly SessionPendingRequest[];
    /** The agent's Plan (`projectSessionAgentPlan`), for "step N of M". */
    plan?: SessionAgentPlan | null;
    /** When the running turn was observed to start; `null` when not known. */
    turnStartedAtMs?: number | null;
    /** The live row's last runtime observation (`activeAt`): when retained facts were last current. */
    lastObservedAtMs?: number | null;
}>;

/** The one ask the hero shows through the shared prompt card; the rest are counted. */
export type SessionSummaryNeedsYou = Readonly<{
    request: SessionPendingRequest;
    moreCount: number;
}>;

/** The three glanceable facts (lab CA); each opens its existing owner. */
export type SessionSummaryFact =
    | Readonly<{ kind: 'runningWork'; count: number; destination: 'workTab' }>
    | Readonly<{ kind: 'changes'; count: number; destination: 'git' }>
    | Readonly<{ kind: 'context'; percent: number; stale: boolean; destination: 'usage' }>;

export type SessionSummaryCardModel = Readonly<{
    /** Exact Home + Session proof is required before any Session fact is exposed. */
    scope: 'exact' | 'realm_unavailable';
    title: string | null;
    agentLabel: string | null;
    agentId: string | null;
    /**
     * The canonical presented awareness answer from `presentSessionAwarenessV1`. Reading
     * `operational.primary` alone here made the card label an offline Session "Online",
     * because runtime, unservability, resuming and staleness all outrank it.
     */
    status: SessionAwarenessPresentationV1 | null;
    /** Lane 09A's freshness, softened once in presentation; values are never zeroed. */
    stale: boolean;
    /** When the retained facts were last current, for the freshness line's "As of"; `null` when unknown. */
    asOfMs?: number | null;
    /** Lane 09A's own admission that it could not see everything it describes. */
    availability: SessionAwarenessProjectionV1['availability'];
    /** Canonical content-readability reason; presentation owns only its label. */
    encryption: SessionAwarenessProjectionV1['encryption'];
    identityDestination: 'sessionInfo';
    rows: readonly SessionSummaryRow[];
    needsYou: SessionSummaryNeedsYou | null;
    /** What the status timer counts from: the ask, else the running turn. */
    sinceMs: number | null;
    statusProgress?: SessionAwarenessProjectionV1['progress'];
    nowLine?: SessionAwarenessProjectionV1['nowLine'];
    statusReasonSetAt?: SessionAwarenessProjectionV1['statusReasonSetAt'];
    /** The agent's Plan itself, for the separate built-in Plan item. */
    plan: SessionAgentPlan | null;
    facts: readonly SessionSummaryFact[];
}>;

/** §10.4: at most two compact detail rows before the full-surface affordance. */
const ROW_BUDGET: Readonly<Record<SessionCompanionDensity, number>> = {
    compact: 2,
    comfortable: 3,
};

function workspaceLabel(
    awareness: SessionAwarenessProjectionV1,
    scm: SessionScmSummary | null,
): string | null {
    const workspace = awareness.workspace;
    const label = workspace?.projectName ?? workspace?.worktreeName ?? workspace?.path ?? null;
    return label ?? scm?.branch ?? null;
}

export function projectSessionSummaryCard(input: SessionSummaryInput): SessionSummaryCardModel {
    const rows: SessionSummaryRow[] = [];

    // An open approval leads because it is the only row a person can act on right
    // now. This is visual ordering, not another attention or relevance predicate.
    if (input.openApprovalCount > 0) {
        rows.push(Object.freeze({
            kind: 'approvals',
            count: input.openApprovalCount,
            destination: 'approvals',
        }));
    }

    if (input.activity && input.activity.total > 0) {
        rows.push(Object.freeze({
            kind: 'activity',
            liveCount: input.activity.live,
            totalCount: input.activity.total,
            title: input.activity.headline?.title ?? null,
            statusLabel: input.activity.headline?.statusLabel ?? null,
            destination: 'workTab',
        }));
    }

    if (input.recap) {
        rows.push(Object.freeze({
            kind: 'recap',
            text: input.recap.text,
            source: input.recap.source,
            destination: 'workTab',
        }));
    }

    const work = input.awareness.currentWork;
    if (work?.title) {
        rows.push(Object.freeze({
            kind: 'work',
            label: work.title,
            status: work.status ?? null,
            destination: 'work',
        }));
    }
    if (work?.activeWorkflowRunCount) {
        rows.push(Object.freeze({
            kind: 'workflow',
            runCount: work.activeWorkflowRunCount,
            destination: 'workTab',
        }));
    }

    const workspace = workspaceLabel(input.awareness, input.scm);
    // A repository with nothing to report adds noise, not information.
    if (workspace && (input.awareness.workspace || input.scm?.hasAnyChanges || input.scm?.branch)) {
        rows.push(Object.freeze({
            kind: 'workspace',
            label: workspace,
            branch: input.scm?.branch ?? null,
            changedFiles: input.scm ? input.scm.changedFiles : null,
            destination: 'git',
        }));
    }

    // Usage appears only when the canonical latest usage supports a truthful
    // metric; an absent window or token count is omitted, never shown as zero.
    if (input.usage && (input.usage.tokens !== null || input.usage.contextPercent !== null)) {
        rows.push(Object.freeze({
            kind: 'usage',
            tokens: input.usage.tokens,
            contextPercent: input.usage.contextPercent,
            stale: input.usage.stale,
            destination: 'usage',
        }));
    }

    const needsYou = resolveNeedsYou(input.pendingPermissions ?? [], input.pendingUserActions ?? []);
    return Object.freeze({
        needsYou,
        sinceMs: needsYou ? needsYou.request.createdAt : input.turnStartedAtMs ?? null,
        ...(input.awareness.progress ? { statusProgress: input.awareness.progress } : {}),
        ...(input.awareness.nowLine ? { nowLine: presentSessionAwarenessNowLineV1(input.awareness) } : {}),
        ...(input.awareness.statusReasonSetAt ? { statusReasonSetAt: input.awareness.statusReasonSetAt } : {}),
        plan: input.plan ?? null,
        facts: resolveFacts(rows, input.awareness.runningWorkCount ?? 0),
        scope: 'exact',
        title: input.awareness.title ?? null,
        agentLabel: input.agentLabel,
        agentId: input.agentId ?? null,
        // A disconnected Session is not an offline Machine: Machine reachability is its own
        // owner and the freshness line names it, so the status never says "Offline" here.
        status: presentSessionAwarenessV1({ ...input.awareness, viewer: input.viewer }),
        stale: input.awareness.freshness !== 'live',
        // Only a behind Summary renders the time; a live one carries no clock (a heartbeat is not a fact).
        asOfMs: input.awareness.freshness !== 'live' && typeof input.lastObservedAtMs === 'number' && input.lastObservedAtMs > 0
            ? input.lastObservedAtMs : null,
        availability: input.awareness.availability,
        encryption: input.awareness.encryption,
        identityDestination: 'sessionInfo',
        rows: Object.freeze(rows),
    });
}

function resolveNeedsYou(
    permissions: readonly SessionPendingRequest[],
    userActions: readonly SessionPendingRequest[],
): SessionSummaryNeedsYou | null {
    const pending = [...permissions, ...userActions].map((request) => ({ id: request.id, createdAt: request.createdAt, request }));
    const oldest = selectOldestPendingRequest(pending);
    return oldest ? Object.freeze({ request: oldest.request, moreCount: pending.length - 1 }) : null;
}

/** Shows the awareness running total alongside the compact workspace and usage facts. */
function resolveFacts(rows: readonly SessionSummaryRow[], runningWorkCount: number): readonly SessionSummaryFact[] {
    const facts: SessionSummaryFact[] = [];
    if (runningWorkCount > 0) {
        facts.push(Object.freeze({ kind: 'runningWork', count: runningWorkCount, destination: 'workTab' }));
    }
    for (const row of rows) {
        if (row.kind === 'workspace' && row.changedFiles !== null && row.changedFiles > 0) {
            facts.push(Object.freeze({ kind: 'changes', count: row.changedFiles, destination: 'git' }));
        }
        if (row.kind === 'usage' && row.contextPercent !== null) {
            facts.push(Object.freeze({
                kind: 'context',
                percent: Math.round(row.contextPercent),
                stale: row.stale,
                destination: 'usage',
            }));
        }
    }
    return Object.freeze(facts);
}

/** Rows the hero already says in its own shape: facts, and the status line's "what". */
const HERO_ROW_KINDS: ReadonlySet<SessionSummaryRow['kind']> = new Set(['activity', 'workspace', 'usage', 'work']);

/**
 * Recap remains a dedicated destination beside the hero's Work text, even in a
 * compact widget. Other details retain their existing density/overflow owner.
 */
export function resolveSessionSummaryDetailRows(
    model: SessionSummaryCardModel,
    presentation: SessionSummaryRowPresentation,
): Readonly<{ rows: readonly SessionSummaryRow[]; hiddenCount: number }> {
    const detailRows = model.rows.filter((row) => !HERO_ROW_KINDS.has(row.kind));
    const visible = resolveSessionSummaryRows(
        { ...model, rows: detailRows.filter((row) => row.kind !== 'recap') },
        presentation,
    );
    return Object.freeze({
        rows: Object.freeze(detailRows.filter((row) => row.kind === 'recap' || visible.rows.includes(row))),
        hiddenCount: visible.hiddenCount,
    });
}

/**
 * Bounded presentation, not dropped data: rows beyond the density budget stay
 * reachable through one labelled full-surface affordance, and the caller uses
 * `hiddenCount` to announce exactly what is omitted.
 */
export function resolveSessionSummaryVisibleRows(
    model: SessionSummaryCardModel,
    density: SessionCompanionDensity,
): Readonly<{ rows: readonly SessionSummaryRow[]; hiddenCount: number }> {
    const budget = ROW_BUDGET[density];
    return Object.freeze({
        rows: Object.freeze(model.rows.slice(0, budget)),
        hiddenCount: Math.max(0, model.rows.length - budget),
    });
}

export type SessionSummaryRowPresentation =
    | Readonly<{ kind: 'full' }>
    | Readonly<{ kind: 'card'; density: SessionCompanionDensity }>
    | Readonly<{ kind: 'widgetSummary' }>;

/** Full Companion is the destination for omitted card rows, so it is uncapped. */
export function resolveSessionSummaryRows(
    model: SessionSummaryCardModel,
    presentation: SessionSummaryRowPresentation,
): Readonly<{ rows: readonly SessionSummaryRow[]; hiddenCount: number }> {
    if (presentation.kind === 'full') {
        return Object.freeze({ rows: model.rows, hiddenCount: 0 });
    }
    if (presentation.kind === 'widgetSummary') return Object.freeze({ rows: [], hiddenCount: model.rows.length });
    return resolveSessionSummaryVisibleRows(model, presentation.density);
}
