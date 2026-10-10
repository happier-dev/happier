import { isSessionOwnedActivityUnobserved } from '../attention/runtimePresentation';
import { isTerminalAgentActivityStatus, type AgentActivityStatusV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityStatusV1';
import type { SessionAgentActivityHeadlineV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';

import {
    buildAgentActivityEvidenceIndex,
    type AgentActivityEvidenceSource,
} from './agentActivityEvidence';
import { deriveHeadlineAgentActivityEntries } from './sources/fromHeadline';
import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    type AgentActivityEntry,
    type AgentActivityHeadlineEntry,
    type AgentActivityLocalEntry,
} from './types';

/**
 * The merge: one roster from the published headline and the locally derived transcript entries.
 *
 * Four invariants, each of which has a way of failing quietly:
 *
 * - **INV-1** the headline owns existence and published status. Newer explicit local completion
 *   reconciles older nonterminal claims, and runtime loss changes observation to unknown.
 * - **INV-2 neither side is dropped.** Local-without-headline is kept (the headline lags, or the
 *   backend publishes none at all) and marked `provenance: 'local'`; headline-without-local is kept
 *   with `detailState: 'unloaded'` — the transcript page holding it has not arrived, which is the
 *   ordinary cold-open state and not an error.
 * - **INV-3 removal is removal.** Nothing is carried forward from a previous merge, so an entry
 *   both sources stop reporting disappears instead of freezing at its last known status. A phase
 *   that reports no entries is a tombstone, never "keep the last status".
 * - **INV-4 referential stability is the CALLER's**, applied once at the hook through
 *   `useReconciledStableRows`. Doing it here as well would mean two notions of "unchanged".
 *
 * **The join is on the handle, not the id.** The two sides cannot agree on an entry id: the
 * publisher namespaces an agent by the run it attached it to, and which run that is is a
 * producer-side decision this process cannot see. They do agree on the provider tool-use id
 * underneath, which the publisher reads off the SDK event and this client reads off the transcript
 * tool call and its sidechain. Joining on the id instead renders every agent of every session
 * twice, with every schema valid and every test green.
 *
 * **Evidence is not merged into the row.** How fresh a unit of work is changes constantly while
 * what the unit IS does not, so the freshest instant per entry is returned in a separate index and
 * never as a row field. Folding it in would give every row a new object on every observation and
 * quietly disable the memoization the roster depends on.
 */

export type AgentActivityMergeStatusDivergence = Readonly<{
    entryId: string;
    headlineStatus: AgentActivityStatusV1;
    localStatus: AgentActivityStatusV1;
}>;

export type AgentActivityMergeDiagnostics = Readonly<{
    /** How many joined entries disagreed on status. Always counted — it is one integer. */
    statusDivergenceCount: number;
    /**
     * The disagreements themselves, in development builds only.
     *
     * A divergence is a producer/consumer bug, not a user-facing state, so it must be findable by a
     * developer and must cost a shipped build nothing.
     */
    statusDivergences: readonly AgentActivityMergeStatusDivergence[];
}>;

export type AgentActivityMergeResult = Readonly<{
    entries: readonly AgentActivityEntry[];
    /**
     * The freshest evidence instant per entry id, joined across both sources.
     *
     * Deliberately beside the entries rather than on them — see the module note. When both sources
     * carry an instant the LATER wins: both are evidence, and the newer one is the one that has not
     * gone stale.
     */
    evidenceAtMsById: ReadonlyMap<string, number>;
    diagnostics: AgentActivityMergeDiagnostics;
}>;

const NO_DIVERGENCES: readonly AgentActivityMergeStatusDivergence[] = Object.freeze([]);

function isDevBuild(): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__;
}

function resolveMergedStatus(headline: AgentActivityHeadlineEntry, local: AgentActivityLocalEntry): AgentActivityStatusV1 {
    if (!isTerminalAgentActivityStatus(headline.status)) {
        if (isTerminalAgentActivityStatus(local.status) && local.endedAtMs !== null
            && local.endedAtMs >= (headline.updatedAtMs ?? 0)) return local.status;
        if (local.status === 'waiting') return 'waiting';
    }
    return headline.status;
}

function toHeadlineOnlyEntry(entry: AgentActivityHeadlineEntry): AgentActivityEntry {
    return {
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        title: entry.title,
        metaDetail: null,
        startedAtMs: entry.startedAtMs,
        // The headline carries no terminal instant by design, and borrowing `updatedAt` for one
        // would be exactly the synthesised finish the entry schema forbids.
        endedAtMs: null,
        provenance: 'headline',
        detailState: 'unloaded',
        parentId: entry.parentId,
        runId: entry.runId,
        sidechainId: entry.sidechainId,
        subagentId: null,
        // Nothing has been LOADED about this entry, so nothing was observed waiting on a person. An
        // unloaded row that announced "needs your approval" would be inviting someone to answer a
        // prompt this client has never seen.
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    };
}

