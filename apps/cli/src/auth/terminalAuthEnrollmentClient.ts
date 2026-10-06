import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { createHomeCredentialDestinationV1, isHomeCredentialDestinationAllowedV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { HomeConnectionDescriptorV1, HomeCredentialDestinationSelectionV1 } from '@happier-dev/protocol';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export type TerminalAuthEnrollmentRuntime = Readonly<{
  /** Explicit acquired runtime origin. A daemon-global publication is never consulted. */
  runtimeOrigin: string;
  carrier: 'https' | 'iroh';
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
  constructor(readonly code: TerminalAuthEnrollmentVerificationErrorCode, message: string) {
    super(message);
    this.name = 'TerminalAuthEnrollmentVerificationError';
  }
}

export class HomeFeaturesUnreadableError extends TerminalAuthEnrollmentVerificationError {
  constructor() {
    super('HOME_FEATURES_UNREADABLE', 'The selected Home reports features this CLI cannot read. Update the CLI/daemon and retry.');
    this.name = 'HomeFeaturesUnreadableError';
  }
}

export function readTerminalAuthHomeIdentity(snapshot: CliServerFeaturesSnapshot): string | null {
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
      );
    }
    if (snapshot.reason === 'timeout') {
      throw new TerminalAuthEnrollmentVerificationError(
        'HOME_FEATURES_TIMEOUT', 'The selected Home features request timed out. Check server availability and retry.',
      );
    }
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_FEATURES_HTTP_ERROR',
      `The selected Home features request failed${snapshot.httpStatus === undefined ? '' : ` (HTTP ${snapshot.httpStatus})`}. Check the server response and retry.`,
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
    throw new Error('Authenticated Home descriptor identity does not match the selected Home');
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
}>): VerifiedTerminalAuthEnrollmentRuntime {
  normalizedOrigin(params.runtime.runtimeOrigin);
  const observedIdentity = readTerminalAuthHomeIdentity(params.snapshot);
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
  if (
    !params.target.descriptor
    || !params.target.credentialDestination
    || !params.target.homeServerIdentityId
    || !observedDescriptor
    || observedIdentity !== params.target.homeServerIdentityId
    || observedDescriptor.homeServerIdentityId !== params.target.homeServerIdentityId
    || JSON.stringify(createHomeCredentialDestinationV1(observedDescriptor))
      !== JSON.stringify(params.target.credentialDestination)
    || !isHomeCredentialDestinationAllowedV1(params.target.credentialDestination, selectedDestination)
  ) {
    throw new TerminalAuthEnrollmentVerificationError(
      'HOME_AUTHORITY_MISMATCH', 'The acquired enrollment runtime does not match the resolved Home authority',
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
