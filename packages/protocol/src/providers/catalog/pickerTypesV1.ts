import type { ProviderBindingCompatibilityV1 } from '../compatibility/v1.js';
import type { ProviderBoundModelRef } from '../selection/v1.js';
import type { ProviderMergedCatalogRowV1 } from './merge.js';
import type { ProviderEndpointRuntimeStateV1, ProviderModelLoadStateV1 } from '../runtimeState/v1.js';
import type { ProviderErrorCodeV1 } from '../errors.js';
import type { ProviderModelPickerSourceKind } from './modelPickerVisibility.js';
import type { ProviderConnectionId } from '../ids.js';

export type ProviderCatalogCompatibilityPresentation = Readonly<{ result: ProviderBindingCompatibilityV1; compatibilityFingerprint: string }>;
export type ProviderCatalogObservationPresentation = Readonly<{ stale: boolean; observedAt?: number; staleAt?: number }>;
export type ProviderCatalogAuthorizationPresentation = Readonly<{ authorized: true }> | Readonly<{ authorized: false; errorCode: ProviderErrorCodeV1 }>;
export type ProviderCatalogRowPresentation = Readonly<{
  compatibility: ProviderCatalogCompatibilityPresentation | null;
  endpointHealth: ProviderEndpointRuntimeStateV1 | null;
  catalog: ProviderCatalogObservationPresentation;
  loadState: ProviderModelLoadStateV1;
}>;
export type ProviderConnectionCatalogRow = Readonly<{
  ref: Extract<ProviderBoundModelRef, { providerConnectionId: string }>;
  descriptor: ProviderMergedCatalogRowV1['descriptor']; sources: ProviderMergedCatalogRowV1['sources'];
  confidence: ProviderMergedCatalogRowV1['confidence']; presentation: ProviderCatalogRowPresentation;
}>;
export type ProviderConnectionCatalog = Readonly<{
  agentTargetKey: string; connectionId: ProviderConnectionId; authorization: ProviderCatalogAuthorizationPresentation;
  providerName: string; connectionName: string; connectionRole: 'default' | 'named';
  connectionDisplayNameMode: 'automatic' | 'custom'; manualModelPolicy: 'allowed' | 'catalog-only';
  sourceKind: ProviderModelPickerSourceKind; rows: readonly ProviderConnectionCatalogRow[]; staleRows: readonly ProviderConnectionCatalogRow[];
}>;
export type ProviderPickerCatalogRow = ProviderConnectionCatalogRow & Readonly<{
  visibility: 'visible' | 'hidden_agent' | 'hidden_all_agents' | 'hidden_current_selection';
}>;
export type ProviderPickerCatalogGroup = Readonly<{
  connectionId: ProviderConnectionId; providerName: string; connectionName: string;
  authorization: ProviderCatalogAuthorizationPresentation; rows: readonly ProviderPickerCatalogRow[];
}>;
export type ProviderPickerHiddenSource = Readonly<{ connectionId: ProviderConnectionId; providerName: string; connectionName: string; modelCount: number }>;
export type ProviderPickerCatalogProjection = Readonly<{ groups: readonly ProviderPickerCatalogGroup[]; hiddenSources: readonly ProviderPickerHiddenSource[] }>;
