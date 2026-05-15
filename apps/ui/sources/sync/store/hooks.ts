import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type {
  Automation,
  AutomationRun,
} from '../domains/automations/automationTypes';
import type {
  DiscardedPendingMessage,
  ScmStatus,
  ScmWorkingSnapshot,
  ScmCommitSelectionPatch,
  Machine,
  PendingMessage,
  Session,
} from '../domains/state/storageTypes';
import type { DecryptedArtifact } from '../domains/artifacts/artifactTypes';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { AgentTextMessage, Message } from '../domains/messages/messageTypes';
import type { Settings } from '../domains/settings/settings';
import { settingsDefaults } from '../domains/settings/settings';
import type { SessionListRenderableSession } from '../domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '../domains/sessionList/sessionListIndex';
import { deriveSessionListMeaningfulActivityAt } from '../domains/session/listing/deriveSessionListActivity';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '../domains/sessionActions/sessionActionDraftTypes';
import type { UserProfile } from '../domains/social/friendTypes';
import { buildSessionMessageRouteId, resolveSessionMessageRouteId } from '../domains/messages/messageRouteIds';
import { useApplyLocalSettings, useApplySettings } from './settingsWriters';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSessionFromState } from '../domains/session/resolveWorkspaceTargetForSessionFromState';
import { deriveSessionAttentionFlags } from '../domains/session/attention/sessionAttention';
import { normalizeSessionId } from '../domains/session/normalizeSessionId';
import { buildMachineDisplayRenderableFromMachine } from '../domains/machines/machineDisplayRenderable';
import { normalizeTrimmedString } from '../domains/session/listing/normalizeTrimmedString';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { buildSessionFolderAssignmentKey } from '../domains/session/folders';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import { getStorage } from '../domains/state/storageStore';
import type { KnownEntitlements } from '../domains/state/storageStore';
import type { ForkedTranscriptSnapshot } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { getForkedTranscriptSnapshotCached } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { resolveSessionListLookupSessionServerScopeFromState } from '../domains/session/listing/sessionListLookupState';
import { resolveVisibleMachinesForActiveServerFromState } from './domains/machines/resolveMachinesForActiveServerFromState';
import type { SessionsDomainSlice, StorageState } from './types';

export function useSessions() {
  const snapshot = getStorage()(
    useShallow((state) => ({
      isDataReady: state.isDataReady,
      sessions: state.sessions,
    }))
  );

  return React.useMemo(() => {
    if (!snapshot.isDataReady) return null;
    return Object.values(snapshot.sessions);
  }, [snapshot.isDataReady, snapshot.sessions]);
}

export function useSession(id: string): Session | null {
  return getStorage()(useShallow((state) => state.sessions[id] ?? null));
}

export function useSessionMetadata(sessionId: string): Session['metadata'] | null {
  return getStorage()((state) => state.sessions[sessionId]?.metadata ?? null);
}

export function useSessionListRenderable(id: string): SessionListRenderableSession | null {
  return getStorage()(useShallow((state) => state.sessionListRenderables[id] ?? null));
}

function projectSessionListRowRenderable(renderable: SessionListRenderableSession | null | undefined): SessionListRenderableSession | null {
  if (!renderable) return null;
  return {
    ...renderable,
    updatedAt: 0,
    thinkingAt: 0,
    pendingVersion: undefined,
    metadataVersion: 0,
    agentStateVersion: 0,
  };
}

export function useSessionListRenderableWithServerScope(
  serverId: string | null | undefined,
  sessionId: string,
): SessionListRenderableSession | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedServerId = normalizeTrimmedString(serverId);
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);

  return getStorage()(useShallow((state) => {
    if (!normalizedSessionId) {
      return null;
    }

    if (normalizedServerId) {
      const scoped = state.sessionListRowStateByServerId?.[normalizedServerId];
      if (scoped && typeof scoped === 'object') {
        return projectSessionListRowRenderable(scoped[normalizedSessionId]);
      }

      if (activeServerId && activeServerId === normalizedServerId) {
        return projectSessionListRowRenderable(state.sessionListRenderables[normalizedSessionId]);
      }

      return null;
    }

    return projectSessionListRowRenderable(state.sessionListRenderables[normalizedSessionId]);
  }));
}

export function useSessionListRenderablesById(): Record<string, SessionListRenderableSession> {
  return getStorage()(useShallow((state) => state.sessionListRenderables));
}

export type SessionListAttentionRow = Readonly<{
  serverId: string | null;
  serverName: string | null;
  session: SessionListRenderableSession;
}>;

export function useSessionListRowStateByServerId(): SessionsDomainSlice['sessionListRowStateByServerId'] {
  return getStorage()(useShallow((state) => state.sessionListRowStateByServerId));
}

export function useSessionListIndexByServerId(): Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> {
  return getStorage()(useShallow((state) => state.sessionListIndexByServerId ?? {}));
}

export function useSessionFolderAssignment(serverId: string | null | undefined, sessionId: string): string | null {
  return getStorage()(useShallow((state) => (
    state.sessionFolderAssignmentsBySessionKey[buildSessionFolderAssignmentKey(serverId, sessionId)] ?? null
  )));
}

