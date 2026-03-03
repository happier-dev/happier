import { type V2SessionByIdResponse, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function getOrCreateTokenCacheKey(token: string): string {
  // Avoid using the raw token in cache keys (accidental leaks in error/debug output),
  // but also avoid collision-prone hashing (which can cause cross-token cache reuse).
  let key = tokenCacheKeyByToken.get(token);
  if (key) return key;

  const cryptoAny = (globalThis as any).crypto as { randomUUID?: () => string } | undefined;
  key =
    typeof cryptoAny?.randomUUID === 'function'
      ? cryptoAny.randomUUID()
      : `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  tokenCacheKeyByToken.set(token, key);
  return key;
}

function toSessionDataKeyCacheKey(serverId: string, sessionId: string, token: string): string {
  return `${serverId}::${sessionId}::${getOrCreateTokenCacheKey(token)}`;
}

export type ScopedSessionCryptoContext =
  | Readonly<{ encryptionMode: 'plain'; sessionDataKey: null }>
  | Readonly<{ encryptionMode: 'e2ee'; sessionDataKey: Uint8Array }>
  | Readonly<{ encryptionMode: 'unknown'; sessionDataKey: null }>;

const sessionCryptoContextCache = new Map<string, ScopedSessionCryptoContext>();
const tokenCacheKeyByToken = new Map<string, string>();

function readMaxSessionKeyCacheEntriesFromEnv(): number {
  const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SESSION_KEY_CACHE_MAX ?? '').trim();
  if (!raw) return 256;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 256;
  return Math.max(1, Math.min(10_000, parsed));
}

function getSessionCryptoContextFromCache(cacheKey: string): ScopedSessionCryptoContext | undefined {
  const existing = sessionCryptoContextCache.get(cacheKey);
  if (existing === undefined) return undefined;
  // Refresh LRU ordering.
  sessionCryptoContextCache.delete(cacheKey);
  sessionCryptoContextCache.set(cacheKey, existing);
  return existing;
}

function setSessionCryptoContextCache(cacheKey: string, value: ScopedSessionCryptoContext): void {
  sessionCryptoContextCache.set(cacheKey, value);

  const max = readMaxSessionKeyCacheEntriesFromEnv();
  while (sessionCryptoContextCache.size > max) {
    const oldest = sessionCryptoContextCache.keys().next();
    if (oldest.done) break;
    sessionCryptoContextCache.delete(oldest.value);
  }
}

async function fetchSessionCryptoContext(params: Readonly<{
  serverUrl: string;
  token: string;
  sessionId: string;
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  timeoutMs: number;
}>): Promise<ScopedSessionCryptoContext> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs)) : null;

  try {
    const response = await runtimeFetch(`${params.serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return { encryptionMode: 'unknown', sessionDataKey: null };

    const body = (await response.json()) as unknown;
    const parsed = V2SessionByIdResponseSchema.safeParse(body);
    if (!parsed.success) return { encryptionMode: 'unknown', sessionDataKey: null };
    const session: V2SessionByIdResponse['session'] = parsed.data.session;
    if (!session) return { encryptionMode: 'unknown', sessionDataKey: null };
    if (normalizeId(session.id) !== params.sessionId) return { encryptionMode: 'unknown', sessionDataKey: null };

    if (session.encryptionMode === 'plain') {
      return { encryptionMode: 'plain', sessionDataKey: null };
    }

    const dek = typeof session.dataEncryptionKey === 'string' ? session.dataEncryptionKey : null;
    if (!dek) return { encryptionMode: 'unknown', sessionDataKey: null };

    const sessionDataKey = await params.decryptEncryptionKey(dek);
    if (!sessionDataKey) return { encryptionMode: 'unknown', sessionDataKey: null };
    return { encryptionMode: 'e2ee', sessionDataKey };
  } catch {
    return { encryptionMode: 'unknown', sessionDataKey: null };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function resolveScopedSessionCryptoContext(params: Readonly<{
  serverId: string;
  serverUrl: string;
  token: string;
  sessionId: string;
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  timeoutMs?: number;
}>): Promise<ScopedSessionCryptoContext> {
  const sessionId = normalizeId(params.sessionId);
  const serverId = normalizeId(params.serverId);
  const token = String(params.token ?? '');
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
  const keyCacheKey = toSessionDataKeyCacheKey(serverId, sessionId, token);

  let context = getSessionCryptoContextFromCache(keyCacheKey);
  if (context === undefined) {
    context = await fetchSessionCryptoContext({
      serverUrl: params.serverUrl,
      token,
      sessionId,
      decryptEncryptionKey: params.decryptEncryptionKey,
      timeoutMs,
    });
    // Cache only stable outcomes; transient fetch failures should be retried.
    if (context.encryptionMode !== 'unknown') {
      setSessionCryptoContextCache(keyCacheKey, context);
    }
  }

  return context;
}

export async function resolveScopedSessionDataKey(params: Readonly<{
  serverId: string;
  serverUrl: string;
  token: string;
  sessionId: string;
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  timeoutMs?: number;
}>): Promise<Uint8Array | null> {
  const context = await resolveScopedSessionCryptoContext(params);
  return context.encryptionMode === 'e2ee' ? context.sessionDataKey : null;
}

export function resetScopedSessionDataKeyCacheForTests(): void {
  sessionCryptoContextCache.clear();
  tokenCacheKeyByToken.clear();
}
