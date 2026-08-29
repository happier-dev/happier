import { z } from 'zod';

import { AgentIdV1Schema } from '../agents/agentIdV1.js';

/**
 * Transition divider contract — the ONLY transition history artifact.
 *
 * The divider is deliberately NOT a new `AgentEventSchema` variant. That union is
 * closed at the discriminator, so a released older reader would fail to parse an
 * unknown `type` and drop the row. Instead the divider rides the already-shipped
 * `type:'message'` passthrough arm as a strict nested sidecar:
 *
 *   { type: 'message', message: '<prose>', sessionAgentTransitionV1: { v, fromAgentId, toAgentId, ...bounds } }
 *
 * An old reader parses it as an ordinary informational message and renders the
 * prose; the sidecar survives its `.passthrough()` untouched. A new reader
 * recognizes the sidecar through {@link readSessionAgentTransitionDividerV1}.
 *
 * This module intentionally imports nothing but `zod` so the transcript record
 * schema, the attention resolvers, and the transition coordinator can all depend
 * on one owner without an import cycle.
 */

/** Sidecar key carried on the passthrough `type:'message'` agent-event arm. */
export const SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY = 'sessionAgentTransitionV1';

/**
 * Prose stored on the divider row. It exists only so a reader that does not
 * understand the sidecar still renders something truthful. New readers render
 * localized copy from the sidecar instead, so this string is not a UI oracle.
 */
export const SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE = 'Continued with another Agent.';

/**
 * Reserved local-ID namespace for the divider. Every generic client-facing
 * message ingress MUST reject a localId in this namespace; only the owner-only
 * transition service may pass one to the canonical `createSessionMessage` owner.
 */
export const SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX = 'agent-transition:';

