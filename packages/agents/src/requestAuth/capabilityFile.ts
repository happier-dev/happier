import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
  CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH,
} from '@happier-dev/protocol/connect/connected-account-request-auth';

export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH =
  join('request-auth', 'capability.json');

export type ConnectedAccountRequestAuthCapabilityDocumentV2 = Readonly<{
  v: typeof CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION;
  materializationId: string;
  /** Opaque digest of the daemon-owned subject/purpose snapshot; never a child selector. */
  subjectScopeDigest: string;
  capability: string;
  /** Current daemon request-auth endpoint. Rotated atomically with the capability. */
  httpPort: number;
}>;

/**
 * Exact UTF-8 ceiling for the compact, newline-terminated V2 document emitted
 * by the canonical writer. The materialization id is the only variably-sized
 * field; U+0001 is a valid, non-trimming one-byte UTF-8 value whose JSON form
 * uses the maximum six-byte escape for every protocol-admitted byte.
 */
export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_MAX_SERIALIZED_UTF8_BYTES =
  new TextEncoder().encode(`${JSON.stringify({
    v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
    materializationId: '\u0001'.repeat(CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH),
    subjectScopeDigest: 'f'.repeat(64),
    capability: 'A'.repeat(43),
    httpPort: 65_535,
  })}\n`).byteLength;

function isSha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function isConnectedAccountRequestAuthMaterializationId(
  value: unknown,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && new TextEncoder().encode(value).byteLength
      <= CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH;
}

export function resolveConnectedAccountRequestAuthCapabilityPath(rootDir: string): string {
  return join(resolve(rootDir), CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH);
}

export function parseConnectedAccountRequestAuthCapabilityDocument(
  value: unknown,
): ConnectedAccountRequestAuthCapabilityDocumentV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowedKeys = ['v', 'materializationId', 'subjectScopeDigest', 'capability', 'httpPort'];
  if (Reflect.ownKeys(record).some((key) => (
    typeof key !== 'string'
    || !allowedKeys.includes(key)
  ))) {
    return null;
  }
  const materializationId = record.materializationId;
  const subjectScopeDigest = record.subjectScopeDigest;
  const capability = record.capability;
  if (
    record.v !== CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION
    || !isConnectedAccountRequestAuthMaterializationId(materializationId)
    || typeof subjectScopeDigest !== 'string'
    || !isSha256Digest(subjectScopeDigest)
    || typeof capability !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(capability)
  ) {
    return null;
  }
  const httpPort = record.httpPort;
  if (typeof httpPort !== 'number' || !Number.isSafeInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    return null;
  }
  return Object.freeze({
    v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
    materializationId,
    subjectScopeDigest,
    capability,
    httpPort,
  });
}

export async function readConnectedAccountRequestAuthCapabilityFile(
  path: string,
): Promise<ConnectedAccountRequestAuthCapabilityDocumentV2 | null> {
  try {
    return parseConnectedAccountRequestAuthCapabilityDocument(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}
