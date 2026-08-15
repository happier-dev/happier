import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchSessionById,
  fetchSessionsPage,
  type RawSessionRecord,
} from '@/session/transport/http/sessionsHttp';

export type ResolveSessionIdResult =
  | { ok: true; sessionId: string; rawSession: RawSessionRecord }
  | { ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] };

const FULL_SESSION_ID_LOOKUP_TIMEOUT_MS = 25_000;

function normalizeIdOrPrefix(value: string): string {
  return value.trim();
}

function isFullSessionId(value: string): boolean {
  return /^c[a-z0-9]{24}$/.test(value);
}

export async function resolveSessionIdOrPrefix(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
}>): Promise<ResolveSessionIdResult> {
  const input = normalizeIdOrPrefix(params.idOrPrefix);
  if (!input) return { ok: false, code: 'session_not_found' };

  const resolve = async (signal?: AbortSignal): Promise<ResolveSessionIdResult> => {
    // Prefer exact matches for long inputs, while retaining fallback tag and prefix resolution.
    if (input.length >= 12) {
      const exact = await fetchSessionById({ token: params.credentials.token, sessionId: input, signal });
      if (exact) {
        return { ok: true, sessionId: input, rawSession: exact };
      }
    }

    const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
    const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
    const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;

    let cursor: string | undefined;
    const matches = new Set<string>();
    const rawSessionsById = new Map<string, RawSessionRecord>();

    const recordMatch = (rawSession: RawSessionRecord): ResolveSessionIdResult | null => {
      const id = rawSession.id;
      if (matches.has(id)) return null;
      matches.add(id);
      rawSessionsById.set(id, rawSession);
      if (matches.size > 1) {
        return { ok: false, code: 'session_id_ambiguous', candidates: Array.from(matches).slice(0, 10) };
      }
      return null;
    };

    const scan = async (archivedOnly: boolean): Promise<ResolveSessionIdResult | null> => {
      cursor = undefined;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200, archivedOnly, signal });
        for (const row of page.sessions) {
          const id = row.id;
          if (id.startsWith(input)) {
            const res = recordMatch(row);
            if (res) return res;
          }

          // Also support resolving by exact tag match when metadata is decryptable.
          const meta = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: row });
          const tag = meta && typeof meta.tag === 'string' ? meta.tag.trim() : '';
          if (tag && tag === input) {
            const res = recordMatch(row);
            if (res) return res;
          }
        }
        if (!page.hasNext || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return null;
    };

    const activeScan = await scan(false);
    if (activeScan) return activeScan;
    const archivedScan = await scan(true);
    if (archivedScan) return archivedScan;

    if (matches.size === 1) {
      const sessionId = Array.from(matches)[0]!;
      return { ok: true, sessionId, rawSession: rawSessionsById.get(sessionId)! };
    }
    if (matches.size === 0) return { ok: false, code: 'session_not_found' };
    return { ok: false, code: 'session_id_ambiguous', candidates: Array.from(matches).slice(0, 10) };
  };

  // Built-in tool calls supply server-issued full ids and have a 30s outer budget. Keep
  // existing prefix/tag lookup behavior unchanged; those interactive searches have no
  // equivalent owner deadline and may legitimately require the configured page scan.
  if (!isFullSessionId(input)) return await resolve();

  const controller = new AbortController();
  let didLookupTimeout = false;
  const timeout = setTimeout(() => {
    didLookupTimeout = true;
    controller.abort();
  }, FULL_SESSION_ID_LOOKUP_TIMEOUT_MS);
  timeout.unref();

  try {
    return await resolve(controller.signal);
  } catch (error) {
    if (didLookupTimeout) return { ok: false, code: 'session_lookup_timeout' };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
