import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import type { ProviderContractMatrixResult } from '../testkit/providers/types';

export const CANDIDATE_BOUND_AGENT_CONTINUITY_IDS = [
  'opencode',
  'pi',
  'claude',
  'codex',
] as const;

export type CandidateBoundAgentContinuitySuccessInput = Readonly<{
  runId: string;
  sdk: Readonly<{
    packageName: '@happier-dev/plugin-sdk';
    version: string;
    integrity: string;
  }>;
  cli: Readonly<{
    packageName: '@happier-dev/cli';
    version: string;
    integrity: string;
  }>;
  standaloneCliArtifact: Readonly<{
    product: 'happier';
    version: string;
    os: string;
    arch: string;
    sha256: string;
  }>;
}>;

export type CandidateBoundAgentContinuitySuccess = Readonly<{
  schemaVersion: 1;
  kind: 'candidate_bound_agent_continuity';
  status: 'passed';
  scenarioId: 'daemon_runner_continuity_a_to_b_to_c';
  agentIds: typeof CANDIDATE_BOUND_AGENT_CONTINUITY_IDS;
  candidate: Readonly<{
    identityFingerprint: string;
    runId: string;
    sdk: CandidateBoundAgentContinuitySuccessInput['sdk'];
    cli: CandidateBoundAgentContinuitySuccessInput['cli'];
  }>;
  standaloneCliArtifact: CandidateBoundAgentContinuitySuccessInput['standaloneCliArtifact'];
}>;

export function createCandidateBoundAgentContinuitySuccess(
  input: CandidateBoundAgentContinuitySuccessInput,
): CandidateBoundAgentContinuitySuccess {
  const sdk = {
    packageName: input.sdk.packageName,
    version: input.sdk.version,
    integrity: input.sdk.integrity,
  };
  const cli = {
    packageName: input.cli.packageName,
    version: input.cli.version,
    integrity: input.cli.integrity,
  };
  const standaloneCliArtifact = {
    product: input.standaloneCliArtifact.product,
    version: input.standaloneCliArtifact.version,
    os: input.standaloneCliArtifact.os,
    arch: input.standaloneCliArtifact.arch,
    sha256: input.standaloneCliArtifact.sha256,
  };
  const candidateIdentity = {
    runId: input.runId,
    sdk,
    cli,
    standaloneCliArtifact,
  };
  return {
    schemaVersion: 1,
    kind: 'candidate_bound_agent_continuity',
    status: 'passed',
    scenarioId: 'daemon_runner_continuity_a_to_b_to_c',
    agentIds: CANDIDATE_BOUND_AGENT_CONTINUITY_IDS,
    candidate: {
      identityFingerprint: `sha256:${createHash('sha256')
        .update(JSON.stringify(candidateIdentity))
        .digest('hex')}`,
      runId: input.runId,
      sdk,
      cli,
    },
    standaloneCliArtifact,
  };
}

export function parseCandidateBoundAgentContinuityArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Readonly<{ candidateManifestPath: string }> {
  let candidate: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--candidate') {
      throw new Error(`candidate_bound_agent_continuity_unknown_argument:${argument}`);
    }
    if (candidate !== null) {
      throw new Error('candidate_bound_agent_continuity_candidate_repeated');
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith('--')) {
      throw new Error('candidate_bound_agent_continuity_candidate_value_required');
    }
    candidate = value;
    index += 1;
  }
  if (!candidate) {
    throw new Error('candidate_bound_agent_continuity_candidate_required');
  }
  return {
    candidateManifestPath: isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(cwd, candidate),
  };
}

export function assertCandidateBoundAgentContinuityResult(
  result: ProviderContractMatrixResult,
): Readonly<{ ok: true }> {
  if (!result.ok) {
    throw new Error(`candidate_bound_agent_continuity_failed:${result.error}`);
  }
  if (result.skipped) {
    throw new Error(`candidate_bound_agent_continuity_skipped:${result.skipped.reason}`);
  }
  return { ok: true };
}
