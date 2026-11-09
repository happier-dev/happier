import axios from '@/api/client/credentialAxios';
import type { AxiosRequestConfig } from 'axios';
import { createHomeCredentialDestinationV1, isHomeCredentialDestinationAllowedV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { HomeConnectionDescriptorV1, HomeCredentialDestinationSelectionV1 } from '@happier-dev/protocol';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { formatHomeAuthorityMismatchFailure, type HomeAuthorityMismatchFacts, type HomeEnrollmentCarrierFailure } from '@happier-dev/protocol/ssh/commandFailure';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export type TerminalAuthEnrollmentRuntime = Readonly<{
  /** Explicit acquired runtime origin. A daemon-global publication is never consulted. */
  runtimeOrigin: string;
  carrier: 'https' | 'iroh';
  irohAttempt?: HomeEnrollmentCarrierFailure['irohAttempt'];
  /** Descriptor endpoint or EndpointId authenticated by the acquisition owner. */
  authenticatedCredentialDestination: HomeCredentialDestinationSelectionV1 | null;
}>;

export type VerifiedTerminalAuthEnrollmentRuntime = Readonly<{
  homeServerIdentityId: string;
  credentialDestination: HomeCredentialDestinationSelectionV1;
}>;

export type TerminalAuthEnrollmentVerificationErrorCode =
  | 'HOME_FEATURES_UNREADABLE'
  | 'HOME_FEATURES_NETWORK'
  | 'HOME_FEATURES_TIMEOUT'
  | 'HOME_FEATURES_HTTP_ERROR'
  | 'HOME_FEATURES_ENDPOINT_MISSING'
  | 'HOME_IDENTITY_MISSING'
  | 'HOME_CREDENTIAL_DESTINATION_UNVERIFIED'
  | 'HOME_AUTHORITY_MISMATCH'
  | 'HOME_LEGACY_ORIGIN_MISMATCH'
  | 'HOME_RUNTIME_ORIGIN_INVALID';

export class TerminalAuthEnrollmentVerificationError extends Error {
  readonly status?: number;
  readonly authCategory?: 'tls_error' | 'network_error';
  readonly authorityReason?: HomeAuthorityMismatchFacts['authorityReason'];
  readonly authorityPhase?: HomeAuthorityMismatchFacts['authorityPhase'];
  readonly authorityCarrier?: HomeAuthorityMismatchFacts['authorityCarrier'];
  readonly authorityDescriptorPresent?: boolean;
  readonly carrierFailure?: HomeEnrollmentCarrierFailure;

  constructor(readonly code: TerminalAuthEnrollmentVerificationErrorCode, message: string,
    options?: ErrorOptions & Readonly<{ status?: number; authorityFailure?: HomeAuthorityMismatchFacts;
      carrierFailure?: HomeEnrollmentCarrierFailure; authCategory?: 'tls_error' | 'network_error' }>) {
    super(code === 'HOME_AUTHORITY_MISMATCH' && options?.authorityFailure
      ? formatHomeAuthorityMismatchFailure(options.authorityFailure) : message, options);
    this.status = options?.status;
    this.authCategory = options?.authCategory;
    this.carrierFailure = options?.carrierFailure;
    if (code === 'HOME_AUTHORITY_MISMATCH' && options?.authorityFailure) Object.assign(this, options.authorityFailure);
    this.name = 'TerminalAuthEnrollmentVerificationError';
  }
}

export class HomeFeaturesUnreadableError extends TerminalAuthEnrollmentVerificationError {
  constructor() {
    super('HOME_FEATURES_UNREADABLE', 'The selected Home reports features this CLI cannot read. Update the CLI/daemon and retry.');
    this.name = 'HomeFeaturesUnreadableError';
  }
}

export function readTerminalAuthHomeIdentity(snapshot: CliServerFeaturesSnapshot, carrier?: TerminalAuthEnrollmentRuntime['carrier'],
  irohAttempt?: TerminalAuthEnrollmentRuntime['irohAttempt']): string | null {
  if (snapshot.status === 'unsupported') {
    if (snapshot.reason === 'invalid_payload') throw new HomeFeaturesUnreadableError();
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_FEATURES_ENDPOINT_MISSING',
      'The selected Home does not provide the features endpoint needed to verify its identity. Update the server and retry.',
    );
  }
  if (snapshot.status === 'error') {
    if (snapshot.reason === 'network') {
      throw new TerminalAuthEnrollmentVerificationError(
        'HOME_FEATURES_NETWORK', 'The selected Home features could not be reached. Check connectivity and retry.',
        { cause: { code: 'ERR_NETWORK' }, authCategory: snapshot.transportCategory ?? 'network_error', ...(carrier ? { carrierFailure: { attemptedCarrier: carrier, reason: 'transport',
          ...(irohAttempt ? { irohAttempt } : {}) } } : {}) },
      );
    }
    if (snapshot.reason === 'timeout') {
      throw new TerminalAuthEnrollmentVerificationError(
        'HOME_FEATURES_TIMEOUT', 'The selected Home features request timed out. Check server availability and retry.',
        { cause: { code: 'ETIMEDOUT' } },
      );
    }
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_FEATURES_HTTP_ERROR',
      `The selected Home features request failed${snapshot.httpStatus === undefined ? '' : ` (HTTP ${snapshot.httpStatus})`}. Check the server response and retry.`,
      { status: snapshot.httpStatus },
    );
  }
  return normalizeServerIdentityIdCapability(snapshot.features.capabilities.serverIdentity?.serverIdentityId) ?? null;
}

