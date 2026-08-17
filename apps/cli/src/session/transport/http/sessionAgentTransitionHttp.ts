import axios from 'axios';
import { z } from 'zod';

import type { SessionStoredMessageContent } from '@happier-dev/protocol';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';

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
 * The transport outcome is deliberately three-valued. A lost response after the
 * server committed is indistinguishable from a request that never arrived, so
 * `unknown` is returned instead of guessing — the coordinator then reports
 * `outcome_unknown` rather than a rejection that would claim an untouched
 * source.
 */

const CommittedCurrentViewSchema = z.object({
  kind: z.literal('legacy_v0'),
  metadataVersion: z.number().int().min(0),
  agentStateVersion: z.number().int().min(0),
});

const CutoverResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    dividerSeq: z.number().int().min(0),
    dividerDidWrite: z.boolean(),
    currentView: CommittedCurrentViewSchema,
  }),
  z.object({
    ok: z.literal(false),
    effect: z.literal('current_view_committed'),
    error: z.enum(['divider-conflict', 'divider-rejected', 'internal']),
    currentView: CommittedCurrentViewSchema,
  }),
  z.object({
    ok: z.literal(false),
    effect: z.literal('none'),
    error: z.enum([
      'invalid-params',
      'forbidden',
      'session-not-found',
      'archived',
      'session-active',
      'version-mismatch',
      'internal',
    ]),
  }),
]);

export type SessionAgentTransitionCutoverResponse = z.infer<typeof CutoverResponseSchema>;

export type SessionAgentTransitionCutoverOutcome =
  | Readonly<{ status: 'settled'; response: SessionAgentTransitionCutoverResponse }>
  /** The server predates the operation. Definitely nothing was written. */
  | Readonly<{ status: 'unsupported' }>
  /** The request may or may not have been applied. Never treated as no-effect. */
  | Readonly<{ status: 'unknown'; reason: string }>;

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

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, `Unauthorized (${response.status})`);
  }
  if (response.status === 404) {
    // The route itself is absent: this operation returns every session-level
    // failure as a 200 body, so a 404 can only be a server that predates it.
    return { status: 'unsupported' };
  }
  if (response.status !== 200) {
    return { status: 'unknown', reason: `Unexpected cutover status ${response.status}` };
  }

  const parsed = CutoverResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    return { status: 'unknown', reason: 'Unexpected cutover response shape' };
  }
  return { status: 'settled', response: parsed.data };
}
