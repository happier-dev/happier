import {
  classifyProviderHostnameSyntax,
  parseProviderIpAddress,
  type ParsedProviderIpAddress,
} from './locality.js';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from './limits.js';
import { isProviderMetadataHostname } from './metadataDestinations.js';
import {
  isBaseCredentialDiagnosticKey,
  isUnsafeTelemetryDataKey,
  normalizeTelemetryDataKey,
  splitSensitiveDiagnosticKeySegments,
} from '../../common/sensitiveKeys.js';

export type ProviderEndpointSafetyErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'userinfo_forbidden'
  | 'fragment_forbidden'
  | 'secret_in_url'
  | 'control_character'
  | 'url_too_long'
  | 'host_too_long'
  | 'path_too_long'
  | 'query_too_long'
  | 'query_forbidden'
  | 'odd_ip_encoding'
  | 'dns_resolution_required'
  | 'unsafe_address'
  | 'http_public_forbidden'
  | 'http_private_confirmation_required';

export class ProviderEndpointSafetyError extends Error {
  readonly code: ProviderEndpointSafetyErrorCode;

  constructor(code: ProviderEndpointSafetyErrorCode, message: string) {
    super(message);
    this.name = 'ProviderEndpointSafetyError';
    this.code = code;
  }
}

export type AssessedProviderEndpoint = Readonly<{
  normalizedUrl: string;
  origin: string;
  hostname: string;
  protocol: 'http:' | 'https:';
  locality: 'public' | 'private' | 'loopback';
  scope: 'account' | 'machine';
  resolvedAddresses: readonly string[];
  nonPublicAddresses: readonly string[];
}>;

export type NormalizedProviderEndpointUrlSyntax = Readonly<{
  normalizedUrl: string;
  origin: string;
  hostname: string;
  protocol: 'http:' | 'https:';
  literalAddress: ParsedProviderIpAddress | null;
}>;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ENCODED_CONTROL_CHARACTER_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu;
const MALFORMED_PERCENT_ENCODING_PATTERN = /%(?![0-9a-f]{2})/iu;
const CREDENTIAL_LIKE_QUERY_VALUE_PATTERN = /^(?:(?:bearer|basic)\s+\S+|(?:sk|pk|rk)[-_][a-z0-9_-]{6,}|xox[baprs]-[a-z0-9-]+|gh[pousr]_[a-z0-9_]+|aiza[a-z0-9_-]+)$/iu;

function fail(code: ProviderEndpointSafetyErrorCode, message: string): never {
  throw new ProviderEndpointSafetyError(code, message);
}