export function useSessionFolderAssignmentsBySessionKey(): Record<string, string | null> {
  return getStorage()(useShallow((state) => state.sessionFolderAssignmentsBySessionKey));
}

export function useSessionServerId(sessionId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => resolveSessionListLookupSessionServerScopeFromState({
    sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
    sessionListIndexByServerId: state.sessionListIndexByServerId,
    sessionListRenderables: state.sessionListRenderables,
    concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
  }, normalizedSessionId)?.serverId ?? null);
}

const emptyArray: unknown[] = [];
const emptyRecord: Record<string, any> = {};
const emptyReviewCommentDrafts: ReviewCommentDraft[] = [];
const emptyActionDrafts: SessionActionDraft[] = [];

function normalizeMessageSeq(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
}

function compareMessagesOldestFirst(a: Message, b: Message): number {
  const aSeq = normalizeMessageSeq((a as any).seq);
  const bSeq = normalizeMessageSeq((b as any).seq);
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
    return aSeq - bSeq;
  }

  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }

  return String(a.id).localeCompare(String(b.id));
}

type SessionMessagesArrayCacheEntry = Readonly<{
  idsRef: readonly string[];
  messagesByIdRef: Record<string, Message>;
  messagesVersion: number;
  messages: readonly Message[];
}>;

const SESSION_MESSAGES_ARRAY_CACHE_MAX = 16;
const sessionMessagesArrayCache = new Map<string, SessionMessagesArrayCacheEntry>();

type UseSessionMessagesOptions = Readonly<{
  enabled?: boolean;
}>;

type SessionSubagentSourceMessagesCacheEntry = Readonly<{
  signature: string;
  messages: readonly Message[];
}>;

const sessionSubagentSourceMessagesCache = new Map<string, SessionSubagentSourceMessagesCacheEntry>();

function stringifySignatureValue(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return String(value);
  }
}

function agentTextLooksLikeExecutionRunSignal(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    (
      normalized.includes('execution run')
      || normalized.includes('run has been started')
      || normalized.includes('run started')
      || /\brun_[0-9a-z-]{8,}\b/i.test(text)
    )
    && (
      normalized.includes('started')
      || normalized.includes('running')
      || normalized.includes('delegate')
      || normalized.includes('execution run')
    )
  );
}

function shouldIncludeSubagentSourceMessage(message: Message): boolean {
  if (message.kind === 'tool-call') return true;
  if (message.kind !== 'agent-text') return false;
  const text = typeof (message as any).text === 'string' ? String((message as any).text) : '';
  return agentTextLooksLikeExecutionRunSignal(text);
}

function appendSubagentSourceMessageSignature(parts: string[], message: Message): void {
  const seq = normalizeMessageSeq((message as any).seq);
  parts.push(`${message.id}:${message.kind}:${seq ?? ''}:${message.createdAt ?? ''}`);
  if (message.kind === 'agent-text') {
    parts.push(typeof (message as any).text === 'string' ? String((message as any).text) : '');
    return;
  }
  if (message.kind !== 'tool-call') return;
  const tool = (message as any).tool;
  parts.push(stringifySignatureValue({
    id: tool?.id ?? null,
    name: tool?.name ?? null,
    state: tool?.state ?? null,
    createdAt: tool?.createdAt ?? null,
    startedAt: tool?.startedAt ?? null,
    completedAt: tool?.completedAt ?? null,
    description: tool?.description ?? null,
    permissionStatus: tool?.permission?.status ?? null,
    input: tool?.input ?? null,
    result: tool?.result ?? null,
  }));
}

function trimSessionSubagentSourceMessagesCache(): void {
  while (sessionSubagentSourceMessagesCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
    const oldestKey = sessionSubagentSourceMessagesCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    sessionSubagentSourceMessagesCache.delete(oldestKey);
  }
}

export function useSessionSubagentSourceMessages(sessionId: string): readonly Message[] {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => {
    const session = state.sessionMessages[normalizedSessionId];
    if (!session) return emptyArray as any as readonly Message[];

    const sourceMessages: Message[] = [];
    const signatureParts: string[] = [];
    const ids = session.messageIdsOldestFirst;
    const orderedMessages = Array.isArray(ids) && ids.length > 0
      ? ids.map((id) => session.messagesById[id]).filter((message): message is Message => message != null)
      : Object.values(session.messagesById ?? {}).sort(compareMessagesOldestFirst);

    for (const message of orderedMessages) {
      if (!shouldIncludeSubagentSourceMessage(message)) continue;
      sourceMessages.push(message);
      appendSubagentSourceMessageSignature(signatureParts, message);
    }

    const signature = signatureParts.join('\u0000');
    const cached = sessionSubagentSourceMessagesCache.get(normalizedSessionId);
    if (cached && cached.signature === signature) {
      sessionSubagentSourceMessagesCache.delete(normalizedSessionId);
      sessionSubagentSourceMessagesCache.set(normalizedSessionId, cached);
      return cached.messages;
    }

    const next = {
      signature,
      messages: sourceMessages.length > 0 ? sourceMessages : (emptyArray as any as readonly Message[]),
    } satisfies SessionSubagentSourceMessagesCacheEntry;
    sessionSubagentSourceMessagesCache.delete(normalizedSessionId);
    sessionSubagentSourceMessagesCache.set(normalizedSessionId, next);
    trimSessionSubagentSourceMessagesCache();
    return next.messages;
  });
}

