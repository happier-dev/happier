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
import { buildSessionDetailAccessProjectionQuery } from '@/sync/api/session/sessionDetailAccessProjection';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { createSessionEncryptionUnavailableError } from '@/sync/encryption/sessionEncryptionUnavailableError';

import { getOrCreateScopedCacheTokenKey, resetScopedCacheTokenKeysForTests } from './scopedCacheTokenKey';
import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';
import { createServerRequestForExplicitServerScope } from './createServerRequestWithServerScope';
import type { ResolvedServerAccountRequestContext } from './resolveServerAccountRequestContext';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function toSessionDataKeyCacheKey(serverId: string, sessionId: string, token: string): string {
  const tokenKey = getOrCreateScopedCacheTokenKey(token, readMaxSessionKeyCacheEntriesFromEnv());
  return `${serverId}::${sessionId}::${tokenKey}`;
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

const sessionCryptoContextResolutions = createScopedResolutionSingleFlight<ScopedSessionCryptoContext>();

function readMaxSessionKeyCacheEntriesFromEnv(): number {
  const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SESSION_KEY_CACHE_MAX ?? '').trim();
  if (!raw) return 256;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 256;
  return Math.max(1, Math.min(10_000, parsed));
}

async function fetchSessionCryptoContext(params: Readonly<SessionAddress & {
  serverUrl: string;
  runtimeOrigin?: string;
  homeCarrier?: HomeCarrier;
  token: string;
  credentials?: AuthCredentials;
  decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
  timeoutMs: number;
}>): Promise<ScopedSessionCryptoContext> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs)) : null;

  try {
    const request = createServerRequestForExplicitServerScope({
      serverUrl: params.serverUrl,
      token: params.token,
      ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
      ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
      timeoutMs: params.timeoutMs,
    });
    const response = await request(`/v2/sessions/${encodeURIComponent(params.sessionId)}${buildSessionDetailAccessProjectionQuery(params.serverId)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      if (isAuthenticationResponseStatus(response.status)) {
        throw createNotAuthenticatedError(response.status);
      }
      return { encryptionMode: 'unknown', sessionDataKey: null };
    }

    const body = (await response.json()) as unknown;
    const parsed = V2SessionByIdResponseSchema.safeParse(body);
    if (!parsed.success) return { encryptionMode: 'unknown', sessionDataKey: null };
    const session: V2SessionByIdResponse['session'] = parsed.data.session;
    if (!session) return { encryptionMode: 'unknown', sessionDataKey: null };
    if (normalizeId(session.id) !== params.sessionId) return { encryptionMode: 'unknown', sessionDataKey: null };

    if (session.encryptionMode === 'plain') {
      return { encryptionMode: 'plain', sessionDataKey: null };
    }

    if (!params.decryptEncryptionKey) {
      return { encryptionMode: 'unknown', sessionDataKey: null };
    }
    const sessionDataKeys = new Map<string, Uint8Array>();
    const hydration = await hydrateSessionDataKeys({
      plan: createSessionDataKeyHydrationPlan({
        sessions: [{
          id: session.id,
          encryptionMode: session.encryptionMode,
          dataEncryptionKey: session.dataEncryptionKey,
          viewerRole: readSessionAccessRole(session, { allowLegacy: true }) === 'owner' ? 'owner' : 'recipient',
        }],
        // The captured credentials of this exact scope decide whether an owner Session with a
        // genuinely absent envelope keeps its historical Account-scoped reader, exactly as
        // full hydration decides it. Keyless or absent credentials never reach it.
        credentialKind: readSessionDataKeyCredentialKind(params.credentials),
        sessionDataKeys,
      }),
      encryption: {
        decryptEncryptionKeys: (values) => Promise.all(values.map((value) => params.decryptEncryptionKey!(value))),
      },
      sessionDataKeys,
    });
    if (hydration.stale) return { encryptionMode: 'unknown', sessionDataKey: null };
    const state = hydration.states.get(session.id);
    if (state === 'legacy_fallback_ready') return { encryptionMode: 'legacy_fallback', sessionDataKey: null };
    const sessionDataKey = hydration.sessionKeys.get(session.id);
    if (state !== 'ready' || !sessionDataKey) {
      return { encryptionMode: 'unknown', sessionDataKey: null };
    }
    return { encryptionMode: 'e2ee', sessionDataKey };
  } catch (error) {
    if (isTerminalAuthError(error)) {
      throw error;
    }
    return { encryptionMode: 'unknown', sessionDataKey: null };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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
}>): Promise<ScopedSessionCryptoContext> {
  const sessionId = normalizeId(params.sessionId);
  const serverId = normalizeId(params.serverId);
  const token = String(params.token ?? '');
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
  const keyCacheKey = toSessionDataKeyCacheKey(serverId, sessionId, token);

  // Coalesce concurrent callers for the same operation; without this, a burst of
  // callers repeats the by-id fetch and asymmetric envelope open. Settled results
  // deliberately do not survive the operation: the Home may repair or rotate the
  // published envelope while the bearer remains unchanged.
  // `keyCacheKey` covers the target server, the session and the bearer token, and the
  // token determines the credentials behind the caller's `decryptEncryptionKey`, so a
  // joiner can only ever adopt a result computed from its own inputs.
  return await sessionCryptoContextResolutions.run(keyCacheKey, async () => {
    const context = await fetchSessionCryptoContext({
      serverId,
      serverUrl: params.serverUrl,
      ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
      ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
      token,
      ...(params.credentials ? { credentials: params.credentials } : {}),
      sessionId,
      decryptEncryptionKey: params.decryptEncryptionKey,
      timeoutMs,
    });
    return context;
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
}>): Promise<SessionEncryption> {
  const { context, sessionId } = params;
  const encryption = context.encryption;
  if (!encryption) throw createSessionEncryptionUnavailableError(sessionId, 'scoped_session_encryption_unavailable');
  const existing = encryption.getSessionEncryption(sessionId);
  if (existing) return existing;
  const cryptoContext = await resolveScopedSessionCryptoContext({
    serverId: context.targetServerId,
    serverUrl: context.targetServerUrl,
    ...(context.runtimeOrigin ? { runtimeOrigin: context.runtimeOrigin } : {}),
    ...(context.homeCarrier ? { homeCarrier: context.homeCarrier } : {}),
    token: context.token,
    ...(context.credentials ? { credentials: context.credentials } : {}),
    sessionId,
    timeoutMs: context.timeoutMs,
    decryptEncryptionKey: (value) => encryption.decryptEncryptionKey(value),
  });
  const installed = await initializeScopedSessionReader({
    sessionId,
    serverId: context.targetServerId,
    context: cryptoContext,
    encryption,
  });
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

export function resetScopedSessionDataKeyCacheForTests(): void {
  sessionCryptoContextResolutions.reset();
  resetScopedCacheTokenKeysForTests();
}
