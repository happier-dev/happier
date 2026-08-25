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
import type { ProviderContributionRegistryView } from '../registry/types';

/** Exact registry projection and wall budget for one admitted probe operation. */
export type ProviderProbeOperationScope = Readonly<{
  registry?: ProviderContributionRegistryView;
  lifetime: ProviderOperationLifetime;
}>;

export type ProviderProbeCredentialLease = Readonly<{
  credential: ProviderProbeCredential;
  redact(value: string): string;
  close(): void;
}>;

export type ProviderProbeCredentialResolution =
  | Readonly<{ ok: true; lease: ProviderProbeCredentialLease }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export type ProviderExternalProbeAuthorizationRequest = Readonly<{
  deployment?: 'external';
  connectionId: string;
  machineId: string;
  endpointTemplateId: string;
  endpointUrl: string;
  protocol: ProviderWireProtocol;
  path: string;
  parser: ProviderCatalogParserV1;
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1;
}>;

export type ProviderManagedProbeAuthorizationRequest = Readonly<{
  deployment: 'managedLocal';
  connectionId: string;
  machineId: string;
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  managedRuntime: ResolvedProviderManagedRuntimeDeclarationV1;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
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
  revalidate(
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
  resolveCredential(reference: TCredentialRef): Promise<ProviderProbeCredentialResolution>;
}>;
