import type {
  AccountSettings,
  CustomProviderTemplateV1,
  PluginContributionIdentityV1,
  ProviderDiscoveryCandidateV1,
  ProviderErrorV1,
  ProviderLocalInstallationSummaryV1,
  QualifiedConnectedAccountPurposeBindingsV1,
  SavedSecret,
} from '@happier-dev/protocol';
import type { ManagedProviderStartRequest } from '@happier-dev/plugin-sdk/providers';
import type {
  DaemonProviderConnectionMutationRequestV1,
  DaemonProviderAgentCompatibilitySummaryV1,
  DaemonProviderConnectionsDescribeResponseV1,
  DaemonProviderConnectionViewV1,
  DaemonProviderModelSettingsMutationRequestV1,
} from '@happier-dev/protocol/rpc';

import type {
  ProviderConnectionResolution,
  ProviderContributionRegistryView,
  ProviderEndpointDnsEvidence,
} from '@/providers/registry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ProviderOperationLifetime } from '@/providers/operationLifetime';
import type { ResolveManagedProviderPurposeBindingIntent } from '@/providers/managed/resolvePurposeBindingSnapshot';

type DescribeSuccess = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;

export type ProviderConnectionView = DaemonProviderConnectionViewV1;
export type ProviderConnectionRuntimeSummary = ProviderConnectionView['runtime'];
export type ProviderConnectionRuntimeProjection = Readonly<{
  summary: ProviderConnectionRuntimeSummary;
  probeObservationIdentity: ProviderConnectionView['probeObservationIdentity'];
}>;

export type ProviderConnectionServiceResult<T extends object> =
  | Readonly<{ status: 'success' } & T>
  | Readonly<{ status: 'error'; error: ProviderErrorV1 }>;

export type ProviderConnectionCreateInput =
  | Readonly<{
      action: 'createContribution'; machineId: string; connectionId: string;
      contributionKey: string; displayName: string | null; savedSecretId: string | null; enable: boolean;
      authoringReview?: Extract<DaemonProviderConnectionMutationRequestV1, { action: 'createContribution' }>['authoringReview'];
      preparedSavedSecret?: Readonly<{ id: string; record: SavedSecret }>;
    }>
  | Readonly<{
      action: 'createCustom'; machineId: string; connectionId: string;
      template: CustomProviderTemplateV1; savedSecretId: string | null; enable: boolean;
      manualModels?: readonly Readonly<{ id: string; name?: string }>[];
      preparedSavedSecret?: Readonly<{ id: string; record: SavedSecret }>;
    }>;

export type ProviderDetectedEnableInput = Readonly<{
  action: 'enableDetected';
  machineId: string;
  connectionId: string;
  candidateId: string;
  displayName: string | null;
  savedSecretId: string | null;
}>;

type ProviderManualAddRequest = Extract<
  DaemonProviderModelSettingsMutationRequestV1,
  { action: 'manualAdd' }
>;

export type ProviderModelSettingsMutationIntent =
  | Readonly<ProviderManualAddRequest & {
      expectedManualSource:
        | Readonly<{ kind: 'custom' }>
        | Readonly<{ kind: 'contribution'; contributionKey: string }>;
    }>
  | Exclude<DaemonProviderModelSettingsMutationRequestV1, ProviderManualAddRequest>;

export type ProviderConnectionServiceSnapshot = Readonly<{
  accountSettings: AccountSettings;
  /** Retained source bytes for Provider legacy/malformed-subtree recovery. */
  rawAccountSettings: Readonly<Record<string, unknown>>;
  /**
   * Immutable Provider projection captured from one authoritative runtime
   * generation. A mutation may reload Account Settings, but must not replace
   * this registry decision before it completes.
   */
  registry: ProviderContributionRegistryView;
  registryGeneration?: string;
}>;

export type ProviderConnectionRegistryProjection = Readonly<{
  registry: ProviderContributionRegistryView;
  /** Present for production lease projections; fixture seams may omit it. */
  generation?: string;
}>;

/**
 * A Provider description projects runtime facts from the same resolved
 * Account-settings snapshot as its connection facts.
 */
export type ProviderConnectionRuntimeSummaryInput = Readonly<{
  connectionId: string;
  machineId: string;
  accountSettings: ProviderConnectionServiceSnapshot['accountSettings'];
  registry: ProviderConnectionServiceSnapshot['registry'];
  dnsEvidence: ProviderEndpointDnsEvidence;
  resolution: Extract<ProviderConnectionResolution, { status: 'resolved' }>;
  /** The public description/mutation budget that admitted this runtime read. */
  lifetime: ProviderOperationLifetime;
}>;

export type ProviderConnectionServiceDeps = Readonly<{
  machineId: string;
  featureGate: Readonly<{ isEnabled(featureId: 'providers' | 'providers.localDiscovery'): boolean }>;
  loadSnapshot(
    registryProjection?: ProviderConnectionRegistryProjection,
  ): Promise<ProviderConnectionServiceSnapshot>;
  updateAccountSettings(
    mutate: (
      raw: Readonly<Record<string, unknown>>,
    ) => Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>> | void>;
  collectDnsEvidence(input: Readonly<{
    accountSettings: Readonly<Record<string, unknown>>;
    connectionId: string;
    machineId: string;
    registry: ProviderContributionRegistryView;
    /** The public mutation/description budget that admitted this DNS work. */
    lifetime: ProviderOperationLifetime;
  }>): Promise<ProviderEndpointDnsEvidence>;
  resolveConnection(input: Readonly<{
    accountSettings: Readonly<Record<string, unknown>>;
    connectionId: string;
    machineId: string;
    registry: ProviderContributionRegistryView;
    dnsEvidence: ProviderEndpointDnsEvidence;
  }>): ProviderConnectionResolution;
  runtimeSummary(input: ProviderConnectionRuntimeSummaryInput): Promise<ProviderConnectionRuntimeProjection>;
  acquireCompatibilityProjection?(): Readonly<{
    project(connection: Extract<ProviderConnectionResolution, { status: 'resolved' }>['record']): readonly DaemonProviderAgentCompatibilitySummaryV1[];
    release(): Promise<void>;
  }> | null;
  discoveryCandidates?(input: Readonly<{
    machineId: string;
    registry: ProviderContributionRegistryView;
    connections: readonly ProviderConnectionView[];
  }>): Promise<readonly ProviderDiscoveryCandidateV1[]>;
  localInstallations?(input: Readonly<{
    machineId: string;
    registry: ProviderContributionRegistryView;
    candidates: readonly ProviderDiscoveryCandidateV1[];
  }>): Promise<readonly ProviderLocalInstallationSummaryV1[]>;
  /**
   * The one authoritative lease for an executable explicit-start operation.
   * Production composes this from the plugin runtime; fixtures may omit it.
   */
  acquireManagedProviderRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
  startManagedProviderRuntime?(input: Readonly<{
    contributionKey: string;
    identity: PluginContributionIdentityV1;
    request: Extract<ManagedProviderStartRequest, { reason: 'explicitStartLocal' }>;
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
    isAuthorizationCurrent(): boolean;
    revalidateAuthorization(): Promise<boolean>;
    /** Borrowed from the enclosing start operation; the caller releases it. */
    runtimeRegistryLease?: PluginRuntimeRegistryLease;
  }>): Promise<Readonly<{ status: 'detecting' | 'running' }>>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  refreshOnEnable?(input: Readonly<{
    connectionId: string;
    machineId: string;
  }>, trigger: 'enable'): Promise<unknown>;
  now(): number;
}>;

export type ProviderConnectionDescription = Omit<DescribeSuccess, 'status'>;
