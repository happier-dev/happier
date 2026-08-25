import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PACKED_MANAGED_PROVIDER_CANDIDATE_HANDOFF_STAGE_IDS,
  parsePackedManagedProviderArgs,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import {
  PackedManagedProviderEntrypointError,
  runPackedChannelProviderEntrypoint,
  runPackedManagedProviderEntrypoint,
  type PackedChannelProviderEntrypointDependencies,
  type PackedManagedProviderEntrypointResult,
  type PackedManagedProviderFailureDiagnostics,
  type PackedManagedProviderHarnessEvidence,
} from './runPackedManagedProviderVertical';
import {
  createPackedManagedProviderLiveScenario,
  type PackedManagedProviderLiveSystem,
} from './packedManagedProviderLiveScenario';
import {
  assertPackedManagedProviderContinuityContract,
  PackedCurrentSourceExternalSessionsExecutionError,
  runPackedCurrentSourceExternalSessions,
  startPackedManagedProviderComposedRuntime,
  type PackedManagedProviderCandidateHandoffObservation,
  type PackedCurrentSourceExternalSessionsObservation,
  type PackedManagedProviderContinuityObservation,
  type PackedManagedProviderRecoveryRefusalObservation,
} from './packedManagedProviderComposedRuntime';

const PACKED_MANAGED_PROVIDER_SAFE_CODE_PATTERN =
  /^(packed_(?:managed_provider|current_source_external_sessions|channel_provider)_[a-z0-9_]+)(?:$|:)/u;

type PackedChannelProviderContinuityProbeDependencies = Omit<
  PackedChannelProviderEntrypointDependencies,
  'runPackedChannelProviderLifecycle' | 'cleanup'
> & Readonly<{
  composed: Pick<
    Awaited<ReturnType<typeof startPackedManagedProviderComposedRuntime>>,
    'probePackedChannelProviderLifecycle' | 'cleanup'
  >;
}>;

export async function runPackedChannelProviderContinuityProbe(
  input: Parameters<typeof runPackedChannelProviderEntrypoint>[0],
  deps: PackedChannelProviderContinuityProbeDependencies,
) {
  const { composed, ...entrypointDeps } = deps;
  return await runPackedChannelProviderEntrypoint(input, {
    ...entrypointDeps,
    runPackedChannelProviderLifecycle: async (lifecycleInput) =>
      await composed.probePackedChannelProviderLifecycle(lifecycleInput),
    cleanup: async () => await composed.cleanup(),
  });
}

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

function requireCandidateHandoffObservation(
  value: PackedManagedProviderCandidateHandoffObservation | null,
): PackedManagedProviderCandidateHandoffObservation {
  if (!value) {
    throw new Error(
      'packed_managed_provider_candidate_handoff_observation_missing',
    );
  }
  return value;
}

function fingerprintJson(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function summarizeFailureDiagnostics(
  diagnostics: PackedManagedProviderFailureDiagnostics | null,
): unknown {
  if (!diagnostics) return null;
  return {
    schemaVersion: diagnostics.schemaVersion,
    code: diagnostics.code,
    phase: diagnostics.phase,
    process: diagnostics.process,
    daemonState: diagnostics.daemonState,
    logs: {
      stdout: { byteCount: diagnostics.logs.stdout.byteCount },
      stderr: { byteCount: diagnostics.logs.stderr.byteCount },
    },
  };
}

function summarizeHarnessEvidence(
  evidence: PackedManagedProviderHarnessEvidence,
): unknown {
  return {
    candidateFrozen: evidence.candidateFrozen,
    standaloneCliFrozen: evidence.standaloneCliFrozen,
    candidateArchiveCensus: evidence.candidateArchiveCensus,
    standaloneCliArchiveEntryCount:
      evidence.standaloneCliArchiveEntryCount,
    hostTarget: evidence.hostTarget,
    stockCliProxyApiTouched:
      evidence.isolation.stockCliProxyApiTouched,
    failureDiagnostics:
      summarizeFailureDiagnostics(evidence.failureDiagnostics),
    cleanup: { disposition: evidence.cleanup.disposition },
  };
}

export function serializePackedManagedProviderContinuitySuccess(
  input: Readonly<{
    result: PackedManagedProviderEntrypointResult;
    continuity: PackedManagedProviderContinuityObservation;
    candidateHandoff: PackedManagedProviderCandidateHandoffObservation;
    recoveryRefusal: PackedManagedProviderRecoveryRefusalObservation;
  }>,
): string {
  const candidateIdentity = {
    runId: input.result.candidate.runId,
    sdk: {
      packageName: input.result.candidate.sdk.packageName,
      version: input.result.candidate.sdk.version,
      integrity: input.result.candidate.sdk.integrity,
    },
    cli: {
      packageName: input.result.candidate.cli.packageName,
      version: input.result.candidate.cli.version,
      integrity: input.result.candidate.cli.integrity,
    },
    standaloneCliSha256: input.result.standaloneCliArtifact.sha256,
  };
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'packed_managed_provider_daemon_continuity',
    status: 'passed',
    candidate: {
      identityFingerprint: fingerprintJson(candidateIdentity),
      sdk: candidateIdentity.sdk,
      cli: candidateIdentity.cli,
    },
    standaloneCliArtifact: {
      product: input.result.standaloneCliArtifact.product,
      version: input.result.standaloneCliArtifact.version,
      os: input.result.standaloneCliArtifact.os,
      arch: input.result.standaloneCliArtifact.arch,
      sha256: input.result.standaloneCliArtifact.sha256,
    },
    freshBootstrapStages: input.result.stages.map((stage) => ({
      id: stage.id,
      status: stage.status,
    })),
    harnessEvidence: summarizeHarnessEvidence(input.result.harnessEvidence),
    continuityContract: input.continuity.contract,
    candidateHandoffStages:
      PACKED_MANAGED_PROVIDER_CANDIDATE_HANDOFF_STAGE_IDS.map((id) => ({
        id,
        status: 'passed' as const,
      })),
    candidateHandoffContract: input.candidateHandoff.contract,
    recoveryRefusal: input.recoveryRefusal,
  });
}

