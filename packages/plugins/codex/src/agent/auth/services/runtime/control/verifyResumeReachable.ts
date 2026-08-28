import type {
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  isCodexCandidatePersistedSessionFileForResume,
  normalizeCodexVendorResumeId,
} from '../../home/sync/sessionFiles.js';

export async function verifyResumeReachableCodex(
  input: AgentConnectedAccountResumeReachabilityInputV1,
): Promise<AgentConnectedAccountResumeReachabilityResultV1> {
  const vendorResumeId = normalizeCodexVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'codex_session_file_not_found' };
  }

  const candidate = await input.sessionFiles.findDeclaredCandidate({
    matchesCandidate: ({ fileName }) => isCodexCandidatePersistedSessionFileForResume({
      candidatePath: fileName,
      vendorResumeId,
    }),
  });
  return candidate.found
    ? { ok: true }
    : { ok: false, reason: 'codex_session_file_not_found' };
}