function readRawHostname(rawUrl: string): string | null {
  const schemeSeparator = rawUrl.indexOf('://');
  if (schemeSeparator < 0) return null;
  const authority = rawUrl.slice(schemeSeparator + 3).split(/[/?#]/u, 1)[0] ?? '';
  const withoutUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
  if (withoutUserinfo.startsWith('[')) {
    const closingBracket = withoutUserinfo.indexOf(']');
    return closingBracket > 0 ? withoutUserinfo.slice(1, closingBracket) : null;
  }
  const colon = withoutUserinfo.lastIndexOf(':');
  return colon >= 0 ? withoutUserinfo.slice(0, colon) : withoutUserinfo;
}

function validateProviderQuery(searchParams: URLSearchParams): void {
  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = normalizeTelemetryDataKey(key);
    if (
      isBaseCredentialDiagnosticKey(key)
      || isUnsafeTelemetryDataKey(normalizedKey)
      || splitSensitiveDiagnosticKeySegments(key).some((part) => ['auth', 'credential', 'credentials', 'key', 'secret'].includes(part))
      || CREDENTIAL_LIKE_QUERY_VALUE_PATTERN.test(value)
      || CONTROL_CHARACTER_PATTERN.test(key)
      || CONTROL_CHARACTER_PATTERN.test(value)
    ) {
      fail('secret_in_url', 'Provider endpoint credentials must use a typed credential transport, not the URL.');
    }
  }
}

function validateProviderRawSearchSyntax(search: string, context: 'endpoint' | 'executable path'): void {
  if (ENCODED_CONTROL_CHARACTER_PATTERN.test(search)) {
    fail('control_character', `Provider ${context} query contains an encoded control character.`);
  }
  if (MALFORMED_PERCENT_ENCODING_PATTERN.test(search)) {
    fail('invalid_url', `Provider ${context} query contains malformed percent encoding.`);
  }
}

function validateAndDecodeProviderPathname(
  pathname: string,
  options: Readonly<{ allowLiteralTraversalSegments?: boolean }> = {},
): string {
  if (ENCODED_CONTROL_CHARACTER_PATTERN.test(pathname)) {
    fail('control_character', 'Provider endpoint path contains an encoded control character.');
  }
  if (MALFORMED_PERCENT_ENCODING_PATTERN.test(pathname)) {
    fail('invalid_url', 'Provider endpoint path contains malformed percent encoding.');
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    fail('invalid_url', 'Provider endpoint path contains malformed percent encoding.');
  }
  if (CONTROL_CHARACTER_PATTERN.test(decodedPath)) {
    fail('control_character', 'Provider endpoint path contains an encoded control character.');
  }
  for (const segment of pathname.split('/')) {
    let decodedSegment = segment;
    for (let depth = 0; depth < segment.length; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decodedSegment);
      } catch {
        break;
      }
      const changed = next !== decodedSegment;
      if (
        next.includes('/')
        || next.includes('\\')
        || (
          (next === '.' || next === '..')
          && (changed || options.allowLiteralTraversalSegments !== true)
        )
      ) {
        fail(
          'invalid_url',
          'Provider endpoint path must not encode path separators or traversal segments.',
        );
      }
      if (CONTROL_CHARACTER_PATTERN.test(next)) {
        fail('control_character', 'Provider endpoint path contains an encoded control character.');
      }
      if (next === decodedSegment) break;
      decodedSegment = next;
    }
  }
  if (decodedPath.startsWith('//') || decodedPath.includes('\\')) {
    fail('invalid_url', 'Provider endpoint path must not encode an authority escape.');
  }
  return decodedPath;
}

