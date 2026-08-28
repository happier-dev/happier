import type { InspectedTarArchiveEntry } from '@happier-dev/release-runtime/archiveExtraction';
import type {
  PackedAuthorCandidate,
} from './run-packed-author-ui-compat.mjs';

export type PackedManagedProviderRunInput = Readonly<{
  candidateManifestPath: string;
  enableOpenCodeLive: false;
  workRoot?: string;
  signal?: AbortSignal;
}>;

export type PackedManagedProviderCurrentSourceInput = Readonly<{
  mode: 'current-source';
  candidateManifestPath: null;
}>;

export type PackedManagedProviderCandidate = PackedAuthorCandidate;

export type PackedManagedProviderPreparation = Readonly<{
  currentSource?: true;
  candidate: PackedManagedProviderCandidate;
  standaloneCliArtifact: Readonly<{
    product: 'happier';
    version: string;
    os: string;
    arch: string;
    archivePath: string;
    sourceArchivePath?: string;
    sha256: string;
    extractRoot: string;
    executablePath: string;
  }>;
  cliLaunchSpec: Readonly<{
    command: string;
    args: readonly string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }>;
  wrapperExecutable: string;
  verifiedCandidateIntegrity: true;
  verifiedCandidatePackageIdentity: true;
  verifiedStandaloneCliIntegrity: true;
  verifiedStandaloneCliIdentity: true;
}>;

export type PackedManagedProviderPreparedInput =
  PackedManagedProviderRunInput
  & Readonly<{ prepared: PackedManagedProviderPreparation }>;

export type PackedManagedProviderWrapperConformanceEvidence = Readonly<{
  publicExplicitStart: boolean;
  publicCatalogProbe: boolean;
  catalogOwnerReleased: boolean;
  publicCredentialLeakObserved: boolean;
  providerAttemptedBeforeSessionDemand: boolean;
}>;

export type PackedManagedProviderSequenceEvidence = Readonly<{
  freshSession: boolean;
  agentId: 'opencode';
  canonicalSessionId: string;
  publicActivationReason: 'sessionDemand';
  connectionRevision: number;
  purposes: readonly string[];
  timeline: Readonly<{
    freshSpawnStartedAtMs: number;
    canonicalSessionRegisteredAtMs: number;
    spawnAcknowledgedAtMs: number;
    providerAttemptAtMs: number;
  }>;
  observedPorts: Readonly<Record<string, number>>;
  stockPortRequestCount: number;
  stockPortOsConnectionAttemptCount: number;
  stockListenerIdentityBefore: string;
  stockListenerIdentityAfter: string;
  preSessionDemandCredentialReleased: boolean;
  preSessionDemandUpstreamAttempted: boolean;
  upstreamAuthorizationFingerprint: string;
  managedRequestAuthOrigin: string;
  upstreamConnectTarget: string;
  promptSentinelObserved: boolean;
  upstreamRequestPath: string;
  currentCredentialRevision: string;
  currentAccessTokenFingerprint: string;
}>;

export type PackedManagedProviderActivationFailureEvidence = Readonly<{
  activationFailedBeforeAck: boolean;
  firstInputDispatched: boolean;
  providerAttempted: boolean;
  publicSessionCleanupComplete: boolean;
  sessionProviderExited: boolean;
}>;

export type PackedManagedProviderCleanupInput =
  PackedManagedProviderRunInput
  & Readonly<{
    prepared: PackedManagedProviderPreparation | null;
    runError: Error | null;
  }>;

