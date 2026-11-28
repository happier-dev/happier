import { createHash } from 'node:crypto';

import type { MemorySettingsV1 } from '@happier-dev/protocol';

import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';
import { readSessionOwnerLocality, tryDecryptSessionOwnerMetadata, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

import { selectSessionsForBackfill } from './selectSessionsForBackfill';

/** Locality comes from the canonical opened owner metadata, including E2EE. */
export function isMemorySessionOnMachine(params: Readonly<{
  session: RawSessionListRow;
  machineId: string;
  credentials: StoredCredentials;
  accountEncryptionMode: 'plain' | 'e2ee';
}>): boolean {
  const input = {
    credentials: params.credentials, accountEncryptionMode: params.accountEncryptionMode, rawSession: params.session,
  };
  // Machine locality is owner-private; the shared presentation envelope is unrelated.
  if (params.session.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
    return tryDecryptSessionOwnerMetadata(input)?.workspace?.machineId === params.machineId;
  }
  const metadata = tryDecryptSessionOwnerMetadataView(input);
  return readSessionOwnerLocality({ metadata, rawSession: params.session })?.machineId === params.machineId;
}

export function createMemorySessionLocalityReader(params: Readonly<{
  machineId: string;
  credentials: StoredCredentials;
}>) {
  // Every caller obtains a freshly authorized row and current Account mode.
  // Retain only the inputs and boolean locality, never opened owner metadata.
  const ownerLocality = new Map<string, Readonly<{ key: string; local: boolean }>>();
  let materialType = params.credentials.encryption?.type;
  const readKey = () => params.credentials.encryption?.type === 'legacy'
    ? params.credentials.encryption.secret : params.credentials.encryption?.machineKey;
  let materialBytes = readKey()?.slice();
  return {
    isOnMachine: (session: RawSessionListRow, accountEncryptionMode: 'plain' | 'e2ee') => {
      const key = readKey();
      if (materialType !== params.credentials.encryption?.type
        || materialBytes?.length !== key?.length
        || (key && !key.every((value, index) => materialBytes?.[index] === value))) {
        ownerLocality.clear();
        materialType = params.credentials.encryption?.type;
        materialBytes = key?.slice();
      }
      const envelope = session.ownerMetadata;
      const ciphertext = accountEncryptionMode === 'e2ee'
        && session.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
        && envelope?.t === 'encrypted' && typeof envelope.c === 'string'
        ? envelope.c : null;
      // Legacy locality also depends on Session content-key/access selection
      // and its released raw locality fallback. Presence/recency is unrelated.
      const legacy = session as RawSessionListRow & Readonly<{ machineId?: unknown; host?: unknown; homeDir?: unknown }>;
      const contentKey = ciphertext !== null ? JSON.stringify([1, ciphertext])
        : accountEncryptionMode === 'e2ee' && (session.metadataLayoutVersion === undefined || session.metadataLayoutVersion === 0)
          ? JSON.stringify([0, session.encryptionMode, session.metadata, session.dataEncryptionKey,
            readSessionAccessProjectionRoleV1(session), legacy.machineId, legacy.host, legacy.homeDir]) : null;
      // Remember a digest of the inputs, not the inputs: owner ciphertext is kilobytes
      // per Session and this reader lives as long as the worker that pages every Session.
      const contentDigest = contentKey === null ? null : createHash('sha256').update(contentKey).digest('base64');
      const retained = ownerLocality.get(session.id);
      if (contentDigest !== null && retained?.key === contentDigest) return retained.local;
      const local = isMemorySessionOnMachine({ ...params, session, accountEncryptionMode });
      if (contentDigest !== null) ownerLocality.set(session.id, { key: contentDigest, local });
      else ownerLocality.delete(session.id);
      return local;
    },
    forget: (sessionIds: readonly string[]) => { for (const id of sessionIds) ownerLocality.delete(id); },
    clear: () => { ownerLocality.clear(); },
  };
}

/**
 * The two Session inventories the daemon memory worker may page. `active` is
 * the ordinary `/v2/sessions` listing, which the server already excludes
 * archived rows from; `archived` is the separate archived listing.
 */
export type MemoryInventoryScope = 'active' | 'archived';

export type MemoryInventoryScopeCursorV1 = Readonly<{
  cursor: string | null;
  hasNext: boolean;
}>;

export type MemoryInventoryState = Readonly<Record<MemoryInventoryScope, MemoryInventoryScopeCursorV1>>;

export const INITIAL_MEMORY_INVENTORY_STATE: MemoryInventoryState = Object.freeze({
  active: Object.freeze({ cursor: null, hasNext: true }),
  archived: Object.freeze({ cursor: null, hasNext: true }),
});

export type MemoryInventoryPage = Readonly<{
  sessions: ReadonlyArray<RawSessionListRow>;
  nextCursor: string | null;
  hasNext: boolean;
}>;

export type MemoryInventoryPageFetcher = (args: Readonly<{
  scope: MemoryInventoryScope;
  cursor?: string;
  limit: number;
  signal?: AbortSignal;
}>) => Promise<MemoryInventoryPage>;

export type MemoryInventoryRefresh = Readonly<{
  /**
   * `snapshot` replaces the candidate set from the head page of every eligible
   * inventory (`new_only`); `append` extends it while paging (`last_30_days`,
   * `all_history`).
   */
  mode: 'snapshot' | 'append';
  sessionIds: readonly string[];
  allowInitialBackfillSessionIds: readonly string[];
  observedSeqBySessionId: ReadonlyMap<string, number>;
  state: MemoryInventoryState;
}>;

/**
 * The archived inventory is requested for indexing only under an explicit
 * opt-in. This is the single place that decides it, so no policy branch can
 * silently inventory archived Sessions.
 */
export function resolveMemoryInventoryScopes(
  includeArchivedSessions: boolean,
): readonly MemoryInventoryScope[] {
  return includeArchivedSessions ? ['active', 'archived'] : ['active'];
}

function readSessionId(row: RawSessionListRow): string {
  const raw = (row as { id?: unknown }).id;
  return typeof raw === 'string' ? raw.trim() : '';
}

function readObservedSeq(row: RawSessionListRow): number {
  const raw = (row as { seq?: unknown }).seq;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

function readCreatedAtMs(row: RawSessionListRow): number {
  const raw = (row as { createdAt?: unknown }).createdAt;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

function readMeaningfulActivityAtMs(row: RawSessionListRow): number {
  for (const raw of [
    (row as { meaningfulActivityAt?: unknown }).meaningfulActivityAt,
    (row as { updatedAt?: unknown }).updatedAt,
    (row as { activeAt?: unknown }).activeAt,
    (row as { createdAt?: unknown }).createdAt,
  ]) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  }
  return 0;
}

export type MemoryInventorySessionEligibility = Readonly<{
  sessionId: string;
  observedSeq: number;
  allowInitialBackfill: boolean;
}>;

/**
 * The one per-Session eligibility decision used by paged inventory and by an
 * explicit `ensureUpToDate(sessionId)` request. The explicit path must not turn
 * `new_only` into all-history or bypass archived opt-in.
 */
export function resolveMemoryInventorySessionEligibility(params: Readonly<{
  session: RawSessionListRow;
  backfillPolicy: MemorySettingsV1['backfillPolicy'];
  includeArchivedSessions: boolean;
  enabledAtMs: number;
  nowMs: number;
}>): MemoryInventorySessionEligibility | null {
  const sessionId = readSessionId(params.session);
  if (!sessionId) return null;
  const archivedAt = (params.session as { archivedAt?: unknown }).archivedAt;
  if (archivedAt !== null && archivedAt !== undefined && !params.includeArchivedSessions) {
    return null;
  }
  const selected = selectSessionsForBackfill({
    sessions: [params.session],
    backfillPolicy: params.backfillPolicy,
    nowMs: params.nowMs,
  });
  if (!selected.sessionIds.includes(sessionId)) return null;
  const enabledAtMs = Math.max(0, Math.trunc(params.enabledAtMs));
  return {
    sessionId,
    observedSeq: readObservedSeq(params.session),
    allowInitialBackfill: params.backfillPolicy === 'new_only'
      && enabledAtMs > 0
      && readCreatedAtMs(params.session) >= enabledAtMs,
  };
}

/**
 * One eligibility and inventory pass shared by every backfill policy and by
 * `ensureUpToDate`. Callers own persistence of the returned cursor state and
 * the candidate set; they never decide which inventories to read.
 */
export async function refreshMemoryInventoryOnce(params: Readonly<{
  backfillPolicy: MemorySettingsV1['backfillPolicy'];
  includeArchivedSessions: boolean;
  enabledAtMs: number;
  pageLimit: number;
  nowMs: number;
  state: MemoryInventoryState;
  seenSessionIds: ReadonlySet<string>;
  fetchSessionsPage: MemoryInventoryPageFetcher;
  isSessionEligible?: (session: RawSessionListRow) => boolean;
  signal?: AbortSignal;
}>): Promise<MemoryInventoryRefresh> {
  const scopes = resolveMemoryInventoryScopes(params.includeArchivedSessions);
  const limit = Math.max(1, Math.trunc(params.pageLimit));
  const isSnapshot = params.backfillPolicy === 'new_only';
  const enabledAtMs = Math.max(0, Math.trunc(params.enabledAtMs));

  const sessionIds: string[] = [];
  const allowInitialBackfillSessionIds: string[] = [];
  const observedSeqBySessionId = new Map<string, number>();
  const emitted = new Set<string>();
  const nextState: Record<MemoryInventoryScope, MemoryInventoryScopeCursorV1> = {
    active: params.state.active,
    archived: params.state.archived,
  };

  for (const scope of scopes) {
    params.signal?.throwIfAborted();
    const scopeState = params.state[scope];
    if (isSnapshot) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const page = await params.fetchSessionsPage({
          scope,
          ...(cursor === undefined ? {} : { cursor }),
          limit,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        params.signal?.throwIfAborted();
        for (const row of page.sessions) {
          if (params.isSessionEligible && !params.isSessionEligible(row)) continue;
          const eligibility = resolveMemoryInventorySessionEligibility({
            session: row,
            backfillPolicy: params.backfillPolicy,
            includeArchivedSessions: params.includeArchivedSessions,
            enabledAtMs,
            nowMs: params.nowMs,
          });
          if (!eligibility || emitted.has(eligibility.sessionId)) continue;
          emitted.add(eligibility.sessionId);
          observedSeqBySessionId.set(eligibility.sessionId, eligibility.observedSeq);
          if (eligibility.allowInitialBackfill) {
            allowInitialBackfillSessionIds.push(eligibility.sessionId);
          }
          sessionIds.push(eligibility.sessionId);
        }
        // The first active page may prepend pinned rows ahead of its
        // meaningful-activity ordering. Its final row still belongs to the
        // ordered page used to derive nextCursor, so only that row can prove
        // this inventory has crossed the enablement boundary.
        const finalOrderedRow = page.sessions.at(-1);
        const crossedEnablementBoundary = enabledAtMs > 0
          && finalOrderedRow !== undefined
          && readMeaningfulActivityAtMs(finalOrderedRow) < enabledAtMs;
        if (enabledAtMs <= 0 || crossedEnablementBoundary || !page.hasNext || !page.nextCursor) break;
        if (seenCursors.has(page.nextCursor)) {
          throw new Error('memory_inventory_cursor_stalled');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      nextState[scope] = INITIAL_MEMORY_INVENTORY_STATE[scope];
      continue;
    }

    const cursor = scopeState.hasNext ? scopeState.cursor ?? undefined : undefined;
    const page = await params.fetchSessionsPage({
      scope,
      ...(cursor === undefined ? {} : { cursor }),
      limit,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();

    const selected = selectSessionsForBackfill({
      sessions: page.sessions,
      backfillPolicy: params.backfillPolicy,
      nowMs: params.nowMs,
    });
    const rowsById = new Map<string, RawSessionListRow>();
    for (const row of page.sessions) {
      const id = readSessionId(row);
      if (!rowsById.has(id)) rowsById.set(id, row);
    }
    for (const id of selected.sessionIds) {
      if (!id || emitted.has(id)) continue;
      const row = rowsById.get(id);
      if (!row) continue;
      if (params.isSessionEligible && !params.isSessionEligible(row)) continue;
      const eligibility = resolveMemoryInventorySessionEligibility({
        session: row,
        backfillPolicy: params.backfillPolicy,
        includeArchivedSessions: params.includeArchivedSessions,
        enabledAtMs,
        nowMs: params.nowMs,
      });
      if (!eligibility) continue;
      emitted.add(id);
      observedSeqBySessionId.set(id, eligibility.observedSeq);
      if (params.seenSessionIds.has(id)) continue;
      sessionIds.push(id);
    }

    if (!scopeState.hasNext) {
      nextState[scope] = { cursor: null, hasNext: false };
    } else if (selected.shouldStopPaging) {
      nextState[scope] = { cursor: null, hasNext: false };
    } else {
      nextState[scope] = { cursor: page.nextCursor, hasNext: Boolean(page.hasNext) };
    }
  }

  return {
    mode: isSnapshot ? 'snapshot' : 'append',
    sessionIds,
    allowInitialBackfillSessionIds,
    observedSeqBySessionId,
    state: nextState,
  };
}
