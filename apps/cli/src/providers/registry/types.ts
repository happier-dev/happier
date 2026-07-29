import type {
  AssessedProviderEndpoint,
  CustomProviderTemplateV1,
  ProviderConnectionId,
  ProviderConnectionV1,
  ProviderContributionV1,
  ProviderErrorCodeV1,
  ProviderSettingsParseDiagnosticV1,
  ProviderWireProtocol,
  QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

import type {
  ResolvedContributionProvenance,
  ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedFirstPartyManagedProviderFacet } from '@/providers/managed/types';

export type ProviderContributionRegistryView = Readonly<{
  providersByContributionKey: ReadonlyMap<string, ResolvedProviderContribution>;
}>;

export type ProviderEndpointDnsEvidence = ReadonlyMap<string, readonly string[]>;

export type ResolvedProviderEndpointSource =
  | 'machine_override'
  | 'account_override'
  | 'contribution'
  | 'contribution_local_candidate'
  | 'custom';

export type ResolvedProviderConnectionEndpoint = Readonly<{
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  publicHeaders: Readonly<Record<string, string>>;
  source: ResolvedProviderEndpointSource;
  machineOverrideApplied: boolean;
  normalizedUrl: string;
  locality: AssessedProviderEndpoint['locality'];
  endpointScope: AssessedProviderEndpoint['scope'];
  resolvedAddresses: readonly string[];
  nonPublicAddresses: readonly string[];
}>;

export type ResolvedProviderConnectionSource =
  | Readonly<{
      kind: 'contribution';
      contributionKey: string;
      pluginId: string;
      provenance: ResolvedContributionProvenance;
      definition: ProviderContributionV1;
    }>
  | Readonly<{
      kind: 'custom';
      template: CustomProviderTemplateV1;
    }>;

export type ResolvedProviderConnectionAuthorization =
  | Readonly<{
      authorized: true;
      grantKind: 'account' | 'machine';
      grantFingerprint: string;
      grantConfirmedAt: number;
    }>
  | Readonly<{
      authorized: false;
      errorCode: Extract<
        ProviderErrorCodeV1,
        | 'provider_connection_disabled'
        | 'provider_account_grant_stale'
        | 'provider_not_enabled_on_machine'
        | 'provider_machine_grant_stale'
      >;
    }>;

type ResolvedProviderConnectionRecordBase = Readonly<{
  v: 1;
  connectionId: ProviderConnectionId;
  machineId: string;
  connection: ProviderConnectionV1;
  displayName: string;
  source: ResolvedProviderConnectionSource;
  scope: 'account' | 'machine';
  connectionSecurityFingerprint: string;
  endpointSetFingerprint: string;
  authorization: ResolvedProviderConnectionAuthorization;
}>;

export type ResolvedProviderConnectionRecord =
  ResolvedProviderConnectionRecordBase & Readonly<
    | {
        deployment: Readonly<{ kind: 'external' }>;
        endpoints: readonly ResolvedProviderConnectionEndpoint[];
      }
    | {
        deployment: Readonly<{
          kind: 'managedLocal';
          implementationIdentity: Readonly<{
            pluginId: string;
            localId: string;
          }>;
          facet: ResolvedFirstPartyManagedProviderFacet;
          purposeBindingIntents: QualifiedConnectedAccountPurposeBindingsV1;
        }>;
        endpoints: readonly [];
        scope: 'machine';
      }
  >;

export type ProviderConnectionResolutionInvalidReason =
  | 'invalid_connection_id'
  | 'invalid_machine_id'
  | 'unknown_endpoint_override'
  | 'managed_deployment_unavailable'
  | 'managed_purpose_bindings_invalid';

export type ProviderConnectionEndpointUnresolvedReason =
  | 'endpoint_resolution_required'
  | 'local_candidate_required'
  | 'endpoint_invalid';

type ResolutionDiagnostics = Readonly<{
  diagnostics: readonly ProviderSettingsParseDiagnosticV1[];
}>;

export type ProviderConnectionResolution =
  | (ResolutionDiagnostics & Readonly<{
      status: 'resolved';
      connectionId: ProviderConnectionId;
      record: ResolvedProviderConnectionRecord;
    }>)
  | (ResolutionDiagnostics & Readonly<{
      status: 'source_unavailable';
      connectionId: ProviderConnectionId;
      contributionKey: string;
      connection: ProviderConnectionV1;
    }>)
  | (ResolutionDiagnostics & Readonly<{
      status: 'deleted';
      connectionId: ProviderConnectionId;
      tombstone: Readonly<{
        v: 1;
        id: ProviderConnectionId;
        contributionKey: string | null;
        lastDisplayName: string;
        deletedAt: number;
      }>;
    }>)
  | (ResolutionDiagnostics & Readonly<{
      status: 'missing';
      connectionId: ProviderConnectionId;
    }>)
  | (ResolutionDiagnostics & Readonly<{
      status: 'invalid';
      connectionId: string;
      reason: ProviderConnectionResolutionInvalidReason;
    }>)
  | (ResolutionDiagnostics & Readonly<{
      status: 'endpoint_unresolved';
      connectionId: ProviderConnectionId;
      reason: ProviderConnectionEndpointUnresolvedReason;
    }>);

export type ResolveProviderConnectionForMachineInput = Readonly<{
  connectionId: string;
  machineId: string;
  accountSettings: unknown;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ReadonlyMap<
    ProviderConnectionId,
    ReadonlyMap<string, string>
  >;
}>;
