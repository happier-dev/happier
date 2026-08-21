import {
  type SessionAgentTransitionSelectionV1,
  type SessionContinuationInspectionRequestV1,
  type SessionContinuationInspectionV1,
} from '@happier-dev/protocol';
import { resolveAgentIdFromSessionMetadata, type AgentId } from '@happier-dev/agents';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

/**
 * Live eligibility for same-Session continuation on THIS machine.
 *
 * Inspection grants no authority and persists nothing: the mutation revalidates
 * every fact it reports. Its only job is to stop the client from arming a
 * submission that the daemon would then have to fail after stopping the source.
 *
 * The predecessor deliberately answers `false` to the depth flags rather than
 * "probably". Reporting a capability this tree does not have would let the UI
 * offer native return or a source-context spawn and then fail late.
 */

/**
 * The single daemon-side answer to "does this Session have a canonical hosted
 * transcript the target Agent can continue from?" (section 2.3).
 *
 * Both transition entry points — inspection and the mutation — ask it here.
 * They previously each inlined `directSessionV1 !== undefined ||
 * transcriptStorage === 'direct'`, which is two more decision-makers for a
 * concept that already has a canonical Session-scoped owner, and which
 * disagreed with it: `getSessionStorageKind`
 * (apps/ui/sources/sync/domains/session/sessionStorageKind.ts) requires an
 * OBJECT with `v === 1` and defaults to `persisted`. A cleared `null`, a legacy
 * `{}`, or a future `{ v: 2 }` is persisted there and was "direct" here, so an
 * ordinary hosted Session silently became untransitionable — the same class of
 * defect as §1.5b, which made the picker unreachable on every ordinary Session.
 *
 * `transcriptStorage: 'direct'` is retained as a distinct, narrower arm: it is
 * the spawn INTENT recorded before `directSessionV1` is established (see
 * backends/opencode/utils/opencodeSessionIdMetadata.ts), so a Session that is
 * about to become direct also has no hosted transcript to hand over. That is a
 * different question from "what storage kind is this Session", which is why it
 * does not belong in the canonical storage-kind owner.
 */
export function hasCanonicalHostedTranscript(metadata: Readonly<Record<string, unknown>>): boolean {
  const directSessionV1 = metadata.directSessionV1;
  const establishedDirect = Boolean(directSessionV1)
    && typeof directSessionV1 === 'object'
    && (directSessionV1 as { v?: unknown }).v === 1;
  return !establishedDirect && metadata.transcriptStorage !== 'direct';
}

export type SessionContinuationTargetSupport =
  | Readonly<{ type: 'supported'; targetAgentId: AgentId }>
  | Readonly<{ type: 'unsupported'; code: 'same_target' | 'target_unavailable' }>;

export type SessionContinuationTargetResolution =
  | Readonly<{ type: 'resolved'; targetAgentId: AgentId }>
  | Readonly<{ type: 'unavailable' }>;

/**
 * Can this selection become a runtime target on this machine AT ALL, ignoring
 * what the Session currently runs?
 *
 * The source-independent half exists because a retry that arrives after a
 * committed cutover finds the Session already naming the target. That request
 * must still resolve its target — to recognise the already-targeted state —
 * without `same_target` shadowing the answer. It is a narrowing of the same
 * decision, not a second one: {@link evaluateSessionContinuationTargetSupport}
 * is defined in terms of it, so catalog membership and representability can
 * never diverge between the two callers.
 */
export function resolveSessionContinuationTargetAgent(
  selection: SessionAgentTransitionSelectionV1,
): SessionContinuationTargetResolution {
  // `providerConnectionId` has no representation anywhere in this tree. The
  // contract requires an explicit rejection rather than a silent drop, because
  // silently dropping it would bind the target to the wrong account.
  if (selection.providerConnectionId != null) return { type: 'unavailable' };

  const agentId = selection.agentId.trim();
  if (!(CATALOG_AGENT_IDS as readonly string[]).includes(agentId)) return { type: 'unavailable' };
  if (agentId === 'customAcp') {
    // A configured ACP target's create/resume/context contract is unproven, so
    // in-place switching to one is excluded in V1.
    return { type: 'unavailable' };
  }
  return { type: 'resolved', targetAgentId: agentId as AgentId };
}

/**
 * The single decision about whether a portable selection can become this
 * machine's runtime target. Both the inspection RPC and the transition mutation
 * call it, so a selection can never pass inspection and then be rejected for a
 * different reason at cutover time.
 */
export function evaluateSessionContinuationTargetSupport(params: Readonly<{
  selection: SessionAgentTransitionSelectionV1;
  sourceAgentId: string;
}>): SessionContinuationTargetSupport {
  const resolved = resolveSessionContinuationTargetAgent(params.selection);
  if (resolved.type === 'unavailable') {
    return { type: 'unsupported', code: 'target_unavailable' };
  }
  if (resolved.targetAgentId === params.sourceAgentId) {
    return { type: 'unsupported', code: 'same_target' };
  }
  return { type: 'supported', targetAgentId: resolved.targetAgentId };
}

export async function inspectSessionContinuation(params: Readonly<{
  credentials: Credentials;
  request: SessionContinuationInspectionRequestV1;
}>): Promise<SessionContinuationInspectionV1> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.request.sourceSessionId,
  }).catch((error: unknown) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  if (!rawSession) {
    return { type: 'unavailable', reason: 'unsupported_session' };
  }

  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
  if (!metadata) {
    return { type: 'unavailable', reason: 'unsupported_session' };
  }

  const record = metadata as Record<string, unknown>;
  const workspacePath = typeof record.path === 'string' ? record.path.trim() : '';
  const sourceAgentId = resolveAgentIdFromSessionMetadata(record);
  // Deliberately NOT gated on the Session's recorded machine. A machine id is a
  // PROXY for "can this Session be continued here", and the components that
  // actually know already answer it: the stop owner finds no local process and
  // says so, an absent DEVICE-LOCAL native-return record already degrades to a
  // full replay, the cutover is server-side and machine-agnostic, and activating
  // the target succeeds or fails here loudly. The proxy was wrong in both
  // directions — it refused a Session a user had legitimately moved to this
  // host, while still admitting a same-id Session whose vendor conversation was
  // long gone — so it removed real capability to prevent nothing.
  const transitionableSession = Boolean(workspacePath)
    && sourceAgentId !== null
    && hasCanonicalHostedTranscript(record);
  if (!transitionableSession) {
    return { type: 'unavailable', reason: 'unsupported_session' };
  }

  const support = evaluateSessionContinuationTargetSupport({
    selection: params.request.selection,
    sourceAgentId: sourceAgentId as string,
  });
  if (support.type === 'unsupported' && support.code === 'target_unavailable') {
    return { type: 'unavailable', reason: 'target_unavailable' };
  }

  return {
    type: 'available',
    protocolVersion: 1,
    // `same_target` is reported as available-but-not-a-transition: the picker
    // shows the current Agent as selected rather than as an error.
    sameSessionTransition: support.type === 'supported',
  };
}
