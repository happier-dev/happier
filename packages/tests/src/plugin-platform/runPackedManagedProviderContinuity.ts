import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PACKED_MANAGED_PROVIDER_CANDIDATE_HANDOFF_STAGE_IDS,
  parsePackedManagedProviderArgs,
  runPackedChannelProviderVertical,
  type PackedManagedProviderPreparedInput,
  type PackedManagedProviderPreparation,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import {
  readPackedPackageManifest,
  sha512Sri,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { exportPackSandboxTarball } from '../../../../apps/stack/scripts/pack.mjs';
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
  startPackedManagedProviderComposedRuntime,
  type PackedManagedProviderCandidateHandoffObservation,
  type PackedCurrentSourceExternalSessionsObservation,
  type PackedManagedProviderContinuityObservation,
  type PackedManagedProviderRecoveryRefusalObservation,
} from './packedManagedProviderComposedRuntime';
import { resolveCliTestLaunchSpec } from '../testkit/process/cliLaunchSpec';

const PACKED_MANAGED_PROVIDER_SAFE_CODE_PATTERN =
  /^(packed_(?:managed_provider|current_source_external_sessions|channel_provider)_[a-z0-9_]+)(?:$|:)/u;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function prepareCurrentSourceManagedProvider(): Promise<Readonly<{
  prepared: PackedManagedProviderPreparation;
  cleanup(): Promise<void>;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-packed-current-provider-'));
  try {
    const packageRoot = join(root, 'packages');
    const testDir = join(root, 'harness');
    const workspaceDir = join(root, 'workspace');
    await Promise.all([
      mkdir(packageRoot, { recursive: true, mode: 0o700 }),
      mkdir(testDir, { recursive: true, mode: 0o700 }),
      mkdir(workspaceDir, { recursive: true, mode: 0o700 }),
    ]);
    const packageDefinitions = [
      ['sdk', 'packages/plugin-sdk', '@happier-dev/plugin-sdk'],
      ['pluginUi', 'packages/plugin-ui', '@happier-dev/plugin-ui'],
      ['channelsProtocol', 'packages/channels-protocol', '@happier-dev/channels-protocol'],
      ['cli', 'apps/cli', '@happier-dev/cli'],
    ] as const;
    const records: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const [field, packageRelDir, packageName] of packageDefinitions) {
      const outputDir = join(packageRoot, field);
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const packed = await exportPackSandboxTarball({
        monorepoRoot: REPOSITORY_ROOT,
        packageRelDir,
        destinationDir: outputDir,
      });
      const tarballName = String(packed?.tarball?.name ?? '');
      if (!tarballName || tarballName !== basename(tarballName)) {
        throw new Error(`packed_current_source_package_identity_invalid:${field}`);
      }
      const tarballPath = join(outputDir, tarballName);
      const [bytes, manifest] = await Promise.all([
        readFile(tarballPath),
        readPackedPackageManifest(tarballPath, join(outputDir, 'manifest')),
      ]);
      if (manifest.name !== packageName || typeof manifest.version !== 'string') {
        throw new Error(`packed_current_source_package_identity_invalid:${field}`);
      }
      const manifestDependencies = manifest.dependencies !== null
        && typeof manifest.dependencies === 'object'
        && !Array.isArray(manifest.dependencies)
        ? manifest.dependencies as Record<string, unknown>
        : {};
      records[field] = Object.freeze({
        packageName,
        version: manifest.version,
        integrity: sha512Sri(bytes),
        tarballPath,
        ...(field === 'pluginUi'
          ? {
              pluginSdkVersion: String(
                manifestDependencies['@happier-dev/plugin-sdk'] ?? '',
              ),
            }
          : {}),
        ...(field === 'cli' ? { entrypoint: 'package/bin/happier.mjs' } : {}),
      });
    }
    const cliLaunchSpec = await resolveCliTestLaunchSpec(
      { testDir, env: { HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy' } },
      {
        snapshotDir: join(root, 'cli-source-snapshot'),
        preferSourceEntrypoint: true,
      },
    );
    const cliRoot = cliLaunchSpec.cwd;
    if (!cliRoot) throw new Error('packed_current_source_cli_root_missing');
    const externalRuntimeRoot = join(root, 'external-provider-runtime');
    await mkdir(externalRuntimeRoot, { recursive: true, mode: 0o700 });
    const operatingSystem = process.platform === 'win32' ? 'windows' : process.platform;
    const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
    if (
      !['darwin', 'linux', 'windows'].includes(operatingSystem)
      || !['amd64', 'arm64'].includes(architecture)
    ) {
      throw new Error('packed_current_source_managed_runtime_target_unsupported');
    }
    const wrapperExecutable = join(
      externalRuntimeRoot,
      `acme-packed-provider-runtime${operatingSystem === 'windows' ? '.exe' : ''}`,
    );
    // The external fixture owns its packaged runtime artifact. A private copy
    // of the already-running Node executable keeps this moving-source proof
    // independent from CPX's Go build and from the singleton CLI runtime asset.
    await copyFile(process.execPath, wrapperExecutable);
    await chmod(wrapperExecutable, 0o700);
    const cliVersion = String(records.cli?.version ?? '0.0.0');
    const artifactSet = {
      schemaVersion: 1,
      runId: `current-source-${randomUUID()}`,
      sdk: records.sdk,
      pluginUi: records.pluginUi,
      channelsProtocol: records.channelsProtocol,
      cli: records.cli,
    };
    const prepared = {
      currentSource: true,
      candidate: artifactSet,
      standaloneCliArtifact: {
        product: 'happier',
        version: cliVersion,
        os: operatingSystem,
        arch: process.arch,
        archivePath: cliRoot,
        sourceArchivePath: cliRoot,
        sha256: '',
        extractRoot: cliRoot,
        executablePath: cliLaunchSpec.command,
      },
      cliLaunchSpec: {
        command: cliLaunchSpec.command,
        args: cliLaunchSpec.args,
        cwd: workspaceDir,
        env: cliLaunchSpec.env,
      },
      wrapperExecutable,
      verifiedCandidateIntegrity: true,
      verifiedCandidatePackageIdentity: true,
      verifiedStandaloneCliIntegrity: true,
      verifiedStandaloneCliIdentity: true,
    } as unknown as PackedManagedProviderPreparation;
    return {
      prepared,
      cleanup: async () => {
        await cliLaunchSpec.cleanup?.();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

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
    currentSource?: boolean;
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
    ...(input.currentSource
      ? {
          source: {
            kind: 'current-source',
            sdk: {
              packageName: candidateIdentity.sdk.packageName,
              version: candidateIdentity.sdk.version,
            },
            cli: {
              packageName: candidateIdentity.cli.packageName,
              version: candidateIdentity.cli.version,
            },
          },
          runtime: {
            product: input.result.standaloneCliArtifact.product,
            version: input.result.standaloneCliArtifact.version,
            os: input.result.standaloneCliArtifact.os,
            arch: input.result.standaloneCliArtifact.arch,
          },
        }
      : {
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
        }),
    freshBootstrapStages: input.result.stages.map((stage) => ({
      id: stage.id,
      status: stage.status,
    })),
    harnessEvidence: input.currentSource
      ? { source: 'current-source', cleanup: input.result.harnessEvidence.cleanup }
      : summarizeHarnessEvidence(input.result.harnessEvidence),
    continuityContract: input.continuity.contract,
    [input.currentSource ? 'currentSourceHandoffStages' : 'candidateHandoffStages']:
      PACKED_MANAGED_PROVIDER_CANDIDATE_HANDOFF_STAGE_IDS.map((id) => ({
        id: input.currentSource ? id.replace(/^candidate-/u, 'current-source-') : id,
        status: 'passed' as const,
      })),
    [input.currentSource ? 'currentSourceHandoffContract' : 'candidateHandoffContract']:
      input.candidateHandoff.contract,
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

async function runPackedCurrentSourceManagedProviderContinuity(): Promise<
  Readonly<{
    prepared: PackedManagedProviderPreparation;
    candidateHandoff: PackedManagedProviderCandidateHandoffObservation;
  }>
> {
  const source = await prepareCurrentSourceManagedProvider();
  const composed = await startPackedManagedProviderComposedRuntime();
  try {
    try {
      return {
        prepared: source.prepared,
        candidateHandoff:
          await composed.probeCandidateExternalAgentProviderHandoff(
            { prepared: source.prepared } as PackedManagedProviderPreparedInput,
          ),
      };
    } catch (cause) {
      throw new PackedCurrentSourceExternalSessionsExecutionError({
        stage: 'handoff-contract',
        cause,
      });
    }
  } finally {
    await composed.cleanup().catch(() => {});
    await source.cleanup();
  }
}

/**
 * The Channel vertical consumes the same moving-source package archives as the
 * ordinary current-source proof, but it exercises the separate real daemon,
 * socket, custody, disable/re-enable, restart, and generation lifecycle.
 * These ephemeral archives are a transport into that loaded process, not a
 * release-candidate input or a frozen test representation.
 */
async function runPackedCurrentSourceChannelProviderContinuity(): Promise<
  Readonly<{
    prepared: PackedManagedProviderPreparation;
    result: Awaited<ReturnType<typeof runPackedChannelProviderVertical>>;
  }>
> {
  const source = await prepareCurrentSourceManagedProvider();
  const composed = await startPackedManagedProviderComposedRuntime();
  try {
    const result = await runPackedChannelProviderVertical(
      { enableOpenCodeLive: false } as Parameters<typeof runPackedChannelProviderVertical>[0],
      {
        prepareCandidate: async () => source.prepared,
        runPackedChannelProviderLifecycle: async (input) =>
          await composed.probePackedChannelProviderLifecycle(input),
        cleanup: async () => await composed.cleanup(),
      },
    );
    return { prepared: source.prepared, result };
  } finally {
    await composed.cleanup().catch(() => {});
    await source.cleanup();
  }
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
    const current = await runPackedCurrentSourceManagedProviderContinuity();
    writeStdout(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'packed_current_source_external_packaged_runtime',
      status: 'passed',
      source: {
        sdk: {
          packageName: current.prepared.candidate.sdk.packageName,
          version: current.prepared.candidate.sdk.version,
        },
        cli: {
          packageName: current.prepared.candidate.cli.packageName,
          version: current.prepared.candidate.cli.version,
        },
      },
      hostTarget: {
        os: process.platform === 'win32' ? 'windows' : process.platform,
        arch: process.arch,
      },
      contract: current.candidateHandoff.contract,
    })}\n`);
    return;
  }
  // The command parser is a JavaScript module. Keep this runtime dispatch
  // tolerant of a newly-added parser arm while its generated TypeScript view
  // is refreshed by the package boundary.
  if (String(parsed.mode) === 'current-source-channel') {
    const current = await runPackedCurrentSourceChannelProviderContinuity();
    const channelsProtocol = current.prepared.candidate.channelsProtocol;
    if (!channelsProtocol) {
      throw new Error('packed_current_source_channels_protocol_missing');
    }
    writeStdout(`${JSON.stringify({
      ...current.result,
      source: {
        kind: 'current-source',
        sdk: {
          packageName: current.prepared.candidate.sdk.packageName,
          version: current.prepared.candidate.sdk.version,
        },
        channelsProtocol: {
          packageName: channelsProtocol.packageName,
          version: channelsProtocol.version,
        },
        cli: {
          packageName: current.prepared.candidate.cli.packageName,
          version: current.prepared.candidate.cli.version,
        },
      },
    })}\n`);
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
