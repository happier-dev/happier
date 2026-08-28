import type { AgentConnectedAccountResumeFileCandidateV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { verifyResumeReachablePi } from './reachability.js';

function createLookup(candidates: readonly AgentConnectedAccountResumeFileCandidateV1[]) {
  return {
    findDeclaredCandidate: vi.fn(async (input: Readonly<{
      matchesCandidate(candidate: AgentConnectedAccountResumeFileCandidateV1): boolean;
    }>) => ({ found: candidates.some(input.matchesCandidate) })),
  };
}

describe('verifyResumeReachablePi', () => {
  it('matches the native session id through host-custodied declared-file evidence', async () => {
    const sessionFiles = createLookup([{
      fileName: '2026-05-27T00-00-00-000Z_pi-session-1.jsonl',
      nativeSessionId: null,
    }]);

    await expect(verifyResumeReachablePi({
      vendorResumeId: 'pi-session-1',
      sessionFiles,
    })).resolves.toEqual({ ok: true });
    expect(sessionFiles.findDeclaredCandidate).toHaveBeenCalledWith({
      matchesCandidate: expect.any(Function),
    });
  });

  it('normalizes a persisted native filename without receiving its host path', async () => {
    const sessionFiles = createLookup([{
      fileName: '2026-05-27T00-00-00-000Z_pi-session-1.jsonl',
      nativeSessionId: 'pi-session-1',
    }]);

    await expect(verifyResumeReachablePi({
      vendorResumeId: '/private/native/2026-05-27T00-00-00-000Z_pi-session-1.jsonl',
      sessionFiles,
    })).resolves.toEqual({ ok: true });
    expect(sessionFiles.findDeclaredCandidate).toHaveBeenCalledWith({
      matchesCandidate: expect.any(Function),
    });
  });

  it('fails closed when no declared candidate carries the native correlation', async () => {
    await expect(verifyResumeReachablePi({
      vendorResumeId: 'pi-session-1',
      sessionFiles: createLookup([{
        fileName: '2026-05-27T00-00-00-000Z_other-session.jsonl',
        nativeSessionId: 'other-session',
      }]),
    })).resolves.toEqual({ ok: false, reason: 'pi_session_file_not_found' });
  });
});