export function serializePackedCurrentSourceExternalSessionsSuccess(
  observation: PackedCurrentSourceExternalSessionsObservation,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'packed_current_source_external_sessions',
    status: 'passed',
    source: {
      cli: observation.sourceCli,
      releaseCandidateRequired: false,
    },
    archives: observation.archives,
    publicExternalSessions: observation.publicExternalSessions,
  });
}

type PackedExternalSessionsCandidateComposedRuntime = Pick<
  Awaited<ReturnType<typeof startPackedManagedProviderComposedRuntime>>,
  | 'probePublicProviderActivation'
  | 'probeFreshManagedSpawn'
  | 'probeManagedDaemonContinuity'
  | 'probeCandidateExternalAgentProviderHandoff'
  | 'probeManagedRecoveryRefusal'
  | 'probeActivationFailureCleanup'
  | 'cleanup'
>;

type PackedExternalSessionsCandidateContinuityDependencies = Readonly<{
  composed: PackedExternalSessionsCandidateComposedRuntime;
  runEntrypoint?: typeof runPackedManagedProviderEntrypoint;
}>;

export async function runPackedExternalSessionsCandidateContinuity(
  input: Parameters<typeof runPackedManagedProviderEntrypoint>[0],
  deps: PackedExternalSessionsCandidateContinuityDependencies,
) {
  const { composed } = deps;
  let continuity: PackedManagedProviderContinuityObservation | null = null;
  let candidateHandoff:
    PackedManagedProviderCandidateHandoffObservation | null = null;
  let recoveryRefusal:
    PackedManagedProviderRecoveryRefusalObservation | null = null;

  const system: PackedManagedProviderLiveSystem = {
    probePackagedWrapper: async (prepared) =>
      await composed.probePublicProviderActivation(prepared),
    probeFreshManagedSpawn: async (prepared) => {
      const fresh = await composed.probeFreshManagedSpawn(prepared);
      recoveryRefusal = await composed.probeManagedRecoveryRefusal(prepared);
      candidateHandoff =
        await composed.probeCandidateExternalAgentProviderHandoff(prepared);
      continuity = await composed.probeManagedDaemonContinuity(prepared);
      return fresh;
    },
    probeActivationFailureCleanup: async (prepared) =>
      await composed.probeActivationFailureCleanup(prepared),
    cleanup: async () => await composed.cleanup(),
  };

  const result = await (deps.runEntrypoint ?? runPackedManagedProviderEntrypoint)(
    input,
    { scenario: createPackedManagedProviderLiveScenario(system) },
  );
  if (!recoveryRefusal) {
    throw new Error(
      'packed_managed_provider_continuity_observation_missing',
    );
  }
  const settledContinuity = requireContinuityObservation(continuity);
  const settledCandidateHandoff =
    requireCandidateHandoffObservation(candidateHandoff);
  assertPackedManagedProviderContinuityContract(settledContinuity.contract);
  return {
    result,
    continuity: settledContinuity,
    candidateHandoff: settledCandidateHandoff,
    recoveryRefusal,
  };
}