function sortValuesByUpdatedAtDescending<T extends { updatedAt: number }>(values: Record<string, T>): T[] {
  return Object.values(values).sort((left, right) => right.updatedAt - left.updatedAt);
}

export function useSessionMessages(
  sessionId: string,
  options?: UseSessionMessagesOptions,
): { messages: Message[]; isLoaded: boolean } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const enabled = options?.enabled !== false;
  // IMPORTANT:
  // Do not derive new arrays inside the Zustand selector. React 18 can call getSnapshot twice, and if the
  // selector allocates new references for unchanged store state it can trigger:
  // - "The result of getSnapshot should be cached…"
  // - "Maximum update depth exceeded"
  //
  // Subscribe to stable primitives instead (ids + version), then derive via useMemo.
  const { ids, isLoaded } = useSessionTranscriptIds(normalizedSessionId, enabled);
  const messagesById = useSessionMessagesById(normalizedSessionId, enabled);
  const version = useSessionMessagesVersion(normalizedSessionId, enabled);

  const messages = React.useMemo(() => {
    if (!enabled) {
      return emptyArray as any as Message[];
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      if (messagesById && Object.keys(messagesById).length > 0) {
        const cached = sessionMessagesArrayCache.get(normalizedSessionId);
        if (
          cached &&
          cached.messagesVersion === version &&
          cached.idsRef === ids &&
          cached.messagesByIdRef === messagesById
        ) {
          sessionMessagesArrayCache.delete(normalizedSessionId);
          sessionMessagesArrayCache.set(normalizedSessionId, cached);
          return cached.messages as Message[];
        }

        const out = Object.values(messagesById).slice().sort(compareMessagesOldestFirst);
        sessionMessagesArrayCache.delete(normalizedSessionId);
        sessionMessagesArrayCache.set(normalizedSessionId, {
          idsRef: ids,
          messagesByIdRef: messagesById,
          messagesVersion: version,
          messages: out,
        });
        while (sessionMessagesArrayCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
          const oldestKey = sessionMessagesArrayCache.keys().next().value;
          if (typeof oldestKey !== 'string') break;
          sessionMessagesArrayCache.delete(oldestKey);
        }
        return out;
      }

      // Minimal stale-while-revalidate behavior:
      // If a session transcript is temporarily reset (ids cleared + isLoaded=false) while a refresh is in flight,
      // keep showing the last derived messages array so switching sessions feels instant.
      const cached = sessionMessagesArrayCache.get(normalizedSessionId);
      if (cached && !isLoaded) {
        sessionMessagesArrayCache.delete(normalizedSessionId);
        sessionMessagesArrayCache.set(normalizedSessionId, cached);
        return cached.messages as Message[];
      }

      if (cached && isLoaded) {
        sessionMessagesArrayCache.delete(normalizedSessionId);
      }

      return emptyArray as any as Message[];
    }

    const cached = sessionMessagesArrayCache.get(normalizedSessionId);
    if (
      cached &&
      cached.messagesVersion === version &&
      cached.idsRef === ids &&
      cached.messagesByIdRef === messagesById
    ) {
      sessionMessagesArrayCache.delete(normalizedSessionId);
      sessionMessagesArrayCache.set(normalizedSessionId, cached);
      return cached.messages as Message[];
    }

    const out: Message[] = [];
    for (const id of ids) {
      const m = messagesById[id];
      if (m) out.push(m);
    }

    sessionMessagesArrayCache.delete(normalizedSessionId);
    sessionMessagesArrayCache.set(normalizedSessionId, {
      idsRef: ids,
      messagesByIdRef: messagesById,
      messagesVersion: version,
      messages: out,
    });
    while (sessionMessagesArrayCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
      const oldestKey = sessionMessagesArrayCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      sessionMessagesArrayCache.delete(oldestKey);
    }

    return out;
  }, [enabled, ids, isLoaded, messagesById, normalizedSessionId, version]);

  return React.useMemo(() => ({ messages, isLoaded }), [isLoaded, messages]);
}

export function useSessionTranscriptIds(sessionId: string, enabled: boolean = true): { ids: string[]; isLoaded: boolean } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const snapshot = getStorage()(
    useShallow((state) => {
      if (!enabled) {
        return {
          committedIds: emptyArray as any as string[],
          messagesVersion: 0,
          isLoaded: false,
        };
      }
      const session = state.sessionMessages[normalizedSessionId];
      return {
        committedIds: session?.messageIdsOldestFirst ?? (emptyArray as any as string[]),
        messagesVersion: session?.messagesVersion ?? 0,
        isLoaded: session?.isLoaded ?? false,
      };
    })
  );
  return React.useMemo(
    () => ({ ids: snapshot.committedIds as string[], isLoaded: snapshot.isLoaded }),
    [snapshot.committedIds, snapshot.isLoaded, snapshot.messagesVersion],
  );
}

