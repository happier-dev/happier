export type PackedAuthorCandidate = Readonly<{
  schemaVersion: 1;
  runId: string;
  sourceBasis?: Readonly<{
    algorithm: 'sha256';
    digest: string;
  }>;
  installers?: Readonly<{
    releaseChannel: 'dev';
    shell: PackedAuthorCandidateBoundFile<'shell', 'install-dev.sh'>;
    powershell: PackedAuthorCandidateBoundFile<'powershell', 'install-dev.ps1'>;
    publicKey: PackedAuthorCandidateBoundFile<'minisign-public-key', 'happier-release.pub'>;
  }>;
  sdk: Readonly<{
    packageName: '@happier-dev/plugin-sdk';
    version: string;
    integrity: string;
    tarballPath: string;
  }>;
  cli: Readonly<{
    packageName: '@happier-dev/cli';
    version: string;
    integrity: string;
    tarballPath: string;
    entrypoint: string;
  }>;
  standaloneCli?: Readonly<{
    product: 'happier';
    version: string;
    os: string;
    arch: 'x64' | 'arm64';
    sha256: string;
    archivePath: string;
    archives: readonly Readonly<{
      product: 'happier';
      version: string;
      os: string;
      arch: 'x64' | 'arm64';
      sha256: string;
      archivePath: string;
    }>[];
    checksums: PackedAuthorCandidateBoundFile<
      'sha256-checksums',
      `checksums-happier-v${string}.txt`
    >;
    signature:
      | PackedAuthorCandidateBoundFile<
          'minisign-signature',
          `checksums-happier-v${string}.txt.minisig`
        >
      | null;
  }>;
}>;

export type PackedAuthorCandidateBoundFile<
  Kind extends string,
  FileName extends string,
> = Readonly<{
  kind: Kind;
  fileName: FileName;
  sizeBytes: number;
  sha256: string;
  filePath: string;
}>;

export const PACKED_AUTHOR_NATIVE_TARGETS: readonly [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
];

export type PackedAuthorVerticalAResult = Readonly<{
  ok: boolean;
  scenario: 'vertical-a';
  candidate: unknown;
  stages: readonly unknown[];
  evidenceLayers: Readonly<{
    ownerFault: PackedAuthorVerticalAEvidenceLayerResult;
    packedExternalBlackBox: PackedAuthorVerticalAEvidenceLayerResult;
    authenticatedDaemon: PackedAuthorVerticalAEvidenceLayerResult;
  }>;
  loadedIdentities: unknown;
  packedNovelQaHandoff?: Readonly<{
    manifestPath: string;
    archivePath: string;
    integrity: string;
    cleanupOwner: 'cleanupPackedNovelConnectedAccountQaHandoff';
    disposition: 'retained-explicitly';
  }>;
  error?: unknown;
  cleanup: Readonly<{ disposition: string }>;
}>;

export type PackedNovelConnectedAccountQaConsumer = Readonly<{
  root: string;
  happyHomeDir: string;
  databasePath: string;
}>;

export type PackedNovelConnectedAccountQaHandoff = Readonly<{
  schemaVersion: 1;
  kind: 'happier_packed_novel_connected_account_qa_handoff_v1';
  runId: string;
  rootId: string;
  manifestPath: string;
  root: string;
  candidate: Readonly<{
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
  }>;
  plugin: Readonly<{
    pluginId: 'acme.vertical-a';
    version: '1.0.0';
    service: Readonly<{
      pluginId: 'acme.vertical-a';
      localId: 'novel-cloud';
    }>;
    authenticationModeIds: readonly ['manual', 'oauth', 'device'];
    archive: Readonly<{
      path: string;
      packOwner: 'run-packed-author-ui-compat#packCurrentPlugin';
      packLabel: 'initial-v1';
      integrity: string;
      sha256: string;
      sizeBytes: number;
      archivePath: string;
    }>;
    archivePath: string;
  }>;
  lifecycle: Readonly<{
    scenario: 'vertical-a';
    completedStageIds: readonly string[];
  }>;
  consumers: Readonly<{
    browser: PackedNovelConnectedAccountQaConsumer;
    device: PackedNovelConnectedAccountQaConsumer;
  }>;
  oauth: Readonly<{
    authorizationOriginConfigurationFieldId: 'authorization-origin';
    callbackUrl: 'http://localhost:1455/auth/callback';
    authorizePath: '/authorize';
    transport: 'ephemeral-https-loopback';
  }>;
  cleanup: Readonly<{
    owner: 'cleanupPackedNovelConnectedAccountQaHandoff';
    markerPath: string;
  }>;
}>;

