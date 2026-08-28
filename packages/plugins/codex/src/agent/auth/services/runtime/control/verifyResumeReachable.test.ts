import type { AgentConnectedAccountResumeFileCandidateV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { verifyResumeReachableCodex } from './verifyResumeReachable.js';

function createLookup(candidates: readonly AgentConnectedAccountResumeFileCandidateV1[]) {
  return {
    findDeclaredCandidate: vi.fn(async (input: Readonly<{
      matchesCandidate(candidate: AgentConnectedAccountResumeFileCandidateV1): boolean;
    }>) => ({ found: candidates.some(input.matchesCandidate) })),
  };
}

describe('verifyResumeReachableCodex', () => {
  it('matches a Codex rollout filename through host-custodied declared-file evidence', async () => {
    const vendorResumeId = '019e7327-46cc-7dca-bb14-8473727db321';
    const sessionFiles = createLookup([{
      fileName: `rollout-2026-08-28T12-00-00-${vendorResumeId}.jsonl`,
      nativeSessionId: null,
    }]);

    await expect(verifyResumeReachableCodex({
      vendorResumeId,
      sessionFiles,
    })).resolves.toEqual({ ok: true });
    expect(sessionFiles.findDeclaredCandidate).toHaveBeenCalledWith({
      matchesCandidate: expect.any(Function),
    });
  });

  it('fails closed for path-shaped identifiers before asking the host to search', async () => {
    const sessionFiles = createLookup([]);
    await expect(verifyResumeReachableCodex({
      vendorResumeId: '/private/native/rollout.jsonl',
      sessionFiles,
    })).resolves.toEqual({ ok: false, reason: 'codex_session_file_not_found' });
    expect(sessionFiles.findDeclaredCandidate).not.toHaveBeenCalled();
  });
});