export function useForkedTranscriptSnapshot(sessionId: string): ForkedTranscriptSnapshot | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => getForkedTranscriptSnapshotCached(state, normalizedSessionId))
  );
}

export function useSessionMessagesById(sessionId: string, enabled: boolean = true): Record<string, Message> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const snapshot = getStorage()(
    useShallow((state) => {
      if (!enabled) {
        return {
          committedIds: emptyArray as any as string[],
          committedMessagesById: emptyRecord as Record<string, Message>,
          messagesVersion: 0,
        };
      }
      const session = state.sessionMessages[normalizedSessionId];
      return {
        committedIds: session?.messageIdsOldestFirst ?? (emptyArray as any as string[]),
        committedMessagesById: session?.messagesById ?? (emptyRecord as Record<string, Message>),
        messagesVersion: session?.messagesVersion ?? 0,
      };
    })
  );
  return React.useMemo(() => snapshot.committedMessagesById, [snapshot.committedMessagesById, snapshot.messagesVersion]);
}

export function useSessionMessagesVersion(sessionId: string, enabled: boolean = true): number {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      if (!enabled) return 0;
      const session = state.sessionMessages[normalizedSessionId];
      return session?.messagesVersion ?? 0;
    })
  );
}

export function useSessionMessagesReducerState(sessionId: string) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const snapshot = getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[normalizedSessionId];
      return {
        reducerState: session?.reducerState ?? null,
        reducerVersion: (session as any)?.reducerVersion ?? 0,
      };
    })
  );

  return snapshot.reducerState;
}

export function useSessionLatestThinkingMessageId(sessionId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[normalizedSessionId];
      return session?.latestThinkingMessageId ?? null;
    })
  );
}

export function useSessionLatestThinkingMessageActivityAtMs(sessionId: string): number | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[normalizedSessionId];
      return session?.latestThinkingMessageActivityAtMs ?? null;
    })
  );
}

export function useHasUnreadMessages(sessionId: string): boolean {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => {
    const session = state.sessions[normalizedSessionId];
    if (session) {
      return deriveSessionAttentionFlags(session, {
        showPendingPermissionRequests: false,
        showPendingUserActionRequests: false,
        showQueuedUserInput: false,
      }).hasUnread;
    }

    return state.sessionListRenderables[normalizedSessionId]?.hasUnreadMessages === true;
  });
}

export function useSessionPendingMessages(
  sessionId: string
): { messages: PendingMessage[]; discarded: DiscardedPendingMessage[]; isLoaded: boolean } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const pending = state.sessionPending[normalizedSessionId];
      return {
        messages: pending?.messages ?? emptyArray,
        discarded: pending?.discarded ?? emptyArray,
        isLoaded: pending?.isLoaded ?? false,
      };
    })
  );
}

export function useSessionListMeaningfulActivityAt(sessionId: string): number | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => selectSessionListMeaningfulActivityAt(state, normalizedSessionId))
  );
}

function selectSessionListMeaningfulActivityAt(state: StorageState, sessionId: string): number | null {
  const session = state.sessions[sessionId];
  const transcript = state.sessionMessages[sessionId];
  const pending = state.sessionPending[sessionId];

  const latestCommittedMessageId =
    transcript?.messageIdsOldestFirst?.length
      ? transcript.messageIdsOldestFirst[transcript.messageIdsOldestFirst.length - 1] ?? null
      : null;
  const latestCommittedMessageCreatedAt =
    latestCommittedMessageId != null
      ? transcript?.messagesById?.[latestCommittedMessageId]?.createdAt ?? null
      : null;

  let latestPendingMessageCreatedAt: number | null = null;
  const pendingMessages = pending?.messages ?? emptyArray;
  for (const pendingMessage of pendingMessages as PendingMessage[]) {
    const createdAt = pendingMessage?.createdAt;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
    latestPendingMessageCreatedAt =
      latestPendingMessageCreatedAt == null ? createdAt : Math.max(latestPendingMessageCreatedAt, createdAt);
  }

  return deriveSessionListMeaningfulActivityAt({
    sessionCreatedAt: session?.createdAt ?? null,
    latestCommittedMessageCreatedAt,
    latestThinkingActivityAt: transcript?.latestThinkingMessageActivityAtMs ?? null,
    latestPendingMessageCreatedAt,
  });
}

export function useSessionListActivityTimeLabel(sessionId: string): string {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => {
    const meaningfulActivityAt = selectSessionListMeaningfulActivityAt(state, normalizedSessionId);
    return typeof meaningfulActivityAt === 'number' && meaningfulActivityAt > 0
      ? formatShortRelativeTime(meaningfulActivityAt)
      : '';
  });
}

export function useSessionReviewCommentsDrafts(sessionId: string): ReviewCommentDraft[] {
  return getStorage()(
    useShallow((state) => state.reviewCommentsDraftsBySessionId[sessionId] ?? emptyReviewCommentDrafts)
  );
}

