import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';

import { encodeBase64 } from '../crypto/base64.js';

export type ProviderFingerprintDomainV1 =
  | 'connection-security'
  | 'binding-security'
  | 'endpoint-set'
  | 'endpoint-observation'
  | 'probe-request'
  | 'compatibility'
  | 'catalog'
  | 'observation-authorization'
  | 'account-grant'
  | 'machine-grant'
  | 'saved-secret-record'
  | 'credential-destination'
  | 'legacy-profile-migration-source'
  | 'legacy-profile-migration-conflict';

function canonicalFingerprintSchema(prefix: string) {
  return z.string().min(1).max(256)
    .refine((value) => value === value.trim(), 'Fingerprint must already be canonical')
    .startsWith(prefix);
}

export const ProviderProbeRequestFingerprintV1Schema = canonicalFingerprintSchema('probe-request:v1:')
  .brand<'ProviderProbeRequestFingerprintV1'>();
export type ProviderProbeRequestFingerprintV1 = z.infer<typeof ProviderProbeRequestFingerprintV1Schema>;
export const ProviderEndpointObservationFingerprintV1Schema = canonicalFingerprintSchema('endpoint-observation:v1:')
  .brand<'ProviderEndpointObservationFingerprintV1'>();
export type ProviderEndpointObservationFingerprintV1 = z.infer<typeof ProviderEndpointObservationFingerprintV1Schema>;
export const ProviderCatalogFingerprintV1Schema = canonicalFingerprintSchema('catalog:v1:')
  .brand<'ProviderCatalogFingerprintV1'>();
export type ProviderCatalogFingerprintV1 = z.infer<typeof ProviderCatalogFingerprintV1Schema>;
export const ProviderObservationAuthorizationFingerprintV1Schema = canonicalFingerprintSchema('observation-authorization:v1:')
  .brand<'ProviderObservationAuthorizationFingerprintV1'>();
export type ProviderObservationAuthorizationFingerprintV1 = z.infer<typeof ProviderObservationAuthorizationFingerprintV1Schema>;

type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | Readonly<{ [key: string]: CanonicalJson }>;

function canonicalJsonTypeError(): TypeError {
  return new TypeError('Fingerprint input must contain only canonical JSON data');
}

function canonicalize(
  value: unknown,
  path: string,
  setPaths: ReadonlySet<string>,
  ancestors: WeakSet<object>,
): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fingerprint input numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw canonicalJsonTypeError();
    ancestors.add(value);
    try {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key !== 'string')) {
        throw canonicalJsonTypeError();
      }
      const entries: CanonicalJson[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw canonicalJsonTypeError();
        entries.push(canonicalize(descriptor.value, `${path}[${index}]`, setPaths, ancestors));
      }
      if (!setPaths.has(path)) return entries;
      const byJson = new Map(entries.map((entry) => [JSON.stringify(entry), entry]));
      return [...byJson.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry);
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === 'object' && value) {
    if (ancestors.has(value)) throw canonicalJsonTypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw canonicalJsonTypeError();
    ancestors.add(value);
    try {
      const outputEntries: Array<readonly [string, CanonicalJson]> = [];
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== 'string')) throw canonicalJsonTypeError();
      for (const key of (ownKeys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw canonicalJsonTypeError();
        const child = descriptor.value;
        if (child === undefined) throw new TypeError('Fingerprint input must not contain undefined');
        outputEntries.push([key, canonicalize(child, path ? `${path}.${key}` : key, setPaths, ancestors)]);
      }
      return Object.fromEntries(outputEntries);
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError('Fingerprint input must be canonical JSON');
}

export function canonicalizeFingerprintValue(
  value: unknown,
  options: Readonly<{ setPaths?: readonly string[] }> = {},
): CanonicalJson {
  return canonicalize(value, '', new Set(options.setPaths ?? []), new WeakSet());
}

export function createProviderFingerprintV1(
  domain: ProviderFingerprintDomainV1,
  value: unknown,
  options: Readonly<{ setPaths?: readonly string[] }> = {},
): string {
  const canonical = canonicalizeFingerprintValue(value, options);
  const digest = encodeBase64(sha256(utf8ToBytes(JSON.stringify(canonical))), 'base64url').replace(/=+$/u, '');
  return `${domain}:v1:${digest}`;
}
