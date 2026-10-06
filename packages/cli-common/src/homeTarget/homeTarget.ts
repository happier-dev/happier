import { ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES, HomeApplicationOriginV1Schema, HomeConnectionDescriptorV1Schema, HomeCredentialDestinationV1Schema, createHomeCredentialDestinationV1, isHomeCredentialDestinationAllowedV1 } from '@happier-dev/protocol/auth/accountDirectory';
import type { HomeConnectionDescriptorV1, HomeCredentialDestinationV1 } from '@happier-dev/protocol';

import { DEFAULT_HAPPIER_CLOUD_SERVER_URL } from '../happierCloud.js';
import {
  resolveHomeCarrierPreferredTransport,
  type HomeCarrierPreferredTransport,
} from '../homeEnrollment/homeCarrierPolicy.js';

export type HomeTargetDescriptorAuthority =
  | 'current_connection'
  | 'trusted_enrollment'
  | 'account_directory';

export type HomeTargetInput =
  | Readonly<{ kind: 'saved_profile'; profileRef: string }>
  | Readonly<{
      kind: 'descriptor';
      descriptor: HomeConnectionDescriptorV1;
      authority: HomeTargetDescriptorAuthority;
    }>
  | Readonly<{
      kind: 'https_url';
      url: string;
      /** Released SSH compatibility: URL the target host uses locally. */
      localUrl?: string;
      /** Released SSH compatibility: web app URL persisted on the target host. */
      webappUrl?: string;
    }>;

export type SavedHomeTargetProfile = Readonly<{
  id: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
  homeConnectionDescriptor?: HomeConnectionDescriptorV1;
}>;

export type ResolvedHomeTarget = Readonly<{
  profileId: string | null;
  homeServerIdentityId: string | null;
  descriptor: HomeConnectionDescriptorV1 | null;
  canonicalAuthUrl: string;
  applicationUrl: string;
  webappUrl: string;
  credentialDestination: HomeCredentialDestinationV1 | null;
  preferredTransport: HomeCarrierPreferredTransport;
  authority: 'saved_profile' | HomeTargetDescriptorAuthority | 'manual_url';
}>;

export type HomeTargetResolutionErrorCode =
  | 'invalid_target'
  | 'profile_missing'
  | 'identity_unobserved'
  | 'identity_mismatch';

export class HomeTargetResolutionError extends Error {
  readonly name = 'HomeTargetResolutionError';

  constructor(
    readonly code: HomeTargetResolutionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function nonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function parseApplicationUrl(value: unknown): string {
  const parsed = HomeApplicationOriginV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new HomeTargetResolutionError('invalid_target', 'Home target URL is invalid');
  }
  return new URL(parsed.data).toString().replace(/\/+$/u, '');
}

function parseWebappUrl(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  try {
    const parsed = new URL(normalized);
    if (
      !normalized
      || new TextEncoder().encode(normalized).byteLength > ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES
      || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('invalid web app URL');
    }
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    throw new HomeTargetResolutionError('invalid_target', 'Home web app URL is invalid');
  }
}

function deriveWebappUrl(applicationUrl: string): string {
  if (applicationUrl === DEFAULT_HAPPIER_CLOUD_SERVER_URL) return 'https://app.happier.dev';
  return new URL(applicationUrl).origin;
}

export function parseHomeTargetInput(value: unknown): HomeTargetInput {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new HomeTargetResolutionError('invalid_target', 'Home target must be a closed object');
  }
  if (value.kind === 'saved_profile') {
    const profileRef = nonEmptyString(value.profileRef);
    if (!profileRef || !hasOnlyKeys(value, ['kind', 'profileRef'])) {
      throw new HomeTargetResolutionError('invalid_target', 'Saved Home target is invalid');
    }
    return { kind: 'saved_profile', profileRef };
  }
  if (value.kind === 'https_url') {
    if (!hasOnlyKeys(value, ['kind', 'url', 'localUrl', 'webappUrl'])) {
      throw new HomeTargetResolutionError('invalid_target', 'Manual Home target is invalid');
    }
    const url = parseApplicationUrl(value.url);
    const localUrl = value.localUrl === undefined ? undefined : parseApplicationUrl(value.localUrl);
    const webappUrl = value.webappUrl === undefined ? undefined : parseApplicationUrl(value.webappUrl);
    return {
      kind: 'https_url',
      url,
      ...(localUrl && localUrl !== url ? { localUrl } : {}),
      ...(webappUrl ? { webappUrl } : {}),
    };
  }
  if (value.kind === 'descriptor') {
    if (!hasOnlyKeys(value, ['kind', 'descriptor', 'authority'])) {
      throw new HomeTargetResolutionError('invalid_target', 'Descriptor Home target is invalid');
    }
    if (
      value.authority !== 'current_connection'
      && value.authority !== 'trusted_enrollment'
      && value.authority !== 'account_directory'
    ) {
      throw new HomeTargetResolutionError('invalid_target', 'Home descriptor authority is invalid');
    }
    const parsed = HomeConnectionDescriptorV1Schema.safeParse(value.descriptor);
    if (!parsed.success) {
      throw new HomeTargetResolutionError('invalid_target', 'Home connection descriptor is invalid');
    }
    return { kind: 'descriptor', descriptor: parsed.data, authority: value.authority };
  }
  throw new HomeTargetResolutionError('invalid_target', 'Unknown Home target kind');
}

