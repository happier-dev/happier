import {
    isTerminalAgentActivityStatus,
    type SessionAgentActivityHeadlineV1,
    type SessionWorkflowActivityHeadlineV1,
} from '@happier-dev/protocol';

import type { AgentActivityCountable } from './deriveAgentActivityCounts';
import {
    deriveHeadlineAgentActivityEntries,
} from './sources/fromHeadline';
import { deriveWorkflowHeadlineAgentActivityEntries } from './sources/fromWorkflowHeadline';
import type {
    AgentActivityEntry,
    AgentActivityHeadlineEntry,
    AgentActivityLocalEntry,
} from './types';

/**
 * The merge: one roster from a published headline and locally derived transcript entries.
 *
 * Four invariants, each of which has a way of failing quietly:
 *
 * - **INV-1** the headline owns EXISTENCE and STATUS. A local source may add detail — the activity
 *   preview, the sidechain, the terminal instant — and may not overrule what state the work is in.
 *   Disagreement is counted, never reconciled: silently averaging two authorities is how a roster
 *   ends up telling two stories on two surfaces. One bounded exception, at `resolveMergedStatus`.
 * - **INV-2** neither side is dropped. Local-without-headline renders (the headline lags, or the
 *   backend publishes none at all); headline-without-local renders with `detailState: 'unloaded'`
 *   (the transcript page holding it has not arrived — the exact case R-3 exists for).
 * - **INV-3** removal is removal. Nothing is carried forward from a previous merge, so an entry that
 *   both sources stop reporting disappears instead of freezing at its last known status.
 * - **INV-4** referential stability is the CALLER's, applied once at the hook through
 *   `useReconciledStableRows`. Doing it here as well would mean two notions of "unchanged".
 *
 * **The join is on the handle, not the id.** The two sides cannot agree on an entry id: the CLI
 * namespaces an agent by the run it attached it to, and it attaches a plain subagent to a
 * synthesized implicit run only once a second one appears — a decision this process cannot see. They
 * do agree on the provider tool-use id underneath, which the CLI reads off the SDK event and the UI
 * reads off the transcript tool call and its sidechain. Joining on the id instead renders every
 * subagent of every Claude session twice, with every schema valid and every test green.
 */

export type AgentActivityMergeStatusDivergence = Readonly<{
    entryId: string;
    headlineStatus: AgentActivityEntry['status'];
    localStatus: AgentActivityEntry['status'];
}>;

export type AgentActivityMergeDiagnostics = Readonly<{
    /** How many joined entries disagreed on status. Always counted — it is one integer. */
    statusDivergenceCount: number;
    /**
     * The disagreements themselves, in development only.
     *
     * A divergence is a producer/consumer bug, not a user-facing state, so it must be findable by a
     * developer and must cost a shipped build nothing.
     */
    statusDivergences: readonly AgentActivityMergeStatusDivergence[];
}>;

export type AgentActivityMergeResult = Readonly<{
    entries: readonly AgentActivityEntry[];
    /** Which headline the roster was built from. `none` is the Codex/Gemini/OpenCode path. */
    headlineSource: 'agentActivity' | 'workflow' | 'none';
    diagnostics: AgentActivityMergeDiagnostics;
}>;

const NO_DIVERGENCES: readonly AgentActivityMergeStatusDivergence[] = Object.freeze([]);

function isDevBuild(): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__;
}

/**
 * The status a joined entry ends up with.
 *
 * INV-1 with ONE narrow exception, and the exception is not a softening of the rule — it is the rule
 * applied to a fact the headline structurally cannot hold. `waiting` is not a lifecycle state the CLI
 * competes for; it is the local observation that a permission prompt is on screen and a PERSON is the
 * blocker. The CLI never sees that prompt, so it publishes `running`, and deferring to it would leave
 * the one status that escalates unable to escalate — the composer would never fill for the case
 * R-7 exists for.
 *
 * It is bounded on both sides: only `waiting` may win, and only over a non-terminal headline status.
 * A finished agent is not waiting on anybody, and painting it as attention would send a person to a
 * row they cannot act on.
 */
