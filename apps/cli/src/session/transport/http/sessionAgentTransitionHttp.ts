import axios from 'axios';
import { z } from 'zod';

import type { SessionStoredMessageContent } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

/**
 * Daemon client for the owner-only Agent-transition cutover.
 *
 * Two things make this a dedicated call rather than a metadata PATCH plus a
 * message POST:
 * - the server enforces `active=false` / `archivedAt=null` inside the same CAS
 *   that writes the sealed target view, which no ordinary patch does;
 * - the generic message ingress REJECTS the reserved divider localId, so the
 *   divider can only be produced by this command.
 *
 * The transport outcome is deliberately two-valued. A lost response after the
 * server committed is indistinguishable from a request that never arrived, so
 * `unknown` is returned instead of guessing — the coordinator then reports
 * `outcome_unknown` rather than a rejection that would claim an untouched
 * source.
 *
 * The wire shape is the ONE cutover contract, shared with the successor tree:
 * the outcome rides the HTTP status (200 success, 409/500 carrying the explicit
 * partial-effect discriminator, 400/403/404 for the status-coded no-effect
 * refusals), which is how every other session route in this server reports
 * itself. This reader and `registerSessionAgentTransitionRoute` are the two
 * halves of that contract, and `sessionAgentTransitionHttp.test.ts` is what pins
 * them together — nothing else does, because the coordinator tests mock this
 * function.
 */

const CutoverSuccessSchema = z.object({
  success: z.literal(true),
  dividerSeq: z.number().int().min(0),
  /**
   * The server found an unreadable row already occupying the reserved divider
   * localId and could not establish that this operation wrote it. A server that
   * seals dividers deterministically decides authorship by byte comparison and
   * never sends this; one that seals with a random nonce has to defer.
   */
  dividerVerificationRequired: z.literal(true).optional(),
}).passthrough();

const CutoverNoEffectErrorSchema = z.enum([
  'invalid-params',
  'forbidden',
  'session-not-found',
  'archived',
  'session-active',
  'version-mismatch',
  'internal',
]);

const CutoverConflictSchema = z.discriminatedUnion('effect', [
  z.object({
    effect: z.literal('none'),
    error: CutoverNoEffectErrorSchema,
  }).passthrough(),
  z.object({
    effect: z.literal('current_view_committed'),
    error: z.enum(['divider-conflict', 'divider-rejected', 'internal']),
  }).passthrough(),
]);

export type SessionAgentTransitionCutoverResponse =
  | Readonly<{ ok: true; dividerSeq: number; dividerVerificationRequired?: true }>
  | Readonly<{
      ok: false;
      effect: 'none';
      error: z.infer<typeof CutoverNoEffectErrorSchema>;
    }>
  | Readonly<{
      ok: false;
      effect: 'current_view_committed';
      error: 'divider-conflict' | 'divider-rejected' | 'internal';
    }>;

export type SessionAgentTransitionCutoverOutcome =
  | Readonly<{ status: 'settled'; response: SessionAgentTransitionCutoverResponse }>
  /** The request may or may not have been applied. Never treated as no-effect. */
  | Readonly<{ status: 'unknown'; reason: string }>;

function noEffect(
  error: z.infer<typeof CutoverNoEffectErrorSchema>,
): SessionAgentTransitionCutoverOutcome {
  return { status: 'settled', response: { ok: false, effect: 'none', error } };
}

export async function commitSessionAgentTransitionCutover(params: Readonly<{
  token: string;
  sessionId: string;
  currentView: Readonly<{
    kind: 'legacy_v0';
    expectedMetadataVersion: number;
    metadataCiphertext: string;
    expectedAgentStateVersion: number;
    agentStateCiphertext: null;
  }>;
  divider: Readonly<{ localId: string; content: SessionStoredMessageContent }>;
  timeoutMs?: number;
}>): Promise<SessionAgentTransitionCutoverOutcome> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeURIComponent(params.sessionId);

  let response: { status: number; data: unknown };
  try {
    response = await axios.post<unknown>(
      `${serverUrl}/v2/sessions/${encodedSessionId}/agent-transition/cutover`,
      {
        v: 1,
        currentView: params.currentView,
        divider: params.divider,
      },
      {
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        timeout: typeof params.timeoutMs === 'number' ? params.timeoutMs : 20_000,
        validateStatus: () => true,
      },
    );
  } catch (error) {
    return {
      status: 'unknown',
      reason: error instanceof Error ? error.message : 'Agent transition cutover transport failed',
    };
  }

  if (response.status === 200) {
    const success = CutoverSuccessSchema.safeParse(response.data);
    return success.success
      ? {
          status: 'settled',
          response: {
            ok: true,
            dividerSeq: success.data.dividerSeq,
            ...(success.data.dividerVerificationRequired
              ? { dividerVerificationRequired: true as const }
              : {}),
          },
        }
      : { status: 'unknown', reason: 'Unexpected cutover response shape' };
  }
  // 409 carries the explicit partial-effect discriminator; a 500 may also carry
  // it when the failure is attributable to a known depth. An unparseable body is
  // ambiguous and must not be collapsed into a definite effect.
  if (response.status === 409 || response.status >= 500) {
    const conflict = CutoverConflictSchema.safeParse(response.data);
    if (!conflict.success) {
      return { status: 'unknown', reason: `Unexpected cutover status ${response.status}` };
    }
    return conflict.data.effect === 'none'
      ? noEffect(conflict.data.error)
      : {
          status: 'settled',
          response: { ok: false, effect: 'current_view_committed', error: conflict.data.error },
        };
  }
  // Every remaining status the route declares is a refusal that wrote nothing.
  // A 401/403 is reported through the union rather than thrown: by the time this
  // runs the source is already stopped, so the coordinator needs a result arm at
  // a known depth — an exception here would surface as `outcome_unknown` and
  // withhold a recovery the daemon can prove.
  if (response.status === 400) return noEffect('invalid-params');
  if (response.status === 401 || response.status === 403) return noEffect('forbidden');
  if (response.status === 404) return noEffect('session-not-found');
  return { status: 'unknown', reason: `Unexpected cutover status ${response.status}` };
}
