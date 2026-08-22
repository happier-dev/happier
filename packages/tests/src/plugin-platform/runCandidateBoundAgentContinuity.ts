import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runProviderContractMatrix } from '../testkit/providers/harness';
import { prepareCandidateBoundCliLaunchSpec } from './runPackedManagedProviderVertical';
import {
  assertCandidateBoundAgentContinuityResult,
  CANDIDATE_BOUND_AGENT_CONTINUITY_IDS,
  createCandidateBoundAgentContinuitySuccess,
  parseCandidateBoundAgentContinuityArgs,
  type CandidateBoundAgentContinuitySuccess,
} from './candidateBoundAgentContinuityContract';

export {
  assertCandidateBoundAgentContinuityResult,
  createCandidateBoundAgentContinuitySuccess,
  parseCandidateBoundAgentContinuityArgs,
} from './candidateBoundAgentContinuityContract';

const AGENT_CONTINUITY_SCENARIO_ID = 'daemon_runner_continuity_a_to_b_to_c';

export async function runCandidateBoundAgentContinuity(
  candidateManifestPath: string,
): Promise<CandidateBoundAgentContinuitySuccess> {
  const prepared = await prepareCandidateBoundCliLaunchSpec({
    candidateManifestPath,
  });
  try {
    assertCandidateBoundAgentContinuityResult(await runProviderContractMatrix({
      providerIds: CANDIDATE_BOUND_AGENT_CONTINUITY_IDS,
      scenarioIds: [AGENT_CONTINUITY_SCENARIO_ID],
      cliLaunchSpec: prepared.cliLaunchSpec,
      launchEntrypointKind: 'candidate_artifact',
      skipWorkspacePreparation: true,
      allowFlakeRetry: false,
    }));
    return createCandidateBoundAgentContinuitySuccess({
      runId: prepared.candidate.runId,
      sdk: {
        packageName: prepared.candidate.sdk.packageName,
        version: prepared.candidate.sdk.version,
        integrity: prepared.candidate.sdk.integrity,
      },
      cli: {
        packageName: prepared.candidate.cli.packageName,
        version: prepared.candidate.cli.version,
        integrity: prepared.candidate.cli.integrity,
      },
      standaloneCliArtifact: {
        product: prepared.standaloneCliArtifact.product,
        version: prepared.standaloneCliArtifact.version,
        os: prepared.standaloneCliArtifact.os,
        arch: prepared.standaloneCliArtifact.arch,
        sha256: prepared.standaloneCliArtifact.sha256,
      },
    });
  } finally {
    await prepared.dispose();
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { candidateManifestPath } = parseCandidateBoundAgentContinuityArgs(argv);
  const result = await runCandidateBoundAgentContinuity(candidateManifestPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
