import type {
  ProviderErrorV1,
  AssessedProviderEndpoint,
  ProviderObservationAuthorizationFingerprintV1,
  ProviderCatalogParserV1,
  ProviderProbeRequestFingerprintV1,
  ProviderWireProtocol,
  ResolvedProviderManagedRuntimeDeclarationV1,
  QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

import type { ProviderProbeCredential } from './client';
import type { ProviderOperationLifetime } from '../operationLifetime';
import type {
  ProviderContributionRegistryView,
  ProviderEndpointDnsEvidence,
} from '../registry/types';
import type { readProviderSettingsForCli } from '../settings/read';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ResolveManagedProviderPurposeBindingIntent } from '../managed/resolvePurposeBindingSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { ManagedProviderInvocationAccountAuthority } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import type { ResolveSharedManagedProviderGatewayBinding } from '@/plugins/runtime/invocation/services/managedServicesAdapter';

/** One already-parsed Account settings generation owned by a bulk operation. */
export type ProviderProbeAccountSettingsBasis = Readonly<{
  scopeKey: string;
  settingsVersion: number;
  providerConnectionsCatalog: ActiveAccountSettingsSnapshot['providerConnectionsCatalog'];
  accountSettings: ActiveAccountSettingsSnapshot['settings'];
  settingsRead: ReturnType<typeof readProviderSettingsForCli>;
}>;

/** Exact immutable facts and wall budget for one admitted probe operation. */
export type ProviderProbeOperationScope = Readonly<{
  registry?: ProviderContributionRegistryView;
  accountSettingsBasis?: ProviderProbeAccountSettingsBasis;
  /** Fresh evidence owned by this immutable bulk operation, never a cache. */
  dnsEvidenceByConnectionId?: ReadonlyMap<string, ProviderEndpointDnsEvidence>;
  lifetime: ProviderOperationLifetime;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  isAccountCurrent?: () => boolean | Promise<boolean>;
  savedSecretOperationContext?: SavedSecretOperationContextV1 | null;
  resolveSavedSecretMaterializer?: (signal?: AbortSignal) => Promise<SavedSecretMaterializerV1>;
  /** Null refuses explicit Account work without issued managed custody. */
  managedRuntimeAccount?: (ManagedProviderInvocationAccountAuthority & Readonly<{
    resolveSharedGateway: ResolveSharedManagedProviderGatewayBinding;
  }>) | null;
}>;

export type ProviderProbeCredentialLease = Readonly<{
  credential: ProviderProbeCredential;
  redact(value: string): string;
  containsSensitiveValue(value: string): boolean;
  close(): void;
}>;

export type ProviderProbeCredentialResolution =
  | Readonly<{ ok: true; lease: ProviderProbeCredentialLease }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

type ProviderExternalProbeAuthorizationRequestBase = Readonly<{
  deployment?: 'external';
  connectionId: string;
  machineId: string;
  endpointTemplateId: string;
  endpointUrl: string;
  protocol: ProviderWireProtocol;
  path: string;
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1;
}>;

export type ProviderExternalProbeAuthorizationRequest = ProviderExternalProbeAuthorizationRequestBase & Readonly<
  | { purpose?: 'catalog'; parser: ProviderCatalogParserV1 }
  | { purpose: 'usage'; usageSourceId: string; parser: string }
>;

export type ProviderManagedProbeAuthorizationRequest = Readonly<{
  deployment: 'managedLocal';
  connectionId: string;
  machineId: string;
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  managedRuntime: ResolvedProviderManagedRuntimeDeclarationV1;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  sourceRegistryVersion: string;
  path: string;
  parser: ProviderCatalogParserV1;
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1;
}>;

export type ProviderProbeAuthorizationRequest =
  | ProviderExternalProbeAuthorizationRequest
  | ProviderManagedProbeAuthorizationRequest;

export type ProviderProbeAuthorizationSuccess<TTicket, TCredentialRef> = Readonly<{
  ok: true;
  ticket: TTicket;
  observationAuthorizationFingerprint: ProviderObservationAuthorizationFingerprintV1;
  credentialRef: TCredentialRef | null;
}>;

export type ProviderProbeAuthorizationResult<TTicket, TCredentialRef> =
  | ProviderProbeAuthorizationSuccess<TTicket, TCredentialRef>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export class ProviderProbeDestinationAuthorizationError extends Error {
  readonly error: ProviderErrorV1;
  constructor(error: ProviderErrorV1) {
    super(error.code);
    this.name = 'ProviderProbeDestinationAuthorizationError';
    this.error = error;
  }
}

export class ProviderProbeCredentialResolutionError extends Error {
  readonly error: ProviderErrorV1;
  constructor(error: ProviderErrorV1) {
    super(error.code);
    this.name = 'ProviderProbeCredentialResolutionError';
    this.error = error;
  }
}

/**
 * Narrow bridge to the canonical spawn/probe authorization owner. This module
 * never reads settings, grants, or SavedSecrets and never mints tickets.
 */
export type ProviderProbeAuthorizationPort<TTicket, TCredentialRef> = Readonly<{
  authorize(
    request: ProviderProbeAuthorizationRequest,
    scope?: ProviderProbeOperationScope,
  ): Promise<ProviderProbeAuthorizationResult<TTicket, TCredentialRef>>;
  /** Already-admitted finite operations with request-local state omit this hook. */
  revalidate?(
    ticket: TTicket,
    request: ProviderProbeAuthorizationRequest,
    scope?: ProviderProbeOperationScope,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
  authorizeDestination(
    ticket: TTicket,
    request: ProviderProbeAuthorizationRequest,
    destination: AssessedProviderEndpoint,
    scope?: ProviderProbeOperationScope,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
  resolveCredential(reference: TCredentialRef, scope?: ProviderProbeOperationScope): Promise<ProviderProbeCredentialResolution>;
}>;
