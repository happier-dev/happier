import type {
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  isCodexCandidatePersistedSessionFileForResume,
  readExactCodexVendorResumeId,
} from '../../home/sync/sessionFiles.js';

export async function verifyResumeReachableCodex(
  input: AgentConnectedAccountResumeReachabilityInputV1,
): Promise<AgentConnectedAccountResumeReachabilityResultV1> {
  const vendorResumeId = readExactCodexVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'codex_session_file_not_found' };
  }

  const candidate = await input.sessionFiles.findDeclaredCandidate({
    includeNativeSessionId: false,
    matchesCandidate: ({ fileName, stateEntryPath }) => stateEntryPath === 'sessions'
      && isCodexCandidatePersistedSessionFileForResume({
      candidatePath: fileName,
      vendorResumeId,
    }),
  });
  return candidate.found
    ? { ok: true }
    : { ok: false, reason: 'codex_session_file_not_found' };
}
