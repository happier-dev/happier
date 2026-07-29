import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type { PluginOperationAvailability, PluginSessionService, PluginSessionSummary, PluginSessionsService, PluginSessionWatchEvent, PluginSessionWatchQuery } from '@happier-dev/plugin-sdk/runtime';
import { randomUUID } from 'node:crypto';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { Credentials } from '@/persistence';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchSessionById,
  fetchSessionsPage,
  type RawSessionListRow,
  type RawSessionRecord,
} from '@/session/transport/http/sessionsHttp';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

const CURSOR_PREFIX = 'plugin_sessions_v1_';
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_SCAN_PAGES = 1_000;
const MAX_INVENTORY_ITEMS = 100_000;
const MAX_CURSOR_ENTRIES = 128;
const DEFAULT_WATCH_POLL_INTERVAL_MS = 1_000;

type StoragePolicy = PluginSessionSummary['storagePolicy'];
type InventoryQuery = Readonly<{
  machineId?: string;
  projectId?: string;
  state?: PluginSessionSummary['state'];
}>;

export type PluginSessionsInventoryParams = Readonly<{
  credentials: Credentials;
  currentSessionId: string;
  isCurrent: () => boolean;
  readStoragePolicy?: () => Promise<StoragePolicy>;
  fetchPage?: (params: Readonly<{
    token: string;
    cursor?: string;
    limit?: number;
    archivedOnly?: boolean;
  }>) => Promise<{ sessions: RawSessionListRow[]; nextCursor: string | null; hasNext: boolean }>;
  fetchById?: (params: Readonly<{
    token: string;
    sessionId: string;
  }>) => Promise<RawSessionRecord | null>;
  watchPollIntervalMs?: number;
}>;

type InventoryPhase = 'unarchived' | 'archived';
type CursorSnapshot = Readonly<{
  queryKey: string;
  items: readonly PluginSessionSummary[];
  offset: number;
}>;
type WithoutRevision<T> = T extends unknown ? Omit<T, 'revision'> : never;
type PluginSessionWatchEventInput = WithoutRevision<PluginSessionWatchEvent>;

function pluginError(code: string, message: string): PluginError {
  return new PluginError({ code, message });
}

async function callInventoryBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PluginError) throw error;
    if (readAuthenticationStatus(error) !== null) {
      throw pluginError('plugin_sessions_not_authenticated', 'Session inventory authentication failed');
    }
    throw new PluginError({
      code: 'plugin_sessions_inventory_unavailable',
      message: 'Session inventory is temporarily unavailable',
      retryable: true,
    });
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw pluginError('plugin_operation_aborted', 'Plugin session operation was aborted');
}

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeQuery(query: InventoryQuery): InventoryQuery {
  return Object.freeze({
    ...(normalizeFilter(query.machineId) ? { machineId: normalizeFilter(query.machineId) } : {}),
    ...(normalizeFilter(query.projectId) ? { projectId: normalizeFilter(query.projectId) } : {}),
    ...(query.state ? { state: query.state } : {}),
  });
}

function queryKey(query: InventoryQuery): string {
  return JSON.stringify([query.machineId ?? null, query.projectId ?? null, query.state ?? null]);
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readRawString(raw: RawSessionListRow | RawSessionRecord, key: string): string | undefined {
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readTitle(metadata: Record<string, unknown> | null): string | undefined {
  const summary = metadata?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined;
  return readMetadataString(summary as Record<string, unknown>, 'text');
}

function runtimeAvailability(state: PluginSessionSummary['state']): PluginOperationAvailability {
  return state === 'active' || state === 'idle'
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({
        status: 'unavailable' as const,
        code: state === 'archived' ? 'session_archived' : 'session_runtime_inactive',
      });
}

function sessionState(raw: RawSessionListRow | RawSessionRecord): PluginSessionSummary['state'] {
  if (typeof raw.archivedAt === 'number') return 'archived';
  return raw.active ? 'active' : 'stopped';
}

function projectSessionSummary(params: Readonly<{
  credentials: Credentials;
  raw: RawSessionListRow | RawSessionRecord;
  storagePolicy: StoragePolicy;
}>): PluginSessionSummary {
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: params.raw,
  });
  const machineId = readRawString(params.raw, 'machineId') ?? readMetadataString(metadata, 'machineId');
  if (!machineId) {
    throw pluginError('plugin_session_identity_unavailable', 'Session machine identity is unavailable');
  }
  const state = sessionState(params.raw);
  const title = readTitle(metadata);
  const projectId = readRawString(params.raw, 'projectId') ?? readMetadataString(metadata, 'projectId');
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  return Object.freeze({
    id: params.raw.id,
    ...(title ? { title } : {}),
    machineId,
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
    state,
    runtimeAvailability: runtimeAvailability(state),
    storagePolicy: params.storagePolicy,
    encryptionMode: params.raw.encryptionMode === 'plain' ? 'plain' : 'e2ee',
    updatedAtMs: params.raw.updatedAt,
  });
}