export const SessionAgentTransitionDividerV1Schema = z
  .object({
    v: z.literal(1),
    fromAgentId: AgentIdV1Schema,
    toAgentId: AgentIdV1Schema,
    /**
     * UPPER bound: the source transcript cutoff the activation brief was built
     * from — the `upToSeqInclusive` the bounded context pass actually used.
     *
     * It is here because nothing else records it. `replaySeedV1.seedText` is
     * blanked the instant the target Agent accepts it, and the metadata record
     * holds one seed per Session, so a Session switched twice keeps only the
     * newest. Without a per-boundary cutoff, "what was this Agent actually
     * handed?" is unanswerable after the fact, and a reader that guessed from
     * the divider's own seq would be wrong for every row admitted between the
     * confirmed stop and the divider write.
     *
     * `0` means the observed transcript head itself was zero. A pass that
     * produces no dialog still records its non-zero observed upper bound.
     *
     * REQUIRED. The only writer that ever omitted it is an unreleased
     * intermediate build of this feature, so accepting a cutoff-less sidecar
     * would buy nothing and cost a third state every reader has to model. Such a
     * sidecar fails the strict parse and the row degrades through the path this
     * shape was already designed for: the whole sidecar is dropped and the
     * stored prose is rendered, exactly as in an older reader.
     */
    sourceCutoffSeqInclusive: z.number().int().nonnegative(),
    /**
     * LOWER bound, exclusive, on a NATIVE RETURN only: the transcript head the
     * arriving Agent had already seen when it last ran this Session.
     *
     * A fresh target's handoff is bounded only above — the pass starts at the
     * beginning of the source — so the cutoff alone rebuilds it exactly. A
     * native return is bounded at BOTH ends and what actually crossed the
     * boundary is the away-delta between them. That lower bound lives in the
     * returning Agent's device-local departure record, which the very next
     * departure overwrites, so this is the only place it can outlive the
     * boundary that used it. Without it a rebuild reruns the same pass with no
     * lower bound and shows the FULL prefix — more than was sent — from a card
     * whose entire claim is that it shows what was handed over.
     *
     * ABSENT is the fresh target: no lower bound existed. Absence therefore
     * means exactly one thing, which is why this is optional rather than a
     * required nullable third state every reader would have to model.
     */
    returningAgentLastSeenSeqInclusive: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SessionAgentTransitionDividerV1 = z.infer<typeof SessionAgentTransitionDividerV1Schema>;

/**
 * True only when two dividers describe the exact same handoff boundary.
 *
 * The replay bounds are not decoration: together they say exactly which slice
 * reached the target. Treating an equal Agent pair with different bounds as a
 * retry would admit or activate against somebody else's boundary.
 */
export function isSameSessionAgentTransitionDividerV1(
  left: Readonly<SessionAgentTransitionDividerV1>,
  right: Readonly<SessionAgentTransitionDividerV1>,
): boolean {
  return left.v === right.v
    && left.fromAgentId === right.fromAgentId
    && left.toAgentId === right.toAgentId
    && left.sourceCutoffSeqInclusive === right.sourceCutoffSeqInclusive
    && left.returningAgentLastSeenSeqInclusive === right.returningAgentLastSeenSeqInclusive;
}

/**
 * Matches only the Agent pair known to a post-cutover reconciliation request.
 *
 * A retry that reaches an already-target Session has no surviving candidate
 * bounds to compare — the durable request carries its localId and Agent pair,
 * while the original bounded pass is gone. That recovery check must therefore
 * not impersonate exact-boundary equality. Callers that still hold the
 * candidate divider (the cutover owner and E2EE verification gate) use
 * {@link isSameSessionAgentTransitionDividerV1} instead.
 */
export function matchesSessionAgentTransitionDividerAgentsV1(
  divider: Readonly<SessionAgentTransitionDividerV1>,
  expected: Readonly<Pick<SessionAgentTransitionDividerV1, 'fromAgentId' | 'toAgentId'>>,
): boolean {
  return divider.fromAgentId === expected.fromAgentId
    && divider.toAgentId === expected.toAgentId;
}

/**
 * Deterministic divider identity: `agent-transition:{submittedLocalId}`. The
 * submitted user-message localId is the single correlation key for the whole
 * transition, so the divider is exactly-once without any receipt or marker.
 */
export function buildSessionAgentTransitionDividerLocalId(submittedLocalId: string): string {
  return `${SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX}${submittedLocalId}`;
}

/** True when a localId falls in the reserved divider namespace. */
export function isSessionAgentTransitionDividerLocalId(localId: unknown): boolean {
  return typeof localId === 'string'
    && localId.startsWith(SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX);
}

/**
 * The single canonical "is this row a transition divider?" reader.
 *
 * It requires BOTH halves of the divider's identity:
 *
 *   - `localId` — the row's OUTER local id, which must be in the reserved
 *     namespace. Every generic message ingress refuses that prefix, so only the
 *     owner-only cutover service can produce a row there. This is the half that
 *     makes the answer trustworthy.
 *   - `event` — the agent-event payload (the `data` of a `type:'event'`
 *     transcript record), which must carry a strictly valid sidecar.
 *
 * The sidecar alone is NOT proof and must never be read as one: its key name is
 * writable by anyone who can post an agent event to the Session, so trusting it
 * on an ordinary row would let an authorized writer silence their own message
 * and manufacture an attribution boundary the transition never made. Attention
 * resolvers, the separator renderer, historical attribution, and the bounded
 * context pass all use THIS function — none of them re-implement either check.
 */
export function readSessionAgentTransitionDividerV1(
  row: Readonly<{ localId: unknown; event: unknown }>,
): SessionAgentTransitionDividerV1 | null {
  if (!isSessionAgentTransitionDividerLocalId(row?.localId)) return null;
  const value = row.event;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'message') return null;
  const sidecar = record[SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY];
  if (sidecar === undefined) return null;
  const parsed = SessionAgentTransitionDividerV1Schema.safeParse(sidecar);
  return parsed.success ? parsed.data : null;
}

/**
 * The stored-record shape a row MUST have before any process calls it a
 * transition divider.
 *
 * {@link readSessionAgentTransitionDividerV1} answers for the reserved localId
 * and the agent-event PAYLOAD; on its own it says nothing about the record
 * WRAPPER carrying that payload. The divider is always written as a
 * `role:'agent'` / `content.type:'event'` record, so a user-role (or non-event)
 * row planted at the reserved localId with a matching sidecar must never be read
 * as one. The server's cutover owner and the daemon's
 * divider-evidence reader both answer that question — about the same rows, in
 * different processes — so they answer it HERE rather than each re-deriving the
 * wrapper checks.
 */
export function readSessionAgentTransitionDividerFromStoredRecordV1(
  row: Readonly<{ localId: unknown; record: unknown }>,
): SessionAgentTransitionDividerV1 | null {
  const value = row?.record;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { role?: unknown; content?: unknown };
  if (record.role !== 'agent') return null;
  const content = record.content as { type?: unknown; data?: unknown } | undefined;
  if (!content || content.type !== 'event') return null;
  return readSessionAgentTransitionDividerV1({ localId: row.localId, event: content.data });
}
