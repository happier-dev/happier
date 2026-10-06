import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type {
  PluginOperationAvailability } from '@happier-dev/plugin-sdk';
import type {
  SessionEvent,
  SessionSummary,
  SessionWatchEvent,
  SessionWatchQuery,
  CurrentSessionHandle,
  SessionHandle,
  SessionSendRequest,
  SessionsService,
} from '@happier-dev/plugin-sdk/sessions';
import type { SubagentsService } from '@happier-dev/plugin-sdk/sessions/subagents';
import type { AgentSessionSubagentObservationPublisher } from '@happier-dev/plugin-sdk/agents/runtime';
import { createHash, randomUUID } from 'node:crypto';

import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchSessionById,
  fetchSessionsPage,
  type RawSessionListRow,
  type RawSessionRecord,
} from '@/session/transport/http/sessionsHttp';
import type { SemanticTranscriptItem } from './transcript/semanticTranscriptItem';
import type { HostExternalSessionsAuthorService } from '@/session/external/privateContract';
import type { PluginSubagentsHostService } from '@/session/subagents/pluginSubagentsService';
import { getSessionTranscript } from './getSessionTranscript';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { hasPluginSessionAccess, projectPluginSessionAccessIdentity } from '@happier-dev/protocol/sessions/pluginAccess';
import type { PluginSessionAccess, PluginSessionAccessScope } from '@happier-dev/protocol';
export type { PluginSessionAccess, PluginSessionAccessScope } from '@happier-dev/protocol';

const CURSOR_PREFIX = 'plugin_sessions_v1_';
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_SCAN_PAGES = 1_000;
const MAX_INVENTORY_ITEMS = 100_000;
const MAX_CURSOR_ENTRIES = 128;
const DEFAULT_WATCH_POLL_INTERVAL_MS = 1_000;
const SESSION_MESSAGE_WATCH_PAGE_LIMIT = 100;

type StoragePolicy = SessionSummary['storagePolicy'];
type InventoryQuery = Readonly<{
  machineId?: string;
  projectId?: string;
  state?: SessionSummary['state'];
}>;


type PluginSessionSystemRecordCapabilities = Pick<
  SessionHandle,
  | 'listSystemRecords'
  | 'upsertSystemRecord'
  | 'readSystemRecord'
  | 'deleteSystemRecord'
>;

export type PluginSessionHandleCapabilities = Readonly<
  PluginSessionSystemRecordCapabilities
  & Partial<Pick<
    SessionHandle,
    | 'auth'
    | 'permissions'
    | 'mcp'
    | 'media'
  >>
  & Readonly<{ subagents?: PluginSubagentsHostService }>
  & Partial<Pick<CurrentSessionHandle, 'setDisplayTitle'>>
>;

const subagentObservationBySessions = new WeakMap<
  SessionsService,
  AgentSessionSubagentObservationPublisher
>();

/** Associates one host-only writer without adding a reflectable public key. */
export function bindPluginSessionsSubagentObservation<TSessions extends SessionsService>(
  sessions: TSessions,
  publisher: AgentSessionSubagentObservationPublisher,
): TSessions {
  subagentObservationBySessions.set(sessions, publisher);
  return sessions;
}

export function readPluginSessionsSubagentObservation(
  sessions: SessionsService,
): AgentSessionSubagentObservationPublisher | undefined {
  return subagentObservationBySessions.get(sessions);
}