export type PackedAuthorVerticalAEvidenceLayerId =
  | 'ownerFault'
  | 'packedExternalBlackBox'
  | 'authenticatedDaemon';

export type PackedAuthorVerticalAEvidenceLayerResult = Readonly<{
  ok: boolean;
  requiredStageIds: readonly string[];
  stages: readonly unknown[];
  error?: Readonly<{
    missingStageIds: readonly string[];
    failedStageIds: readonly string[];
    duplicateStageIds: readonly string[];
    unexpectedStageIds: readonly string[];
  }>;
}>;

export const VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS: Readonly<
  Record<PackedAuthorVerticalAEvidenceLayerId, readonly string[]>
>;

export function buildVerticalAEvidenceLayerResult(
  layerId: PackedAuthorVerticalAEvidenceLayerId,
  stages: readonly Readonly<{ id: string; ok?: boolean }>[],
): PackedAuthorVerticalAEvidenceLayerResult;

export function buildVerticalAResult(input: Readonly<{
  candidate: PackedAuthorCandidate;
  stages: readonly Readonly<{ id: string; ok?: boolean }>[];
  loadedIdentities: unknown;
  executionFailure?: Readonly<{
    code: string;
    message: string;
  }> | null;
}>): PackedAuthorVerticalAResult;

export function shouldRetainPackedAuthorTempRoot(input: Readonly<{
  succeeded: boolean;
  retainFailedTempRequested: boolean;
}>): boolean;

export function formatPackedQualifiedConnectedAccountHttpFailure(
  input: Readonly<{
    method: string;
    path: string;
    status: number;
  }>,
): string;

export function assertPackedAuthorCredentialSentinelsAbsent(
  input: Readonly<{
    commandOutputs?: readonly Readonly<{
      stdout?: string;
      stderr?: string;
    }>[];
    logs?: readonly string[];
    markerLog?: string;
    result?: unknown;
    sentinels?: readonly string[];
  }>,
): void;

export function assertPackedConnectedAccountWatchRematerialization(
  input: Readonly<{
    selectionEnvelope: unknown;
    watchEnvelope: unknown;
    mutation: unknown;
  }>,
): Readonly<{
  selection: string;
  resyncCount: number;
  rematerializedAccountIds: readonly string[];
}>;

export function assertPackedConnectedAccountDormancy(
  input: Readonly<{
    baseline: unknown;
    dormant: unknown;
    reenabled: unknown;
    materializationEnvelope: unknown;
  }>,
): Readonly<{
  dormantRuntime: string;
  preservedAccountId: string;
  preservedGroupId: string;
  rematerializedAccountId: string;
}>;

export function parseCandidateManifest(raw: string, manifestPath: string): PackedAuthorCandidate;

export function assertPackedAuthorCandidateInstallerArtifacts(
  candidate: PackedAuthorCandidate,
  options: Readonly<{
    manifestPath: string;
    readFileImpl?: (path: string) => Promise<Buffer>;
    lstatImpl?: typeof import('node:fs/promises').lstat;
    realpathImpl?: typeof import('node:fs/promises').realpath;
  }>,
): Promise<void>;

export function assertPackedAuthorCandidateManifestArtifacts(
  candidate: PackedAuthorCandidate,
  options: Readonly<{
    manifestPath: string;
    readFileImpl?: (path: string) => Promise<Uint8Array>;
    lstatImpl?: typeof import('node:fs/promises').lstat;
    realpathImpl?: typeof import('node:fs/promises').realpath;
  }>,
): Promise<void>;

export function loadPackedAuthorCandidateManifest(
  argv: readonly string[],
  dependencies?: Readonly<{
    cwd?: string;
    readFileImpl?: (manifestPath: string) => Promise<string | Uint8Array>;
    parseCandidateManifestImpl?: (
      raw: string,
      manifestPath: string,
    ) => PackedAuthorCandidate;
    assertCandidateArtifactsImpl?: (
      candidate: PackedAuthorCandidate,
      options: Readonly<{ manifestPath: string }>,
    ) => Promise<void>;
  }>,
): Promise<PackedAuthorCandidate>;

export function loadPackedAuthorNaturalArtifacts(
  argv: readonly string[],
  dependencies?: Readonly<{
    cwd?: string;
    createRunId?: () => string;
    readFileImpl?: (artifactPath: string) => Promise<Uint8Array>;
    lstatImpl?: typeof import('node:fs/promises').lstat;
    createPackedAuthorCandidateImpl?: (input: Readonly<{
      runId: string;
      sdkTarballPath: string;
      cliTarballPath: string;
    }>) => Promise<PackedAuthorCandidate>;
  }>,
): Promise<PackedAuthorCandidate>;