function toLocalOnlyEntry(entry: AgentActivityLocalEntry): AgentActivityEntry {
    return {
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        ...(entry.isActive !== undefined ? { isActive: entry.isActive } : {}),
        title: entry.title,
        metaDetail: entry.metaDetail,
        startedAtMs: entry.startedAtMs,
        endedAtMs: entry.endedAtMs,
        provenance: 'local',
        detailState: 'loaded',
        // A locally derived entry never claims a parent: only the publisher knows which run it
        // attached an agent to, and inventing containment here is how a live unit of work becomes
        // invisible to every count.
        parentId: null,
        runId: entry.runId,
        sidechainId: entry.sidechainId,
        subagentId: entry.subagentId ?? entry.id,
        attentionKinds: entry.attentionKinds,
    };
}

function toMergedEntry(
    headline: AgentActivityHeadlineEntry,
    local: AgentActivityLocalEntry,
): AgentActivityEntry {
    const status = resolveMergedStatus(headline, local);
    return {
        // The headline's id wins so one agent is keyed identically on every surface, whichever
        // source that surface happened to see first.
        id: headline.id,
        kind: headline.kind,
        status,
        ...(local.isActive !== undefined ? { isActive: local.isActive } : {}),        // The local title is the live one — it tracks the tool call as it is edited and is not
        // clamped by the headline's transport bound — so it wins when it says something.
        title: local.title.trim().length > 0 ? local.title : headline.title,
        metaDetail: local.metaDetail,
        startedAtMs: local.startedAtMs ?? headline.startedAtMs,
        endedAtMs: local.endedAtMs,
        provenance: 'merged',
        detailState: 'loaded',
        parentId: headline.parentId,
        runId: local.runId ?? headline.runId,
        sidechainId: local.sidechainId ?? headline.sidechainId,
        subagentId: local.subagentId ?? local.id,
        // Tied to the RESOLVED status, not to the local observation alone. `resolveMergedStatus`
        // already refuses to let a local `waiting` overrule a terminal headline; carrying the
        // attention through anyway would leave a finished row still asking someone to answer.
        attentionKinds: status === 'waiting' ? local.attentionKinds : NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    };
}

export function deriveAgentActivityEntries(params: Readonly<{
    headline: SessionAgentActivityHeadlineV1 | null | undefined;
    local: readonly AgentActivityLocalEntry[];
    runtimeLostSinceMs?: number | null;
}>): AgentActivityMergeResult {
    const headlineEntries = deriveHeadlineAgentActivityEntries(params.headline);

    const headlineById = new Map<string, AgentActivityHeadlineEntry>();
    const headlineByHandle = new Map<string, AgentActivityHeadlineEntry>();
    for (const entry of headlineEntries) {
        headlineById.set(entry.id, entry);
        // First writer wins: if a producer ever named two agents by one tool-use id, joining the
        // local row onto both would duplicate it — the failure this module exists to prevent.
        if (entry.handle !== null && !headlineByHandle.has(entry.handle)) {
            headlineByHandle.set(entry.handle, entry);
        }
    }

    const entries: AgentActivityEntry[] = [];
    // Collected as observations and folded by the evidence owner, so "the later of two instants"
    // has exactly one implementation in the app.
    const observations: AgentActivityEvidenceSource[] = [];
    const consumedHeadlineIds = new Set<string>();
    const divergences: AgentActivityMergeStatusDivergence[] = [];
    let statusDivergenceCount = 0;
    const collectDivergences = isDevBuild();

    // Local order first: it is the roster `deriveSessionSubagents` already sorted. What matters
    // here is only that the sequence is deterministic.
    for (const local of params.local) {
        const match = headlineById.get(local.id)
            ?? (local.handle !== null ? headlineByHandle.get(local.handle) : undefined);
        if (!match || consumedHeadlineIds.has(match.id)) {
            entries.push(toLocalOnlyEntry(local));
            observations.push({ id: local.id, updatedAtMs: local.updatedAtMs });
            continue;
        }
        consumedHeadlineIds.add(match.id);
        // Counted only when the headline actually overruled the local source. The `waiting` overlay
        // above is a designed resolution, not a producer bug, and folding it in here would bury the
        // signal this diagnostic exists to surface.
        if (
            match.status !== local.status
            && resolveMergedStatus(match, local) === match.status
        ) {
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
        // Both instants are pushed under the merged id; the index keeps the later one.
        observations.push({ id: match.id, updatedAtMs: match.updatedAtMs });
        observations.push({ id: match.id, updatedAtMs: local.updatedAtMs });
    }

    for (const headlineEntry of headlineEntries) {
        if (consumedHeadlineIds.has(headlineEntry.id)) continue;
        entries.push(toHeadlineOnlyEntry(headlineEntry));
        observations.push({ id: headlineEntry.id, updatedAtMs: headlineEntry.updatedAtMs });
    }

    const evidenceAtMsById = buildAgentActivityEvidenceIndex(observations);
    return {
        entries: entries.map((entry) => entry.kind !== 'execution_run'
            && !isTerminalAgentActivityStatus(entry.status) && entry.status !== 'unknown'
            && isSessionOwnedActivityUnobserved(params.runtimeLostSinceMs, evidenceAtMsById.get(entry.id))
            ? { ...entry, status: 'unknown', attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION }
            : entry),
        evidenceAtMsById,
        diagnostics: {
            statusDivergenceCount,
            statusDivergences: divergences.length > 0 ? divergences : NO_DIVERGENCES,
        },
    };
}