export function useWorkspaceReviewCommentsDrafts(scope: WorkspaceScopeBase | null): ReviewCommentDraft[] {
  const cacheKey = React.useMemo(() => {
    if (!scope) return null;
    try {
      return buildWorkspaceCacheKey(scope);
    } catch {
      return null;
    }
  }, [scope]);

  return getStorage()(
    useShallow((state) => (cacheKey ? (state.reviewCommentsDraftsByWorkspaceCacheKey?.[cacheKey] ?? emptyReviewCommentDrafts) : emptyReviewCommentDrafts))
  );
}

export function useSessionActionDrafts(sessionId: string): SessionActionDraft[] {
  return getStorage()(
    useShallow((state) => (state.actionDraftsBySessionId ? (state.actionDraftsBySessionId[sessionId] ?? emptyActionDrafts) : emptyActionDrafts))
  );
}

function buildMessageLegacySignature(message: Message | null): string {
  if (!message) return 'null';
  try {
    return JSON.stringify(message) ?? 'null';
  } catch {
    return `${message.id}:${message.kind}:${message.createdAt}`;
  }
}

export function useMessage(sessionId: string, messageId: string): Message | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[normalizedSessionId];
      const message = session?.messagesById?.[messageId] ?? null;
      if (!message) {
        return {
          message: null,
          revision: 0,
          legacySignature: '',
        };
      }
      return {
        message,
        revision: session?.messageRevisionsById?.[messageId] ?? 0,
        legacySignature: buildMessageLegacySignature(message),
      };
    })
  ).message;
}

export function useResolvedSessionMessageRouteId(sessionId: string, routeMessageId: string): string | null {
  const messagesById = useSessionMessagesById(sessionId);
  const version = useSessionMessagesVersion(sessionId, true);
  const reducerState = useSessionMessagesReducerState(sessionId);

  return React.useMemo(() => {
    return resolveSessionMessageRouteId({
      routeMessageId,
      messagesById,
      reducerState,
    });
  }, [messagesById, reducerState, routeMessageId, version]);
}

export function useSessionMessageRouteId(sessionId: string, messageId: string): string | null {
  const messagesById = useSessionMessagesById(sessionId);
  const version = useSessionMessagesVersion(sessionId, true);
  const reducerState = useSessionMessagesReducerState(sessionId);

  return React.useMemo(() => {
    return buildSessionMessageRouteId({
      messageId,
      messagesById,
      reducerState,
    });
  }, [messageId, messagesById, reducerState, version]);
}

export function useMessagesByIds(sessionId: string, messageIds: readonly string[]): Message[] {
  // IMPORTANT:
  // Avoid allocating arrays inside the Zustand selector. React 18 can call getSnapshot twice, and if the
  // selector allocates new references for unchanged store state it can trigger:
  // - "The result of getSnapshot should be cached…"
  // - "Maximum update depth exceeded"
  const messagesById = useSessionMessagesById(sessionId);
  const version = useSessionMessagesVersion(sessionId, true);

  return React.useMemo(() => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return emptyArray as any as Message[];
    const out: Message[] = [];
    for (const id of messageIds) {
      const m = messagesById[id];
      if (m) out.push(m);
    }
    return out;
  }, [messageIds, messagesById, version]);
}

export function useSessionUsage(sessionId: string) {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.reducerState?.latestUsage ?? null;
    })
  );
}

export function useSettings(): Settings {
  return getStorage()(useShallow((state) => state.settings ?? settingsDefaults));
}

export function useSettingMutable<K extends keyof Settings>(
  name: K
): [Settings[K], (value: Settings[K]) => void] {
  const applySettings = useApplySettings();
  const setValue = React.useCallback(
    (value: Settings[K]) => {
      applySettings({ [name]: value } as Partial<Settings>);
    },
    [applySettings, name]
  );
  const value = useSetting(name);
  return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
  return getStorage()(useShallow((state) => state.settings?.[name] ?? settingsDefaults[name]));
}

export function useLocalSettings(): LocalSettings {
  return getStorage()(useShallow((state) => state.localSettings));
}

export function useAllMachines(): Machine[] {
  return getStorage()(
    useShallow((state) => {
      return resolveVisibleMachinesForActiveServerFromState(state);
    })
  );
}

export function useMachineRecordValues(): Machine[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as Machine[];
      return Object.values(state.machines);
    })
  );
}

const EMPTY_MACHINE_LIST_BY_SERVER_ID: Record<string, Machine[] | null> = {};

