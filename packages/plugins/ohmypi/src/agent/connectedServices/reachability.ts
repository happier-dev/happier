import type {
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  isBareSessionFileId,
  parseSessionIdFromFileName,
  sessionFileNameMatchesSessionId,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

const OH_MY_PI_SESSION_NOT_FOUND_REASON = 'ohmypi_session_file_not_found';

export type VerifyOhMyPiResumeReachableInput = AgentConnectedAccountResumeReachabilityInputV1;
export type VerifyOhMyPiResumeReachableResult = AgentConnectedAccountResumeReachabilityResultV1;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOhMyPiSessionIdFromResumeReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isBareSessionFileId(trimmed)) return trimmed;
  return parseSessionIdFromFileName(trimmed);
}

export async function verifyResumeReachableOhMyPi(
  input: VerifyOhMyPiResumeReachableInput,
): Promise<VerifyOhMyPiResumeReachableResult> {
  const vendorResumeId = asNonEmptyString(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
  }

  const sessionId = resolveOhMyPiSessionIdFromResumeReference(vendorResumeId);
  if (!sessionId) {
    return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
  }

  const candidate = await input.sessionFiles.findDeclaredCandidate({
    matchesCandidate: ({ fileName, nativeSessionId }) => (
      nativeSessionId === sessionId
      || sessionFileNameMatchesSessionId(fileName, sessionId)
    ),
  });
  return candidate.found
    ? { ok: true }
    : { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
}