export function resolveHomeTargetFromDescriptor(params: Readonly<{
  descriptor: HomeConnectionDescriptorV1;
  authority: HomeTargetDescriptorAuthority | 'saved_profile';
  profile?: SavedHomeTargetProfile;
}>): ResolvedHomeTarget {
  const descriptor = HomeConnectionDescriptorV1Schema.parse(params.descriptor);
  const httpsEndpoint = descriptor.endpoints.find((endpoint) => endpoint.kind === 'https');
  const applicationUrl = httpsEndpoint
    ? parseApplicationUrl(httpsEndpoint.url)
    : parseApplicationUrl(descriptor.canonicalServerUrl);
  return {
    profileId: params.profile?.id ?? null,
    homeServerIdentityId: descriptor.homeServerIdentityId,
    descriptor,
    canonicalAuthUrl: parseApplicationUrl(descriptor.canonicalServerUrl),
    applicationUrl,
    webappUrl: params.profile?.webappUrl
      ? parseWebappUrl(params.profile.webappUrl)
      : deriveWebappUrl(descriptor.canonicalServerUrl),
    credentialDestination: createHomeCredentialDestinationV1(descriptor),
    preferredTransport: resolveHomeCarrierPreferredTransport(descriptor),
    authority: params.authority,
  };
}

export async function resolveHomeTarget(params: Readonly<{
  input: HomeTargetInput;
  readSavedProfile: (profileRef: string) => Promise<SavedHomeTargetProfile | null>;
}>): Promise<ResolvedHomeTarget> {
  const input = parseHomeTargetInput(params.input);
  if (input.kind === 'descriptor') {
    return resolveHomeTargetFromDescriptor({ descriptor: input.descriptor, authority: input.authority });
  }
  if (input.kind === 'https_url') {
    const canonicalAuthUrl = parseApplicationUrl(input.url);
    const applicationUrl = parseApplicationUrl(input.localUrl ?? input.url);
    return {
      profileId: null,
      homeServerIdentityId: null,
      descriptor: null,
      canonicalAuthUrl,
      applicationUrl,
      webappUrl: input.webappUrl ? parseWebappUrl(input.webappUrl) : deriveWebappUrl(canonicalAuthUrl),
      credentialDestination: null,
      preferredTransport: 'https',
      authority: 'manual_url',
    };
  }
  const profile = await params.readSavedProfile(input.profileRef);
  if (!profile) {
    throw new HomeTargetResolutionError('profile_missing', `Saved Home profile not found: ${input.profileRef}`);
  }
  if (profile.homeConnectionDescriptor) {
    return resolveHomeTargetFromDescriptor({
      descriptor: profile.homeConnectionDescriptor,
      authority: 'saved_profile',
      profile,
    });
  }
  const applicationUrl = parseApplicationUrl(profile.localServerUrl ?? profile.serverUrl);
  return {
    profileId: profile.id,
    homeServerIdentityId: null,
    descriptor: null,
    canonicalAuthUrl: parseApplicationUrl(profile.serverUrl),
    applicationUrl,
    webappUrl: parseWebappUrl(profile.webappUrl),
    credentialDestination: null,
    preferredTransport: 'https',
    authority: 'saved_profile',
  };
}

