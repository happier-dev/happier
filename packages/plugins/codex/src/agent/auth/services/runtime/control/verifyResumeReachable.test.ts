import type { AgentConnectedAccountResumeFileCandidateV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { verifyResumeReachableCodex } from './verifyResumeReachable.js';

function createLookup(candidates: readonly AgentConnectedAccountResumeFileCandidateV1[]) {
  return {
    verifyDeclaredPaths: async () => ({ found: false }),
    findDeclaredCandidate: vi.fn(async (input: Readonly<{
      matchesCandidate(candidate: AgentConnectedAccountResumeFileCandidateV1): boolean;
    }>) => ({ found: candidates.some(input.matchesCandidate) })),
  };
}

describe('verifyResumeReachableCodex', () => {
  it.each(['.jsonl', '.jsonl.zst'])('matches a %s rollout through host-custodied declared-file evidence', async extension => {
    const vendorResumeId = '019e7327-46cc-7dca-bb14-8473727db321';
    const sessionFiles = createLookup([{
      fileName: `rollout-2026-08-28T12-00-00-${vendorResumeId}${extension}`,
      nativeSessionId: null,
      stateEntryPath: 'sessions',
    }]);

    await expect(verifyResumeReachableCodex({
      vendorResumeId,
      sessionFiles,
    })).resolves.toEqual({ ok: true });
    expect(sessionFiles.findDeclaredCandidate).toHaveBeenCalledWith({
      includeNativeSessionId: false,
      matchesCandidate: expect.any(Function),
    });
  });

  it('matches the exact vendor resume id bytes and never a stripped sibling', async () => {
    const exactVendorResumeId = '  provider ses AB+cd==  ';
    const strippedVendorResumeId = exactVendorResumeId.trim();
    const strippedOnly = createLookup([{
      fileName: `rollout-2026-09-13T12-00-00-${strippedVendorResumeId}.jsonl`,
      nativeSessionId: null,
      stateEntryPath: 'sessions',
    }]);
    await expect(verifyResumeReachableCodex({
      vendorResumeId: exactVendorResumeId,
      sessionFiles: strippedOnly,
    })).resolves.toEqual({ ok: false, reason: 'codex_session_file_not_found' });

    const exactOnly = createLookup([{
      fileName: `rollout-2026-09-13T12-00-00-${exactVendorResumeId}.jsonl`,
      nativeSessionId: null,
      stateEntryPath: 'sessions',
    }]);
    await expect(verifyResumeReachableCodex({
      vendorResumeId: exactVendorResumeId,
      sessionFiles: exactOnly,
    })).resolves.toEqual({ ok: true });
    await expect(verifyResumeReachableCodex({
      vendorResumeId: strippedVendorResumeId,
      sessionFiles: exactOnly,
    })).resolves.toEqual({ ok: false, reason: 'codex_session_file_not_found' });

    const blank = createLookup([]);
    await expect(verifyResumeReachableCodex({
      vendorResumeId: ' \n ',
      sessionFiles: blank,
    })).resolves.toEqual({ ok: false, reason: 'codex_session_file_not_found' });
    expect(blank.findDeclaredCandidate).not.toHaveBeenCalled();
  });

  it('fails closed for path-shaped identifiers before asking the host to search', async () => {
    const sessionFiles = createLookup([]);
    await expect(verifyResumeReachableCodex({
      vendorResumeId: '/private/native/rollout.jsonl',
      sessionFiles,
    })).resolves.toEqual({ ok: false, reason: 'codex_session_file_not_found' });
    expect(sessionFiles.findDeclaredCandidate).not.toHaveBeenCalled();
  });

  it.each(['archived_sessions', undefined])('does not accept a rollout from %s state evidence', async (stateEntryPath) => {
    const vendorResumeId = '019e7327-46cc-7dca-bb14-8473727db321';
    await expect(verifyResumeReachableCodex({ vendorResumeId, sessionFiles: createLookup([{
      fileName: `rollout-2026-08-28T12-00-00-${vendorResumeId}.jsonl`,
      nativeSessionId: vendorResumeId,
      ...(stateEntryPath === undefined ? {} : { stateEntryPath }),
    }]) })).resolves.toEqual({ ok: false, reason: 'codex_session_file_not_found' });
  });
});