export function useMachineListByServerId(): Record<string, Machine[] | null> {
  const machineListByServerIdRaw = getStorage()(useShallow((state) => state.machineListByServerId));
  const machineListByServerId = machineListByServerIdRaw ?? EMPTY_MACHINE_LIST_BY_SERVER_ID;
  return React.useMemo(() => {
    const source: Record<string, Machine[] | null> =
      machineListByServerId && typeof machineListByServerId === 'object'
        ? (machineListByServerId as unknown as Record<string, Machine[] | null>)
        : {};
    let hasChanges = false;
    const nextByServerId: Record<string, Machine[] | null> = {};

    for (const [serverId, machines] of Object.entries(source)) {
      if (!Array.isArray(machines)) {
        nextByServerId[serverId] = machines;
        continue;
      }

      const visibleMachines = machines.filter((machine) => {
        const revokedAt = machine.revokedAt;
        return !(typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0);
      });
      if (visibleMachines.length !== machines.length) {
        hasChanges = true;
        nextByServerId[serverId] = visibleMachines;
        continue;
      }

      nextByServerId[serverId] = machines;
    }

    return hasChanges ? nextByServerId : source;
  }, [machineListByServerId]);
}

export function useMachineListStatusByServerId(): Record<string, 'idle' | 'loading' | 'signedOut' | 'error'> {
  const machineListStatusByServerId = getStorage()(useShallow((state) => state.machineListStatusByServerId));
  return React.useMemo(() => {
    return machineListStatusByServerId && typeof machineListStatusByServerId === 'object'
      ? (machineListStatusByServerId as unknown as Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>)
      : {};
  }, [machineListStatusByServerId]);
}

export function useMachine(machineId: string): Machine | null {
  return getStorage()(useShallow((state) => state.machines[machineId] ?? null));
}

export function useServerScopedMachine(serverId: string | null | undefined, machineId: string): Machine | null {
  return getStorage()(useShallow((state) => {
    const normalizedMachineId = typeof machineId === 'string' ? machineId.trim() : '';
    if (!normalizedMachineId) {
      return null;
    }

    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    if (normalizedServerId.length > 0) {
      const scopedMachines = state.machineListByServerId?.[normalizedServerId];
      if (Array.isArray(scopedMachines)) {
        const scopedMachine = scopedMachines.find((candidate) => candidate.id === normalizedMachineId) ?? null;
        if (scopedMachine) {
          return scopedMachine;
        }
      }
    }

    return state.machines[normalizedMachineId] ?? null;
  }));
}

export function useAllSessions(): Session[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as Session[];
      return sortValuesByUpdatedAtDescending(state.sessions);
    })
  );
}

export function useAllSessionsForAttention(): Session[] {
  return getStorage()(
    useShallow((state) => sortValuesByUpdatedAtDescending(state.sessions))
  );
}

export function useAllSessionListRenderables(): SessionListRenderableSession[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as SessionListRenderableSession[];
      return sortValuesByUpdatedAtDescending(state.sessionListRenderables);
    })
  );
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : null;
}

function appendSessionListAttentionRows(params: Readonly<{
  rows: SessionListAttentionRow[];
  seenKeys: Set<string>;
  serverId: string | null;
  serverName?: string | null;
  sessions: Readonly<Record<string, SessionListRenderableSession>> | null | undefined;
}>): void {
  const sessions = params.sessions;
  if (!sessions || typeof sessions !== 'object') return;

  const serverId = normalizeOptionalString(params.serverId);
  const serverName = normalizeOptionalString(params.serverName);
  for (const sessionIdRaw in sessions) {
    const sessionId = normalizeOptionalString(sessionIdRaw);
    if (!sessionId) continue;
    const session = sessions[sessionIdRaw];
    if (!session) continue;

    const key = `${serverId ?? 'local'}:${session.id}`;
    if (params.seenKeys.has(key)) continue;
    params.seenKeys.add(key);
    params.rows.push({ serverId, serverName, session });
  }
}

export function useAllSessionListAttentionRows(): SessionListAttentionRow[] {
  const activeServerId = normalizeOptionalString(useActiveServerSnapshot().serverId);
  const snapshot = getStorage()(
    useShallow((state) => ({
      isDataReady: state.isDataReady,
      sessionListRenderables: state.sessionListRenderables,
      sessionListRowStateByServerId: state.sessionListRowStateByServerId,
      concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
    }))
  );

  return React.useMemo(() => {
    const rows: SessionListAttentionRow[] = [];
    const seenKeys = new Set<string>();

    if (activeServerId) {
      appendSessionListAttentionRows({
        rows,
        seenKeys,
        serverId: activeServerId,
        sessions: snapshot.sessionListRenderables,
      });
    } else {
      appendSessionListAttentionRows({
        rows,
        seenKeys,
        serverId: null,
        sessions: snapshot.sessionListRenderables,
      });
    }

    for (const serverIdRaw in snapshot.sessionListRowStateByServerId ?? {}) {
      const serverId = normalizeOptionalString(serverIdRaw);
      if (!serverId) continue;
      appendSessionListAttentionRows({
        rows,
        seenKeys,
        serverId,
        sessions: snapshot.sessionListRowStateByServerId?.[serverIdRaw],
      });
    }

    for (const serverIdRaw in snapshot.concurrentSessionListCacheByServerId ?? {}) {
      const serverId = normalizeOptionalString(serverIdRaw);
      if (!serverId) continue;
      const entry = snapshot.concurrentSessionListCacheByServerId?.[serverIdRaw];
      appendSessionListAttentionRows({
        rows,
        seenKeys,
        serverId,
        serverName: entry?.serverName ?? null,
        sessions: entry?.sessions,
      });
    }

    if (rows.length > 1) {
      rows.sort((left, right) => right.session.updatedAt - left.session.updatedAt);
    }
    return rows;
  }, [
    activeServerId,
    snapshot.concurrentSessionListCacheByServerId,
    snapshot.sessionListRenderables,
    snapshot.sessionListRowStateByServerId,
  ]);
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(
  name: K
): [LocalSettings[K], (value: LocalSettings[K]) => void] {
  const applyLocalSettings = useApplyLocalSettings();
  const setValue = React.useCallback(
    (value: LocalSettings[K]) => {
      applyLocalSettings({ [name]: value } as Partial<LocalSettings>);
    },
    [applyLocalSettings, name]
  );
  const value = useLocalSetting(name);
  return [value, setValue];
}

// Project management hooks
export function useProjects() {
  return getStorage()(useShallow((state) => state.getProjects()));
}

export function useProject(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProject(projectId) : null)));
}