/**
 * Process-level seams this command owns. The composed runtime launches a real
 * server/daemon pair and the artifact owners read, verify, and extract real
 * candidate archives, so a candidate-shaped test supplies its own.
 */
export type PackedManagedProviderContinuityCommandDependencies = Omit<
  PackedChannelProviderEntrypointDependencies,
  'runPackedChannelProviderLifecycle' | 'cleanup'
> & Readonly<{
  startChannelComposedRuntime?: () => Promise<
    PackedChannelProviderContinuityProbeDependencies['composed']
  >;
  writeStdout?: (line: string) => void;
}>;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: PackedManagedProviderContinuityCommandDependencies = {},
): Promise<void> {
  const {
    startChannelComposedRuntime = startPackedManagedProviderComposedRuntime,
    writeStdout = (line: string) => {
      process.stdout.write(line);
    },
    ...candidateDependencies
  } = dependencies;
  const parsed = parsePackedManagedProviderArgs(argv);
  if (parsed.mode === 'current-source') {
    writeStdout(
      `${serializePackedCurrentSourceExternalSessionsSuccess(
        await runPackedCurrentSourceExternalSessions(),
      )}\n`,
    );
    return;
  }
  if (parsed.mode === 'channel') {
    // The vertical result is already the complete stage evidence document, so
    // it is written as-is rather than through a second summarizing projection.
    writeStdout(`${JSON.stringify(
      await runPackedChannelProviderContinuityProbe(parsed, {
        ...candidateDependencies,
        composed: await startChannelComposedRuntime(),
      }),
    )}\n`);
    return;
  }
  if (parsed.mode !== 'run') {
    throw new Error('packed_managed_provider_continuity_requires_candidate');
  }

  const composed = await startPackedManagedProviderComposedRuntime();
  const {
    result,
    continuity,
    candidateHandoff,
    recoveryRefusal,
  } = await runPackedExternalSessionsCandidateContinuity(parsed, { composed });
  writeStdout(`${serializePackedManagedProviderContinuitySuccess({
    result,
    continuity,
    candidateHandoff,
    recoveryRefusal,
  })}\n`);
}

export function serializePackedManagedProviderContinuityFailure(
  error: unknown,
): string {
  if (error instanceof PackedCurrentSourceExternalSessionsExecutionError) {
    return JSON.stringify({
      schemaVersion: 1,
      kind: 'packed_managed_provider_daemon_continuity_error',
      status: 'failed',
      code: 'packed_current_source_external_sessions_execution_failed',
      stage: error.stage,
      causeCode: resolvePackedManagedProviderSafeFailureCode(error.cause)
        ?? 'unexpected',
      evidence: null,
    });
  }
  const candidateCode = error instanceof PackedManagedProviderEntrypointError
    ? error.code
    : error instanceof Error
      ? error.message
      : '';
  const code = PACKED_MANAGED_PROVIDER_SAFE_CODE_PATTERN.exec(candidateCode)?.[1]
    ?? 'packed_managed_provider_execution_failed';
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'packed_managed_provider_daemon_continuity_error',
    status: code === 'packed_managed_provider_cancelled'
      ? 'cancelled'
      : 'failed',
    code,
    evidence: error instanceof PackedManagedProviderEntrypointError
      ? summarizeHarnessEvidence(error.evidence)
      : null,
  });
}

function resolvePackedManagedProviderSafeFailureCode(
  error: unknown,
  visited = new Set<object>(),
): string | null {
  if (typeof error !== 'object' || error === null || visited.has(error)) {
    return null;
  }
  visited.add(error);
  if (error instanceof PackedManagedProviderEntrypointError) {
    return PACKED_MANAGED_PROVIDER_SAFE_CODE_PATTERN.exec(error.code)?.[1]
      ?? resolvePackedManagedProviderSafeFailureCode(error.cause, visited);
  }
  if (error instanceof PackedCurrentSourceExternalSessionsExecutionError) {
    return resolvePackedManagedProviderSafeFailureCode(error.cause, visited);
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const code = resolvePackedManagedProviderSafeFailureCode(nested, visited);
      if (code) return code;
    }
  }
  if (error instanceof Error) {
    return PACKED_MANAGED_PROVIDER_SAFE_CODE_PATTERN.exec(error.message)?.[1]
      ?? resolvePackedManagedProviderSafeFailureCode(error.cause, visited);
  }
  return null;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${serializePackedManagedProviderContinuityFailure(error)}\n`,
    );
    process.exitCode = 1;
  }
}
