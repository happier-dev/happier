import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';

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
import { collectOpenApprovalSessionIds } from '../domains/artifacts/approvalArtifacts';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { AgentTextMessage, Message } from '../domains/messages/messageTypes';
import type { Settings } from '../domains/settings/settings';
import { settingsDefaults } from '../domains/settings/settings';
import {
  deriveSessionListRenderableHasUnreadMessagesFromSession,
  isSessionListRenderableWarmCacheProgressOnlyChange,
  resolveSessionListReadableSeq,
  summarizeSessionListReadableActivityFromMessageRecords,
  type SessionListRenderableSession,
} from '../domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '../domains/sessionList/sessionListIndex';
import { deriveSessionListMeaningfulActivityAt } from '../domains/session/listing/deriveSessionListActivity';
import { getPermissionsInUiWhileLocal } from '../domains/state/agentStateCapabilities';
import { getSessionLocalControlState, type SessionLocalControlState } from '../domains/session/control/sessionLocalControl';
import { readExternalSessionLink } from '../domains/session/external/readExternalSessionLink';
import type { SessionForkSupportSource } from '../domains/sessionFork/forkUiSupport';
import { agentTextLooksLikeExecutionRunSignal, shouldIncludeSubagentSourceMessage } from '../domains/session/subagents/subagentSourceMessageDetection';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '../domains/sessionActions/sessionActionDraftTypes';
import type { UserProfile } from '../domains/social/friendTypes';
import { buildSessionMessageRouteId, resolveSessionMessageRouteId } from '../domains/messages/messageRouteIds';
import { useApplyLocalSettings, useApplySettings } from './settingsWriters';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSessionFromState } from '../domains/session/resolveWorkspaceTargetForSessionFromState';
import { normalizeSessionId } from '../domains/session/normalizeSessionId';
import { buildSessionMetadataStabilitySignature } from '../domains/session/metadata/sessionMetadataStability';
import { buildMachineDisplayRenderableFromMachine } from '../domains/machines/machineDisplayRenderable';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import { normalizeTrimmedString } from '../domains/session/listing/normalizeTrimmedString';
import { normalizeSessionListKeyParts } from '../domains/session/listing/sessionListKeyNormalization';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent } from '../domains/server/serverProfiles';
import { buildSessionFolderAssignmentKey } from '../domains/session/folders';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
  buildSessionRealtimeScmScopeFromSnapshot,
  getMountedSessionRealtimeScmConsumerScopeResetVersion,
  registerSessionRealtimeScmConsumerScope,
  subscribeMountedSessionRealtimeScmConsumerScopeResets,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';

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

const sessionForkSupportSourceCache = new Map<string, Readonly<{
  signature: string;
  value: SessionForkSupportSource;
}>>();

export function useSessionForkSupportSource(sessionId: string | null): SessionForkSupportSource | null {
  return getStorage()(
    useShallow((state) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const session = normalizedSessionId ? state.sessions[normalizedSessionId] ?? null : null;
      if (!session || !normalizedSessionId) return null;

      const signature = `${session.serverId ?? ''}\u0000${buildSessionMetadataStabilitySignature(session.metadata)}`;
      const cached = sessionForkSupportSourceCache.get(normalizedSessionId);
      if (cached?.signature === signature) return cached.value;

      const value: SessionForkSupportSource = { metadata: session.metadata, serverId: session.serverId };
      sessionForkSupportSourceCache.set(normalizedSessionId, { signature, value });
      return value;
    })
  );
}

export type SessionChatFooterState = Readonly<{
  controlledByUser: boolean;
  localControl: SessionLocalControlState | null;
  permissionsInUiWhileLocal: boolean;
}>;

const sessionChatFooterStateCache = new Map<string, Readonly<{
  signature: string;
  value: SessionChatFooterState;
}>>();

function buildSessionChatFooterStateSignature(value: SessionChatFooterState): string {
  const localControl = value.localControl;
  return [
    value.controlledByUser ? '1' : '0',
    value.permissionsInUiWhileLocal ? '1' : '0',
    localControl ? '1' : '0',
    localControl?.attached ? '1' : '0',
    localControl?.topology ?? '',
    localControl?.remoteWritable ? '1' : '0',
    localControl?.canAttach ? '1' : '0',
    localControl?.canDetach ? '1' : '0',
  ].join('|');
}