export type PluginSessionsInventoryParams = Readonly<{
  credentials: StoredCredentials;
  signal: AbortSignal;
  readCredentials?: () => Promise<StoredCredentials | null>;
  currentSessionId: string | null;
  /** Required final authority; an omitted binding must never become ambient Session access. */
  sessionScopes: readonly PluginSessionAccessScope[];
  isCurrent: () => boolean;
  external: HostExternalSessionsAuthorService;
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
    serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  }>) => Promise<RawSessionRecord | null>;
  /** The daemon's already-retained snapshot for this exact Home. */
  resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  watchPollIntervalMs?: number;
  executeMessageAction: (params: Readonly<{
    sessionId: string;
    request: SessionSendRequest;
    signal: AbortSignal;
  }>) => Promise<import('@happier-dev/protocol').SessionInputAdmissionResultV1>;
  readAccountEncryptionCurrentness?: (
    credentials: StoredCredentials,
  ) => Promise<AccountEncryptionCurrentnessResponse>;
  createHandleCapabilities: (context: Readonly<{
    sessionId: string;
    readSummary: SessionHandle['summary'];
  }>) => PluginSessionHandleCapabilities;
}>;

type InventoryPhase = 'unarchived' | 'archived';
type CursorSnapshot = Readonly<{
  queryKey: string;
  credentialKey: string;
  items: readonly SessionSummary[];
  offset: number;
}>;
type WithoutRevision<T> = T extends unknown ? Omit<T, 'revision'> : never;
type SessionWatchEventInput = WithoutRevision<SessionWatchEvent>;

function pluginError(code: string, message: string): PluginError {
  return new PluginError({ code, message });
}

async function callInventoryBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPluginError(error)) throw error;
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

