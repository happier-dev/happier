import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from './limits.js';
import { isUnsafeTelemetryDataKey } from '../../common/sensitiveKeys.js';
import { compareProviderCanonicalStringsV1 } from '../canonicalOrderV1.js';

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const QUERY_NAME_PATTERN = /^[A-Za-z0-9._~-]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

const TRANSPORT_OWNED_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const OBJECT_KEY_POISON_HEADER_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function normalizeHeaderName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (
    !normalized
    || normalized.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHeaderNameChars
    || !HEADER_NAME_PATTERN.test(normalized)
    || OBJECT_KEY_POISON_HEADER_NAMES.has(normalized)
  ) {
    throw new Error('Invalid provider header name.');
  }
  return normalized;
}

function isSecretBearingHeaderName(name: string): boolean {
  if (isUnsafeTelemetryDataKey(name)) return true;
  const tokens = name.split(/[-_]+/u);
  return tokens.some((token) => [
    'auth',
    'authentication',
    'authorization',
    'credential',
    'credentials',
    'key',
    'password',
    'passwd',
    'secret',
    'token',
  ].includes(token));
}

export function normalizeProviderPublicHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(headers);
  if (entries.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxPublicHeaders) {
    throw new Error('Provider public-header count exceeds the limit.');
  }
  const normalized = new Map<string, string>();
  for (const [rawName, value] of entries) {
    const name = normalizeHeaderName(rawName);
    if (TRANSPORT_OWNED_HEADER_NAMES.has(name) || isSecretBearingHeaderName(name)) {
      throw new Error('Provider public headers must not contain transport-owned or secret-bearing names.');
    }
    if (normalized.has(name)) throw new Error('Provider public headers contain a case-equivalent duplicate.');
    if (
      value.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHeaderValueChars
      || CONTROL_CHARACTER_PATTERN.test(value)
    ) {
      throw new Error('Invalid provider public-header value.');
    }
    normalized.set(name, value);
  }
  return Object.fromEntries([...normalized.entries()].sort(([a], [b]) =>
    compareProviderCanonicalStringsV1(a, b)));
}

export function normalizeProviderCredentialHeaderName(name: string): string {
  const normalized = normalizeHeaderName(name);
  if (TRANSPORT_OWNED_HEADER_NAMES.has(normalized)) {
    throw new Error('Provider credential destination cannot use a transport-owned header.');
  }
  return normalized;
}

export function normalizeProviderQueryParameterName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized
    || normalized.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHeaderNameChars
    || CONTROL_CHARACTER_PATTERN.test(normalized)
    || !QUERY_NAME_PATTERN.test(normalized)
  ) {
    throw new Error('Invalid provider credential query-parameter name.');
  }
  return normalized;
}