export function assertResolvedHomeTargetIdentity(
  target: ResolvedHomeTarget,
  observedHomeServerIdentityId: string,
): string {
  const observed = nonEmptyString(observedHomeServerIdentityId);
  if (!observed) {
    throw new HomeTargetResolutionError('identity_unobserved', 'Stable Home identity was not observed');
  }
  if (target.homeServerIdentityId && target.homeServerIdentityId !== observed) {
    throw new HomeTargetResolutionError(
      'identity_mismatch',
      `Resolved Home identity ${target.homeServerIdentityId} does not match observed Home identity ${observed}`,
    );
  }
  return observed;
}

/** Projects a resolved local target into the non-secret authority sent to another CLI. */
export function createTransferableHomeTargetInput(target: ResolvedHomeTarget): HomeTargetInput {
  if (target.descriptor) {
    return {
      kind: 'descriptor',
      descriptor: target.descriptor,
      authority: target.authority === 'account_directory' ? 'account_directory' : 'trusted_enrollment',
    };
  }
  return {
    kind: 'https_url',
    url: target.canonicalAuthUrl,
    ...(target.applicationUrl !== target.canonicalAuthUrl ? { localUrl: target.applicationUrl } : {}),
    ...(target.webappUrl !== deriveWebappUrl(target.canonicalAuthUrl) ? { webappUrl: target.webappUrl } : {}),
  };
}

