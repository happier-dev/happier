import type { AgentConnectedAccountResumeFileCandidateV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { verifyResumeReachableClaude } from './verifyResumeReachable.js';

function createLookup(candidates: readonly AgentConnectedAccountResumeFileCandidateV1[]) {
  return {
    verifyDeclaredPaths: async () => ({ found: false }),
    findDeclaredCandidate: vi.fn(async (input: Readonly<{
      matchesCandidate(candidate: AgentConnectedAccountResumeFileCandidateV1): boolean;
    }>) => ({ found: candidates.some(input.matchesCandidate) })),
  };
}

describe('verifyResumeReachableClaude', () => {
  it('accepts the exact Claude transcript filename in declared shared state', async () => {
    const sessionFiles = createLookup([{
      fileName: 'claude-session-exact.jsonl',
      nativeSessionId: null,
    }]);

    await expect(verifyResumeReachableClaude({
      vendorResumeId: 'claude-session-exact',
      sessionFiles,
    })).resolves.toEqual({ ok: true });
  });

  it('accepts exact native identity evidence and refuses sibling or blank identities', async () => {
    const sessionFiles = createLookup([{
      fileName: 'transcript.jsonl',
      nativeSessionId: 'claude-session-exact',
    }]);

    await expect(verifyResumeReachableClaude({
      vendorResumeId: 'claude-session-exact',
      sessionFiles,
    })).resolves.toEqual({ ok: true });
    await expect(verifyResumeReachableClaude({
      vendorResumeId: 'claude-session-sibling',
      sessionFiles,
    })).resolves.toEqual({ ok: false, reason: 'codex_continuation_unreachable' });
    await expect(verifyResumeReachableClaude({
      vendorResumeId: '  ',
      sessionFiles,
    })).resolves.toEqual({ ok: false, reason: 'claude_session_file_not_found' });
  });
});
