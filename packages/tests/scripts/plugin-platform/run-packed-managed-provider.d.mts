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

export type PackedManagedProviderCandidate = PackedAuthorCandidate;

export type PackedManagedProviderPreparation = Readonly<{
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
  tokenFreeReadiness: boolean;
  preActivationLookupRefused: boolean;
  preActivationCredentialReleased: boolean;
  preActivationUpstreamAttempted: boolean;
}>;

export type PackedManagedProviderSequenceEvidence = Readonly<{
  freshSession: boolean;
  agentId: 'opencode';
  canonicalSessionIdBeforeWebhook: string | null;
  canonicalSessionId: string;
  purposes: readonly string[];
  capabilityScopeDigests: readonly string[];
  timeline: Readonly<{
    freshSpawnStartedAtMs: number;
    canonicalSessionRegisteredAtMs: number;
    capabilitiesActivatedAtMs: number;
    canonicalWebhookAcknowledgedAtMs: number;
    spawnAcknowledgedAtMs: number;
    agentRequestAuthLookupAtMs: number;
    agentRequestAuthLookupCompletedAtMs: number;
    managedRequestAuthLookupAtMs: number;
    managedRequestAuthLookupCompletedAtMs: number;
    providerAttemptAtMs: number;
  }>;
  observedPorts: Readonly<Record<string, number>>;
  stockPortRequestCount: number;
  stockPortOsConnectionAttemptCount: number;
  stockListenerIdentityBefore: string;
  stockListenerIdentityAfter: string;
  preActivationCredentialReleased: boolean;
  preActivationUpstreamAttempted: boolean;
  preActivationAgentCapabilityPresent: boolean;
  managedLeaseCredentialRevision: string;
  managedLeaseAccessTokenFingerprint: string;
  upstreamAuthorizationFingerprint: string;
  managedRequestAuthOrigin: string;
  managedConnectionSecurityFingerprint: string;
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
  wrapperStopped: boolean;
  capabilityRetired: boolean;
  materializationRemoved: boolean;
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

export const PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS: readonly string[];

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
  | (PackedManagedProviderRunInput & Readonly<{ mode: 'run' }>);

export function buildPackedManagedProviderRecipe(params: Readonly<{
  packageRoot: string;
}>): Readonly<Record<string, unknown>>;

export function runPackedManagedProviderVertical(
  input: PackedManagedProviderRunInput,
  deps: PackedManagedProviderDependencies,
): Promise<PackedManagedProviderVerticalResult>;