export function normalizeProviderOriginRelativePathSyntax(
  rawPath: string,
  options: Readonly<{ allowQuery?: boolean }> = {},
): string {
  if (rawPath.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxUrlChars) {
    fail('url_too_long', 'Provider endpoint path and query are too long.');
  }
  if (rawPath.trim() !== rawPath || CONTROL_CHARACTER_PATTERN.test(rawPath)) {
    fail('control_character', 'Provider endpoint path contains whitespace or control characters.');
  }
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) {
    fail('invalid_url', 'Provider executable paths must be single-leading-slash origin-relative paths.');
  }

  // WHATWG URL parsing removes encoded dot segments before exposing
  // `pathname`. Inspect the caller's raw path first so `%2e%2e/` cannot be
  // normalized into an apparently safe path. Literal `.`/`..` segments stay
  // supported and are canonicalized by URL below.
  validateAndDecodeProviderPathname(
    rawPath.split(/[?#]/u, 1)[0] ?? rawPath,
    { allowLiteralTraversalSegments: true },
  );

  let parsed: URL;
  try {
    parsed = new URL(rawPath, 'https://provider.invalid');
  } catch {
    fail('invalid_url', 'Provider executable path is invalid.');
  }
  if (parsed.origin !== 'https://provider.invalid') {
    fail('invalid_url', 'Provider executable paths must not change the endpoint origin.');
  }
  if (parsed.hash) fail('fragment_forbidden', 'Provider executable paths must not contain fragments.');
  if (options.allowQuery !== true && parsed.search.length > 0) {
    fail('query_forbidden', 'Provider executable path queries are not allowed in this context.');
  }
  if (parsed.pathname.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxPathChars) {
    fail('path_too_long', 'Provider endpoint path is too long.');
  }
  if (parsed.search.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxQueryChars) {
    fail('query_too_long', 'Provider endpoint query is too long.');
  }
  validateAndDecodeProviderPathname(parsed.pathname);
  validateProviderRawSearchSyntax(parsed.search, 'executable path');
  validateProviderQuery(parsed.searchParams);
  return `${parsed.pathname}${parsed.search}`;
}

function normalizeAndValidateResolvedAddresses(addresses: readonly string[]): Readonly<{
  all: readonly string[];
  nonPublic: readonly string[];
  hasPrivate: boolean;
  allLoopback: boolean;
}> {
  const byAddress = new Map<string, 'public' | 'private' | 'loopback'>();
  for (const rawAddress of addresses) {
    const parsed = parseProviderIpAddress(rawAddress);
    if (!parsed) fail('unsafe_address', 'Provider endpoint DNS returned an invalid IP address.');
    if (parsed.locality === 'unsafe') fail('unsafe_address', 'Provider endpoint resolves to an unsafe destination.');
    byAddress.set(parsed.normalized, parsed.locality);
  }
  if (byAddress.size === 0) fail('dns_resolution_required', 'Provider endpoint needs a successful A/AAAA resolution.');
  const all = [...byAddress.keys()].sort();
  const nonPublic = all.filter((address) => byAddress.get(address) !== 'public');
  return {
    all,
    nonPublic,
    hasPrivate: nonPublic.some((address) => byAddress.get(address) === 'private'),
    allLoopback: nonPublic.length === all.length && all.every((address) => byAddress.get(address) === 'loopback'),
  };
}

export function normalizeProviderEndpointUrlSyntax(
  rawUrl: string,
  options: Readonly<{ allowQuery?: boolean }> = {},
): NormalizedProviderEndpointUrlSyntax {
  if (rawUrl.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxUrlChars) {
    fail('url_too_long', 'Provider endpoint URL is too long.');
  }
  if (rawUrl.trim() !== rawUrl || CONTROL_CHARACTER_PATTERN.test(rawUrl)) {
    fail('control_character', 'Provider endpoint URL contains whitespace or control characters.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail('invalid_url', 'Provider endpoint must be an absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('unsupported_scheme', 'Provider endpoint must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password) fail('userinfo_forbidden', 'Provider endpoint must not contain URL credentials.');
  if (parsed.hash) fail('fragment_forbidden', 'Provider endpoint must not contain a fragment.');
  if (options.allowQuery === false && parsed.search.length > 0) {
    fail('query_forbidden', 'Provider endpoint queries are not allowed in this context.');
  }
  validateProviderRawSearchSyntax(parsed.search, 'endpoint');
  validateProviderQuery(parsed.searchParams);

  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
  if (!hostname || hostname.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHostnameChars) {
    fail('host_too_long', 'Provider endpoint hostname is missing or too long.');
  }
  if (isProviderMetadataHostname(hostname)) {
    fail('unsafe_address', 'Provider endpoint targets a cloud metadata destination.');
  }
  const literalAddress = parseProviderIpAddress(hostname);
  if (!literalAddress && hostname.split('.').some((label) => label.length === 0 || label.length > 63)) {
    fail('host_too_long', 'Provider endpoint hostname contains an invalid label.');
  }
  if (parsed.pathname.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxPathChars) {
    fail('path_too_long', 'Provider endpoint path is too long.');
  }
  if (parsed.search.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxQueryChars) {
    fail('query_too_long', 'Provider endpoint query is too long.');
  }
  validateAndDecodeProviderPathname(parsed.pathname);
  if (literalAddress?.version === 4) {
    const rawHostname = readRawHostname(rawUrl)?.toLowerCase();
    if (rawHostname !== literalAddress.normalized) {
      fail('odd_ip_encoding', 'Provider endpoint IPv4 literals must use canonical dotted-decimal spelling.');
    }
  }
  if (literalAddress?.locality === 'unsafe') {
    fail('unsafe_address', 'Provider endpoint targets an unsafe destination.');
  }

  parsed.hostname = literalAddress?.version === 6 ? `[${literalAddress.normalized}]` : hostname;
  return {
    normalizedUrl: parsed.toString(),
    origin: parsed.origin,
    hostname,
    protocol: parsed.protocol,
    literalAddress,
  };
}

export function assessProviderEndpoint(
  rawUrl: string,
  options: Readonly<{
    resolvedAddresses?: readonly string[];
    privateNetworkConfirmed?: boolean;
  }> = {},
): AssessedProviderEndpoint {
  const syntax = normalizeProviderEndpointUrlSyntax(rawUrl);
  const literalAddress = syntax.literalAddress;

  let resolvedAddresses: readonly string[];
  let nonPublicAddresses: readonly string[];
  let locality: 'public' | 'private' | 'loopback';
  if (literalAddress) {
    // `normalizeProviderEndpointUrlSyntax` already rejects this case; keep the explicit guard here
    // so this authorization layer remains independently fail-closed and the narrowed type is exact.
    if (literalAddress.locality === 'unsafe') fail('unsafe_address', 'Provider endpoint targets an unsafe destination.');
    locality = literalAddress.locality;
    resolvedAddresses = [literalAddress.normalized];
    nonPublicAddresses = locality === 'public' ? [] : resolvedAddresses;
  } else {
    const hostnameSyntax = classifyProviderHostnameSyntax(syntax.hostname);
    if (!options.resolvedAddresses || options.resolvedAddresses.length === 0) {
      fail('dns_resolution_required', 'Provider endpoint needs a successful A/AAAA resolution.');
    }
    const resolved = normalizeAndValidateResolvedAddresses(options.resolvedAddresses);
    resolvedAddresses = resolved.all;
    nonPublicAddresses = resolved.nonPublic;
    if (hostnameSyntax === 'loopback' && !resolved.allLoopback) {
      fail('unsafe_address', 'A localhost provider endpoint resolved outside loopback.');
    }
    locality = resolved.allLoopback ? 'loopback' : resolved.hasPrivate || resolved.nonPublic.length > 0 ? 'private' : 'public';
  }

  if (syntax.protocol === 'http:' && locality === 'public') {
    fail('http_public_forbidden', 'Public provider endpoints must use HTTPS.');
  }
  if (syntax.protocol === 'http:' && locality === 'private' && options.privateNetworkConfirmed !== true) {
    fail('http_private_confirmation_required', 'Private HTTP provider endpoints require explicit machine confirmation.');
  }

  return {
    normalizedUrl: syntax.normalizedUrl,
    origin: syntax.origin,
    hostname: syntax.hostname,
    protocol: syntax.protocol,
    locality,
    scope: locality === 'public' ? 'account' : 'machine',
    resolvedAddresses,
    nonPublicAddresses,
  };
}

export function buildProviderEndpointSetFingerprintInput(
  endpoints: readonly Readonly<{ endpointTemplateId: string; endpoint: AssessedProviderEndpoint }>[],
): Readonly<{
  endpoints: readonly Readonly<{
    endpointTemplateId: string;
    normalizedUrl: string;
    nonPublicAddresses: readonly string[];
  }>[];
}> {
  return {
    endpoints: endpoints.map(({ endpointTemplateId, endpoint }) => ({
      endpointTemplateId,
      normalizedUrl: endpoint.normalizedUrl,
      nonPublicAddresses: [...new Set(endpoint.nonPublicAddresses)].sort(),
    })),
  };
}

export function evaluateProviderRedirect(params: Readonly<{
  from: AssessedProviderEndpoint;
  location: string;
  resolvedAddresses?: readonly string[];
  privateNetworkConfirmed?: boolean;
  requestCarriesCredential: boolean;
}>): Readonly<{
  endpoint: AssessedProviderEndpoint;
  authorizationRevalidationRequired: true;
  credentialDisposition: 'none' | 'strip' | 'reauthorize-before-forward';
}> {
  let targetUrl: string;
  try {
    targetUrl = new URL(params.location, params.from.normalizedUrl).toString();
  } catch {
    fail('invalid_url', 'Provider redirect location is invalid.');
  }
  const endpoint = assessProviderEndpoint(targetUrl, {
    ...(params.resolvedAddresses ? { resolvedAddresses: params.resolvedAddresses } : {}),
    ...(params.privateNetworkConfirmed ? { privateNetworkConfirmed: true } : {}),
  });
  return {
    endpoint,
    authorizationRevalidationRequired: true,
    credentialDisposition: !params.requestCarriesCredential
      ? 'none'
      : endpoint.origin === params.from.origin
        ? 'reauthorize-before-forward'
        : 'strip',
  };
}
