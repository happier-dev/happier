import type {
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  doesPiSessionFileNameMatchSessionId,
  resolvePiSessionIdFromResumeReference,
} from '../sessionFiles.js';

export type VerifyPiResumeReachableInput = AgentConnectedAccountResumeReachabilityInputV1;
export type VerifyPiResumeReachableResult = AgentConnectedAccountResumeReachabilityResultV1;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function verifyResumeReachablePi(
  input: VerifyPiResumeReachableInput,
): Promise<VerifyPiResumeReachableResult> {
  const vendorResumeId = asNonEmptyString(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'pi_session_file_not_found' };
  }
  const sessionId = resolvePiSessionIdFromResumeReference(vendorResumeId);
  if (!sessionId) {
    return { ok: false, reason: 'pi_session_file_not_found' };
  }

  const candidate = await input.sessionFiles.findDeclaredCandidate({
    matchesCandidate: ({ fileName, nativeSessionId }) => (
      nativeSessionId === sessionId
      || doesPiSessionFileNameMatchSessionId(fileName, sessionId)
    ),
  });
  return candidate.found
    ? { ok: true }
    : { ok: false, reason: 'pi_session_file_not_found' };
}