export function useSessionChatFooterState(sessionId: string | null): SessionChatFooterState | null {
  return getStorage()(
    useShallow((state) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const session = normalizedSessionId ? state.sessions[normalizedSessionId] ?? null : null;
      if (!session) return null;

      const value: SessionChatFooterState = {
        controlledByUser: session.agentState?.controlledByUser === true,
        localControl: getSessionLocalControlState(session),
        permissionsInUiWhileLocal: getPermissionsInUiWhileLocal(session.agentState?.capabilities),
      };
      const signature = buildSessionChatFooterStateSignature(value);
      const cached = sessionChatFooterStateCache.get(session.id);
      if (cached?.signature === signature) return cached.value;

      sessionChatFooterStateCache.set(session.id, { signature, value });
      return value;
    })
  );
}

export function useSessionMetadata(sessionId: string): Session['metadata'] | null {
  return getStorage()((state) => state.sessions[sessionId]?.metadata ?? null);
}

export function useSessionListRenderable(id: string): SessionListRenderableSession | null {
  return getStorage()(useShallow((state) => state.sessionListRenderables[id] ?? null));
}

const ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS = 30_000;

const sessionListRowRenderableProjectionCache = new WeakMap<SessionListRenderableSession, SessionListRenderableSession>();
const sessionListRowRenderableProjectionByKey = new Map<string, Readonly<{
  source: SessionListRenderableSession;
  projected: SessionListRenderableSession;
}>>();

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function resolveProgressTimestamp(renderable: SessionListRenderableSession): number | null {
  const updatedAt = finiteTimestamp(renderable.updatedAt);
  const meaningfulActivityAt = finiteTimestamp(renderable.meaningfulActivityAt);
  if (updatedAt === null) return meaningfulActivityAt;
  if (meaningfulActivityAt === null) return updatedAt;
  return Math.max(updatedAt, meaningfulActivityAt);
}

function hasSameRelativeProgressLabels(
  previous: SessionListRenderableSession,
  next: SessionListRenderableSession,
  nowMs: number,
): boolean {
  const previousUpdatedAt = finiteTimestamp(previous.updatedAt);
  const nextUpdatedAt = finiteTimestamp(next.updatedAt);
  if (previousUpdatedAt !== null && nextUpdatedAt !== null) {
    if (formatShortRelativeTimeAt(previousUpdatedAt, nowMs) !== formatShortRelativeTimeAt(nextUpdatedAt, nowMs)) {
      return false;
    }
  }

  const previousMeaningfulActivityAt = finiteTimestamp(previous.meaningfulActivityAt);
  const nextMeaningfulActivityAt = finiteTimestamp(next.meaningfulActivityAt);
  if (previousMeaningfulActivityAt !== null && nextMeaningfulActivityAt !== null) {
    if (
      formatShortRelativeTimeAt(previousMeaningfulActivityAt, nowMs)
      !== formatShortRelativeTimeAt(nextMeaningfulActivityAt, nowMs)
    ) {
      return false;
    }
  }

  return true;
}

function shouldReusePreviousProgressProjection(input: Readonly<{
  previous: SessionListRenderableSession;
  next: SessionListRenderableSession;
  nowMs: number;
}>): boolean {
  const { previous, next, nowMs } = input;
  if (previous === next) return false;
  if (!isSessionListRenderableWarmCacheProgressOnlyChange(previous, next)) return false;
  if (previous.activeAt !== next.activeAt) return false;

  const previousTimestamp = resolveProgressTimestamp(previous);
  const nextTimestamp = resolveProgressTimestamp(next);
  if (previousTimestamp === null || nextTimestamp === null) return false;
  if (nextTimestamp <= previousTimestamp) return false;
  if (nextTimestamp - previousTimestamp >= ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS) return false;

  return hasSameRelativeProgressLabels(previous, next, nowMs);
}

function buildProjectedSessionListRowRenderable(renderable: SessionListRenderableSession): SessionListRenderableSession {
  const isActiveStreaming = renderable.active === true
    && renderable.presence === 'online'
    && renderable.thinking === true;
  return {
    ...renderable,
    updatedAt: isActiveStreaming ? 0 : renderable.updatedAt,
    activeAt: renderable.presence === 'online' ? 0 : renderable.activeAt,
    thinkingAt: 0,
    pendingVersion: undefined,
    metadataVersion: 0,
    agentStateVersion: 0,
  };
}

function resolveSessionListRowRenderableProjectionKey(
  renderable: SessionListRenderableSession,
  scopeKey: string | null | undefined,
): string {
  const normalizedScopeKey = typeof scopeKey === 'string' ? scopeKey.trim() : '';
  return normalizedScopeKey || renderable.id;
}