function resolveMergedStatus(
    headlineStatus: AgentActivityEntry['status'],
    localStatus: AgentActivityEntry['status'],
): AgentActivityEntry['status'] {
    if (localStatus === 'waiting' && !isTerminalAgentActivityStatus(headlineStatus)) return 'waiting';
    return headlineStatus;
}

function mergeEvidenceInstant(
    left: number | null | undefined,
    right: number | null | undefined,
): number | null {
    const leftMs = typeof left === 'number' && Number.isFinite(left) ? left : null;
    const rightMs = typeof right === 'number' && Number.isFinite(right) ? right : null;
    if (leftMs === null) return rightMs;
    if (rightMs === null) return leftMs;
    return Math.max(leftMs, rightMs);
}

function toHeadlineOnlyEntry(entry: AgentActivityHeadlineEntry): AgentActivityEntry {
    return {
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        title: entry.title,
        metaDetail: null,
        startedAtMs: entry.startedAtMs ?? null,
        updatedAtMs: entry.updatedAtMs ?? null,
        // The headline carries no terminal instant by design, and borrowing `updatedAt` for one is
        // D-8. The row's elapsed guard reads an absent end as "no claim", which is the truth.
        endedAtMs: null,
        provenance: 'headline',
        detailState: 'unloaded',
        parentId: entry.parentId ?? null,
        liveAgentComplement: entry.liveAgentComplement ?? null,
        runId: entry.runId ?? null,
        sidechainId: entry.sidechainId ?? null,
        subagentId: null,
    };
}

function toLocalOnlyEntry(entry: AgentActivityLocalEntry): AgentActivityEntry {
    return {
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        title: entry.title,
        metaDetail: entry.metaDetail ?? null,
        startedAtMs: entry.startedAtMs ?? null,
        updatedAtMs: entry.updatedAtMs ?? null,
        endedAtMs: entry.endedAtMs ?? null,
        provenance: 'local',
        detailState: 'loaded',
        parentId: null,
        // A locally derived entry is one agent. It never speaks for a run's complement.
        liveAgentComplement: null,
        runId: entry.runId ?? null,
        sidechainId: entry.sidechainId ?? null,
        subagentId: entry.subagentId ?? entry.id,
    };
}

function toMergedEntry(
    headline: AgentActivityHeadlineEntry,
    local: AgentActivityLocalEntry,
): AgentActivityEntry {
    return {
        // The headline's id wins so one agent is keyed identically on every surface, whichever
        // source that surface happened to see first.
        id: headline.id,
        kind: headline.kind,
        status: resolveMergedStatus(headline.status, local.status),
        // The local title is the live one — it tracks the tool call as it is edited and is not
        // clamped by the headline's transport bound — so it wins when it says something.
        title: local.title.trim().length > 0 ? local.title : headline.title,
        metaDetail: local.metaDetail ?? null,
        startedAtMs: local.startedAtMs ?? headline.startedAtMs ?? null,
        updatedAtMs: mergeEvidenceInstant(headline.updatedAtMs, local.updatedAtMs),
        endedAtMs: local.endedAtMs ?? null,
        provenance: 'merged',
        detailState: 'loaded',
        parentId: headline.parentId ?? null,
        liveAgentComplement: headline.liveAgentComplement ?? null,
        runId: local.runId ?? headline.runId ?? null,
        sidechainId: local.sidechainId ?? headline.sidechainId ?? null,
        subagentId: local.subagentId ?? local.id,
    };
}