export function useProjectForSession(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getProjectForSession(sessionId) : null))
  );
}

export function useSessionWorkspacePath(sessionId: string | null): string | null {
  return getStorage()(
    useShallow((state) => {
      const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!normalizedSessionId) return null;
      return resolveWorkspaceTargetForSessionFromState({
        sessions: state.sessions,
        sessionListRenderables: state.sessionListRenderables,
        machines: state.machines,
        sessionListIndexByServerId: state.sessionListIndexByServerId,
        getProjectForSession: state.getProjectForSession,
      }, normalizedSessionId)?.rootPath ?? null;
    })
  );
}

export function useSessionRpcAvailabilityState(sessionId: string | null): Readonly<{
  sessionExists: boolean;
  sessionRpcAvailable: boolean;
}> {
  return getStorage()(
    useShallow((state) => {
      const session = sessionId ? state.sessions[sessionId] ?? null : null;
      const sessionExists = Boolean(session);
      return {
        sessionExists,
        sessionRpcAvailable: sessionExists && session?.active !== false,
      };
    })
  );
}

export function useProjectSessions(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProjectSessions(projectId) : [])));
}

export function useProjectScmStatus(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProjectScmStatus(projectId) : null)));
}

export function useSessionProjectScmStatus(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmStatus(sessionId) : null))
  );
}

export function useProjectScmSnapshot(projectId: string | null): ScmWorkingSnapshot | null {
  return getStorage()(
    useShallow((state) => (projectId ? state.getProjectScmSnapshot(projectId) : null))
  );
}

export function useSessionProjectScmSnapshot(sessionId: string | null): ScmWorkingSnapshot | null {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmSnapshot(sessionId) : null))
  );
}

export function useSessionProjectScmSnapshotError(
  sessionId: string | null
): import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmSnapshotError(sessionId) : null))
  );
}

export function useWorkspaceScmStatus(scope: WorkspaceScopeBase | null): ScmStatus | null {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmStatus(scope) : null)));
}

export function useWorkspaceScmSnapshot(scope: WorkspaceScopeBase | null): ScmWorkingSnapshot | null {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmSnapshot(scope) : null)));
}

export function useWorkspaceScmSnapshotError(
  scope: WorkspaceScopeBase | null
): import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmSnapshotError(scope) : null)));
}

export function useWorkspaceScmTouchedPaths(scope: WorkspaceScopeBase | null): string[] {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmTouchedPaths(scope) : [])));
}

export function useWorkspaceScmCommitSelectionPaths(scope: WorkspaceScopeBase | null): string[] {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmCommitSelectionPaths(scope) : [])));
}

export function useWorkspaceScmCommitSelectionPatches(scope: WorkspaceScopeBase | null): ScmCommitSelectionPatch[] {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmCommitSelectionPatches(scope) : [])));
}

export function useWorkspaceScmOperationLog(scope: WorkspaceScopeBase | null) {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmOperationLog(scope) : [])));
}

export function useWorkspaceScmInFlightOperation(scope: WorkspaceScopeBase | null) {
  return getStorage()(useShallow((state) => (scope ? state.getWorkspaceScmInFlightOperation(scope) : null)));
}

export function useSessionProjectScmTouchedPaths(sessionId: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmTouchedPaths(sessionId) : []))
  );
}

export function useSessionProjectScmCommitSelectionPaths(sessionId: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmCommitSelectionPaths(sessionId) : []))
  );
}

export function useSessionProjectScmCommitSelectionPatches(sessionId: string | null): ScmCommitSelectionPatch[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmCommitSelectionPatches(sessionId) : []))
  );
}

export function useSessionProjectScmOperationLog(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmOperationLog(sessionId) : []))
  );
}

export function useSessionProjectScmInFlightOperation(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmInFlightOperation(sessionId) : null))
  );
}

export function useSessionRepositoryTreeExpandedPaths(sessionId: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionRepositoryTreeExpandedPaths(sessionId) : []))
  );
}