function projectSessionListRowRenderable(
  renderable: SessionListRenderableSession | null | undefined,
  scopeKey?: string | null,
): SessionListRenderableSession | null {
  if (!renderable) return null;
  const projectionKey = resolveSessionListRowRenderableProjectionKey(renderable, scopeKey);
  const cached = sessionListRowRenderableProjectionCache.get(renderable);
  if (cached) {
    const keyedProjection = sessionListRowRenderableProjectionByKey.get(projectionKey);
    if (keyedProjection?.source !== renderable || keyedProjection.projected !== cached) {
      sessionListRowRenderableProjectionByKey.set(projectionKey, {
        source: renderable,
        projected: cached,
      });
    }
    return cached;
  }

  const previousProjection = sessionListRowRenderableProjectionByKey.get(projectionKey);
  if (previousProjection && shouldReusePreviousProgressProjection({
    previous: previousProjection.source,
    next: renderable,
    nowMs: Date.now(),
  })) {
    sessionListRowRenderableProjectionCache.set(renderable, previousProjection.projected);
    return previousProjection.projected;
  }

  const projected = buildProjectedSessionListRowRenderable(renderable);
  sessionListRowRenderableProjectionCache.set(renderable, projected);
  sessionListRowRenderableProjectionByKey.set(projectionKey, {
    source: renderable,
    projected,
  });
  return projected;
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
        return projectSessionListRowRenderable(
          scoped[normalizedSessionId],
          `${normalizedServerId}\u0000${normalizedSessionId}`,
        );
      }

      if (activeServerId && activeServerId === normalizedServerId) {
        return projectSessionListRowRenderable(
          state.sessionListRenderables[normalizedSessionId],
          `${normalizedServerId}\u0000${normalizedSessionId}`,
        );
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

export type SessionListReachabilityRenderable = Pick<SessionListRenderableSession, 'id' | 'metadata'>;

type SessionListReachabilityItemKey = Readonly<{
  key: string;
  serverId: string;
  sessionId: string;
}>;

const emptySessionListReachabilityRenderablesByKey =
  new Map<string, SessionListReachabilityRenderable>() as ReadonlyMap<string, SessionListReachabilityRenderable>;
const sessionListReachabilityRenderableCache = new Map<string, Readonly<{
  metadata: SessionListRenderableSession['metadata'];
  value: SessionListReachabilityRenderable;
}>>();

export function buildSessionListReachabilityRenderableKey(
  serverId: string | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  const normalizedServerId = normalizeTrimmedString(serverId);
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedServerId || !normalizedSessionId) return null;
  return `${normalizedServerId}\u0000${normalizedSessionId}`;
}

function projectSessionListReachabilityRenderable(
  cacheKey: string,
  renderable: SessionListRenderableSession,
): SessionListReachabilityRenderable {
  const cached = sessionListReachabilityRenderableCache.get(cacheKey);
  if (cached?.metadata === renderable.metadata && cached.value.id === renderable.id) {
    return cached.value;
  }

  const value: SessionListReachabilityRenderable = {
    id: renderable.id,
    metadata: renderable.metadata,
  };
  sessionListReachabilityRenderableCache.set(cacheKey, {
    metadata: renderable.metadata,
    value,
  });
  return value;
}

export function useSessionListReachabilityRenderablesForItems(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
): ReadonlyMap<string, SessionListReachabilityRenderable> {
  const itemKeys = React.useMemo(() => {
    if (!items || items.length === 0) return emptyArray as SessionListReachabilityItemKey[];
    const next: SessionListReachabilityItemKey[] = [];
    for (const item of items) {
      if (!item || item.type !== 'session') continue;
      const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId);
      if (!key) continue;
      next.push({
        key,
        serverId: normalizeTrimmedString(item.serverId)!,
        sessionId: normalizeSessionId(item.sessionId)!,
      });
    }
    return next.length === 0 ? (emptyArray as SessionListReachabilityItemKey[]) : next;
  }, [items]);

  return getStorage()(useShallow((state) => {
    if (itemKeys.length === 0) return emptySessionListReachabilityRenderablesByKey;

    const next = new Map<string, SessionListReachabilityRenderable>();
    for (const itemKey of itemKeys) {
      const row = state.sessionListRowStateByServerId?.[itemKey.serverId]?.[itemKey.sessionId];
      if (!row) continue;
      next.set(itemKey.key, projectSessionListReachabilityRenderable(itemKey.key, row));
    }

    return next.size === 0 ? emptySessionListReachabilityRenderablesByKey : next;
  }));
}