export type PackedManagedProviderScenarioDependencies = Readonly<{
  runPackagedWrapperConformance(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderWrapperConformanceEvidence>;
  runFreshManagedSequence(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderSequenceEvidence>;
  runActivationFailureCleanupProbe(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderActivationFailureEvidence>;
  cleanup(input: PackedManagedProviderCleanupInput): Promise<void>;
}>;

export type PackedManagedProviderDependencies =
  PackedManagedProviderScenarioDependencies
  & Readonly<{
    prepareCandidate(
      input: PackedManagedProviderRunInput,
    ): Promise<PackedManagedProviderPreparation>;
  }>;

export type PackedChannelProviderLifecycleEvidence = Readonly<{
  archive: Readonly<{
    hostRuntime: 'daemonArchive';
    reviewedInstall: true;
    publicOnlyArtifact: true;
    publicDependencyClosure: true;
  }>;
  discovery: Readonly<{
    corePluginId: 'happier.channels';
    providerPluginId: 'acme.channels.out-of-tree-socket';
    actionLocalId: 'fixture/setup';
    targetSurface: 'plugin';
    coldCatalogBeforeProviderActivation: true;
    demandedActivation: true;
    caller: Readonly<{ kind: 'plugin'; pluginId: 'happier.channels' }>;
    strictInputRejectedBeforeHandler: true;
    strictResultRejectedBeforeCore: true;
  }>;
  resource: Readonly<{
    localId: 'status-v1';
    readObserved: true;
    watchSubscribed: true;
    invalidationDropped: true;
    rereadConverged: true;
  }>;
  background: Readonly<{
    startedAfterAdoption: true;
    normalizedNetworkClientObserved: true;
    socketConnectCountBeforeAdoption: 0;
    observationIngressCustodied: true;
    outboundDeliveryCustodied: true;
    historyGapReported: true;
    confirmedStopReported: true;
  }>;
  lifecycle: Readonly<{
    disableAbortedGeneration: true;
    reenableSocketCount: 1;
    daemonRestartSocketCount: 1;
    failedReplacementRetainedLkg: true;
    retiredGenerationReportInert: true;
    uninstalledCleanly: true;
  }>;
}>;

export type PackedChannelProviderScenarioDependencies = Readonly<{
  runPackedChannelProviderLifecycle(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedChannelProviderLifecycleEvidence>;
  cleanup(input: PackedManagedProviderCleanupInput): Promise<void>;
}>;

export type PackedChannelProviderDependencies =
  PackedChannelProviderScenarioDependencies
  & Readonly<{
    prepareCandidate(
      input: PackedManagedProviderRunInput,
    ): Promise<PackedManagedProviderPreparation>;
  }>;

export type PackedManagedProviderStage = Readonly<{
  id: string;
  status: 'passed';
  evidence?: unknown;
}>;

export type PackedManagedProviderVerticalResult = Readonly<{
  schemaVersion: 1;
  kind: 'packed_managed_provider_vertical';
  status: 'passed';
  candidate: Readonly<{
    runId: string;
    sdk: PackedManagedProviderCandidate['sdk'];
    cli: PackedManagedProviderCandidate['cli'];
  }>;
  standaloneCliArtifact: Readonly<{
    product: 'happier';
    version: string;
    os: string;
    arch: string;
    archivePath: string;
    sha256: string;
    executablePath: string;
    wrapperExecutable: string;
  }>;
  stages: readonly PackedManagedProviderStage[];
  blockers: readonly [];
}>;

export type PackedChannelProviderVerticalResult = Readonly<{
  schemaVersion: 1;
  kind: 'packed_channel_provider_vertical';
  status: 'passed';
  candidate: Readonly<{
    runId: string;
    sdk: PackedManagedProviderCandidate['sdk'];
    channelsProtocol: NonNullable<
      PackedManagedProviderCandidate['channelsProtocol']
    >;
    cli: PackedManagedProviderCandidate['cli'];
  }>;
  standaloneCliArtifact: Readonly<{
    product: 'happier';
    version: string;
    os: string;
    arch: string;
    archivePath: string;
    sha256: string;
    executablePath: string;
  }>;
  stages: readonly PackedManagedProviderStage[];
  blockers: readonly [];
}>;

export const PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS: readonly string[];
export const PACKED_MANAGED_PROVIDER_CANDIDATE_HANDOFF_STAGE_IDS:
  readonly string[];
export const PACKED_CHANNEL_PROVIDER_REQUIRED_STAGE_IDS: readonly string[];

export function assertPackedManagedStandaloneCliArchiveIdentity(params: Readonly<{
  archivePath: string;
  candidateCliVersion: string;
  entries: readonly InspectedTarArchiveEntry[];
  platform?: NodeJS.Platform;
  arch?: string;
}>): Readonly<{
  product: 'happier';
  version: string;
  os: string;
  arch: string;
  archiveName: string;
  artifactRootName: string;
  executableRelativePath: string;
  wrapperRelativePath: string;
}>;

export function resolvePackedManagedWrapperExecutable(params: Readonly<{
  standaloneCliExecutable: string;
  standaloneCliExtractRoot: string;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  realpathSync?: (path: string) => string;
}>): string;

export function parsePackedManagedProviderArgs(argv: readonly string[]):
  | Readonly<{ mode: 'recipe'; candidateManifestPath: null }>
  | PackedManagedProviderCurrentSourceInput
  | (PackedManagedProviderRunInput & Readonly<{ mode: 'run' | 'channel' }>);

export function buildPackedManagedProviderRecipe(params: Readonly<{
  packageRoot: string;
}>): Readonly<Record<string, unknown>>;

export function buildPackedManagedProviderEntrypointInvocation(params: Readonly<{
  packageRoot: string;
  parsed:
    | PackedManagedProviderCurrentSourceInput
    | (PackedManagedProviderRunInput & Readonly<{ mode: 'run' | 'channel' }>);
}>): Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
}>;

export function runPackedManagedProviderVertical(
  input: PackedManagedProviderRunInput,
  deps: PackedManagedProviderDependencies,
): Promise<PackedManagedProviderVerticalResult>;

export function runPackedChannelProviderVertical(
  input: PackedManagedProviderRunInput,
  deps: PackedChannelProviderDependencies,
): Promise<PackedChannelProviderVerticalResult>;
