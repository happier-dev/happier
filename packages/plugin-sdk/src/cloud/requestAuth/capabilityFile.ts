import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV =
  'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH';
export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION = 2 as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH = 256 as const;
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