export function parseRunnerArgs(argv: readonly string[]): Readonly<{
  scenario: 'vertical-a';
  sdkTarballPath: string;
  cliTarballPath: string;
  packedNovelQaHandoffRoot?: string;
}>;

export function parsePackedNovelConnectedAccountQaHandoff(
  raw: string,
  manifestPath: string,
): PackedNovelConnectedAccountQaHandoff;

export function loadPackedNovelConnectedAccountQaHandoff(
  input: Readonly<{ manifestPath: string }>,
): Promise<PackedNovelConnectedAccountQaHandoff>;

export function createPackedNovelConnectedAccountQaHandoff(
  input: Readonly<{
    outputRoot: string;
    candidate: PackedAuthorCandidate;
    archiveBytes: Uint8Array;
    pluginArtifact: Readonly<{
      label: 'initial-v1';
      pluginId: 'acme.vertical-a';
      version: '1.0.0';
      integrity: string;
      size: number;
    }>;
    stages: readonly Readonly<{ id: string; ok?: boolean }>[];
  }>,
): Promise<PackedNovelConnectedAccountQaHandoff>;

export function cleanupPackedNovelConnectedAccountQaHandoff(
  input: Readonly<{ manifestPath: string }>,
): Promise<Readonly<{
  disposition: 'removed';
  runId: string;
}>>;

export function assertPackedNovelConnectedAccountQaCandidate(
  input: Readonly<{
    handoff: PackedNovelConnectedAccountQaHandoff;
    candidate: PackedAuthorCandidate;
  }>,
): PackedNovelConnectedAccountQaHandoff;

export function startPackedNovelConnectedAccountAuthorizationServer():
Promise<Readonly<{
  origin: string;
  caCertificatePath: string;
  callbackUrl: 'http://localhost:1455/auth/callback';
  getRequestSummary(): Readonly<{
    authorizationRedirects: number;
    rejectedRequests: number;
  }>;
  close(): Promise<void>;
}>>;

export function sha512Sri(bytes: Uint8Array): string;

export type PackedCliCommandEnvelope = Readonly<{
  ok: boolean;
  kind: string;
  data?: Readonly<{
    pluginId?: string;
    desiredGeneration?: string | null;
    appliedGeneration?: string | null;
    pendingSurfaces?: readonly unknown[];
    plugin?: Readonly<{
      version?: string;
      install?: Readonly<{
        trust?: Readonly<{ state?: string }>;
      }>;
    }>;
  }>;
  error?: Readonly<{
    code?: string;
    causeCode?: string;
    pendingChangeId?: string;
    review?: PackedPluginInstallReview;
  }>;
}>;

export type PackedPluginInstallReview = Readonly<{
  pluginId: string;
  displayName: string;
  version: string;
  source: Readonly<{
    kind: 'path' | 'archive' | 'npm';
    locator: string;
    integrity?: string;
  }>;
  executableRealms: readonly ('daemon' | 'reactNative')[];
  requiredHostAccess: readonly Readonly<{
    id: string;
    capability: string;
    reason: string;
  }>[];
  optionalHostAccess: readonly Readonly<{
    id: string;
    capability: string;
    reason: string;
  }>[];
}>;

export type PackedPluginInstallDecisionOutcome = Readonly<{
  kind: 'committed' | 'failed' | 'conflict' | 'expired' | 'cancelled' | 'unavailable' | 'outcomeUnknown' | 'busy';
  pluginId?: string;
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
  pendingSurfaces?: readonly string[];
  code?: string;
  message?: string;
}>;

export type VerticalAMarkerEvent = Readonly<{
  kind: string;
  version: string;
  activationInstanceId: string;
  pid: number;
}>;

export function assertPackedPackageIdentity(
  packageManifest: unknown,
  artifact: PackedAuthorCandidate['sdk'] | PackedAuthorCandidate['cli'],
  label: string,
): void;

export function assertPackedCliEntrypoint(
  packageManifest: unknown,
  cliArtifact: PackedAuthorCandidate['cli'],
): void;