const emptySessionListRowRenderablesByKey =
  new Map<string, SessionListRenderableSession>() as ReadonlyMap<string, SessionListRenderableSession>;

export function useSessionListRowRenderablesForItems(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
): ReadonlyMap<string, SessionListRenderableSession> {
  const itemKeys = React.useMemo(() => {
    if (!items || items.length === 0) return emptyArray as SessionListReachabilityItemKey[];
    const next: SessionListReachabilityItemKey[] = [];
    for (const item of items) {
      if (!item || item.type !== 'session') continue;
      const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId);
      if (!key) continue;
      next.push({
        key,
        serverId: normalizeTrimmedString(item.serverId)!,
        sessionId: normalizeSessionId(item.sessionId)!,
      });
    }
    return next.length === 0 ? (emptyArray as SessionListReachabilityItemKey[]) : next;
  }, [items]);

  return getStorage()(useShallow((state) => {
    if (itemKeys.length === 0) return emptySessionListRowRenderablesByKey;

    const next = new Map<string, SessionListRenderableSession>();
    for (const itemKey of itemKeys) {
      const row = state.sessionListRowStateByServerId?.[itemKey.serverId]?.[itemKey.sessionId];
      const projected = projectSessionListRowRenderable(row, itemKey.key);
      if (!projected) continue;
      next.set(`${itemKey.serverId}:${itemKey.sessionId}`, projected);
    }

    return next.size === 0 ? emptySessionListRowRenderablesByKey : next;
  }));
}

const EMPTY_SESSION_LIST_INDEX_BY_SERVER_ID: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> = {};

function normalizeSelectedSessionListServerIds(serverIds: ReadonlyArray<string> | null | undefined): string[] {
  if (!Array.isArray(serverIds)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawServerId of serverIds) {
    const serverId = String(rawServerId ?? '').trim();
    if (!serverId || seen.has(serverId)) continue;
    seen.add(serverId);
    out.push(serverId);
  }
  return out;
}

function resolveEquivalentSessionListIndexServerId(
  indexByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>,
  requestedServerId: string,
): string | null {
  if (Object.prototype.hasOwnProperty.call(indexByServerId, requestedServerId)) return requestedServerId;
  return Object.keys(indexByServerId).find((storedServerId) => (
    areServerProfileIdentifiersEquivalent(storedServerId, requestedServerId)
  )) ?? null;
}

export function useSessionListIndexByServerId(
  serverIds?: ReadonlyArray<string>,
): Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> {
  const hasExplicitServerSelection = Array.isArray(serverIds);
  const serverIdsKey = hasExplicitServerSelection ? serverIds.join('\u0001') : null;
  const selectedServerIds = React.useMemo(
    () => hasExplicitServerSelection ? normalizeSelectedSessionListServerIds(serverIds) : [],
    [hasExplicitServerSelection, serverIds, serverIdsKey],
  );

  return getStorage()(useShallow((state) => {
    const indexByServerId = state.sessionListIndexByServerId ?? EMPTY_SESSION_LIST_INDEX_BY_SERVER_ID;
    if (!hasExplicitServerSelection) return indexByServerId;
    if (selectedServerIds.length === 0) return EMPTY_SESSION_LIST_INDEX_BY_SERVER_ID;
    const selected: Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined> = {};
    for (const serverId of selectedServerIds) {
      const resolvedServerId = resolveEquivalentSessionListIndexServerId(indexByServerId, serverId);
      if (!resolvedServerId) continue;
      selected[resolvedServerId] = indexByServerId[resolvedServerId] ?? null;
    }
    return Object.keys(selected).length > 0 ? selected : EMPTY_SESSION_LIST_INDEX_BY_SERVER_ID;
  }));
}

export function useSessionFolderAssignment(serverId: string | null | undefined, sessionId: string): string | null {
  return getStorage()(useShallow((state) => (
    state.sessionFolderAssignmentsBySessionKey[buildSessionFolderAssignmentKey(serverId, sessionId)] ?? null
  )));
}

export function useSessionFolderAssignmentsBySessionKey(): Record<string, string | null> {
  return getStorage()(useShallow((state) => state.sessionFolderAssignmentsBySessionKey));
}

const EMPTY_MACHINE_DISPLAY_BY_ID: Record<string, MachineDisplayRenderable> = {};

