import type {
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { readClaudeProviderIdentityValue } from '../../../../protocol/providerIdentity.js';

export async function verifyResumeReachableClaude(
  input: AgentConnectedAccountResumeReachabilityInputV1,
): Promise<AgentConnectedAccountResumeReachabilityResultV1> {
  const vendorResumeId = readClaudeProviderIdentityValue(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'claude_session_file_not_found' };
  }

  const candidate = await input.sessionFiles.findDeclaredCandidate({
    matchesCandidate: ({ fileName, nativeSessionId }) => (
      nativeSessionId === vendorResumeId
      || fileName === `${vendorResumeId}.jsonl`
    ),
  });
  return candidate.found
    ? { ok: true }
    // Reuse the existing permanent continuation-loss reason. Lookup errors reject instead.
    : { ok: false, reason: 'codex_continuation_unreachable' };
}
