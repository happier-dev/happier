import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Scoped broker-refresh capability token (least privilege; hardening finding F2).
 *
 * Shared, provider-agnostic core used by every connected-service auth broker and by the single daemon
 * bridge preHandler that authorizes them. A broker must NOT receive the daemon's full `controlToken`
 * (which authorizes EVERY control endpoint). Instead the daemon mints a NARROW capability token, scoped
 * to the broker-refresh endpoints only, derived
 * deterministically from the master control token:
 *
 *   token = base64url( HMAC-SHA256(controlToken, BROKER_REFRESH_SCOPE_LABEL) )
 *
 * Properties:
 *  - The broker holds ONLY this derived token (injected via the runtime child env), never the master.
 *    A leaked broker token cannot call the broad control surface (the broad endpoints keep
 *    `requireAuth`, which compares the master token; the scoped token does not match it).
 *  - The daemon re-derives the same value from its in-memory master `controlToken` and constant-time
 *    compares — no extra persisted secret, no parallel token-store mechanism.
 *  - It is rebound to the daemon's master secret: a daemon restart re-mints `controlToken`, which
 *    rotates the scoped token.
 *  - It is provider-agnostic: every broker derives the SAME value, so a SINGLE bridge preHandler
 *    authorizes broker refresh calls (no parallel per-provider refresh path / no parallel token mechanism).
 */
export const CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV = 'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN';

/**
 * The only broker credential passed to a child after the v2 capability migration: an absolute path
 * to a private, atomically replaceable capability document. Long-lived brokers reread it for every
 * request so daemon replacement/selection rotation does not require an ambient master secret.
 */
export const CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH_ENV =
  'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH';
export const CONNECTED_SERVICE_BROKER_CAPABILITY_VERSION = 1 as const;
export const CONNECTED_SERVICE_BROKER_CAPABILITY_RELATIVE_PATH = join('broker', 'capability.json');

export type ConnectedServiceBrokerCapabilityDocumentV1 = Readonly<{
  v: typeof CONNECTED_SERVICE_BROKER_CAPABILITY_VERSION;
  materializationId: string;
  selectionIdentityDigest: string;
  capability: string;
}>;

export type ConnectedServiceBrokerCapabilityDescriptor = Readonly<{
  path: string;
  materializationId: string;
  selectionIdentityDigest: string;
  capabilityDigest: string;
}>;

function normalizeNonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function digestValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixedDigestEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function digestConnectedServiceBrokerCapability(value: unknown): string {
  const normalized = normalizeNonEmpty(value);
  return normalized ? digestValue(normalized) : '';
}

export function digestConnectedServiceBrokerSelectionIdentity(value: unknown): string {
  const normalized = normalizeNonEmpty(value);
  return normalized ? digestValue(normalized) : '';
}

export function resolveConnectedServiceBrokerCapabilityPath(rootDir: string): string {
  return join(resolve(rootDir), CONNECTED_SERVICE_BROKER_CAPABILITY_RELATIVE_PATH);
}

function parseCapabilityDocument(value: unknown): ConnectedServiceBrokerCapabilityDocumentV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const materializationId = normalizeNonEmpty(record.materializationId);
  const selectionIdentityDigest = normalizeNonEmpty(record.selectionIdentityDigest);
  const capability = normalizeNonEmpty(record.capability);
  if (
    record.v !== CONNECTED_SERVICE_BROKER_CAPABILITY_VERSION
    || !materializationId
    || !/^[a-f0-9]{64}$/.test(selectionIdentityDigest)
    || !/^[A-Za-z0-9_-]{43}$/.test(capability)
  ) {
    return null;
  }
  return Object.freeze({
    v: CONNECTED_SERVICE_BROKER_CAPABILITY_VERSION,
    materializationId,
    selectionIdentityDigest,
    capability,
  });
}

