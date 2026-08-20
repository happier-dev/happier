import {
  resolveCanonicalMachineId,
  type SessionAgentTransitionSelectionV1,
  type SessionContinuationInspectionRequestV1,
  type SessionContinuationInspectionV1,
} from '@happier-dev/protocol';
import { resolveAgentIdFromSessionMetadata, type AgentId } from '@happier-dev/agents';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { fetchAccountMachineReplacements } from '@/api/machine/fetchAccountMachineReplacements';
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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The single daemon-side answer to "is this daemon the Session's host?".
 *
 * Both transition entry points ask it here for the same reason they share
 * {@link hasCanonicalHostedTranscript}: a Session hosted elsewhere must never
 * pass inspection and then be stopped by the mutation, or vice versa.
 *
 * The rest of this feature already assumes the answer is yes. The per-Agent
 * native-return record is DEVICE-LOCAL (`agentNativeReturn.ts`), the workspace
 * path names this host's filesystem, and the client can legitimately address a
 * machine other than the Session's recorded one — the UI resolves its RPC target
 * through the machine REPLACEMENT chain, and the server routes a machine RPC by
 * the named machine without checking that it hosts the Session. So the daemon is
 * the only place this can be decided.
 *
 * An unknown machine on either side is not a mismatch: an older row that records
 * no machine, or a daemon whose identity was not threaded in, must not lose the
 * ability to switch Agents.
 *
 * A machine REPLACEMENT is not a mismatch either. Replacing a machine must not
 * strand the Sessions the previous one hosted, and nothing re-homes a Session
 * row, so its recorded host stays the predecessor forever. Both sides are
 * therefore resolved through {@link resolveCanonicalMachineId} — the same walk
 * the client used to choose this daemon as the RPC target — so the successor
 * recognises its own inheritance instead of reading it as foreign. That yields a
 * fresh target with a full replay, because the DEVICE-LOCAL resume record is
 * simply absent on a new host and an absent record already degrades to replay;
 * no vendor state is migrated, because the vendor conversation genuinely does
 * not exist here.
 *
 * The chain lives only on the server, so it costs one Account-scoped read — taken
 * ONLY when the identity comparison already failed, which is the rare case. An
 * unreadable chain proves no inheritance and keeps the refusal.
 */
export async function sessionIsHostedHere(params: Readonly<{
  currentMachineId?: string | null;
  rawSession: Readonly<Record<string, unknown>>;
  metadata: Readonly<Record<string, unknown>>;
  credentials: Credentials;
}>): Promise<boolean> {
  const hostMachineId = readNonEmptyString(params.currentMachineId);
  const sessionMachineId = readNonEmptyString(params.rawSession.machineId)
    ?? readNonEmptyString(params.metadata.machineId);
  if (!hostMachineId || !sessionMachineId || hostMachineId === sessionMachineId) return true;

  const machines = await fetchAccountMachineReplacements({ credentials: params.credentials });
  if (!machines) return false;
  const canonicalSessionMachineId = resolveCanonicalMachineId(sessionMachineId, machines)?.machineId
    ?? sessionMachineId;
  const canonicalHostMachineId = resolveCanonicalMachineId(hostMachineId, machines)?.machineId
    ?? hostMachineId;
  return canonicalSessionMachineId === canonicalHostMachineId;
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
  /** Exact daemon machine; a Session hosted elsewhere is not transitionable. */
  currentMachineId?: string | null;
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
  const transitionableSession = Boolean(workspacePath)
    && sourceAgentId !== null
    && hasCanonicalHostedTranscript(record)
    && await sessionIsHostedHere({
      currentMachineId: params.currentMachineId,
      rawSession,
      metadata: record,
      credentials: params.credentials,
    });
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
