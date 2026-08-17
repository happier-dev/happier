import { z } from 'zod';

/**
 * Transition divider contract — the ONLY transition history artifact.
 *
 * The divider is deliberately NOT a new `AgentEventSchema` variant. That union is
 * closed at the discriminator, so a released older reader would fail to parse an
 * unknown `type` and drop the row. Instead the divider rides the already-shipped
 * `type:'message'` passthrough arm as a strict nested sidecar:
 *
 *   { type: 'message', message: '<prose>', sessionAgentTransitionV1: { v, fromAgentId, toAgentId } }
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
    fromAgentId: z.string().trim().min(1).max(128),
    toAgentId: z.string().trim().min(1).max(128),
  })
  .strict();
export type SessionAgentTransitionDividerV1 = z.infer<typeof SessionAgentTransitionDividerV1Schema>;

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
 * The single canonical "is this agent-event a transition divider?" reader.
 *
 * `value` is the agent-event payload (the `data` of a `type:'event'` transcript
 * record). Returns the parsed sidecar, or `null` for every other row. Attention
 * resolvers, the separator renderer, historical attribution, and the bounded
 * context pass all use THIS function — none of them re-implement the shape check.
 */
export function readSessionAgentTransitionDividerV1(
  value: unknown,
): SessionAgentTransitionDividerV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'message') return null;
  const sidecar = record[SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY];
  if (sidecar === undefined) return null;
  const parsed = SessionAgentTransitionDividerV1Schema.safeParse(sidecar);
  return parsed.success ? parsed.data : null;
}
