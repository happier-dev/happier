import { describe, expect, it } from 'vitest';

import {
  assertCandidateBoundAgentContinuityResult,
  createCandidateBoundAgentContinuitySuccess,
  parseCandidateBoundAgentContinuityArgs,
} from '../../plugin-platform/candidateBoundAgentContinuityContract';

describe('candidate-bound Agent continuity adapter', () => {
  it('requires exactly one candidate manifest', () => {
    expect(parseCandidateBoundAgentContinuityArgs([
      '--candidate',
      './candidate.json',
    ], '/private/repo')).toEqual({
      candidateManifestPath: '/private/repo/candidate.json',
    });
    expect(() => parseCandidateBoundAgentContinuityArgs([], '/private/repo'))
      .toThrow('candidate_bound_agent_continuity_candidate_required');
    expect(() => parseCandidateBoundAgentContinuityArgs([
      '--candidate',
      './candidate.json',
      '--candidate',
      './other.json',
    ], '/private/repo')).toThrow('candidate_bound_agent_continuity_candidate_repeated');
  });

  it('treats every provider skip or failure as non-success', () => {
    expect(() => assertCandidateBoundAgentContinuityResult({
      ok: true,
      skipped: { reason: 'Agent authentication unavailable' },
    })).toThrow('candidate_bound_agent_continuity_skipped:Agent authentication unavailable');
    expect(() => assertCandidateBoundAgentContinuityResult({
      ok: false,
      error: 'Agent failed',
    })).toThrow('candidate_bound_agent_continuity_failed:Agent failed');
    expect(assertCandidateBoundAgentContinuityResult({ ok: true })).toEqual({ ok: true });
  });

  it('binds success identity to the verified SDK, CLI, and selected standalone bytes', () => {
    const input = {
      runId: 'candidate-1',
      sdk: {
        packageName: '@happier-dev/plugin-sdk' as const,
        version: '1.2.3',
        integrity: `sha512-${'A'.repeat(86)}==`,
      },
      cli: {
        packageName: '@happier-dev/cli' as const,
        version: '1.2.3',
        integrity: `sha512-${'B'.repeat(86)}==`,
      },
      standaloneCliArtifact: {
        product: 'happier' as const,
        version: '1.2.3',
        os: 'darwin',
        arch: 'arm64',
        sha256: 'a'.repeat(64),
      },
    };
    const first = createCandidateBoundAgentContinuitySuccess(input);
    const changedProductBytes = createCandidateBoundAgentContinuitySuccess({
      ...input,
      standaloneCliArtifact: {
        ...input.standaloneCliArtifact,
        sha256: 'b'.repeat(64),
      },
    });

    expect(first.candidate).toMatchObject({
      runId: 'candidate-1',
      sdk: input.sdk,
      cli: input.cli,
    });
    expect(first).toMatchObject({
      kind: 'candidate_bound_agent_continuity',
      agentIds: ['opencode', 'pi', 'claude', 'codex'],
    });
    expect(first.standaloneCliArtifact).toEqual(input.standaloneCliArtifact);
    expect(first.candidate.identityFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(changedProductBytes.candidate.identityFingerprint)
      .not.toBe(first.candidate.identityFingerprint);
  });
});
