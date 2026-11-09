import { type V2SessionByIdResponse, V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import {
  createNotAuthenticatedError,
  isAuthenticationResponseStatus,
  isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';
import {
  createSessionDataKeyHydrationPlan,
  hydrateSessionDataKeys,
  readSessionDataKeyCredentialKind,
} from '@/sync/encryption/sessionDataKeyHydration';
import { readSessionAccessRole } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionDetailAccessProjectionVersion } from '@/sync/api/session/sessionDetailAccessProjection';
import { readSessionByIdHttp } from '@/sync/engine/sessions/sessionByIdHttp';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { createSessionEncryptionUnavailableError } from '@/sync/encryption/sessionEncryptionUnavailableError';

import { createServerRequestForExplicitServerScope } from './createServerRequestWithServerScope';
import type { CapturedServerReadTransport } from './capturedServerReadTransport';
import type { ResolvedServerAccountRequestContext } from './resolveServerAccountRequestContext';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

/**
 * The canonical Session data-key hydration outcome for one explicitly scoped Session.
 *
 * `legacy_fallback` is the owner-only historical reader (`legacy_fallback_ready`): a Session a
 * key-holding owner created before per-Session envelopes. It is never a standalone DEK, so it
 * carries no key and must not be transferred (Follow preparation treats it as unavailable).
 */
export type ScopedSessionCryptoContext =
  | Readonly<{ encryptionMode: 'plain'; sessionDataKey: null }>
  | Readonly<{ encryptionMode: 'e2ee'; sessionDataKey: Uint8Array }>
  | Readonly<{ encryptionMode: 'legacy_fallback'; sessionDataKey: null }>
  | Readonly<{ encryptionMode: 'unknown'; sessionDataKey: null }>;

async function hydrateScopedSessionCryptoContext(params: Readonly<{
  sessionId: string;
  encryptionMode?: 'plain' | 'e2ee';
  dataEncryptionKey: string | null | undefined;
  viewerRole: 'owner' | 'recipient';
  credentials?: AuthCredentials;
  decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
  isCurrent?: () => boolean;
}>): Promise<ScopedSessionCryptoContext> {
  if (params.isCurrent?.() === false) return { encryptionMode: 'unknown', sessionDataKey: null };
  if (params.encryptionMode === 'plain') return { encryptionMode: 'plain', sessionDataKey: null };
  if (!params.decryptEncryptionKey) return { encryptionMode: 'unknown', sessionDataKey: null };
  const sessionDataKeys = new Map<string, Uint8Array>();
  const hydration = await hydrateSessionDataKeys({
    plan: createSessionDataKeyHydrationPlan({
      sessions: [{ id: params.sessionId, encryptionMode: params.encryptionMode,
        dataEncryptionKey: params.dataEncryptionKey, viewerRole: params.viewerRole }],
      credentialKind: readSessionDataKeyCredentialKind(params.credentials),
      sessionDataKeys,
    }),
    encryption: { decryptEncryptionKeys: values => Promise.all(values.map(value => params.decryptEncryptionKey!(value))) },
    sessionDataKeys,
    shouldContinue: params.isCurrent,
  });
  if (hydration.stale) return { encryptionMode: 'unknown', sessionDataKey: null };
  const state = hydration.states.get(params.sessionId);
  if (state === 'legacy_fallback_ready') return { encryptionMode: 'legacy_fallback', sessionDataKey: null };
  const sessionDataKey = hydration.sessionKeys.get(params.sessionId);
  return state === 'ready' && sessionDataKey ? { encryptionMode: 'e2ee', sessionDataKey }
    : { encryptionMode: 'unknown', sessionDataKey: null };
}

/**
 * Installs the Session reader the scoped crypto context selected on the scoped Account
 * encryption owner: the standalone DEK, or `null` for the owner-only historical reader.
 * Returns false when there is no reader to install.
 */
export async function initializeScopedSessionReader(params: Readonly<{
  sessionId: string;
  serverId: string;
  context: ScopedSessionCryptoContext;
  encryption: Readonly<{
    initializeSessions: (keys: Map<string, Uint8Array | null>, scope?: Readonly<{ serverId?: string }>) => Promise<unknown>;
  }>;
}>): Promise<boolean> {
  if (params.context.encryptionMode !== 'e2ee' && params.context.encryptionMode !== 'legacy_fallback') return false;
  await params.encryption.initializeSessions(
    new Map([[params.sessionId, params.context.sessionDataKey]]),
    { serverId: params.serverId },
  );
  return true;
}

async function fetchSessionCryptoContext(params: Readonly<SessionAddress & {
  serverUrl: string;
  runtimeOrigin?: string;
  homeCarrier?: HomeCarrier;
  token: string;
  credentials?: AuthCredentials;
  decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
  timeoutMs: number;
  explicitRetry?: true;
  signal?: AbortSignal;
  readTransport?: CapturedServerReadTransport;
}>): Promise<ScopedSessionCryptoContext> {
  try {
    throwIfAborted(params.signal);
    const request = createServerRequestForExplicitServerScope({
      serverUrl: params.serverUrl,
      token: params.token,
      ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
      ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
    });
    const response = await readSessionByIdHttp({ sessionId: params.sessionId, serverId: params.serverId,
      token: params.token, request: (path, init) => request(path, init, params.explicitRetry ? { retry: 'none' } : undefined),
      readTransport: params.readTransport, accessProjectionVersion: readSessionDetailAccessProjectionVersion(params.serverId),
      timeoutMs: params.timeoutMs, signal: params.signal, retry: params.explicitRetry ? 'none' : undefined });
    if (!response.ok) {
      if (isAuthenticationResponseStatus(response.status)) {
        throw createNotAuthenticatedError(response.status);
      }
      return { encryptionMode: 'unknown', sessionDataKey: null };
    }

    const body = response.body;
    throwIfAborted(params.signal);
    const parsed = V2SessionByIdResponseSchema.safeParse(body);
    if (!parsed.success) return { encryptionMode: 'unknown', sessionDataKey: null };
    const session: V2SessionByIdResponse['session'] = parsed.data.session;
    if (!session) return { encryptionMode: 'unknown', sessionDataKey: null };
    if (normalizeId(session.id) !== params.sessionId) return { encryptionMode: 'unknown', sessionDataKey: null };

    return await hydrateScopedSessionCryptoContext({ sessionId: session.id, encryptionMode: session.encryptionMode,
      dataEncryptionKey: session.dataEncryptionKey,
      viewerRole: readSessionAccessRole(session, { allowLegacy: true }) === 'owner' ? 'owner' : 'recipient',
      credentials: params.credentials, decryptEncryptionKey: params.decryptEncryptionKey,
      isCurrent: () => !params.signal?.aborted });
  } catch (error) {
    if (isTerminalAuthError(error)) {
      throw error;
    }
    return { encryptionMode: 'unknown', sessionDataKey: null };
  }
}

export async function resolveScopedSessionCryptoContext(params: Readonly<SessionAddress & {
  serverUrl: string;
  runtimeOrigin?: string;
  homeCarrier?: HomeCarrier;
  token: string;
  /** The exact scope's stored credentials; the bearer `token` identifies the in-flight operation. */
  credentials?: AuthCredentials;
  decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
  timeoutMs?: number;
  explicitRetry?: true;
  signal?: AbortSignal;
  readTransport?: CapturedServerReadTransport;
}>): Promise<ScopedSessionCryptoContext> {
  const sessionId = normalizeId(params.sessionId);
  const serverId = normalizeId(params.serverId);
  const token = String(params.token ?? '');
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
  // Share only the captured raw observation. Each caller's encryption owner opens
  // and admits its own envelope; a token alone does not identify that crypto owner.
  return await fetchSessionCryptoContext({
      serverId,
      serverUrl: params.serverUrl,
      ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
      ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
      token,
      ...(params.credentials ? { credentials: params.credentials } : {}),
      sessionId,
      decryptEncryptionKey: params.decryptEncryptionKey,
      timeoutMs,
      ...(params.explicitRetry ? { explicitRetry: true } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      readTransport: params.readTransport,
    });
}

type ScopedSessionEncryptionContext = Extract<ResolvedServerAccountRequestContext, { scope: 'scoped' }>;

/**
 * The Session reader for one Session under a captured Account authority.
 *
 * Every scoped context carries a fresh Account encryption owner with no Session readers
 * installed, so a reader is hydrated on demand from the Session's published data-key
 * envelope (or the owner-only historical reader) and installed on that same owner. A
 * Session with no openable reader fails with the typed unavailable error: it is never
 * reported as missing, and never sealed with the Account-scoped reader or as plaintext.
 */
export async function resolveScopedSessionEncryption(params: Readonly<{
  context: ScopedSessionEncryptionContext;
  sessionId: string;
  /** Exact-scope admission already performed by the Session reader; never a list-row projection. */
  admittedSession?: Readonly<{
    id: string;
    encryptionMode: 'plain' | 'e2ee';
    dataEncryptionKey: string | null;
    viewerRole: 'owner' | 'recipient';
    isCurrent: () => boolean;
  }>;
}>): Promise<SessionEncryption> {
  const { context, sessionId, admittedSession } = params;
  const assertCurrent = () => {
    if (admittedSession && (admittedSession.id !== sessionId || !admittedSession.isCurrent())) {
      throw createSessionEncryptionUnavailableError(sessionId, 'scoped_session_encryption_unavailable');
    }
  };
  assertCurrent();
  const encryption = context.encryption;
  if (!encryption) throw createSessionEncryptionUnavailableError(sessionId, 'scoped_session_encryption_unavailable');
  const existing = encryption.getSessionEncryption(sessionId);
  if (existing) return existing;
  const cryptoContext = admittedSession ? await hydrateScopedSessionCryptoContext({
    sessionId, encryptionMode: admittedSession.encryptionMode, dataEncryptionKey: admittedSession.dataEncryptionKey,
    viewerRole: admittedSession.viewerRole, credentials: context.credentials,
    decryptEncryptionKey: value => encryption.decryptEncryptionKey(value, {
      serverId: context.targetServerId, workClass: 'interactive',
    }), isCurrent: admittedSession.isCurrent,
  }) : await resolveScopedSessionCryptoContext({
    serverId: context.targetServerId,
    serverUrl: context.targetServerUrl,
    ...(context.runtimeOrigin ? { runtimeOrigin: context.runtimeOrigin } : {}),
    ...(context.homeCarrier ? { homeCarrier: context.homeCarrier } : {}),
    token: context.token,
    ...(context.credentials ? { credentials: context.credentials } : {}),
    sessionId,
    timeoutMs: context.timeoutMs,
    readTransport: context.readTransport,
    decryptEncryptionKey: (value) => encryption.decryptEncryptionKey(value, {
      serverId: context.targetServerId, workClass: 'interactive',
    }),
  });
  assertCurrent();
  const installed = await initializeScopedSessionReader({
    sessionId,
    serverId: context.targetServerId,
    context: cryptoContext,
    encryption,
  });
  assertCurrent();
  const sessionEncryption = installed ? encryption.getSessionEncryption(sessionId) : null;
  if (!sessionEncryption) throw createSessionEncryptionUnavailableError(sessionId, 'scoped_session_encryption_unavailable');
  return sessionEncryption;
}

/**
 * A Session-reader source for consumers that seal or open one Session's content under a
 * captured Account authority. `null` for a token-only Account, which has no E2EE material.
 */
export function createScopedSessionEncryptionSource(context: ScopedSessionEncryptionContext): Readonly<{
  getSessionEncryption: (sessionId: string) => Promise<SessionEncryption>;
}> | null {
  if (!context.encryption) return null;
  return {
    getSessionEncryption: (sessionId) => resolveScopedSessionEncryption({ context, sessionId }),
  };
}