function matchesQuery(summary: PluginSessionSummary, query: InventoryQuery): boolean {
  return (!query.machineId || summary.machineId === query.machineId)
    && (!query.projectId || summary.projectId === query.projectId)
    && (!query.state || summary.state === query.state);
}

async function defaultReadStoragePolicy(): Promise<StoragePolicy> {
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() });
  return snapshot.status === 'ready'
    ? snapshot.features.capabilities.encryption.storagePolicy
    : 'required_e2ee';
}

export function createPluginSessionsInventory(params: PluginSessionsInventoryParams): PluginSessionsService {
  const base = createUnavailablePluginServices().sessions;
  const fetchPage = params.fetchPage ?? (async (request) => await fetchSessionsPage(request));
  const fetchById = params.fetchById ?? (async (request) => await fetchSessionById(request));
  const readStoragePolicy = params.readStoragePolicy ?? defaultReadStoragePolicy;
  const pollIntervalMs = Math.max(1, Math.floor(params.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS));
  const cursors = new Map<string, CursorSnapshot>();

  const isGenerationCurrent = (): boolean => {
    try {
      return params.isCurrent() === true;
    } catch {
      return false;
    }
  };
  const assertGenerationCurrent = (): void => {
    if (!isGenerationCurrent()) throw pluginError('plugin_generation_retired', 'Plugin generation is retired');
  };
  const availability = (): PluginOperationAvailability => isGenerationCurrent()
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'unavailable' as const, code: 'plugin_generation_retired' });

  const createSessionService = (sessionId: string): PluginSessionService => Object.freeze({
    async summary(options?: { signal?: AbortSignal }) {
      assertNotAborted(options?.signal);
      assertGenerationCurrent();
      const raw = await callInventoryBoundary(async () => await fetchById({ token: params.credentials.token, sessionId }));
      assertNotAborted(options?.signal);
      assertGenerationCurrent();
      if (!raw) throw pluginError('plugin_session_not_found', 'Session is not available to this account');
      const storagePolicy = await callInventoryBoundary(readStoragePolicy);
      assertNotAborted(options?.signal);
      assertGenerationCurrent();
      return projectSessionSummary({ credentials: params.credentials, raw, storagePolicy });
    },
    async send() {
      throw pluginError('plugin_session_messaging_unavailable', 'Durable plugin session messaging is unavailable');
    },
    watch(): Disposable {
      throw pluginError('plugin_session_messaging_unavailable', 'Durable plugin session message watch is unavailable');
    },
  });

  const scanInventory = async (
    query: InventoryQuery,
    signal?: AbortSignal,
  ): Promise<readonly PluginSessionSummary[]> => {
    const storagePolicy = await callInventoryBoundary(readStoragePolicy);
    assertNotAborted(signal);
    assertGenerationCurrent();
    const items: PluginSessionSummary[] = [];
    const seen = new Set<string>();
    const phases: readonly InventoryPhase[] = query.state === 'archived'
      ? ['archived']
      : query.state
        ? ['unarchived']
        : ['unarchived', 'archived'];
    let pages = 0;
    for (const phase of phases) {
      let upstream: string | undefined;
      do {
        assertNotAborted(signal);
        if (++pages > MAX_SCAN_PAGES) {
          throw pluginError('plugin_sessions_inventory_too_large', 'Plugin session inventory scan exceeded its page bound');
        }
        const page = await callInventoryBoundary(async () => await fetchPage({
          token: params.credentials.token,
          ...(upstream ? { cursor: upstream } : {}),
          limit: MAX_PAGE_LIMIT,
          ...(phase === 'archived' ? { archivedOnly: true } : {}),
        }));
        assertNotAborted(signal);
        assertGenerationCurrent();
        for (const raw of page.sessions) {
          if (seen.has(raw.id)) {
            throw pluginError('plugin_sessions_inventory_invalid', 'Session inventory contained a duplicate identity');
          }
          seen.add(raw.id);
          const summary = projectSessionSummary({ credentials: params.credentials, raw, storagePolicy });
          if (matchesQuery(summary, query)) items.push(summary);
          if (seen.size > MAX_INVENTORY_ITEMS) {
            throw pluginError('plugin_sessions_inventory_too_large', 'Plugin session inventory exceeded its item bound');
          }
        }
        upstream = page.hasNext && page.nextCursor ? page.nextCursor : undefined;
      } while (upstream);
    }
    return Object.freeze(items);
  };

  const readCursor = (raw: string, query: InventoryQuery): CursorSnapshot => {
    if (!raw.startsWith(CURSOR_PREFIX) || raw.length > 256) {
      throw pluginError('plugin_sessions_cursor_invalid', 'Invalid plugin sessions cursor');
    }
    const snapshot = cursors.get(raw);
    if (!snapshot || snapshot.queryKey !== queryKey(query)) {
      throw pluginError('plugin_sessions_cursor_invalid', 'Invalid plugin sessions cursor');
    }
    return snapshot;
  };

  const storeCursor = (snapshot: CursorSnapshot): string => {
    while (cursors.size >= MAX_CURSOR_ENTRIES) {
      const oldest = cursors.keys().next().value as string | undefined;
      if (!oldest) break;
      cursors.delete(oldest);
    }
    const cursor = `${CURSOR_PREFIX}${randomUUID()}`;
    cursors.set(cursor, snapshot);
    return cursor;
  };

  const list = async (rawQuery: {
    cursor?: string;
    limit?: number;
    machineId?: string;
    projectId?: string;
    state?: PluginSessionSummary['state'];
    signal?: AbortSignal;
  } = {}): Promise<{ items: readonly PluginSessionSummary[]; nextCursor?: string }> => {
    assertNotAborted(rawQuery.signal);
    assertGenerationCurrent();
    const query = normalizeQuery(rawQuery);
    const limit = typeof rawQuery.limit === 'number' && Number.isFinite(rawQuery.limit)
      ? Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(rawQuery.limit)))
      : DEFAULT_PAGE_LIMIT;
    const snapshot = rawQuery.cursor
      ? readCursor(rawQuery.cursor, query)
      : Object.freeze({ queryKey: queryKey(query), items: await scanInventory(query, rawQuery.signal), offset: 0 });
    assertNotAborted(rawQuery.signal);
    assertGenerationCurrent();
    const items = snapshot.items.slice(snapshot.offset, snapshot.offset + limit);
    const nextOffset = snapshot.offset + items.length;
    return Object.freeze({
      items: Object.freeze(items),
      ...(nextOffset < snapshot.items.length
        ? { nextCursor: storeCursor(Object.freeze({ ...snapshot, offset: nextOffset })) }
        : {}),
    });
  };

  const loadAll = async (query: InventoryQuery): Promise<readonly PluginSessionSummary[]> => {
    return await scanInventory(query);
  };

  const get = async (id: string, options?: { signal?: AbortSignal }): Promise<PluginSessionService | null> => {
    assertNotAborted(options?.signal);
    assertGenerationCurrent();
    const normalizedId = id.trim();
    if (!normalizedId) throw pluginError('plugin_session_id_invalid', 'Session id is required');
    const raw = await callInventoryBoundary(async () => await fetchById({ token: params.credentials.token, sessionId: normalizedId }));
    assertNotAborted(options?.signal);
    assertGenerationCurrent();
    return raw ? createSessionService(normalizedId) : null;
  };

  const watch = (rawQuery: PluginSessionWatchQuery, listener: (event: PluginSessionWatchEvent) => void): Disposable => {
    assertGenerationCurrent();
    const query = normalizeQuery(rawQuery);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let revision = 0;
    let previous = new Map<string, PluginSessionSummary>();
    const emit = (event: PluginSessionWatchEventInput) => {
      if (disposed) return;
      try {
        listener(Object.freeze({ ...event, revision: String(++revision) }) as PluginSessionWatchEvent);
      } catch {
        // Plugin listeners cannot take down the host-owned watch loop.
      }
    };
    const poll = async (): Promise<void> => {
      if (disposed || !isGenerationCurrent()) return;
      try {
        const items = await loadAll(query);
        if (disposed || !isGenerationCurrent()) return;
        const next = new Map(items.map((item) => [item.id, item] as const));
        if (revision === 0) {
          emit({ kind: 'snapshot', items });
        } else {
          for (const item of items) {
            if (JSON.stringify(previous.get(item.id)) !== JSON.stringify(item)) emit({ kind: 'upserted', item });
          }
          for (const id of previous.keys()) {
            if (!next.has(id)) emit({ kind: 'removed', id });
          }
        }
        previous = next;
      } catch {
        if (!disposed && isGenerationCurrent()) emit({ kind: 'resyncRequired' });
      }
      if (!disposed && isGenerationCurrent()) timer = setTimeout(() => void poll(), pollIntervalMs);
    };
    void poll();
    return Object.freeze({
      dispose() {
        disposed = true;
        if (timer) clearTimeout(timer);
      },
    });
  };

  const currentService = createSessionService(params.currentSessionId);
  const current = Object.freeze({
    ...base.current,
    ...currentService,
    availability,
  });
  return Object.freeze({ ...base, current, list, get, watch });
}
