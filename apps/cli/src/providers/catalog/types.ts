import type {
  ProviderBindingCompatibilityV1,
  ProviderBoundModelRef,
  ProviderCatalogReferenceResolutionV1,
  ProviderCatalogRuntimeStateKeyV1,
  ProviderEndpointRuntimeStateV1,
  ProviderMergedCatalogRowV1,
  ProviderModelLoadStateV1,
  ProviderRuntimeStateFileV1,
  ProviderSettingsV1,
  ProviderConnectionId,
} from '@happier-dev/protocol';

import type { ResolvedProviderConnectionRecord } from '../registry/types';

export type ProviderCatalogCompatibilityPresentation = Readonly<{
  result: ProviderBindingCompatibilityV1;
  compatibilityFingerprint: string;
}>;

export type ProviderCatalogObservationPresentation = Readonly<{
  stale: boolean;
  observedAt?: number;
  staleAt?: number;
}>;

export type ProviderCatalogAuthorizationPresentation =
  | Readonly<{ authorized: true }>
  | Extract<ResolvedProviderConnectionRecord['authorization'], { authorized: false }>;

/**
 * Presentation facts intentionally remain separate. Endpoint health is not
 * catalog freshness, and neither fact is model load state or compatibility.
 */
export type ProviderCatalogRowPresentation = Readonly<{
  compatibility: ProviderCatalogCompatibilityPresentation | null;
  endpointHealth: ProviderEndpointRuntimeStateV1 | null;
  catalog: ProviderCatalogObservationPresentation;
  loadState: ProviderModelLoadStateV1;
}>;

export type ProviderConnectionCatalogRow = Readonly<{
  ref: Extract<ProviderBoundModelRef, { providerConnectionId: string }>;
  descriptor: ProviderMergedCatalogRowV1['descriptor'];
  sources: ProviderMergedCatalogRowV1['sources'];
  confidence: ProviderMergedCatalogRowV1['confidence'];
  presentation: ProviderCatalogRowPresentation;
}>;

export type ProviderConnectionCatalog = Readonly<{
  agentTargetKey: string;
  connectionId: ProviderConnectionId;
  authorization: ProviderCatalogAuthorizationPresentation;
  providerName: string;
  connectionName: string;
  connectionRole: 'default' | 'named';
  connectionDisplayNameMode: 'automatic' | 'custom';
  manualModelPolicy: 'allowed' | 'catalog-only';
  rows: readonly ProviderConnectionCatalogRow[];
  staleRows: readonly ProviderConnectionCatalogRow[];
}>;

export type AssembleProviderConnectionCatalogInput = Readonly<{
  agentTargetKey: string;
  connection: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
  runtimeState: ProviderRuntimeStateFileV1;
  /** Exact current key, including the current authorization fingerprint. */
  catalogRuntimeKey: ProviderCatalogRuntimeStateKeyV1 | null;
  compatibilityByModelId?: ReadonlyMap<string, ProviderCatalogCompatibilityPresentation>;
  /** States already selected by the health owner for the current authorization fingerprint. */
  currentEndpointHealthByTemplateId?: ReadonlyMap<string, ProviderEndpointRuntimeStateV1>;
  /** Persisted selection retained only as a stale presentation row while authorization is unavailable. */
  currentSelectionForRecovery?: ProviderBoundModelRef;
}>;

export type ProviderCatalogModelReferenceResolution =
  | Readonly<{
      status: 'listed';
      ref: Extract<ProviderBoundModelRef, { providerConnectionId: string }>;
      row: ProviderConnectionCatalogRow;
    }>
  | Readonly<{
      status: 'not_currently_listed';
      ref: Extract<ProviderBoundModelRef, { providerConnectionId: string }>;
      descriptor: Readonly<{ id: string; name: string }>;
      provenance: Extract<ProviderCatalogReferenceResolutionV1, { status: 'not_currently_listed' }>['provenance'];
    }>
  | Readonly<{
      status: 'not_found';
      ref: Extract<ProviderBoundModelRef, { providerConnectionId: string }>;
      errorCode: 'provider_model_not_found';
    }>;

export type ProviderPickerCatalogRow = ProviderConnectionCatalogRow & Readonly<{
  visibility: 'visible' | 'hidden_agent' | 'hidden_all_agents' | 'hidden_current_selection';
}>;

export type ProviderPickerCatalogGroup = Readonly<{
  connectionId: ProviderConnectionId;
  providerName: string;
  connectionName: string;
  authorization: ProviderCatalogAuthorizationPresentation;
  rows: readonly ProviderPickerCatalogRow[];
}>;

export type ProviderPickerCatalogProjection = Readonly<{
  groups: readonly ProviderPickerCatalogGroup[];
}>;
