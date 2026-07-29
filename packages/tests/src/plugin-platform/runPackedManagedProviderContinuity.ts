import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parsePackedManagedProviderArgs,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import {
  PackedManagedProviderEntrypointError,
  runPackedManagedProviderEntrypoint,
} from './runPackedManagedProviderVertical';
import {
  createPackedManagedProviderLiveScenario,
  type PackedManagedProviderActivationFailureObservation,
  type PackedManagedProviderLiveSystem,
} from './packedManagedProviderLiveScenario';
import {
  createCanonicalPackedManagedProviderLiveSystem,
} from './packedManagedProviderLiveSystem';
import {
  assertPackedManagedProviderContinuityContract,
  startPackedManagedProviderComposedRuntime,
  type PackedManagedProviderContinuityObservation,
  type PackedManagedProviderRecoveryRefusalObservation,
} from './packedManagedProviderComposedRuntime';

function requireContinuityObservation(
  value: PackedManagedProviderContinuityObservation | null,
): PackedManagedProviderContinuityObservation {
  if (!value) {
    throw new Error(
      'packed_managed_provider_continuity_observation_missing',
    );
  }
  return value;
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parsePackedManagedProviderArgs(argv);
  if (parsed.mode !== 'run') {
    throw new Error('packed_managed_provider_continuity_requires_candidate');
  }

  const wrapperSystem = createCanonicalPackedManagedProviderLiveSystem();
  const composed = await startPackedManagedProviderComposedRuntime();
  let activationFailure:
    PackedManagedProviderActivationFailureObservation | null = null;
  let continuity: PackedManagedProviderContinuityObservation | null = null;
  let recoveryRefusal:
    PackedManagedProviderRecoveryRefusalObservation | null = null;

  const system: PackedManagedProviderLiveSystem = {
    probePackagedWrapper: async (input) =>
      await wrapperSystem.probePackagedWrapper(input),
    probeFreshManagedSpawn: async (input) => {
      activationFailure =
        await composed.probeActivationFailureCleanup(input);
      const fresh = await composed.probeFreshManagedSpawn(input);
      continuity =
        await composed.probeManagedDaemonContinuity(input);
      recoveryRefusal =
        await composed.probeManagedRecoveryRefusal(input);
      return fresh;
    },
    probeActivationFailureCleanup: async () => {
      if (!activationFailure) {
        throw new Error(
          'packed_managed_provider_continuity_activation_probe_missing',
        );
      }
      return activationFailure;
    },
    cleanup: async (cleanupInput) => {
      const outcomes = await Promise.allSettled([
        composed.cleanup(),
        wrapperSystem.cleanup(cleanupInput),
      ]);
      const failures = outcomes
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => (outcome as PromiseRejectedResult).reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'packed managed continuity cleanup failed',
        );
      }
    },
  };

  const result = await runPackedManagedProviderEntrypoint(parsed, {
    scenario: createPackedManagedProviderLiveScenario(system),
  });
  if (!recoveryRefusal) {
    throw new Error(
      'packed_managed_provider_continuity_observation_missing',
    );
  }
  const settledContinuity = requireContinuityObservation(continuity);
  assertPackedManagedProviderContinuityContract(settledContinuity.contract);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'packed_managed_provider_daemon_continuity',
    status: 'passed',
    candidate: result.candidate,
    standaloneCliArtifact: result.standaloneCliArtifact,
    freshBootstrapStages: result.stages,
    harnessEvidence: result.harnessEvidence,
    continuityContract: settledContinuity.contract,
    continuity: settledContinuity,
    recoveryRefusal,
  })}\n`);
}

export function serializePackedManagedProviderContinuityFailure(
  error: PackedManagedProviderEntrypointError,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'packed_managed_provider_daemon_continuity_error',
    status: error.code === 'packed_managed_provider_cancelled'
      ? 'cancelled'
      : 'failed',
    code: error.code,
    evidence: error.evidence,
  });
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof PackedManagedProviderEntrypointError)) throw error;
    process.stderr.write(
      `${serializePackedManagedProviderContinuityFailure(error)}\n`,
    );
    process.exitCode = 1;
  }
}