export type AuthenticatedExactHomeConnectionDescriptorObservation =
  | Readonly<{ kind: 'available'; descriptor: HomeConnectionDescriptorV1 }>
  | Readonly<{ kind: 'unavailable' }>;

type HttpResponse = Readonly<{ data: unknown }>;
type Post = (url: string, data?: unknown, config?: AxiosRequestConfig<unknown>) => Promise<HttpResponse>;
type Get = (url: string, config?: AxiosRequestConfig<unknown>) => Promise<HttpResponse>;

function normalizedOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(raw ?? '').trim());
  } catch {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_RUNTIME_ORIGIN_INVALID', 'Terminal authentication runtime origin is invalid',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_RUNTIME_ORIGIN_INVALID', 'Terminal authentication runtime origin must use HTTP or HTTPS',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_RUNTIME_ORIGIN_INVALID', 'Terminal authentication runtime origin is invalid',
    );
  }
  return parsed.toString().replace(/\/+$/u, '');
}

function sameCredentialDestination(
  left: HomeCredentialDestinationSelectionV1,
  right: HomeCredentialDestinationSelectionV1,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'iroh'
    ? left.endpointId === (right as Extract<HomeCredentialDestinationSelectionV1, { kind: 'iroh' }>).endpointId
    : new URL(left.applicationUrl).toString().replace(/\/+$/u, '')
      === new URL((right as Extract<HomeCredentialDestinationSelectionV1, { kind: 'https' }>).applicationUrl)
        .toString().replace(/\/+$/u, '');
}

/**
 * A complete descriptor may become exact local routing authority only when it came from the
 * authenticated feature projection. Public fallback remains usable for URL-only compatibility,
 * but is advisory and must never be promoted to an exact descriptor generation.
 */
export function resolveAuthenticatedExactHomeConnectionDescriptorObservation(params: Readonly<{
  snapshot: CliServerFeaturesSnapshot;
  expectedHomeServerIdentityId: string;
}>): AuthenticatedExactHomeConnectionDescriptorObservation {
  if (params.snapshot.status !== 'ready' || params.snapshot.provenance !== 'authenticated') {
    return { kind: 'unavailable' };
  }

  const descriptor = params.snapshot.features.homeConnectionDescriptor;
  if (!descriptor) return { kind: 'unavailable' };

  const observedIdentity = normalizeServerIdentityIdCapability(
    params.snapshot.features.capabilities.serverIdentity?.serverIdentityId,
  );
  if (
    !observedIdentity
    || observedIdentity !== params.expectedHomeServerIdentityId
    || descriptor.homeServerIdentityId !== observedIdentity
  ) {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_AUTHORITY_MISMATCH', 'Authenticated Home descriptor identity does not match the selected Home',
    );
  }

  return { kind: 'available', descriptor };
}

/**
 * Verifies the acquired first-contact runtime before request/status/claim and again after claim.
 * The loopback runtime origin is transport-only; credential authority comes from the authenticated
 * descriptor destination returned by the acquisition owner.
 */