export function assertVerticalANotificationLifecycleEvidence(
  evidence: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>;

export function readPackedPackageManifest(
  tarballPath: string,
  extractionRoot: string,
): Promise<Record<string, unknown>>;

export function startCandidateRegistry(params: Readonly<{
  sdk: PackedAuthorCandidate['sdk'];
  sdkBytes: Uint8Array;
  packageManifest?: Record<string, unknown>;
}>): Promise<Readonly<{
  origin: string;
  close(): Promise<void>;
}>>;

export function configureVerticalAManifest(params: Readonly<{
  manifest: Readonly<Record<string, unknown>>;
  version: string;
  pluginId: string;
  fetchOrigin: string;
  connectedAccountOrigin?: string;
}>): Readonly<Record<string, unknown>>;

export function configureDescriptorOnlyManifest(params: Readonly<{
  manifest: Readonly<Record<string, unknown>>;
  version: string;
}>): Readonly<Record<string, unknown>>;

export function configureVerticalAPlugin(params: Readonly<{
  pluginRoot: string;
  pluginId: string;
  version: string;
  packageName?: string;
  failActivation?: boolean;
  fetchOrigin: string;
  connectedAccountOrigin?: string;
}>): Promise<void>;

export function readVerticalAMarkerEvents(markerPath: string): Promise<readonly VerticalAMarkerEvent[]>;

export function findLatestMarkerEvent(
  events: readonly VerticalAMarkerEvent[],
  kind: string,
  version: string,
): VerticalAMarkerEvent | null;

export function waitForActivationCleanup(params: Readonly<{
  markerPath: string;
  version: string;
  activationInstanceId: string;
  timeoutMs?: number;
}>): Promise<VerticalAMarkerEvent>;

export function waitForActivationCleanupFailure(params: Readonly<{
  markerPath: string;
  version: string;
  activationInstanceId: string;
  timeoutMs?: number;
}>): Promise<VerticalAMarkerEvent>;

export function assertVerticalAScmInstalledProbe(params: Readonly<{
  probe: unknown;
  backendId: string;
  hostingProviderId: string;
}>): Readonly<{
  generation: number;
  backendId: string;
  hostingProviderId: string;
  authService: unknown;
  clientPreference: unknown;
  statusErrorCode: string;
  repositoryAuth: unknown;
  browserTargetId: string;
  browserActionIds: readonly string[];
}>;

export function assertVerticalAScmUninstalledProbe(params: Readonly<{
  probe: unknown;
  backendId: string;
  hostingProviderId: string;
}>): Readonly<{
  generation: number;
  backendId: string;
  hostingProviderId: string;
  backend: 'absent';
  hostingProvider: 'absent';
  authoritativeFamiliesPresent: true;
}>;

export function runPackedCli(params: Readonly<{
  cliEntrypoint: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
}>): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>>;

export function restartPackedDaemonForUpdatedTrustStore(params: Readonly<{
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runCli?: typeof runPackedCli;
}>): ReturnType<typeof runPackedCli>;

export function runPackedCliJson(
  params: Readonly<{
    cliEntrypoint: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
  }>,
  expectedKind: string,
): Promise<PackedCliCommandEnvelope>;

export function runPackedReviewedPluginInstall(params: Readonly<{
  cliEntrypoint: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  decideInstallReview: (params: Readonly<{
    happyHomeDir: string;
    pendingChangeId: string;
    review: PackedPluginInstallReview;
  }>) => Promise<PackedPluginInstallDecisionOutcome>;
  runCli?: typeof runPackedCli;
}>): Promise<Readonly<{
  pendingChangeId: string;
  review: PackedPluginInstallReview;
  change: PackedPluginInstallDecisionOutcome;
}>>;

export function parseJsonEnvelope(stdout: string, label: string): PackedCliCommandEnvelope;

export function parseSuccessfulCommandEnvelope(
  stdout: string,
  expectedKind: string,
): PackedCliCommandEnvelope;

export function sanitizePackedAuthorArtifactEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function assertPackedDaemonRuntimeIdentity(params: Readonly<{
  installedCliPackageRoot: string;
  candidateVersion: string;
  daemonState: Readonly<{
    pid?: number | null;
    startedWithCliVersion?: string | null;
  }>;
  expectedDaemonPid: number;
  runtime: Readonly<{
    execPath?: string;
    argv?: readonly string[];
  }> | null | undefined;
}>): Promise<Readonly<{
  pid: number;
  executable: string;
  entrypoint: string;
  packageRelativeEntrypoint: 'package-dist/index.mjs' | 'dist/index.mjs';
  cliVersion: string;
}>>;

export function materializePackedCli(params: Readonly<{
  cliArtifact: PackedAuthorCandidate['cli'];
  installRoot: string;
  env?: NodeJS.ProcessEnv;
  runImpl?: (
    command: string,
    args: readonly string[],
    options: Readonly<{
      cwd: string;
      env: NodeJS.ProcessEnv;
    }>,
  ) => Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>>;
}>): Promise<string>;

export function runVerticalA(
  candidate: PackedAuthorCandidate,
  options: Readonly<{
    captureLayerResultsOnFailure?: boolean;
    packedNovelQaHandoffRoot?: string;
    baseEnv: NodeJS.ProcessEnv;
    prepareHome: (params: Readonly<{ happyHomeDir: string }>) => Promise<Record<string, string | undefined>>;
    decideInstallReview: (params: Readonly<{
      happyHomeDir: string;
      pendingChangeId: string;
      review: PackedPluginInstallReview;
    }>) => Promise<PackedPluginInstallDecisionOutcome>;
    probeScm: (params: Readonly<{
      phase: 'installed' | 'uninstalled';
      happyHomeDir: string;
      cwd: string;
      pluginId: string;
      backendId: string;
      hostingProviderId: string;
    }>) => Promise<Readonly<{
      projection: unknown;
      status?: unknown;
      repository?: unknown;
    }>>;
    probeRetainedCapabilities: (params: Readonly<{
      phase: 'installed' | 'uninstalled';
      happyHomeDir: string;
      pluginId: string;
    }>) => Promise<Readonly<{
      projection: unknown;
      structuredResolution: unknown;
      structuredAction?: unknown;
    }>>;
    probeConnectedAccounts: (params: Readonly<{
      phase:
        | 'installed'
        | 'builtinMultimode'
        | 'builtinMultimodeCleanup'
        | 'restarted'
        | 'establishedOperations'
        | 'directDelete'
        | 'watchRematerialize'
        | 'watchRestore'
        | 'prepareDormancy'
        | 'dormant'
        | 'reEnabled'
        | 'replaced'
        | 'uninstalled';
      happyHomeDir: string;
      pluginId: string;
      service: Readonly<{ pluginId: string; localId: string }>;
      configuredOrigin: string;
      staleConfiguredOrigin: string;
      oauthAttemptId?: string;
      oauthCallbackUrl?: string;
      oauthState?: string;
      deviceAttemptId?: string;
      builtinAccountId?: string;
    }>) => Promise<Readonly<{
      begin?: unknown;
      initialConfigurationAdmission?: unknown;
      configurationCommitted?: unknown;
      beginStaleConfiguration?: unknown;
      staleConfigurationCommitted?: unknown;
      staleConfigurationSubmit?: unknown;
      configurationRestored?: unknown;
      qualifiedAccountsCapability?: unknown;
      submit?: unknown;
      beginAccountB?: unknown;
      submitAccountB?: unknown;
      beginReconnectAccountA?: unknown;
      submitReconnectAccountA?: unknown;
      qualifiedGroup?: unknown;
      qualifiedGroupAfterReconnect?: unknown;
      beginOutcomeUnknown?: unknown;
      submitOutcomeUnknown?: unknown;
      beginCancellation?: unknown;
      cancellation?: unknown;
      beginLateResult?: unknown;
      cancelLateResult?: unknown;
      lateResult?: unknown;
      beginOAuthConfiguration?: unknown;
      oauthConfigurationCommitted?: unknown;
      beginOAuthStart?: unknown;
      beginOAuth?: unknown;
      oauthAuthorization?: unknown;
      beginDeviceConfiguration?: unknown;
      deviceConfigurationCommitted?: unknown;
      continueDeviceStart?: unknown;
      continueDevice?: unknown;
      completeOAuth?: unknown;
      resumeDevice?: unknown;
      devicePolls?: unknown;
      deviceFinal?: unknown;
      deviceAccountConfiguration?: unknown;
      statusLifecycle?: unknown;
      refreshLifecycle?: unknown;
      quotaLifecycle?: unknown;
      revokeLifecycle?: unknown;
      directDeleteLifecycle?: unknown;
      binding?: unknown;
      group?: unknown;
      account?: unknown;
      runtime?: unknown;
    }>>;
    probeExternalSessions: (params: Readonly<{
      phase: 'installed' | 'restarted' | 'replaced' | 'uninstalled';
      happyHomeDir: string;
      agentId: string;
      source: Readonly<Record<string, unknown>>;
      candidateCursor?: string;
      tailCursor?: string;
      sessionId?: string;
    }>) => Promise<Record<string, unknown>>;
    probeNotifications: (params: Readonly<{
      phase:
        | 'configure'
        | 'credential-invalid'
        | 'credential-valid'
        | 'policy-disabled'
        | 'policy-enabled';
      happyHomeDir: string;
      pluginId: string;
    }>) => Promise<unknown>;
  }>,
): Promise<PackedAuthorVerticalAResult>;
