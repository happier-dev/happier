import { z } from '../zodRuntimePolicy.js';

/**
 * The content-free closed-app wake this Home sends beside the badge refresh and
 * the remote-alert leg.
 *
 * It carries identifiers and an optional mute qualifier, never content. A
 * recipient device that receives it synchronizes that exact
 * Home and then evaluates the recipient's own Activity notification policy and
 * content builder locally, so the Home never has to learn the recipient's
 * settings to reach a closed app.
 *
 * It is deliberately not a delivery contract: Android delivers it as an ordinary
 * data message, iOS as a `content-available` background notification that the OS
 * may throttle, delay or discard. Repeated wakes are safe — synchronization is
 * idempotent and the local notification path dedupes on the canonical Activity
 * event identity.
 */
export const SESSION_CHANGED_WAKE_TYPE = 'session_changed';

export const SessionChangedWakeV1Schema = z.strictObject({
  type: z.literal(SESSION_CHANGED_WAKE_TYPE),
  /** Originating Home, when this Home knows its own identity. */
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  /** Reconcile this wake without presenting a local alert. */
  alert: z.optional(z.literal('muted')),
});
export type SessionChangedWakeV1 = z.infer<typeof SessionChangedWakeV1Schema>;

/**
 * Strict parse of a received push data bag. Anything that is not exactly this
 * payload — a badge refresh, a remote alert, a permissive nested dictionary — is
 * `null` rather than a partially trusted wake.
 */
export function parseSessionChangedWakeV1(data: unknown): SessionChangedWakeV1 | null {
  const parsed = SessionChangedWakeV1Schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