export function verifyTerminalAuthEnrollmentRuntime(params: Readonly<{
  target: ResolvedHomeTarget;
  runtime: TerminalAuthEnrollmentRuntime;
  snapshot: CliServerFeaturesSnapshot;
  /** Only pre-claim callers may accept an absent advisory public descriptor. */
  phase?: HomeAuthorityMismatchFacts['authorityPhase'];
}>): VerifiedTerminalAuthEnrollmentRuntime {
  normalizedOrigin(params.runtime.runtimeOrigin);
  const observedIdentity = readTerminalAuthHomeIdentity(params.snapshot, params.runtime.carrier, params.runtime.irohAttempt);
  if (!observedIdentity) {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_IDENTITY_MISSING', 'Unable to verify the selected Home identity: the features response has no Home identity',
    );
  }
  const selectedDestination = params.runtime.authenticatedCredentialDestination;
  if (!selectedDestination) {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_CREDENTIAL_DESTINATION_UNVERIFIED', 'The enrollment carrier did not authenticate a credential destination',
    );
  }

  if (!params.target.descriptor) {
    if (
      params.runtime.carrier !== 'https'
      || selectedDestination.kind !== 'https'
      || normalizedOrigin(selectedDestination.applicationUrl) !== normalizedOrigin(params.target.applicationUrl)
      || normalizedOrigin(params.runtime.runtimeOrigin) !== normalizedOrigin(params.target.applicationUrl)
    ) {
      throw new TerminalAuthEnrollmentVerificationError(
        'HOME_LEGACY_ORIGIN_MISMATCH', 'Legacy URL-only authentication requires its exact HTTPS Home origin',
      );
    }
    return { homeServerIdentityId: observedIdentity, credentialDestination: selectedDestination };
  }

  const observedDescriptor = params.snapshot.status === 'ready'
    ? params.snapshot.features.homeConnectionDescriptor
    : undefined;
  // Public discovery is read-only and may legitimately have no committed
  // descriptor yet. Trust still comes from the selected input and acquired
  // endpoint, never from a public response. Post-claim callers remain exact,
  // including when their authenticated request falls back to public features.
  const publicFirstContact = params.phase === 'first_contact'
    && params.snapshot.status === 'ready' && params.snapshot.provenance === 'public'
    && params.runtime.carrier === selectedDestination.kind
    && (selectedDestination.kind !== 'https'
      || normalizedOrigin(params.runtime.runtimeOrigin) === normalizedOrigin(selectedDestination.applicationUrl));
  // Preserve the existing predicate order; labels explain a refusal without
  // exposing either side of an identity, descriptor or endpoint comparison.
  let authorityReason: HomeAuthorityMismatchFacts['authorityReason'] | undefined;
  if (!params.target.descriptor || !params.target.credentialDestination || !params.target.homeServerIdentityId) {
    authorityReason = 'target';
  } else if (!observedDescriptor && !publicFirstContact) {
    authorityReason = 'descriptor';
  } else if (observedIdentity !== params.target.homeServerIdentityId) {
    authorityReason = 'identity';
  } else if (observedDescriptor && observedDescriptor.homeServerIdentityId !== params.target.homeServerIdentityId) {
    authorityReason = 'descriptor_identity';
  } else if (observedDescriptor && JSON.stringify(createHomeCredentialDestinationV1(observedDescriptor))
    !== JSON.stringify(params.target.credentialDestination)) {
    authorityReason = 'destination';
  } else if (!isHomeCredentialDestinationAllowedV1(params.target.credentialDestination, selectedDestination)) {
    authorityReason = 'destination_not_allowed';
  }
  if (authorityReason) {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_AUTHORITY_MISMATCH', 'The acquired enrollment runtime does not match the resolved Home authority',
      { authorityFailure: { authorityReason, authorityPhase: params.phase ?? 'authenticated',
        authorityCarrier: params.runtime.carrier, authorityDescriptorPresent: Boolean(observedDescriptor) } },
    );
  }

  return { homeServerIdentityId: observedIdentity, credentialDestination: selectedDestination };
}

function runtimeUrl(runtime: TerminalAuthEnrollmentRuntime, path: string): string {
  return `${normalizedOrigin(runtime.runtimeOrigin)}${path}`;
}

export async function createTerminalAuthRequest(params: Readonly<{
  runtime: TerminalAuthEnrollmentRuntime;
  publicKey: string;
  supportsV2?: boolean;
  claimSecretHash: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  post?: Post;
}>): Promise<unknown> {
  const post = params.post ?? (async (url: string, data?: unknown, config?: AxiosRequestConfig<unknown>) =>
    await axios.post(url, data, config));
  const response = await post(runtimeUrl(params.runtime, '/v1/auth/request'), {
    publicKey: params.publicKey,
    ...(typeof params.supportsV2 === 'boolean' ? { supportsV2: params.supportsV2 } : {}),
    claimSecretHash: params.claimSecretHash,
  }, {
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.timeoutMs ? { timeout: params.timeoutMs } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return response.data;
}

export async function readTerminalAuthRequestStatus(params: Readonly<{
  runtime: TerminalAuthEnrollmentRuntime;
  publicKey: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  get?: Get;
}>): Promise<unknown> {
  const get = params.get ?? (async (url: string, config?: AxiosRequestConfig<unknown>) =>
    await axios.get(url, config));
  const response = await get(runtimeUrl(params.runtime, '/v1/auth/request/status'), {
    params: { publicKey: params.publicKey },
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.timeoutMs ? { timeout: params.timeoutMs } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return response.data;
}

export async function claimTerminalAuthRequest(params: Readonly<{
  runtime: TerminalAuthEnrollmentRuntime;
  publicKey: string;
  claimSecret: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  post?: Post;
}>): Promise<unknown> {
  const post = params.post ?? (async (url: string, data?: unknown, config?: AxiosRequestConfig<unknown>) =>
    await axios.post(url, data, config));
  const response = await post(runtimeUrl(params.runtime, '/v1/auth/request/claim'), {
    publicKey: params.publicKey,
    claimSecret: params.claimSecret,
  }, {
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.timeoutMs ? { timeout: params.timeoutMs } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return response.data;
}