function combineAbortSignals(lifetimeSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
  if (!callerSignal || callerSignal === lifetimeSignal) return lifetimeSignal;
  return AbortSignal.any([lifetimeSignal, callerSignal]);
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

function credentialKey(credentials: StoredCredentials): string {
  return createHash('sha256').update(credentials.token).digest('hex');
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readTitle(metadata: Record<string, unknown> | null): string | undefined {
  const summary = metadata?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined;
  return readMetadataString(summary as Record<string, unknown>, 'text');
}

function runtimeAvailability(state: SessionSummary['state']): PluginOperationAvailability {
  return state === 'active' || state === 'idle'
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({
        status: 'unavailable' as const,
        code: state === 'archived' ? 'session_archived' : 'session_runtime_inactive',
      });
}

function sessionState(raw: RawSessionListRow | RawSessionRecord): SessionSummary['state'] {
  if (typeof raw.archivedAt === 'number') return 'archived';
  return raw.active ? 'active' : 'stopped';
}

function projectSessionSummary(params: Readonly<{
  credentials: StoredCredentials;
  raw: RawSessionListRow | RawSessionRecord;
  storagePolicy: StoragePolicy;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
}>): SessionSummary {
  const metadata = tryDecryptSessionPresentationMetadataView({
    credentials: params.credentials,
    rawSession: params.raw,
    accountEncryptionMode: params.accountEncryptionMode,
  });
  const { machineId, projectId } = projectPluginSessionAccessIdentity(params.raw, metadata);
  const state = sessionState(params.raw);
  const title = readTitle(metadata);
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  return Object.freeze({
    id: params.raw.id,
    ...(title ? { title } : {}),
    ...(machineId ? { machineId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
    state,
    runtimeAvailability: runtimeAvailability(state),
    storagePolicy: params.storagePolicy,
    encryptionMode: params.raw.encryptionMode === 'plain' ? 'plain' : 'e2ee',
    updatedAtMs: params.raw.updatedAt,
  });
}

function matchesQuery(summary: SessionSummary, query: InventoryQuery): boolean {
  return (!query.machineId || (
    summary.machineId !== undefined
    && summary.machineId === query.machineId
  ))
    && (!query.projectId || summary.projectId === query.projectId)
    && (!query.state || summary.state === query.state);
}

function hasSessionAccess(
  scopes: readonly PluginSessionAccessScope[],
  summary: SessionSummary,
  access: PluginSessionAccess,
): boolean {
  return hasPluginSessionAccess({ scopes, session: summary, access });
}

function projectSessionMessageEvent(item: SemanticTranscriptItem): Extract<SessionEvent, { kind: 'message' }> | null {
  if (
    typeof item.seq !== 'number'
    || !Number.isSafeInteger(item.seq)
    || item.seq < 0
    || item.id.trim().length === 0
  ) {
    return null;
  }
  const sender = item.semanticRole === 'user'
    ? 'user' as const
    : item.semanticRole === 'assistant' || item.semanticRole === 'reasoning'
      ? 'agent' as const
      : item.semanticRole === 'tool'
        ? 'tool' as const
        : item.semanticRole === 'event'
          ? 'system' as const
          : null;
  if (!sender) return null;
  const text = typeof item.text === 'string' && item.text.length > 0
    ? item.text
    : typeof item.summary === 'string' && item.summary.length > 0
      ? item.summary
      : null;
  if (!text) return null;
  return Object.freeze({
    sequence: item.seq,
    kind: 'message' as const,
    message: Object.freeze({
      version: 1 as const,
      messageId: item.id,
      sender,
      parts: Object.freeze([
        Object.freeze({ kind: 'text' as const, text }),
      ]) as readonly [{ readonly kind: 'text'; readonly text: string }],
    }),
  });
}

function readStoragePolicyFromSnapshot(snapshot: CliServerFeaturesSnapshot | undefined): StoragePolicy {
  return snapshot?.status === 'ready'
    ? snapshot.features.capabilities.encryption.storagePolicy
    : 'required_e2ee';
}

export function createPluginSessionsInventory(
  params: PluginSessionsInventoryParams,
): SessionsService {
  const fetchPage = params.fetchPage ?? (async (request) => await fetchSessionsPage(request));
  const fetchById = params.fetchById ?? (async (request) => await fetchSessionById(request));
  const readStoragePolicy = params.readStoragePolicy
    ?? (async () => readStoragePolicyFromSnapshot(params.resolveServerFeaturesSnapshot?.()));
  const readAccountEncryptionCurrentness = params.readAccountEncryptionCurrentness
    ?? (async (credentials: StoredCredentials) =>
      await fetchAccountEncryptionCurrentness({ token: credentials.token }));
  const pollIntervalMs = Math.max(1, Math.floor(params.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS));
  const cursors = new Map<string, CursorSnapshot>();

  const isOccurrenceCurrent = (): boolean => {
    if (params.signal.aborted) return false;
    try {
      return params.isCurrent() === true;
    } catch {
      return false;
    }
  };
  const assertGenerationCurrent = (): void => {
    if (!isOccurrenceCurrent()) throw pluginError('plugin_generation_retired', 'Plugin generation is retired');
  };
  const readCurrentCredentials = async (signal?: AbortSignal): Promise<StoredCredentials> => {
    assertNotAborted(signal);
    assertGenerationCurrent();
    const credentials = params.readCredentials
      ? await callInventoryBoundary(params.readCredentials)
      : params.credentials;
    assertNotAborted(signal);
    assertGenerationCurrent();
    if (!credentials) {
      throw pluginError('plugin_sessions_not_authenticated', 'Session inventory authentication is unavailable');
    }
    return credentials;
  };
  const assertDeclaredSessionAccess = (access: PluginSessionAccess): void => {
    if (!params.sessionScopes.some((scope) => scope.access.includes(access))) {
      throw pluginError('plugin_session_scope_unavailable', 'This Session access scope is unavailable');
    }
  };
  const hasMetadataIndependentSessionAccess = (
    sessionId: string,
    access: PluginSessionAccess,
  ): boolean => params.sessionScopes.some((scope) => (
    scope.access.includes(access)
    && (scope.sessionIds === undefined || scope.sessionIds.includes(sessionId))
    && scope.machineIds === undefined
    && scope.projectIds === undefined
  ));
  const assertSynchronouslyAccessibleSession = (
    sessionId: string,
    access: PluginSessionAccess,
  ): void => {
    assertGenerationCurrent();
    if (!hasMetadataIndependentSessionAccess(sessionId, access)) {
      throw pluginError('plugin_session_scope_unavailable', 'This Session access scope is unavailable');
    }
  };
  const readSession = async (
    sessionId: string,
    signal?: AbortSignal,
    currentCredentials?: StoredCredentials,
  ): Promise<Readonly<{ credentials: StoredCredentials; summary: SessionSummary | null; raw: RawSessionRecord | null }>> => {
    const credentials = currentCredentials ?? await readCurrentCredentials(signal);
    const serverFeaturesSnapshot = params.resolveServerFeaturesSnapshot?.();
    const [raw, storagePolicy, accountEncryptionCurrentness] = await Promise.all([
      callInventoryBoundary(async () => await fetchById({
        token: credentials.token,
        sessionId,
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
      })),
      callInventoryBoundary(readStoragePolicy),
      callInventoryBoundary(async () => await readAccountEncryptionCurrentness(credentials)),
    ]);
    assertNotAborted(signal);
    assertGenerationCurrent();
    return Object.freeze({
      credentials,
      raw,
      summary: raw
        ? projectSessionSummary({
          credentials,
          raw,
          storagePolicy,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
        })
        : null,
    });
  };
  const assertSessionAccess = async (
    sessionId: string,
    access: PluginSessionAccess,
    signal?: AbortSignal,
  ): Promise<StoredCredentials> => {
    assertDeclaredSessionAccess(access);
    const credentials = await readCurrentCredentials(signal);
    if (hasMetadataIndependentSessionAccess(sessionId, access)) return credentials;
    const session = await readSession(sessionId, signal, credentials);
    if (!session.summary) {
      throw pluginError('plugin_session_not_found', 'Session is not available to this account');
    }
    if (!hasSessionAccess(params.sessionScopes, session.summary, access)) {
      throw pluginError('plugin_session_scope_unavailable', 'This Session access scope is unavailable');
    }
    return session.credentials;
  };
  const readAuthorizedSession = async (
    sessionId: string,
    access: PluginSessionAccess,
    signal?: AbortSignal,
  ): Promise<Readonly<{ credentials: StoredCredentials; summary: SessionSummary; raw: RawSessionRecord }>> => {
    assertDeclaredSessionAccess(access);
    const session = await readSession(sessionId, signal);
    if (!session.summary || !session.raw) {
      throw pluginError('plugin_session_not_found', 'Session is not available to this account');
    }
    if (!hasSessionAccess(params.sessionScopes, session.summary, access)) {
      throw pluginError('plugin_session_scope_unavailable', 'This Session access scope is unavailable');
    }
    return Object.freeze({ credentials: session.credentials, summary: session.summary, raw: session.raw });
  };
  const unavailableHandleMethod = () => {
    throw pluginError('plugin_session_service_unavailable', 'This Session capability is unavailable');
  };
  const unavailableSubagents = Object.freeze({
    capabilities: unavailableHandleMethod,
    list: unavailableHandleMethod,
    get: unavailableHandleMethod,
    observe: unavailableHandleMethod,
    watch: unavailableHandleMethod,
  });
  const unavailableSubagentReads: SubagentsService = Object.freeze({
    list: unavailableHandleMethod,
    get: unavailableHandleMethod,
    watch: unavailableHandleMethod,
  });
  const unavailableSubagentObservation: AgentSessionSubagentObservationPublisher = Object.freeze({
    observe: unavailableHandleMethod,
  });

  const createSessionService = (sessionId: string): Readonly<{
    handle: SessionHandle;
    currentCapability: Pick<CurrentSessionHandle, 'setDisplayTitle'>;
    subagentObservation: AgentSessionSubagentObservationPublisher;
  }> => {
    const readSummary: SessionHandle['summary'] = async (options) => {
      assertNotAborted(options?.signal);
      return (await readAuthorizedSession(sessionId, 'read', options?.signal)).summary;
    };
    const handleCapabilities = params.createHandleCapabilities({ sessionId, readSummary });
    const {
      setDisplayTitle,
      listSystemRecords,
      upsertSystemRecord,
      readSystemRecord,
      deleteSystemRecord,
      auth,
      permissions,
      mcp,
      media,
      subagents,
      ...baseCapabilities
    } = handleCapabilities;
    const guardedListSystemRecords: SessionHandle['listSystemRecords'] = async (query, options) => {
      await assertSessionAccess(sessionId, 'read', options?.signal);
      return await listSystemRecords(query, options);
    };
    const guardedUpsertSystemRecord: SessionHandle['upsertSystemRecord'] = async (request, options) => {
      await assertSessionAccess(sessionId, 'write', options?.signal);
      return await upsertSystemRecord(request, options);
    };
    const guardedReadSystemRecord: SessionHandle['readSystemRecord'] = async (request, options) => {
      await assertSessionAccess(sessionId, 'read', options?.signal);
      return await readSystemRecord(request, options);
    };
    const guardedDeleteSystemRecord: SessionHandle['deleteSystemRecord'] = async (request, options) => {
      await assertSessionAccess(sessionId, 'write', options?.signal);
      return await deleteSystemRecord(request, options);
    };
    const unavailableAuth: SessionHandle['auth'] = Object.freeze({
      services: Object.freeze({ refreshRuntimeAuth: unavailableHandleMethod }),
    });
    const unavailablePermissions: SessionHandle['permissions'] = Object.freeze({
      requestDecision: unavailableHandleMethod,
      getMode: unavailableHandleMethod,
    });
    const unavailableMcp: SessionHandle['mcp'] = Object.freeze({ elicit: unavailableHandleMethod });
    const unavailableMedia: SessionHandle['media'] = Object.freeze({ registerSourceRoot: unavailableHandleMethod });
    const guardedAuth: SessionHandle['auth'] = Object.freeze({
      services: Object.freeze({
        async refreshRuntimeAuth(
          ...args: Parameters<SessionHandle['auth']['services']['refreshRuntimeAuth']>
        ) {
          const [request, options] = args;
          await assertSessionAccess(sessionId, 'control', options?.signal);
          return await (auth ?? unavailableAuth).services.refreshRuntimeAuth(request, options);
        },
      }),
    });
    const guardedPermissions: SessionHandle['permissions'] = Object.freeze({
      async requestDecision(
        ...args: Parameters<SessionHandle['permissions']['requestDecision']>
      ) {
        const [request, options] = args;
        await assertSessionAccess(sessionId, 'control', options?.signal);
        return await (permissions ?? unavailablePermissions).requestDecision(request, options);
      },
      getMode() {
        assertSynchronouslyAccessibleSession(sessionId, 'control');
        return (permissions ?? unavailablePermissions).getMode();
      },
    });
    const guardedMcp: SessionHandle['mcp'] = Object.freeze({
      async elicit(...args: Parameters<SessionHandle['mcp']['elicit']>) {
        const [request, options] = args;
        await assertSessionAccess(sessionId, 'control', options?.signal);
        return await (mcp ?? unavailableMcp).elicit(request, options);
      },
    });
    const guardedMedia: SessionHandle['media'] = Object.freeze({
      async registerSourceRoot(
        ...args: Parameters<SessionHandle['media']['registerSourceRoot']>
      ) {
        const [request, options] = args;
        await assertSessionAccess(sessionId, 'control', options?.signal);
        const source = await (media ?? unavailableMedia).registerSourceRoot(request, options);
        return Object.freeze({
          async publishGenerated(
            ...publishArgs: Parameters<Awaited<ReturnType<SessionHandle['media']['registerSourceRoot']>>['publishGenerated']>
          ) {
            const [mediaRequest, publishOptions] = publishArgs;
            await assertSessionAccess(sessionId, 'control', publishOptions?.signal);
            return await source.publishGenerated(mediaRequest, publishOptions);
          },
          dispose: () => source.dispose(),
        });
      },
    });
    const guardedSubagentObservation: AgentSessionSubagentObservationPublisher = Object.freeze({
      async observe(...args: Parameters<PluginSubagentsHostService['observe']>) {
        const [input, options] = args;
        await assertSessionAccess(sessionId, 'control', options?.signal);
        return await (subagents ?? unavailableSubagents).observe(input, options);
      },
    });
    const guardedSubagents: SubagentsService = Object.freeze({
      async list(...args: Parameters<SessionHandle['subagents']['list']>) {
        const [query] = args;
        await assertSessionAccess(sessionId, 'control', query?.signal);
        return await (subagents ?? unavailableSubagents).list(query);
      },
      async get(...args: Parameters<SessionHandle['subagents']['get']>) {
        const [id, options] = args;
        await assertSessionAccess(sessionId, 'control', options?.signal);
        return await (subagents ?? unavailableSubagents).get(id, options);
      },
      watch(...args: Parameters<SessionHandle['subagents']['watch']>) {
        const [query, listener] = args;
        assertDeclaredSessionAccess('control');
        let disposed = false;
        let subscription: Disposable | null = null;
        void assertSessionAccess(sessionId, 'control').then(() => {
          if (disposed) return;
          subscription = (subagents ?? unavailableSubagents).watch(query, listener);
        }).catch(() => undefined);
        return Object.freeze({
          dispose() {
            if (disposed) return;
            disposed = true;
            subscription?.dispose();
          },
        });
      },
    });
    const handle = Object.freeze({
      summary: readSummary,
      async send(request: SessionSendRequest, options?: { signal?: AbortSignal }) {
        const operationSignal = combineAbortSignals(params.signal, options?.signal);
        assertNotAborted(options?.signal);
        await assertSessionAccess(sessionId, 'write', operationSignal);
        assertNotAborted(operationSignal);
        assertGenerationCurrent();
        const result = await params.executeMessageAction({
          sessionId,
          request,
          signal: operationSignal,
        });
        assertGenerationCurrent();
        return Object.freeze(result);
      },
      listSystemRecords: guardedListSystemRecords,
      upsertSystemRecord: guardedUpsertSystemRecord,
      readSystemRecord: guardedReadSystemRecord,
      deleteSystemRecord: guardedDeleteSystemRecord,
      watch(listener: (event: SessionEvent) => void): Disposable {
        assertDeclaredSessionAccess('read');
        assertGenerationCurrent();
        const lifetime = new AbortController();
        const signal = combineAbortSignals(params.signal, lifetime.signal);
        let source: ReturnType<typeof openSessionEventSource> | null = null;
        let cursor = '0';
        let lastDeliveredSequence = -1;
        let previousSnapshot: string | undefined;
        const isWatching = () => !signal.aborted && isOccurrenceCurrent();
        const close = () => { void source?.close().catch(() => undefined); };
        signal.addEventListener('abort', close, { once: true });
        const emit = (event: SessionEvent) => {
          if (!isWatching()) return;
          try {
            const result = (listener as (value: SessionEvent) => void | Promise<void>)(event);
            if (result) void result.catch(() => undefined);
          } catch {
            // Plugin listeners cannot take down the host-owned observation loop.
          }
        };
        const observe = async () => {
          try {
            // Authorize before subscribing, then subscribe before the baseline read.
            const credentials = await assertSessionAccess(sessionId, 'read', signal);
            if (!isWatching()) return;
            source = openSessionEventSource({ token: credentials.token, sessionId });
            while (isWatching()) {
              const revision = source.currentRevision();
              try {
                const session = await readAuthorizedSession(sessionId, 'read', signal);
                if (!isWatching()) return;
                if (session.credentials.token !== credentials.token) return;
                const snapshot = JSON.stringify([
                  session.summary, session.raw.latestTurnId, session.raw.latestTurnStatus,
                  session.raw.latestTurnStatusObservedAt, session.raw.latestReadyEventSeq,
                ]);
                // Turn settlement can unblock publication without a new transcript row.
                if (previousSnapshot !== undefined && previousSnapshot !== snapshot) {
                  emit({ kind: 'changed', sequence: session.raw.seq, summary: session.summary });
                }
                previousSnapshot = snapshot;
                let hasMore: boolean;
                do {
                  const page = await getSessionTranscript({
                    credentials: session.credentials,
                    idOrPrefix: sessionId,
                    limit: SESSION_MESSAGE_WATCH_PAGE_LIMIT,
                    cursor,
                    direction: 'after',
                    scope: 'main',
                    roles: ['user', 'assistant'],
                    includeTools: true,
                    includeReasoning: true,
                    includeEvents: true,
                    includeRaw: false,
                    includeStructuredPayload: false,
                    maxCharsPerMessage: 50_000,
                    signal,
                    serverFeaturesSnapshot: params.resolveServerFeaturesSnapshot?.(),
                  });
                  if (!isWatching()) return;
                  if (!page.ok) {
                    throw pluginError('plugin_session_messages_unavailable', 'Session messages are temporarily unavailable');
                  }
                  if (page.sessionId !== sessionId) {
                    throw pluginError('plugin_session_binding_mismatch', 'Session message observation resolved a different Session');
                  }
                  const events = page.items
                    .map(projectSessionMessageEvent)
                    .filter((event): event is Extract<SessionEvent, { kind: 'message' }> => event !== null)
                    .sort((left, right) => left.sequence - right.sequence);
                  for (const event of events) {
                    if (!isWatching()) return;
                    if (event.sequence <= lastDeliveredSequence) continue;
                    lastDeliveredSequence = event.sequence;
                    emit(event);
                  }
                  const previousCursor = cursor;
                  if (page.nextCursor !== null) cursor = page.nextCursor;
                  hasMore = page.hasMore && cursor !== previousCursor;
                } while (hasMore && isWatching());
              } catch (error) {
                if (isPluginError(error) && !error.retryable) return;
                // Keep the frontier on read failure; the next event/reconnect retries it.
              }
              if (!isWatching() || !await source.waitForChange(revision, { deadlineMs: null, signal })) return;
            }
          } finally {
            signal.removeEventListener('abort', close);
            await source?.close();
          }
        };
        void observe().catch(() => undefined);
        return Object.freeze({ dispose: () => lifetime.abort() });
      },
      auth: guardedAuth,
      permissions: guardedPermissions,
      mcp: guardedMcp,
      media: guardedMedia,
      subagents: guardedSubagents,
      ...baseCapabilities,
    });
    const currentCapability = Object.freeze({
      async setDisplayTitle(title: string | null, options?: { signal?: AbortSignal }) {
        if (!setDisplayTitle) {
          throw pluginError('plugin_session_display_title_unavailable', 'Session title mutation is unavailable');
        }
        await assertSessionAccess(sessionId, 'control', options?.signal);
        await setDisplayTitle(title, options);
      },
    });
    return Object.freeze({
      handle,
      currentCapability,
      subagentObservation: guardedSubagentObservation,
    });
  };

  const scanInventory = async (
    query: InventoryQuery,
    credentials: StoredCredentials,
    signal?: AbortSignal,
  ): Promise<readonly SessionSummary[]> => {
    const [storagePolicy, accountEncryptionCurrentness] = await Promise.all([
      callInventoryBoundary(readStoragePolicy),
      callInventoryBoundary(async () => await readAccountEncryptionCurrentness(credentials)),
    ]);
    assertNotAborted(signal);
    assertGenerationCurrent();
    const items: SessionSummary[] = [];
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
          token: credentials.token,
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
          const summary = projectSessionSummary({
            credentials,
            raw,
            storagePolicy,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
          });
          if (
            hasSessionAccess(params.sessionScopes, summary, 'read')
            && matchesQuery(summary, query)
          ) items.push(summary);
          if (seen.size > MAX_INVENTORY_ITEMS) {
            throw pluginError('plugin_sessions_inventory_too_large', 'Plugin session inventory exceeded its item bound');
          }
        }
        upstream = page.hasNext && page.nextCursor ? page.nextCursor : undefined;
      } while (upstream);
    }
    return Object.freeze(items);
  };

  const readCursor = (raw: string, query: InventoryQuery, currentCredentialKey: string): CursorSnapshot => {
    if (!raw.startsWith(CURSOR_PREFIX) || raw.length > 256) {
      throw pluginError('plugin_sessions_cursor_invalid', 'Invalid plugin sessions cursor');
    }
    const snapshot = cursors.get(raw);
    if (
      !snapshot
      || snapshot.queryKey !== queryKey(query)
      || snapshot.credentialKey !== currentCredentialKey
    ) {
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
    state?: SessionSummary['state'];
  } = {}, options?: { signal?: AbortSignal }): Promise<{ items: readonly SessionSummary[]; nextCursor?: string }> => {
    assertNotAborted(options?.signal);
    assertGenerationCurrent();
    assertDeclaredSessionAccess('read');
    const credentials = await readCurrentCredentials(options?.signal);
    const query = normalizeQuery(rawQuery);
    const limit = typeof rawQuery.limit === 'number' && Number.isFinite(rawQuery.limit)
      ? Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(rawQuery.limit)))
      : DEFAULT_PAGE_LIMIT;
    const snapshot = rawQuery.cursor
      ? readCursor(rawQuery.cursor, query, credentialKey(credentials))
      : Object.freeze({
          queryKey: queryKey(query),
          credentialKey: credentialKey(credentials),
          items: await scanInventory(query, credentials, options?.signal),
          offset: 0,
        });
    assertNotAborted(options?.signal);
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

  const loadAll = async (query: InventoryQuery): Promise<readonly SessionSummary[]> => {
    assertDeclaredSessionAccess('read');
    const credentials = await readCurrentCredentials();
    return await scanInventory(query, credentials);
  };

  const get = async (id: string, options?: { signal?: AbortSignal }): Promise<SessionHandle | null> => {
    assertNotAborted(options?.signal);
    assertGenerationCurrent();
    const normalizedId = id.trim();
    if (!normalizedId) throw pluginError('plugin_session_id_invalid', 'Session id is required');
    assertDeclaredSessionAccess('read');
    const { summary } = await readSession(normalizedId, options?.signal);
    if (!summary || !hasSessionAccess(params.sessionScopes, summary, 'read')) return null;
    return createSessionService(normalizedId).handle;
  };

  const watch = (rawQuery: SessionWatchQuery, listener: (event: SessionWatchEvent) => void): Disposable => {
    assertGenerationCurrent();
    assertDeclaredSessionAccess('read');
    const query = normalizeQuery(rawQuery);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let revision = 0;
    let previous = new Map<string, SessionSummary>();
    const emit = (event: SessionWatchEventInput) => {
      if (disposed) return;
      try {
        listener(Object.freeze({ ...event, revision: String(++revision) }) as SessionWatchEvent);
      } catch {
        // Plugin listeners cannot take down the host-owned watch loop.
      }
    };
    const poll = async (): Promise<void> => {
      if (disposed || !isOccurrenceCurrent()) return;
      try {
        const items = await loadAll(query);
        if (disposed || !isOccurrenceCurrent()) return;
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
        if (!disposed && isOccurrenceCurrent()) emit({ kind: 'resyncRequired' });
      }
      if (!disposed && isOccurrenceCurrent()) timer = setTimeout(() => void poll(), pollIntervalMs);
    };
    void poll();
    return Object.freeze({
      dispose() {
        disposed = true;
        if (timer) clearTimeout(timer);
      },
    });
  };

  const currentService = params.currentSessionId === null || params.sessionScopes.length === 0
    ? null
    : createSessionService(params.currentSessionId);
  const current = currentService
    ? Object.freeze({ ...currentService.handle, ...currentService.currentCapability })
    : null;
  const sessions = Object.freeze({
    current,
    list,
    get,
    watch,
    subagents: current?.subagents ?? unavailableSubagentReads,
    external: params.external,
  });
  return bindPluginSessionsSubagentObservation(
    sessions,
    currentService?.subagentObservation ?? unavailableSubagentObservation,
  );
}
