import type { ProviderBoundModelRef, ProviderCatalogReferenceResolutionV1, ProviderCatalogRuntimeStateKeyV1,
  ProviderEndpointRuntimeStateV1, ProviderRuntimeStateFileV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { ResolvedProviderConnectionRecord } from '../registry/types';
import type { ProviderCatalogCompatibilityPresentation, ProviderConnectionCatalogRow } from '@happier-dev/protocol/providers/catalog/pickerTypesV1';
export type { ProviderCatalogCompatibilityPresentation, ProviderCatalogObservationPresentation,
  ProviderCatalogAuthorizationPresentation, ProviderCatalogRowPresentation, ProviderConnectionCatalogRow,
  ProviderConnectionCatalog, ProviderPickerCatalogRow, ProviderPickerCatalogGroup, ProviderPickerHiddenSource,
  ProviderPickerCatalogProjection } from '@happier-dev/protocol/providers/catalog/pickerTypesV1';

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
  /**
   * Persisted selection retained as a current-only stale presentation row when
   * the assembled catalog cannot represent it: authorization is unavailable, or
   * the two-sided freeform policy makes catalog membership not the authority.
   */
  currentSelectionForRecovery?: ProviderBoundModelRef;
  /**
   * Whether the target Agent accepts model ids the Provider catalog never lists.
   * Required with `currentSelectionForRecovery` for the freeform retention rule;
   * omitted it defaults to the closed side.
   */
  agentSupportsFreeformModelIds?: boolean;
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