export function useMachineDisplayById(): Record<string, MachineDisplayRenderable> {
  return getStorage()(useShallow((state) => state.machineDisplayById ?? EMPTY_MACHINE_DISPLAY_BY_ID));
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

function resolveSessionLastMobileSurfaceStorageKeyFromState(
  state: Pick<StorageState, 'sessions' | 'sessionListIndexByServerId' | 'sessionListRenderables' | 'concurrentSessionListCacheByServerId'>,
  sessionId: string,
): string {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return '';
  const resolvedServerId = resolveSessionListLookupSessionServerScopeFromState({
    sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
    sessionListIndexByServerId: state.sessionListIndexByServerId,
    sessionListRenderables: state.sessionListRenderables,
    concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
  }, normalizedSessionId)?.serverId ?? null;
  return normalizeSessionListKeyParts(resolvedServerId, normalizedSessionId).sessionKey ?? normalizedSessionId;
}

function readSessionLastMobileSurfaceFromMap(
  persistedBySessionId: LocalSettings['sessionLastMobileSurfaceBySessionId'] | null | undefined,
  sessionId: string,
  scopedStorageKey: string,
): LocalSettings['sessionLastMobileSurfaceBySessionId'][string] | null {
  const scopedValue = scopedStorageKey ? persistedBySessionId?.[scopedStorageKey] ?? null : null;
  if (typeof scopedValue === 'string') return scopedValue;
  const legacyValue = persistedBySessionId?.[sessionId] ?? null;
  return typeof legacyValue === 'string' ? legacyValue : null;
}

const emptyArray: unknown[] = [];
const emptyRecord: Record<string, any> = {};
const emptyReviewCommentDrafts: ReviewCommentDraft[] = [];
const emptyActionDrafts: SessionActionDraft[] = [];
const emptyOpenApprovalSessionIds: ReadonlyArray<string> = Object.freeze([]);

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
  sourceVersion: number;
  signature: string;
  messages: readonly Message[];
}>;

const sessionSubagentSourceMessagesCache = new Map<string, SessionSubagentSourceMessagesCacheEntry>();
const sessionSubagentSourceMessageSignatureCache = new WeakMap<Message, string>();

export function clearSessionMessageDerivedCachesForServerScopeReset(): void {
  sessionMessagesArrayCache.clear();
  sessionSubagentSourceMessagesCache.clear();
}

function stringifySignatureValue(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return String(value);
  }
}

function appendSubagentSourceMessageSignature(parts: string[], message: Message): void {
  const cached = sessionSubagentSourceMessageSignatureCache.get(message);
  if (cached !== undefined) {
    parts.push(cached);
    return;
  }

  const messageParts: string[] = [];
  const seq = normalizeMessageSeq((message as any).seq);
  messageParts.push(`${message.id}:${message.kind}:${seq ?? ''}:${message.createdAt ?? ''}`);
  if (message.kind === 'agent-text') {
    messageParts.push(typeof (message as any).text === 'string' ? String((message as any).text) : '');
    const signature = messageParts.join('\u0001');
    sessionSubagentSourceMessageSignatureCache.set(message, signature);
    parts.push(signature);
    return;
  }
  if (message.kind !== 'tool-call') {
    const signature = messageParts.join('\u0001');
    sessionSubagentSourceMessageSignatureCache.set(message, signature);
    parts.push(signature);
    return;
  }
  const tool = (message as any).tool;
  messageParts.push(stringifySignatureValue({
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
  const signature = messageParts.join('\u0001');
  sessionSubagentSourceMessageSignatureCache.set(message, signature);
  parts.push(signature);
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

    const sourceVersion = typeof session.subagentSourceVersion === 'number' && Number.isFinite(session.subagentSourceVersion)
      ? Math.trunc(session.subagentSourceVersion)
      : session.messagesVersion;
    const cached = sessionSubagentSourceMessagesCache.get(normalizedSessionId);
    if (cached && cached.sourceVersion === sourceVersion) {
      sessionSubagentSourceMessagesCache.delete(normalizedSessionId);
      sessionSubagentSourceMessagesCache.set(normalizedSessionId, cached);
      return cached.messages;
    }

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
    if (cached && cached.signature === signature) {
      sessionSubagentSourceMessagesCache.delete(normalizedSessionId);
      const nextCached = { ...cached, sourceVersion };
      sessionSubagentSourceMessagesCache.set(normalizedSessionId, nextCached);
      return cached.messages;
    }

    const next = {
      sourceVersion,
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
          isLoaded: false,
        };
      }
      const session = state.sessionMessages[normalizedSessionId];
      return {
        committedIds: session?.messageIdsOldestFirst ?? (emptyArray as any as string[]),
        isLoaded: session?.isLoaded ?? false,
      };
    })
  );
  return React.useMemo(
    () => ({ ids: snapshot.committedIds as string[], isLoaded: snapshot.isLoaded }),
    [snapshot.committedIds, snapshot.isLoaded],
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
      const readableActivity = summarizeCommittedSessionMessagesForUnread(state.sessionMessages[normalizedSessionId]);
      const readableSeq = resolveSessionListReadableSeq(session, readableActivity);
      const hasUnreadMessages = deriveSessionListRenderableHasUnreadMessagesFromSession(session, readableActivity);
      if (
        hasUnreadMessages === false
        && readableActivity === undefined
        && readableSeq <= 0
        && !readExternalSessionLink(session.metadata)
      ) {
        return state.sessionListRenderables[normalizedSessionId]?.hasUnreadMessages === true;
      }
      return hasUnreadMessages;
    }

    return state.sessionListRenderables[normalizedSessionId]?.hasUnreadMessages === true;
  });
}