export async function readConnectedServiceBrokerCapabilityFile(
  path: string,
): Promise<ConnectedServiceBrokerCapabilityDocumentV1 | null> {
  try {
    return parseCapabilityDocument(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export async function writeConnectedServiceBrokerCapabilityFile(input: Readonly<{
  rootDir: string;
  materializationId: string;
  selectionIdentity: string;
}>): Promise<ConnectedServiceBrokerCapabilityDescriptor> {
  const materializationId = normalizeNonEmpty(input.materializationId);
  const selectionIdentityDigest = digestConnectedServiceBrokerSelectionIdentity(input.selectionIdentity);
  if (!materializationId || !selectionIdentityDigest) {
    throw new Error('connected_service_broker_capability_identity_invalid');
  }
  const path = resolveConnectedServiceBrokerCapabilityPath(input.rootDir);
  const capability = randomBytes(32).toString('base64url');
  const document: ConnectedServiceBrokerCapabilityDocumentV1 = {
    v: CONNECTED_SERVICE_BROKER_CAPABILITY_VERSION,
    materializationId,
    selectionIdentityDigest,
    capability,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({
    path,
    materializationId,
    selectionIdentityDigest,
    capabilityDigest: digestConnectedServiceBrokerCapability(capability),
  });
}

export async function verifyConnectedServiceBrokerCapabilityFile(input: Readonly<{
  path: string;
  materializationId: string;
  selectionIdentity: string;
  capabilityDigest: string;
}>): Promise<ConnectedServiceBrokerCapabilityDescriptor | null> {
  try {
    const fileStat = await stat(input.path);
    if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) return null;
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid !== null && fileStat.uid !== currentUid) return null;
    const document = await readConnectedServiceBrokerCapabilityFile(input.path);
    if (!document) return null;
    const materializationId = normalizeNonEmpty(input.materializationId);
    const selectionIdentityDigest = digestConnectedServiceBrokerSelectionIdentity(input.selectionIdentity);
    const capabilityDigest = digestConnectedServiceBrokerCapability(document.capability);
    if (
      document.materializationId !== materializationId
      || !fixedDigestEquals(document.selectionIdentityDigest, selectionIdentityDigest)
      || !fixedDigestEquals(capabilityDigest, normalizeNonEmpty(input.capabilityDigest))
    ) {
      return null;
    }
    return Object.freeze({
      path: resolve(input.path),
      materializationId,
      selectionIdentityDigest,
      capabilityDigest,
    });
  } catch {
    return null;
  }
}

export async function removeConnectedServiceBrokerCapabilityFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Scope label folded into the HMAC. Versioned so a future scope/format change is unambiguous and
 * never collides with the master token or another derived capability. Provider-agnostic: every broker
 * folds the SAME label so the SAME scoped token authorizes the shared bridge.
 */
export const CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL = 'happier:connected-service-broker-refresh:v1';

/**
 * ONE derivation core for every scoped capability token (the scope is the HMAC label; empty
 * inputs fail closed). Every scoped daemon capability (broker refresh, execution-run
 * materialization, future scopes) derives through THIS function — no parallel HMAC/verify
 * implementations.
 */
export function deriveScopedCapabilityToken(
  controlToken: string | null | undefined,
  scopeLabel: string,
): string {
  const normalized = typeof controlToken === 'string' ? controlToken.trim() : '';
  if (!normalized) return '';
  return createHmac('sha256', normalized)
    .update(scopeLabel)
    .digest('base64url');
}

/**
 * Constant-time verification that `provided` is the scoped capability token for `controlToken`
 * under `scopeLabel`. Fails closed on any empty/blank input. Hashes both sides to a fixed length
 * so `timingSafeEqual` never throws on a length mismatch and the comparison stays constant-time
 * regardless of input shape.
 */
export function isValidScopedCapabilityToken(
  provided: string | null | undefined,
  controlToken: string | null | undefined,
  scopeLabel: string,
): boolean {
  const expected = deriveScopedCapabilityToken(controlToken, scopeLabel);
  const candidate = typeof provided === 'string' ? provided.trim() : '';
  if (!expected || !candidate) return false;
  const expectedDigest = createHash('sha256').update(expected).digest();
  const candidateDigest = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

/**
 * Derive the scoped broker-refresh capability token from the daemon master control token.
 * Returns an empty string for an empty/blank control token (fail-closed: an empty token never
 * authorizes anything because the verifier rejects empty providers).
 */
export function deriveConnectedServiceBrokerRefreshToken(controlToken: string | null | undefined): string {
  return deriveScopedCapabilityToken(controlToken, CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
}

/**
 * Constant-time verification that `provided` is the scoped broker-refresh token for `controlToken`.
 * Fails closed on any empty/blank input. Used by the daemon control server's dedicated broker-refresh
 * preHandler (NOT the broad `requireAuth`).
 */
export function isValidConnectedServiceBrokerRefreshToken(
  provided: string | null | undefined,
  controlToken: string | null | undefined,
): boolean {
  return isValidScopedCapabilityToken(provided, controlToken, CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
}