export function useWorkspaceRepositoryTreeExpandedPaths(scope: WorkspaceScopeBase | null): string[] {
  const cacheKey = React.useMemo(() => {
    if (!scope) return null;
    try {
      return buildWorkspaceCacheKey(scope);
    } catch {
      return null;
    }
  }, [scope]);

  return getStorage()(
    useShallow((state) => (cacheKey ? state.getWorkspaceRepositoryTreeExpandedPaths(scope as WorkspaceScopeBase) : []))
  );
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
  return getStorage()(useShallow((state) => state.localSettings[name]));
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as DecryptedArtifact[];
      // Filter out draft artifacts from the main list
      return sortValuesByUpdatedAtDescending(state.artifacts).filter((artifact) => !artifact.draft);
    })
  );
}

export function useAllArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as DecryptedArtifact[];
      // Return all artifacts including drafts
      return sortValuesByUpdatedAtDescending(state.artifacts);
    })
  );
}

export function useAutomations(): Automation[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as Automation[];
      return sortValuesByUpdatedAtDescending(state.automations);
    })
  );
}

export function useAutomation(automationId: string): Automation | null {
  return getStorage()(useShallow((state) => state.automations[automationId] ?? null));
}

export function useAutomationRuns(automationId: string): AutomationRun[] {
  return getStorage()(
    useShallow((state) => state.automationRunsByAutomationId[automationId] ?? emptyArray)
  ) as AutomationRun[];
}

export function useDraftArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as DecryptedArtifact[];
      // Return only draft artifacts
      return sortValuesByUpdatedAtDescending(state.artifacts).filter((artifact) => artifact.draft === true);
    })
  );
}

export function useArtifact(artifactId: string): DecryptedArtifact | null {
  return getStorage()(useShallow((state) => state.artifacts[artifactId] ?? null));
}

export function useArtifactsCount(): number {
  return getStorage()(
    useShallow((state) => {
      // Count only non-draft artifacts
      return Object.values(state.artifacts).filter((a) => !a.draft).length;
    })
  );
}

export function useEntitlement(id: KnownEntitlements): boolean {
  return getStorage()(useShallow((state) => state.purchases.entitlements[id] ?? false));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
  return getStorage()(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'speaking' {
  return getStorage()(useShallow((state) => state.realtimeMode));
}

export function useSocketStatus() {
  return getStorage()(
    useShallow((state) => ({
      status: state.socketStatus,
      lastConnectedAt: state.socketLastConnectedAt,
      lastDisconnectedAt: state.socketLastDisconnectedAt,
      lastError: state.socketLastError,
      lastErrorAt: state.socketLastErrorAt,
    }))
  );
}

export function useEndpointConnectivity() {
  return getStorage()(
    useShallow((state) => ({
      status: state.endpointStatus,
      reason: state.endpointReason,
      attempt: state.endpointAttempt,
      nextRetryAt: state.endpointNextRetryAt,
      lastConnectedAt: state.endpointLastConnectedAt,
      lastDisconnectedAt: state.endpointLastDisconnectedAt,
      lastErrorMessage: state.endpointLastErrorMessage,
    }))
  );
}

export function useSyncError() {
  return getStorage()(useShallow((state) => state.syncError));
}

export function useLastSyncAt() {
  return getStorage()(useShallow((state) => state.lastSyncAt));
}

export function useSessionScmStatus(sessionId: string): ScmStatus | null {
  return getStorage()(useShallow((state) => state.sessionScmStatus[sessionId] ?? null));
}

export function useIsDataReady(): boolean {
  return getStorage()(useShallow((state) => state.isDataReady));
}

export function useProfile() {
  return getStorage()(useShallow((state) => state.profile));
}

export function useActiveServerAccountScope() {
  return getStorage()(useShallow((state) => state.profileScope ?? null));
}

export function useFriends() {
  return getStorage()(useShallow((state) => state.friends));
}

export function useFriendRequests() {
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get pending requests (where status is 'pending')
      const requests = Object.values(state.friends).filter((friend) => friend.status === 'pending');
      return requests.length > 0 ? requests : emptyArray as UserProfile[];
    })
  );
}

export function useAcceptedFriends() {
  return getStorage()(
    useShallow((state) => {
      const friends = Object.values(state.friends).filter((friend) => friend.status === 'friend');
      return friends.length > 0 ? friends : emptyArray as UserProfile[];
    })
  );
}

export function useFeedItems() {
  return getStorage()(useShallow((state) => state.feedItems));
}
export function useFeedLoaded() {
  return getStorage()((state) => state.feedLoaded);
}
export function useFriendsLoaded() {
  return getStorage()((state) => state.friendsLoaded);
}

export function useFriend(userId: string | undefined) {
  return getStorage()(useShallow((state) => (userId ? state.friends[userId] : undefined)));
}

export function useUser(userId: string | undefined) {
  return getStorage()(useShallow((state) => (userId ? state.users[userId] : undefined)));
}

export function useRequestedFriends() {
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get sent requests (where status is 'requested')
      const requests = Object.values(state.friends).filter((friend) => friend.status === 'requested');
      return requests.length > 0 ? requests : emptyArray as UserProfile[];
    })
  );
}
