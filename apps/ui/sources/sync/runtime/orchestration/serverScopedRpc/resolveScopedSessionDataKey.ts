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

const sessionDataKeyCache = new Map<string, Uint8Array | null>();
const tokenCacheKeyByToken = new Map<string, string>();

function readMaxSessionKeyCacheEntriesFromEnv(): number {
  const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SESSION_KEY_CACHE_MAX ?? '').trim();
  if (!raw) return 256;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 256;
  return Math.max(1, Math.min(10_000, parsed));
}

function getSessionDataKeyFromCache(cacheKey: string): Uint8Array | null | undefined {
  const existing = sessionDataKeyCache.get(cacheKey);
  if (existing === undefined) return undefined;
  // Refresh LRU ordering.
  sessionDataKeyCache.delete(cacheKey);
  sessionDataKeyCache.set(cacheKey, existing);
  return existing;
}

function setSessionDataKeyCache(cacheKey: string, value: Uint8Array | null): void {
  sessionDataKeyCache.set(cacheKey, value);

  const max = readMaxSessionKeyCacheEntriesFromEnv();
  while (sessionDataKeyCache.size > max) {
    const oldest = sessionDataKeyCache.keys().next();
    if (oldest.done) break;
    sessionDataKeyCache.delete(oldest.value);
  }
}

async function fetchSessionDataKey(params: Readonly<{
  serverUrl: string;
  token: string;
  sessionId: string;
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  timeoutMs: number;
}>): Promise<Uint8Array | null> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs)) : null;

  try {
    const response = await fetch(`${params.serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { session?: { id: string; dataEncryptionKey?: string | null } };
    const session = body?.session ?? null;
    if (!session) return null;
    if (normalizeId(session.id) !== params.sessionId) return null;
    const dek = typeof session.dataEncryptionKey === 'string' ? session.dataEncryptionKey : null;
    if (!dek) return null;

    return await params.decryptEncryptionKey(dek);
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function resolveScopedSessionDataKey(params: Readonly<{
  serverId: string;
  serverUrl: string;
  token: string;
  sessionId: string;
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  timeoutMs?: number;
}>): Promise<Uint8Array | null> {
  const sessionId = normalizeId(params.sessionId);
  const serverId = normalizeId(params.serverId);
  const token = String(params.token ?? '');
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
  const keyCacheKey = toSessionDataKeyCacheKey(serverId, sessionId, token);

  let sessionDataKey = getSessionDataKeyFromCache(keyCacheKey);
  if (sessionDataKey === undefined) {
    sessionDataKey = await fetchSessionDataKey({
      serverUrl: params.serverUrl,
      token,
      sessionId,
      decryptEncryptionKey: params.decryptEncryptionKey,
      timeoutMs,
    });
    setSessionDataKeyCache(keyCacheKey, sessionDataKey ?? null);
  }

  return sessionDataKey ?? null;
}

export function resetScopedSessionDataKeyCacheForTests(): void {
  sessionDataKeyCache.clear();
  tokenCacheKeyByToken.clear();
}