/** Strict parser for the JSON-safe resolved projection passed to system tasks. */
export function parseResolvedHomeTarget(value: unknown): ResolvedHomeTarget {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'profileId',
    'homeServerIdentityId',
    'descriptor',
    'canonicalAuthUrl',
    'applicationUrl',
    'webappUrl',
    'credentialDestination',
    'preferredTransport',
    'authority',
  ])) {
    throw new HomeTargetResolutionError('invalid_target', 'Resolved Home target is invalid');
  }
  const profileId = value.profileId === null ? null : nonEmptyString(value.profileId);
  const identity = value.homeServerIdentityId === null ? null : nonEmptyString(value.homeServerIdentityId);
  const descriptorResult = value.descriptor === null
    ? null
    : HomeConnectionDescriptorV1Schema.safeParse(value.descriptor);
  const credentialDestinationResult = value.credentialDestination === null
    ? null
    : HomeCredentialDestinationV1Schema.safeParse(value.credentialDestination);
  if (
    (value.profileId !== null && !profileId)
    || (value.homeServerIdentityId !== null && !identity)
    || (descriptorResult !== null && !descriptorResult.success)
    || (credentialDestinationResult !== null && !credentialDestinationResult.success)
    || (value.preferredTransport !== 'https' && value.preferredTransport !== 'iroh')
    || (
      value.authority !== 'saved_profile'
      && value.authority !== 'current_connection'
      && value.authority !== 'trusted_enrollment'
      && value.authority !== 'account_directory'
      && value.authority !== 'manual_url'
    )
  ) {
    throw new HomeTargetResolutionError('invalid_target', 'Resolved Home target is invalid');
  }
  const descriptor = descriptorResult?.success ? descriptorResult.data : null;
  const credentialDestination = credentialDestinationResult?.success
    ? credentialDestinationResult.data
    : null;
  const authority = value.authority;
  const preferredTransport = value.preferredTransport;
  const canonicalAuthUrl = parseApplicationUrl(value.canonicalAuthUrl);
  const applicationUrl = parseApplicationUrl(value.applicationUrl);
  const webappUrl = parseWebappUrl(value.webappUrl);
  if (
    descriptor
    && (
      identity !== descriptor.homeServerIdentityId
      || !credentialDestination
      || JSON.stringify(credentialDestination) !== JSON.stringify(createHomeCredentialDestinationV1(descriptor))
    )
  ) {
    throw new HomeTargetResolutionError('invalid_target', 'Resolved Home target descriptor projection is inconsistent');
  }
  if (!descriptor && (identity !== null || credentialDestination !== null)) {
    throw new HomeTargetResolutionError('invalid_target', 'URL-only Home target cannot claim identity or credential authority');
  }
  if (
    authority === 'manual_url'
    && (
      profileId !== null
      || descriptor !== null
      || identity !== null
      || credentialDestination !== null
      || preferredTransport !== 'https'
      || canonicalAuthUrl !== applicationUrl
    )
  ) {
    throw new HomeTargetResolutionError('invalid_target', 'Manual Home target projection is inconsistent');
  }
  const isDescriptorAuthority = authority === 'current_connection'
    || authority === 'trusted_enrollment'
    || authority === 'account_directory';
  if (isDescriptorAuthority && !descriptor) {
    throw new HomeTargetResolutionError('invalid_target', 'Descriptor Home target authority requires a descriptor');
  }
  if (authority === 'saved_profile' && !profileId) {
    throw new HomeTargetResolutionError('invalid_target', 'Saved Home target requires a profile');
  }
  if (authority !== 'saved_profile' && authority !== 'manual_url' && !descriptor) {
    throw new HomeTargetResolutionError('invalid_target', 'Home target authority projection is inconsistent');
  }
  if (authority === 'manual_url' && descriptor) {
    throw new HomeTargetResolutionError('invalid_target', 'Descriptor Home target cannot use manual URL authority');
  }
  if (descriptor && canonicalAuthUrl !== parseApplicationUrl(descriptor.canonicalServerUrl)) {
    throw new HomeTargetResolutionError('invalid_target', 'Home target canonical authentication URL does not match its descriptor');
  }
  if (descriptor && preferredTransport !== resolveHomeCarrierPreferredTransport(descriptor)) {
    throw new HomeTargetResolutionError('invalid_target', 'Home target carrier preference does not match its descriptor');
  }
  if (!descriptor && preferredTransport !== 'https') {
    throw new HomeTargetResolutionError('invalid_target', 'URL-only Home target must use HTTPS carrier preference');
  }
  if (descriptor && credentialDestination) {
    const irohEndpoint = descriptor.endpoints.find((endpoint) => endpoint.kind === 'iroh');
    const hasHttpsEndpoint = descriptor.endpoints.some((endpoint) => endpoint.kind === 'https');
    if (
      preferredTransport === 'iroh'
      && (
        !irohEndpoint
        || !isHomeCredentialDestinationAllowedV1(
          credentialDestination,
          { kind: 'iroh', endpointId: irohEndpoint.endpointId },
        )
      )
    ) {
      throw new HomeTargetResolutionError('invalid_target', 'Iroh Home target is outside its authorized credential destination');
    }
    if (
      (preferredTransport === 'https' || hasHttpsEndpoint)
      && !isHomeCredentialDestinationAllowedV1(credentialDestination, { kind: 'https', applicationUrl })
    ) {
      throw new HomeTargetResolutionError('invalid_target', 'HTTPS Home target is outside its authorized credential destination');
    }
    if (!hasHttpsEndpoint && applicationUrl !== canonicalAuthUrl) {
      throw new HomeTargetResolutionError('invalid_target', 'Iroh-only Home target application URL must remain its canonical audience');
    }
  }
  return {
    profileId,
    homeServerIdentityId: identity,
    descriptor,
    canonicalAuthUrl,
    applicationUrl,
    webappUrl,
    credentialDestination,
    preferredTransport,
    authority,
  };
}
