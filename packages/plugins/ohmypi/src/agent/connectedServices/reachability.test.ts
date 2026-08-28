import type { AgentConnectedAccountResumeFileCandidateV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { verifyResumeReachableOhMyPi } from './reachability.js';

function createLookup(candidates: readonly AgentConnectedAccountResumeFileCandidateV1[]) {
  return {
    findDeclaredCandidate: vi.fn(async (input: Readonly<{
      matchesCandidate(candidate: AgentConnectedAccountResumeFileCandidateV1): boolean;
    }>) => ({ found: candidates.some(input.matchesCandidate) })),
  };
}

describe('verifyResumeReachableOhMyPi', () => {
  it('matches the native session id through host-custodied declared-file evidence', async () => {
    const sessionFiles = createLookup([{
      fileName: '2026-05-28T00-00-00-000Z_omp-session-1.jsonl',
      nativeSessionId: null,
    }]);

    await expect(verifyResumeReachableOhMyPi({
      vendorResumeId: 'omp-session-1',
      sessionFiles,
    })).resolves.toEqual({ ok: true });
    expect(sessionFiles.findDeclaredCandidate).toHaveBeenCalledWith({
      matchesCandidate: expect.any(Function),
    });
  });

  it('uses native header evidence when a filename alone does not carry the session id', async () => {
    await expect(verifyResumeReachableOhMyPi({
      vendorResumeId: 'omp-session-1',
      sessionFiles: createLookup([{
        fileName: 'opaque.jsonl',
        nativeSessionId: 'omp-session-1',
      }]),
    })).resolves.toEqual({ ok: true });
  });

  it('fails closed when no declared candidate carries the native correlation', async () => {
    await expect(verifyResumeReachableOhMyPi({
      vendorResumeId: 'omp-session-missing',
      sessionFiles: createLookup([]),
    })).resolves.toEqual({
      ok: false,
      reason: 'ohmypi_session_file_not_found',
    });
  });
});
