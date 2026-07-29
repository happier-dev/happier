import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  extractArchivePayloadToDirectory,
  inspectTarArchiveEntries,
  type InspectedTarArchiveEntry,
} from '@happier-dev/release-runtime/archiveExtraction';

import {
  assertPackedAuthorCandidateArchivesSafe,
} from '../../scripts/plugin-platform/packed-author-artifact-boundary.mjs';
import {
  assertPackedAuthorCandidateManifestArtifacts,
  assertPackedCliEntrypoint,
  assertPackedPackageIdentity,
  parseCandidateManifest,
  readPackedPackageManifest,
  sha512Sri,
  type PackedAuthorCandidate,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  assertPackedManagedStandaloneCliArchiveIdentity,
  parsePackedManagedProviderArgs,
  resolvePackedManagedWrapperExecutable,
  runPackedManagedProviderVertical,
  type PackedManagedProviderPreparation,
  type PackedManagedProviderRunInput,
  type PackedManagedProviderScenarioDependencies,
  type PackedManagedProviderVerticalResult,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import { reserveAvailablePort as reserveCanonicalAvailablePort } from '../testkit/network/reserveAvailablePort';
import {
  createPackedManagedProviderLiveScenario,
} from './packedManagedProviderLiveScenario';

const STOCK_CLIPROXYAPI_PORT = 8317;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CANDIDATE_DAEMON_CONTROL_READINESS_TIMEOUT_PREFIX =
  'Timed out waiting for condition (packed managed candidate daemon control readiness)';

type CandidateArchiveCensus = Readonly<{
  sdk: Readonly<{ entryCount: number }>;
  cli: Readonly<{ entryCount: number }>;
}>;

export type PackedManagedProviderArtifactOwners = Readonly<{
  assertCandidateArchivesSafe(params: Readonly<{
    sdkTarballPath: string;
    cliTarballPath: string;
  }>): Promise<CandidateArchiveCensus>;
  readPackedPackageManifest(
    archivePath: string,
    extractionRoot: string,
  ): Promise<Record<string, unknown>>;
  inspectTarArchiveEntries(params: Readonly<{
    archivePath: string;
  }>): Promise<readonly InspectedTarArchiveEntry[]>;
  extractArchivePayloadToDirectory(params: Readonly<{
    archivePath: string;
    archiveName: string;
    extractDir: string;
  }>): Promise<void>;
}>;

type IsolatedPorts = Readonly<{
  server: number;
  daemon: number;
  wrapper: number;
}>;

export type PackedManagedProviderHarnessEvidence = Readonly<{
  candidateFrozen: boolean;
  standaloneCliFrozen: boolean;
  candidateArchiveCensus: CandidateArchiveCensus | null;
  standaloneCliArchiveEntryCount: number | null;
  hostTarget: Readonly<{
    os: string;
    arch: string;
  }>;
  isolation: Readonly<{
    happyHomeDir: string | null;
    databasePath: string | null;
    workspaceDir: string | null;
    openCodeStateDir: string | null;
    ports: IsolatedPorts | null;
    stockCliProxyApiPort: 8317;
    stockCliProxyApiTouched: boolean | null;
  }>;
  failureDiagnostics: PackedManagedProviderFailureDiagnostics | null;
  cleanup: Readonly<{
    disposition: 'removed' | 'failed' | 'not_applicable';
    error?: string;
  }>;
}>;

export type PackedManagedProviderFailureDiagnostics = Readonly<{
  schemaVersion: 1;
  code:
    | 'packed_managed_provider_candidate_daemon_exited_before_state'
    | 'packed_managed_provider_candidate_daemon_startup_timed_out'
    | 'packed_managed_provider_candidate_daemon_startup_failed';
  phase: string | null;
  process: Readonly<{
    exitCode: number | null;
    signalCode: string | null;
  }>;
  daemonState: Readonly<{
    everWritten: boolean | null;
    everRemoved: boolean | null;
    lastCandidateCount: number | null;
  }>;
  logs: Readonly<{
    stdout: Readonly<{
      byteCount: number;
      tail: string | null;
    }>;
    stderr: Readonly<{
      byteCount: number;
      tail: string | null;
    }>;
  }>;
}>;

export type PackedManagedProviderEntrypointResult =
  PackedManagedProviderVerticalResult
  & Readonly<{
    harnessEvidence: PackedManagedProviderHarnessEvidence;
  }>;

export class PackedManagedProviderEntrypointError extends Error {
  readonly code: string;
  readonly evidence: PackedManagedProviderHarnessEvidence;
  override readonly cause: unknown;

  constructor(params: Readonly<{
    code: string;
    message?: string;
    evidence: PackedManagedProviderHarnessEvidence;
    cause?: unknown;
  }>) {
    super(params.message ?? params.code);
    this.name = 'PackedManagedProviderEntrypointError';
    this.code = params.code;
    this.evidence = params.evidence;
    this.cause = params.cause;
  }
}

type MutableHarnessState = {
  workRoot: string | null;
  ownsWorkRoot: boolean;
  candidateFrozen: boolean;
  standaloneCliFrozen: boolean;
  candidateArchiveCensus: CandidateArchiveCensus | null;
  standaloneCliArchiveEntryCount: number | null;
  happyHomeDir: string | null;
  databasePath: string | null;
  workspaceDir: string | null;
  openCodeStateDir: string | null;
  ports: IsolatedPorts | null;
  stockCliProxyApiTouched: boolean | null;
  failureDiagnostics: PackedManagedProviderFailureDiagnostics | null;
  cleanup: PackedManagedProviderHarnessEvidence['cleanup'];
};

export type PackedManagedProviderEntrypointDependencies = Readonly<{
  scenario: PackedManagedProviderScenarioDependencies;
  artifactOwners?: PackedManagedProviderArtifactOwners;
  reserveAvailablePort?: () => Promise<number>;
  platform?: NodeJS.Platform;
  arch?: string;
}>;

const canonicalArtifactOwners: PackedManagedProviderArtifactOwners = {
  assertCandidateArchivesSafe: assertPackedAuthorCandidateArchivesSafe,
  readPackedPackageManifest,
  inspectTarArchiveEntries,
  extractArchivePayloadToDirectory,
};

function normalizedOs(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'windows' : platform;
}

function normalizedArch(arch: string): string {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function cancellationError(evidence: PackedManagedProviderHarnessEvidence): PackedManagedProviderEntrypointError {
  return new PackedManagedProviderEntrypointError({
    code: 'packed_managed_provider_cancelled',
    evidence,
  });
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  evidence: PackedManagedProviderHarnessEvidence,
): void {
  if (signal?.aborted) throw cancellationError(evidence);
}

function snapshotEvidence(
  state: MutableHarnessState,
  platform: NodeJS.Platform,
  arch: string,
): PackedManagedProviderHarnessEvidence {
  return {
    candidateFrozen: state.candidateFrozen,
    standaloneCliFrozen: state.standaloneCliFrozen,
    candidateArchiveCensus: state.candidateArchiveCensus,
    standaloneCliArchiveEntryCount: state.standaloneCliArchiveEntryCount,
    hostTarget: {
      os: normalizedOs(platform),
      arch: normalizedArch(arch),
    },
    isolation: {
      happyHomeDir: state.happyHomeDir,
      databasePath: state.databasePath,
      workspaceDir: state.workspaceDir,
      openCodeStateDir: state.openCodeStateDir,
      ports: state.ports,
      stockCliProxyApiPort: STOCK_CLIPROXYAPI_PORT,
      stockCliProxyApiTouched: state.stockCliProxyApiTouched,
    },
    failureDiagnostics: state.failureDiagnostics,
    cleanup: state.cleanup,
  };
}

function readFailureDiagnostics(
  error: unknown,
): PackedManagedProviderFailureDiagnostics | null {
  if (!error || typeof error !== 'object') return null;
  const diagnostics = Reflect.get(
    error,
    'packedManagedProviderFailureDiagnostics',
  ) as unknown;
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const value = diagnostics as Partial<PackedManagedProviderFailureDiagnostics>;
  if (
    value.schemaVersion !== 1
    || typeof value.code !== 'string'
    || !value.code.startsWith(
      'packed_managed_provider_candidate_daemon_',
    )
  ) {
    return null;
  }
  return diagnostics as PackedManagedProviderFailureDiagnostics;
}

function errorCode(error: unknown): string {
  if (error instanceof PackedManagedProviderEntrypointError) return error.code;
  if (
    error instanceof Error
    && error.message.startsWith(
      CANDIDATE_DAEMON_CONTROL_READINESS_TIMEOUT_PREFIX,
    )
  ) {
    return 'packed_managed_provider_candidate_daemon_control_not_ready';
  }
  if (error instanceof Error && /^packed_managed_provider_[a-z0-9_:.-]+$/u.test(error.message)) {
    return error.message;
  }
  return 'packed_managed_provider_execution_failed';
}

async function createPrivateWorkRoot(params: Readonly<{
  requestedRoot: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
}>): Promise<string> {
  const { requestedRoot } = params;
  if (!requestedRoot) {
    const root = await mkdtemp(join(tmpdir(), 'happier-packed-managed-'));
    await chmod(root, PRIVATE_DIRECTORY_MODE);
    return root;
  }
  const root = resolve(requestedRoot);
  await mkdir(dirname(root), { recursive: true });
  try {
    await mkdir(root, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    throw new PackedManagedProviderEntrypointError({
      code: 'packed_managed_provider_work_root_must_be_new',
      evidence: {
        candidateFrozen: false,
        standaloneCliFrozen: false,
        candidateArchiveCensus: null,
        standaloneCliArchiveEntryCount: null,
        hostTarget: {
          os: normalizedOs(params.platform),
          arch: normalizedArch(params.arch),
        },
        isolation: {
          happyHomeDir: null,
          databasePath: null,
          workspaceDir: null,
          openCodeStateDir: null,
          ports: null,
          stockCliProxyApiPort: STOCK_CLIPROXYAPI_PORT,
          stockCliProxyApiTouched: null,
        },
        failureDiagnostics: null,
        cleanup: { disposition: 'not_applicable' },
      },
      cause: error,
    });
  }
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  return root;
}

async function writeFrozenFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, {
    flag: 'wx',
    mode: PRIVATE_FILE_MODE,
  });
}

async function assertContainedRegularFile(params: Readonly<{
  rootPath: string;
  filePath: string;
  code: string;
}>): Promise<string> {
  const [physicalRoot, physicalFile, directStats] = await Promise.all([
    realpath(params.rootPath),
    realpath(params.filePath),
    lstat(params.filePath),
  ]);
  if (
    directStats.isSymbolicLink()
    || !directStats.isFile()
    || !isPathWithin(physicalRoot, physicalFile)
  ) {
    throw new Error(params.code);
  }
  return physicalFile;
}

async function reserveIsolatedPorts(params: Readonly<{
  reserveAvailablePort: () => Promise<number>;
  signal?: AbortSignal;
  evidence: () => PackedManagedProviderHarnessEvidence;
}>): Promise<IsolatedPorts> {
  const values: number[] = [];
  while (values.length < 3) {
    assertNotAborted(params.signal, params.evidence());
    const port = await params.reserveAvailablePort();
    if (
      !Number.isInteger(port)
      || port < 1
      || port > 65_535
    ) {
      throw new Error('packed_managed_provider_reserved_port_invalid');
    }
    if (port === STOCK_CLIPROXYAPI_PORT || values.includes(port)) continue;
    values.push(port);
  }
  return {
    server: values[0]!,
    daemon: values[1]!,
    wrapper: values[2]!,
  };
}

function assertCandidateIntegrity(
  candidate: PackedAuthorCandidate,
  sdkBytes: Uint8Array,
  cliBytes: Uint8Array,
): void {
  if (sha512Sri(sdkBytes) !== candidate.sdk.integrity) {
    throw new Error('packed_managed_provider_candidate_sdk_integrity_mismatch');
  }
  if (sha512Sri(cliBytes) !== candidate.cli.integrity) {
    throw new Error('packed_managed_provider_candidate_cli_integrity_mismatch');
  }
}

async function prepareCandidate(params: Readonly<{
  input: PackedManagedProviderRunInput;
  state: MutableHarnessState;
  owners: PackedManagedProviderArtifactOwners;
  reserveAvailablePort: () => Promise<number>;
  platform: NodeJS.Platform;
  arch: string;
}>): Promise<PackedManagedProviderPreparation> {
  const evidence = () => snapshotEvidence(params.state, params.platform, params.arch);
  assertNotAborted(params.input.signal, evidence());
  const manifestPath = resolve(params.input.candidateManifestPath);
  const manifestBytes = await readFile(manifestPath);
  const candidate = parseCandidateManifest(
    manifestBytes.toString('utf8'),
    manifestPath,
  );
  await assertPackedAuthorCandidateManifestArtifacts(candidate, {
    manifestPath,
  });
  const expectedStandalone = candidate.standaloneCli?.archives.find(
    (artifact) => (
      artifact.os === normalizedOs(params.platform)
      && artifact.arch === normalizedArch(params.arch)
    ),
  );
  if (!expectedStandalone) {
    throw new Error(
      'packed_managed_provider_standalone_cli_candidate_provenance_mismatch',
    );
  }
  const standaloneSourcePath = resolve(expectedStandalone.archivePath);
  const [sdkBytes, cliBytes, standaloneBytes] = await Promise.all([
    readFile(candidate.sdk.tarballPath),
    readFile(candidate.cli.tarballPath),
    readFile(standaloneSourcePath),
  ]);
  assertCandidateIntegrity(candidate, sdkBytes, cliBytes);
  const standaloneDigest = createHash('sha256')
    .update(standaloneBytes)
    .digest('hex');
  if (
    resolve(expectedStandalone.archivePath) !== standaloneSourcePath
    || expectedStandalone.sha256 !== standaloneDigest
    || expectedStandalone.product !== 'happier'
    || expectedStandalone.version !== candidate.cli.version
    || expectedStandalone.os !== normalizedOs(params.platform)
    || expectedStandalone.arch !== normalizedArch(params.arch)
  ) {
    throw new Error(
      'packed_managed_provider_standalone_cli_candidate_provenance_mismatch',
    );
  }
  assertNotAborted(params.input.signal, evidence());

  const workRoot = params.state.workRoot;
  if (!workRoot) {
    throw new Error('packed_managed_provider_private_root_unavailable');
  }
  const archivesDir = join(workRoot, 'archives');
  const manifestsDir = join(workRoot, 'package-manifests');
  const standaloneExtractDir = join(workRoot, 'standalone');
  const happyHomeDir = join(workRoot, 'home');
  const databaseDir = join(workRoot, 'database');
  const workspaceDir = join(workRoot, 'agent-workspace');
  const openCodeStateDir = join(workRoot, 'opencode-state');
  await Promise.all([
    mkdir(archivesDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(manifestsDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(standaloneExtractDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(happyHomeDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(databaseDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(workspaceDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(openCodeStateDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
  ]);
  params.state.happyHomeDir = happyHomeDir;
  params.state.databasePath = join(databaseDir, 'happier-server.sqlite');
  params.state.workspaceDir = workspaceDir;
  params.state.openCodeStateDir = openCodeStateDir;

  const sdkAttestedPath = join(archivesDir, 'sdk-attested.tgz');
  const cliAttestedPath = join(archivesDir, 'cli-attested.tgz');
  const standaloneAttestedPath = join(
    archivesDir,
    basename(standaloneSourcePath),
  );
  const manifestAttestedPath = join(archivesDir, 'candidate-attested.json');
  await Promise.all([
    writeFrozenFile(sdkAttestedPath, sdkBytes),
    writeFrozenFile(cliAttestedPath, cliBytes),
    writeFrozenFile(standaloneAttestedPath, standaloneBytes),
    writeFrozenFile(manifestAttestedPath, manifestBytes),
  ]);
  params.state.candidateFrozen = true;
  params.state.standaloneCliFrozen = true;
  assertNotAborted(params.input.signal, evidence());

  const candidateArchiveCensus = await params.owners.assertCandidateArchivesSafe({
    sdkTarballPath: sdkAttestedPath,
    cliTarballPath: cliAttestedPath,
  });
  params.state.candidateArchiveCensus = candidateArchiveCensus;
  const [sdkManifest, cliManifest] = await Promise.all([
    params.owners.readPackedPackageManifest(
      sdkAttestedPath,
      join(manifestsDir, 'sdk'),
    ),
    params.owners.readPackedPackageManifest(
      cliAttestedPath,
      join(manifestsDir, 'cli'),
    ),
  ]);
  assertPackedPackageIdentity(sdkManifest, candidate.sdk, 'Packed SDK');
  assertPackedPackageIdentity(cliManifest, candidate.cli, 'Packed CLI');
  assertPackedCliEntrypoint(cliManifest, candidate.cli);
  assertNotAborted(params.input.signal, evidence());

  const standaloneEntries = await params.owners.inspectTarArchiveEntries({
    archivePath: standaloneAttestedPath,
  });
  params.state.standaloneCliArchiveEntryCount = standaloneEntries.length;
  const standaloneIdentity = assertPackedManagedStandaloneCliArchiveIdentity({
    archivePath: standaloneAttestedPath,
    candidateCliVersion: candidate.cli.version,
    entries: standaloneEntries,
    platform: params.platform,
    arch: params.arch,
  });
  await params.owners.extractArchivePayloadToDirectory({
    archivePath: standaloneAttestedPath,
    archiveName: standaloneIdentity.archiveName,
    extractDir: standaloneExtractDir,
  });
  assertNotAborted(params.input.signal, evidence());

  const artifactRoot = join(
    standaloneExtractDir,
    standaloneIdentity.artifactRootName,
  );
  const physicalArtifactRoot = await realpath(artifactRoot);
  const executablePath = join(
    standaloneExtractDir,
    ...standaloneIdentity.executableRelativePath.split('/'),
  );
  const wrapperExpectedPath = join(
    standaloneExtractDir,
    ...standaloneIdentity.wrapperRelativePath.split('/'),
  );
  const unpackedDir = join(artifactRoot, 'tools', 'unpacked');
  const [physicalExecutable, physicalWrapper] = await Promise.all([
    assertContainedRegularFile({
      rootPath: artifactRoot,
      filePath: executablePath,
      code: 'packed_managed_provider_standalone_cli_executable_containment_mismatch',
    }),
    assertContainedRegularFile({
      rootPath: artifactRoot,
      filePath: wrapperExpectedPath,
      code: 'packed_managed_provider_standalone_cli_wrapper_containment_mismatch',
    }),
    assertContainedRegularFile({
      rootPath: artifactRoot,
      filePath: join(unpackedDir, 'CLIProxyAPI-LICENSE'),
      code: 'packed_managed_provider_standalone_cli_license_containment_mismatch',
    }),
    assertContainedRegularFile({
      rootPath: artifactRoot,
      filePath: join(
        unpackedDir,
        'CLIProxyAPI-THIRD-PARTY-NOTICES',
      ),
      code: 'packed_managed_provider_standalone_cli_notices_containment_mismatch',
    }),
  ]);
  const wrapperExecutable = resolvePackedManagedWrapperExecutable({
    standaloneCliExecutable: physicalExecutable,
    standaloneCliExtractRoot: artifactRoot,
    platform: params.platform,
  });
  if (resolve(wrapperExecutable) !== resolve(physicalWrapper)) {
    throw new Error(
      'packed_managed_provider_standalone_cli_wrapper_identity_mismatch',
    );
  }

  params.state.ports = await reserveIsolatedPorts({
    reserveAvailablePort: params.reserveAvailablePort,
    signal: params.input.signal,
    evidence,
  });
  const frozenCandidate: PackedAuthorCandidate = {
    ...candidate,
    sdk: {
      ...candidate.sdk,
      tarballPath: sdkAttestedPath,
    },
    cli: {
      ...candidate.cli,
      tarballPath: cliAttestedPath,
    },
  };
  return {
    candidate: frozenCandidate,
    standaloneCliArtifact: {
      product: standaloneIdentity.product,
      version: standaloneIdentity.version,
      os: standaloneIdentity.os,
      arch: standaloneIdentity.arch,
      archivePath: standaloneAttestedPath,
      sourceArchivePath: standaloneSourcePath,
      sha256: standaloneDigest,
      extractRoot: physicalArtifactRoot,
      executablePath: physicalExecutable,
    },
    cliLaunchSpec: {
      command: physicalExecutable,
      args: [],
      cwd: workspaceDir,
      env: {
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
        HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED: '1',
        HAPPIER_HOME_DIR: happyHomeDir,
        HAPPIER_PACKED_MANAGED_SERVER_PORT: String(params.state.ports.server),
        HAPPIER_PACKED_MANAGED_DAEMON_PORT: String(params.state.ports.daemon),
        HAPPIER_PACKED_MANAGED_WRAPPER_PORT: String(params.state.ports.wrapper),
        HAPPIER_PACKED_MANAGED_DATABASE_PATH: params.state.databasePath,
        XDG_CONFIG_HOME: join(openCodeStateDir, 'config'),
        XDG_DATA_HOME: join(openCodeStateDir, 'data'),
        XDG_STATE_HOME: join(openCodeStateDir, 'state'),
        XDG_CACHE_HOME: join(openCodeStateDir, 'cache'),
      },
    },
    wrapperExecutable,
    verifiedCandidateIntegrity: true,
    verifiedCandidatePackageIdentity: true,
    verifiedStandaloneCliIntegrity: true,
    verifiedStandaloneCliIdentity: true,
  };
}

export async function runPackedManagedProviderEntrypoint(
  input: PackedManagedProviderRunInput,
  deps: PackedManagedProviderEntrypointDependencies,
): Promise<PackedManagedProviderEntrypointResult> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const state: MutableHarnessState = {
    workRoot: null,
    ownsWorkRoot: false,
    candidateFrozen: false,
    standaloneCliFrozen: false,
    candidateArchiveCensus: null,
    standaloneCliArchiveEntryCount: null,
    happyHomeDir: null,
    databasePath: null,
    workspaceDir: null,
    openCodeStateDir: null,
    ports: null,
    stockCliProxyApiTouched: null,
    failureDiagnostics: null,
    cleanup: { disposition: 'not_applicable' },
  };
  const evidence = () => snapshotEvidence(state, platform, arch);

  try {
    state.workRoot = await createPrivateWorkRoot({
      requestedRoot: input.workRoot,
      platform,
      arch,
    });
    state.ownsWorkRoot = true;
    const result = await runPackedManagedProviderVertical(input, {
      prepareCandidate: async () => await prepareCandidate({
        input,
        state,
        owners: deps.artifactOwners ?? canonicalArtifactOwners,
        reserveAvailablePort:
          deps.reserveAvailablePort ?? reserveCanonicalAvailablePort,
        platform,
        arch,
      }),
      runPackagedWrapperConformance: async (scenarioInput) => {
        assertNotAborted(input.signal, evidence());
        return await deps.scenario.runPackagedWrapperConformance(scenarioInput);
      },
      runFreshManagedSequence: async (scenarioInput) => {
        assertNotAborted(input.signal, evidence());
        const observed =
          await deps.scenario.runFreshManagedSequence(scenarioInput);
        state.stockCliProxyApiTouched =
          observed.stockPortRequestCount !== 0
          || observed.stockPortOsConnectionAttemptCount !== 0
          || observed.stockListenerIdentityAfter
            !== observed.stockListenerIdentityBefore;
        state.ports = {
          server: observed.observedPorts.server,
          daemon: observed.observedPorts.daemon,
          wrapper: observed.observedPorts.wrapper,
        };
        return observed;
      },
      runActivationFailureCleanupProbe: async (scenarioInput) => {
        assertNotAborted(input.signal, evidence());
        return await deps.scenario.runActivationFailureCleanupProbe(scenarioInput);
      },
      cleanup: async (cleanupInput) => {
        let scenarioCleanupError: unknown = null;
        try {
          await deps.scenario.cleanup(cleanupInput);
        } catch (error) {
          scenarioCleanupError = error;
        }
        if (state.ownsWorkRoot && state.workRoot) {
          try {
            await rm(state.workRoot, { recursive: true, force: true });
            state.cleanup = { disposition: 'removed' };
          } catch (error) {
            state.cleanup = {
              disposition: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
            if (!scenarioCleanupError) scenarioCleanupError = error;
          }
        }
        if (scenarioCleanupError) throw scenarioCleanupError;
      },
    });
    return {
      ...result,
      harnessEvidence: evidence(),
    };
  } catch (error) {
    state.failureDiagnostics = readFailureDiagnostics(error);
    if (
      state.ownsWorkRoot
      && state.workRoot
      && state.cleanup.disposition === 'not_applicable'
    ) {
      try {
        await rm(state.workRoot, { recursive: true, force: true });
        state.cleanup = { disposition: 'removed' };
      } catch (cleanupError) {
        state.cleanup = {
          disposition: 'failed',
          error: cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        };
      }
    }
    throw new PackedManagedProviderEntrypointError({
      code: errorCode(error),
      evidence: evidence(),
      cause: error,
    });
  }
}

export type PackedManagedProviderCommandDependencies = Readonly<{
  artifactOwners?: PackedManagedProviderArtifactOwners;
  reserveAvailablePort?: () => Promise<number>;
  nowIso?: () => string;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
  setExitCode?: (code: number) => void;
}>;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: PackedManagedProviderCommandDependencies = {},
): Promise<void> {
  const parsed = parsePackedManagedProviderArgs(argv);
  if (parsed.mode !== 'run') {
    throw new Error(
      'packed_managed_provider_entrypoint_requires_run_arguments',
    );
  }
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
  const writeStdout = dependencies.writeStdout
    ?? ((line: string) => process.stdout.write(line));
  const writeStderr = dependencies.writeStderr
    ?? ((line: string) => process.stderr.write(line));
  const setExitCode = dependencies.setExitCode
    ?? ((code: number) => {
      process.exitCode = code;
    });
  const startedAt = nowIso();
  const scenario = createPackedManagedProviderLiveScenario();
  try {
    const result = await runPackedManagedProviderEntrypoint(parsed, {
      scenario,
      artifactOwners: dependencies.artifactOwners,
      reserveAvailablePort: dependencies.reserveAvailablePort,
    });
    writeStdout(`${JSON.stringify({
      ...result,
      startedAt,
      completedAt: nowIso(),
    })}\n`);
    setExitCode(0);
  } catch (error) {
    const entrypointError = error instanceof PackedManagedProviderEntrypointError
      ? error
      : new PackedManagedProviderEntrypointError({
          code: errorCode(error),
          evidence: {
            candidateFrozen: false,
            standaloneCliFrozen: false,
            candidateArchiveCensus: null,
            standaloneCliArchiveEntryCount: null,
            hostTarget: {
              os: normalizedOs(process.platform),
              arch: normalizedArch(process.arch),
            },
            isolation: {
              happyHomeDir: null,
              databasePath: null,
              workspaceDir: null,
              openCodeStateDir: null,
              ports: null,
              stockCliProxyApiPort: STOCK_CLIPROXYAPI_PORT,
              stockCliProxyApiTouched: null,
            },
            failureDiagnostics: null,
            cleanup: { disposition: 'not_applicable' },
          },
          cause: error,
        });
    writeStderr(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'packed_managed_provider_vertical_error',
      status: entrypointError.code === 'packed_managed_provider_cancelled'
        ? 'cancelled'
        : 'failed',
      code: entrypointError.code,
      evidence: entrypointError.evidence,
    })}\n`);
    setExitCode(1);
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