export function useSessionReadyActivity(sessionId: string): {
  latestReadyEventSeq: number | null;
  latestReadyEventAt: number | null;
} {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessions[normalizedSessionId];
      const sessionMessages = state.sessionMessages[normalizedSessionId];
      const renderable = state.sessionListRenderables[normalizedSessionId];
      return {
        latestReadyEventSeq:
          sessionMessages?.latestReadyEventSeq
          ?? session?.latestReadyEventSeq
          ?? renderable?.latestReadyEventSeq
          ?? null,
        latestReadyEventAt:
          sessionMessages?.latestReadyEventAt
          ?? session?.latestReadyEventAt
          ?? renderable?.latestReadyEventAt
          ?? null,
      };
    })
  );
}

export function useSessionVisibleReadSeq(
  sessionId: string,
  params: Readonly<{
    sessionSeq: number | null;
    latestTurnStatus: PrimaryTurnStatusV1 | null | undefined;
  }>,
): number | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const { sessionSeq, latestTurnStatus } = params;
  return getStorage()((state) => {
    const sessionMessages = state.sessionMessages[normalizedSessionId];
    if (!sessionMessages || sessionMessages.isLoaded !== true) {
      return null;
    }
    const session = state.sessions[normalizedSessionId];
    const renderable = state.sessionListRenderables[normalizedSessionId];
    const readableActivity = summarizeSessionListReadableActivityFromMessageRecords(
      sessionMessages.messageIdsOldestFirst,
      sessionMessages.messagesById,
    );
    const latestReadyEventSeq =
      sessionMessages.latestReadyEventSeq
      ?? session?.latestReadyEventSeq
      ?? renderable?.latestReadyEventSeq
      ?? null;
    if (
      readableActivity?.latestCommittedMessageSeq == null
      && latestReadyEventSeq == null
      && !(hasTerminalPrimaryTurnStatus(latestTurnStatus) && sessionSeq != null)
    ) {
      return null;
    }
    return resolveSessionListReadableSeq({
      seq: sessionSeq ?? 0,
      latestReadyEventSeq,
      latestTurnStatus,
    }, readableActivity);
  });
}

function hasTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null | undefined): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
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
  const renderable = state.sessionListRenderables[sessionId];
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
    sessionMeaningfulActivityAt: session?.meaningfulActivityAt ?? renderable?.meaningfulActivityAt ?? null,
    sessionCreatedAt: session?.createdAt ?? renderable?.createdAt ?? null,
    latestCommittedMessageCreatedAt,
    latestThinkingActivityAt: transcript?.latestThinkingMessageActivityAtMs ?? null,
    latestPendingMessageCreatedAt,
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

const legacyMessageSignatureCache = new WeakMap<Message, Readonly<{
  messagesVersion: number;
  signature: string;
}>>();

function buildMessageLegacySignature(message: Message | null, messagesVersion: number): string {
  if (!message) return 'null';
  const cached = legacyMessageSignatureCache.get(message);
  if (cached?.messagesVersion === messagesVersion) return cached.signature;

  let signature: string;
  try {
    signature = JSON.stringify(message) ?? 'null';
  } catch {
    signature = `${message.id}:${message.kind}:${message.createdAt}`;
  }
  legacyMessageSignatureCache.set(message, { messagesVersion, signature });
  return signature;
}

