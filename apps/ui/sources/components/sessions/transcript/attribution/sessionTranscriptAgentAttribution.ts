import { readSessionAgentTransitionDividerV1 } from '@happier-dev/protocol';

import { isAgentId, type AgentId } from '@/agents/registry/registryCore';
import type { Message } from '@/sync/domains/messages/messageTypes';

/**
 * Historical Agent attribution over transition-divider boundaries.
 *
 * A Session can change Agent without changing identity. Every consumer that
 * needs "which Agent produced this row" used to read the Session's *current*
 * Agent from live metadata, so after a switch the whole history re-rendered as
 * the new Agent: Codex-era tool headers, bodies and terminal permission
 * outcomes were relabelled Claude, and vice versa.
 *
 * The boundary is the transition divider itself, the only durable record of the
 * change. Between two dividers exactly one Agent is running, so a divider index
 * answers the question **exactly** for the same-Session model — per-turn
 * granularity would buy nothing. This is why it needs no turn hydration and
 * behaves identically on every client and transport.
 *
 * Two tiers, no third:
 *
 * 1. **Divider boundary.** A row after a divider belongs to that divider's
 *    `toAgentId`; a row before the earliest divider belongs to that divider's
 *    `fromAgentId`.
 * 2. **Neutral.** Anything else resolves to `null` — a Session that never
 *    switched, a row with no allocated sequence, a divider naming an Agent this
 *    build's catalog does not know, or a span whose two enclosing dividers
 *    disagree about who was running. `null` means "no historical evidence", and
 *    every consumer then keeps its existing live-metadata behavior. That is
 *    deliberate: an unswitched Session is the overwhelming majority and its
 *    live Agent is already the correct answer, so attribution must never
 *    degrade it.
 *
 * Known bound, accepted with the design: a source row that the canonical
 * writers accept *after* the divider sequence (the stop/cutover race in
 * §11.1.7) is attributed to the target. Divider boundaries are the only
 * evidence this tier has, and inventing a per-row Agent for that race would
 * require the turn hydration this design exists to avoid.
 *
 * Recognition goes through the protocol's single divider reader; the sidecar
 * shape is not re-checked here.
 */

export type SessionAgentTransitionBoundary = Readonly<{
    /** Sequence of the divider row itself. Rows strictly after it are the target's. */
    seq: number;
    fromAgentId: AgentId;
    toAgentId: AgentId;
}>;

export type SessionTranscriptAgentAttributionIndex = Readonly<{
    /** Ascending by `seq`. Empty for every Session that never switched Agent. */
    boundaries: readonly SessionAgentTransitionBoundary[];
}>;

/**
 * Shared empty index. Referentially stable so the (overwhelmingly common)
 * no-transition transcript never invalidates a memo or a context consumer.
 */
export const EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX: SessionTranscriptAgentAttributionIndex =
    Object.freeze({ boundaries: Object.freeze([]) as readonly SessionAgentTransitionBoundary[] });

function readRowSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : null;
}

function collectSessionTranscriptAgentAttributionBoundaries(
    messages: Iterable<Message | null | undefined> | null | undefined,
): SessionAgentTransitionBoundary[] {
    if (!messages) return [];

    const boundaries: SessionAgentTransitionBoundary[] = [];
    for (const message of messages) {
        if (!message || message.kind !== 'agent-event') continue;
        const seq = readRowSeq(message.seq);
        if (seq === null) continue;
        const divider = readSessionAgentTransitionDividerV1({
            localId: message.localId,
            event: message.event,
        });
        if (!divider) continue;
        if (!isAgentId(divider.fromAgentId) || !isAgentId(divider.toAgentId)) continue;
        boundaries.push({
            seq,
            fromAgentId: divider.fromAgentId,
            toAgentId: divider.toAgentId,
        });
    }
    boundaries.sort((a, b) => a.seq - b.seq);
    return boundaries;
}

/**
 * The complete output-relevant input for transcript-root attribution.
 *
 * Streaming text and unrelated message-map replacements are deliberately not
 * represented: they cannot change historical Agent attribution. The list is
 * sorted before serialization, so map insertion order cannot republish an
 * otherwise equivalent divider set.
 */
export function createSessionTranscriptAgentAttributionBoundarySignature(
    messages: Iterable<Message | null | undefined> | null | undefined,
): string {
    return JSON.stringify(collectSessionTranscriptAgentAttributionBoundaries(messages));
}

/**
 * Build the boundary index for one transcript. Called once per transcript, not
 * once per row: resolution is a lookup against a list that is empty or tiny.
 *
 * A divider whose Agent ids this build's catalog does not know contributes no
 * boundary. The divider *row* still renders its raw ids (a divider outlives the
 * catalog), but attribution cannot hand an unknown id to a consumer that will
 * look up an Agent core with it.
 */
export function buildSessionTranscriptAgentAttributionIndex(
    messages: Iterable<Message | null | undefined> | null | undefined,
): SessionTranscriptAgentAttributionIndex {
    const boundaries = collectSessionTranscriptAgentAttributionBoundaries(messages);
    if (boundaries.length === 0) return EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX;
    return { boundaries };
}

/**
 * The Agent that produced the row at `seq`, or `null` when there is no
 * historical evidence and the caller should keep its live-metadata answer.
 */
export function resolveHistoricalAgentIdAtSeq(
    index: SessionTranscriptAgentAttributionIndex | null | undefined,
    seq: number | null | undefined,
): AgentId | null {
    const boundaries = index?.boundaries;
    if (!boundaries || boundaries.length === 0) return null;
    const rowSeq = readRowSeq(seq);
    if (rowSeq === null) return null;

    // The divider row marks the end of the source's span, so equality stays
    // with the source: only rows strictly after it belong to the target.
    let resolved: AgentId | null = null;
    for (const boundary of boundaries) {
        if (rowSeq <= boundary.seq) {
            if (resolved === null) return boundary.fromAgentId;
            // A chain is evidence only while it is continuous. When the previous
            // divider handed the Session to one Agent and this one says a
            // different Agent was running, the two disagree about who produced
            // the rows between them and neither claim is proof. That is the
            // neutral tier, not a third one: the consumer keeps its live-metadata
            // answer rather than being handed a confident wrong Agent.
            return resolved === boundary.fromAgentId ? resolved : null;
        }
        resolved = boundary.toAgentId;
    }
    return resolved;
}
