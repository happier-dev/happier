import type {
  CustomProviderTemplateV1,
  ProviderDiscoveryCandidateV1,
  ProviderErrorV1,
  ProviderLocalInstallationSummaryV1,
  SavedSecret,
} from '@happier-dev/protocol';
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
  accountSettings: Readonly<Record<string, unknown>>;
  registry: ProviderContributionRegistryView;
}>;

export type ProviderConnectionServiceDeps = Readonly<{
  machineId: string;
  featureGate: Readonly<{ isEnabled(featureId: 'providers' | 'providers.localDiscovery' | 'localServices.managed'): boolean }>;
  loadSnapshot(): Promise<ProviderConnectionServiceSnapshot>;
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
  }>): Promise<ProviderEndpointDnsEvidence>;
  resolveConnection(input: Readonly<{
    accountSettings: Readonly<Record<string, unknown>>;
    connectionId: string;
    machineId: string;
    registry: ProviderContributionRegistryView;
    dnsEvidence: ProviderEndpointDnsEvidence;
  }>): ProviderConnectionResolution;
  runtimeSummary(input: Readonly<{
    connectionId: string;
    machineId: string;
    resolution: Extract<ProviderConnectionResolution, { status: 'resolved' }>;
  }>): Promise<ProviderConnectionRuntimeProjection>;
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
  startManaged?(input: Readonly<{
    machineId: string;
    contributionKey: string;
    pluginId: string;
    providerName: string;
    lookupNames: readonly string[];
    fixedArgs: readonly string[];
  }>): Promise<Readonly<{ status: 'detecting' | 'running' }>>;
  refreshOnEnable?(input: Readonly<{
    connectionId: string;
    machineId: string;
  }>, trigger: 'enable'): Promise<unknown>;
  now(): number;
}>;

export type ProviderConnectionDescription = Omit<DescribeSuccess, 'status'>;