export function deriveAgentActivityEntries(params: Readonly<{
    headline: SessionAgentActivityHeadlineV1 | null | undefined;
    /** The older count-only key, used only when the unified one is absent (PLAN §5.2). */
    workflowHeadline?: SessionWorkflowActivityHeadlineV1 | null;
    local: readonly AgentActivityLocalEntry[];
}>): AgentActivityMergeResult {
    // Exactly one headline source. Both are projected from the SAME committed run snapshots, so
    // reading both would list every run twice.
    const headlineSource: AgentActivityMergeResult['headlineSource'] = params.headline
        ? 'agentActivity'
        : params.workflowHeadline
            ? 'workflow'
            : 'none';
    const headlineEntries = params.headline
        ? deriveHeadlineAgentActivityEntries(params.headline)
        : deriveWorkflowHeadlineAgentActivityEntries(params.workflowHeadline);

    const headlineById = new Map<string, AgentActivityHeadlineEntry>();
    const headlineByHandle = new Map<string, AgentActivityHeadlineEntry>();
    for (const entry of headlineEntries) {
        headlineById.set(entry.id, entry);
        // First writer wins: if a provider ever named two agents by one tool-use id, joining the
        // local row onto both would duplicate it — the failure this whole module exists to prevent.
        if (entry.handle !== null && !headlineByHandle.has(entry.handle)) {
            headlineByHandle.set(entry.handle, entry);
        }
    }

    const entries: AgentActivityEntry[] = [];
    const consumedHeadlineIds = new Set<string>();
    const divergences: AgentActivityMergeStatusDivergence[] = [];
    let statusDivergenceCount = 0;
    const collectDivergences = isDevBuild();

    // Local order first: it is the roster the pane already sorts, and the section model re-orders
    // anyway. What matters here is that the sequence is deterministic.
    for (const local of params.local) {
        const match = headlineById.get(local.id)
            ?? (local.handle !== null ? headlineByHandle.get(local.handle) : undefined);
        if (!match || consumedHeadlineIds.has(match.id)) {
            entries.push(toLocalOnlyEntry(local));
            continue;
        }
        consumedHeadlineIds.add(match.id);
        // Counted only when the headline actually overruled the local source. The `waiting` overlay
        // above is a designed resolution, not a producer bug, and folding it in here would bury the
        // signal this diagnostic exists to surface.
        if (match.status !== local.status && resolveMergedStatus(match.status, local.status) === match.status) {
            statusDivergenceCount += 1;
            if (collectDivergences) {
                divergences.push({
                    entryId: match.id,
                    headlineStatus: match.status,
                    localStatus: local.status,
                });
            }
        }
        entries.push(toMergedEntry(match, local));
    }

    for (const headlineEntry of headlineEntries) {
        if (consumedHeadlineIds.has(headlineEntry.id)) continue;
        entries.push(toHeadlineOnlyEntry(headlineEntry));
    }

    return {
        entries,
        headlineSource,
        diagnostics: {
            statusDivergenceCount,
            statusDivergences: divergences.length > 0 ? divergences : NO_DIVERGENCES,
        },
    };
}

/**
 * A merged entry, as the shared counter reads it.
 *
 * The count vocabulary is narrower than the entry vocabulary on purpose: this app calls every member
 * of a session's roster a *subagent*, whether it arrived as a `Task` sidechain, a delegated execution
 * run or a teammate, so collapsing them here keeps the composer's copy in the product's own words
 * instead of inventing three nouns a reader has never seen.
 *
 * A background task is the one member that must NOT collapse into that noun: it is a headless
 * command, and counting it as a subagent would let a surface say "3 subagents working" about two
 * agents and a shell loop.
 *
 * A workflow run keeps BOTH of the things that let a surface describe it honestly: the run it is
 * (`runId`, which its own agents are joined back to) and the complement its producer stated
 * (`liveAgentComplement`). Dropping the latter here is what understated a five-agent workflow to
 * "1 agent working" on the chip and on the session-list row.
 */
export function toAgentActivityCountable(entry: AgentActivityEntry): AgentActivityCountable {
    return {
        id: entry.id,
        kind: entry.kind === 'workflow_run'
            ? 'workflow'
            : entry.kind === 'background_task'
                ? 'backgroundTask'
                : 'subagent',
        status: entry.status,
        parentId: entry.parentId ?? null,
        runId: entry.runId ?? null,
        liveAgentComplement: entry.liveAgentComplement ?? null,
        endedAtMs: entry.endedAtMs ?? null,
    };
}