function summarizeCommittedSessionMessagesForUnread(
  sessionMessages: StorageState['sessionMessages'][string] | undefined,
): ReturnType<typeof summarizeSessionListReadableActivityFromMessageRecords> {
  if (!sessionMessages) return undefined;
  return summarizeSessionListReadableActivityFromMessageRecords(
    sessionMessages.messageIdsOldestFirst,
    sessionMessages.messagesById,
  );
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
      const revision = session?.messageRevisionsById?.[messageId] ?? null;
      const legacyMessagesVersion = revision === null ? session?.messagesVersion ?? 0 : 0;
      return {
        message,
        revision,
        legacySignature: revision === null ? buildMessageLegacySignature(message, legacyMessagesVersion) : null,
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
  const selectedMessagesCacheRef = React.useRef<{
    messageIds: readonly string[];
    messageRefs: readonly (Message | undefined)[];
    messages: Message[];
  } | null>(null);

  return React.useMemo(() => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return emptyArray as any as Message[];
    const messageRefs: Array<Message | undefined> = [];
    const out: Message[] = [];
    for (const id of messageIds) {
      const m = messagesById[id];
      messageRefs.push(m);
      if (m) out.push(m);
    }
    const cached = selectedMessagesCacheRef.current;
    if (cached && cached.messageIds.length === messageIds.length && cached.messageRefs.length === messageRefs.length) {
      let same = true;
      for (let index = 0; index < messageIds.length; index += 1) {
        if (cached.messageIds[index] !== messageIds[index] || cached.messageRefs[index] !== messageRefs[index]) {
          same = false;
          break;
        }
      }
      if (same) return cached.messages;
    }
    selectedMessagesCacheRef.current = {
      messageIds: messageIds.slice(),
      messageRefs,
      messages: out,
    };
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

type LaunchSelectionMachinesCache = Readonly<{
  signature: string;
  machines: Machine[];
}>;

let launchSelectionMachinesCache: LaunchSelectionMachinesCache | null = null;

function buildLaunchSelectionMachineSignature(machine: Machine): string {
  const metadata = machine.metadata;
  return [
    machine.id,
    String(machine.active === true),
    String(isMachineOnline(machine)),
    String(machine.revokedAt ?? ''),
    String(machine.replacedByMachineId ?? ''),
    String(machine.daemonStateVersion ?? ''),
    String(metadata?.displayName ?? ''),
    String(metadata?.host ?? ''),
    String(metadata?.homeDir ?? ''),
    String(metadata?.platform ?? ''),
  ].join('|');
}

function buildLaunchSelectionMachinesSignature(machines: readonly Machine[]): string {
  return machines.map(buildLaunchSelectionMachineSignature).join('\n');
}

function getStableLaunchSelectionMachines(machines: Machine[]): Machine[] {
  const signature = buildLaunchSelectionMachinesSignature(machines);
  if (launchSelectionMachinesCache?.signature === signature) {
    return launchSelectionMachinesCache.machines;
  }

  launchSelectionMachinesCache = { signature, machines };
  return machines;
}

export function useLaunchSelectionMachines(): Machine[] {
  return getStorage()((state) => {
    return getStableLaunchSelectionMachines(resolveVisibleMachinesForActiveServerFromState(state));
  });
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

type MachineCliDetectionTarget = Readonly<{
  daemonStateVersion: number;
  isOnline: boolean;
}>;

type MachineCliDetectionTargetCacheEntry = Readonly<{
  signature: string;
  target: MachineCliDetectionTarget;
}>;

const machineCliDetectionTargetCache = new Map<string, MachineCliDetectionTargetCacheEntry>();

function getStableMachineCliDetectionTarget(machineId: string, machine: Machine | null): MachineCliDetectionTarget {
  const daemonStateVersion = machine?.daemonStateVersion ?? 0;
  const isOnline = machine ? isMachineOnline(machine) : false;
  const signature = `${daemonStateVersion}:${isOnline ? 'online' : 'offline'}`;
  const cached = machineCliDetectionTargetCache.get(machineId);
  if (cached?.signature === signature) {
    return cached.target;
  }
  const target = { daemonStateVersion, isOnline };
  machineCliDetectionTargetCache.set(machineId, { signature, target });
  return target;
}

export function useMachineCliDetectionTarget(machineId: string | null): MachineCliDetectionTarget {
  return getStorage()((state) => {
    const normalizedMachineId = String(machineId ?? '').trim();
    const machine = normalizedMachineId ? state.machines[normalizedMachineId] ?? null : null;
    return getStableMachineCliDetectionTarget(normalizedMachineId, machine);
  });
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

export function useSessionRealtimeScmTranscriptConsumer(
  sessionId: string | null,
  snapshot: ScmWorkingSnapshot | null,
): void {
  const mountedScmConsumerResetVersion = React.useSyncExternalStore(
    subscribeMountedSessionRealtimeScmConsumerScopeResets,
    getMountedSessionRealtimeScmConsumerScopeResetVersion,
    getMountedSessionRealtimeScmConsumerScopeResetVersion,
  );

  React.useEffect(() => {
    if (!sessionId) return undefined;
    const scope = snapshot
      ? buildSessionRealtimeScmScopeFromSnapshot(getStorage().getState(), sessionId, snapshot) ?? { sessionId }
      : { sessionId };
    return registerSessionRealtimeScmConsumerScope(scope);
  }, [mountedScmConsumerResetVersion, sessionId, snapshot]);
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

export function useSessionLastMobileSurface(sessionId: string | null): LocalSettings['sessionLastMobileSurfaceBySessionId'][string] | null {
  return getStorage()(useShallow((state) => {
    if (!sessionId) return null;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return null;
    const scopedStorageKey = resolveSessionLastMobileSurfaceStorageKeyFromState(state, normalizedSessionId);
    return readSessionLastMobileSurfaceFromMap(
      state.localSettings.sessionLastMobileSurfaceBySessionId,
      normalizedSessionId,
      scopedStorageKey,
    );
  }));
}

export function usePersistSessionLastMobileSurface(): (
  sessionId: string,
  surface: LocalSettings['sessionLastMobileSurfaceBySessionId'][string],
) => void {
  const applyLocalSettings = useApplyLocalSettings();
  return React.useCallback((sessionId, surface) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    const scopedStorageKey = resolveSessionLastMobileSurfaceStorageKeyFromState(getStorage().getState(), normalizedSessionId);
    const current = getStorage().getState().localSettings.sessionLastMobileSurfaceBySessionId ?? {};
    applyLocalSettings({
      sessionLastMobileSurfaceBySessionId: {
        ...current,
        [scopedStorageKey || normalizedSessionId]: surface,
      },
    });
  }, [applyLocalSettings]);
}

export function useProjectLastMobileSurface(workspaceRefId: string | null): LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'][string] | null {
  return getStorage()(useShallow((state) => {
    if (!workspaceRefId) return null;
    const value = state.localSettings.projectLastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] ?? null;
    return typeof value === 'string' ? value : null;
  }));
}

export function usePersistProjectLastMobileSurface(): (
  workspaceRefId: string,
  surface: LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'][string],
) => void {
  const applyLocalSettings = useApplyLocalSettings();
  return React.useCallback((workspaceRefId, surface) => {
    const current = getStorage().getState().localSettings.projectLastMobileSurfaceByWorkspaceRefId ?? {};
    applyLocalSettings({
      projectLastMobileSurfaceByWorkspaceRefId: {
        ...current,
        [workspaceRefId]: surface,
      },
    });
  }, [applyLocalSettings]);
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

function collectOpenApprovalSessionIdListFromArtifacts(
  artifacts: Readonly<Record<string, DecryptedArtifact>>,
): ReadonlyArray<string> {
  const visibleArtifacts: DecryptedArtifact[] = [];
  for (const artifact of Object.values(artifacts)) {
    if (artifact.draft === true) continue;
    visibleArtifacts.push(artifact);
  }
  const ids = collectOpenApprovalSessionIds(visibleArtifacts);
  return ids.size === 0 ? emptyOpenApprovalSessionIds : Array.from(ids).sort();
}

export function useOpenApprovalSessionIds(): ReadonlyArray<string> {
  const selectorRef = React.useRef<((state: StorageState) => ReadonlyArray<string>) | null>(null);
  if (!selectorRef.current) {
    let previousIsDataReady: boolean | null = null;
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousIds: ReadonlyArray<string> = emptyOpenApprovalSessionIds;

    selectorRef.current = (state) => {
      if (state.isDataReady === previousIsDataReady && state.artifacts === previousArtifacts) {
        return previousIds;
      }

      previousIsDataReady = state.isDataReady;
      previousArtifacts = state.artifacts;
      previousIds = state.isDataReady
        ? collectOpenApprovalSessionIdListFromArtifacts(state.artifacts)
        : emptyOpenApprovalSessionIds;
      return previousIds;
    };
  }

  return getStorage()(useShallow(selectorRef.current));
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

export function useAccountSettingsSyncStatus() {
  return getStorage()(useShallow((state) => state.accountSettingsSyncStatus));
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
