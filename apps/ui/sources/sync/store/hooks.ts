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
import {
  collectOpenApprovalSessionIds,
  listOpenApprovalArtifactsForSession,
  type OpenApprovalArtifactForSession,
} from '../domains/artifacts/approvalArtifacts';
import { isAutomationLinkedToSession } from '../domains/automations/automationSessionLink';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { AgentTextMessage, Message } from '../domains/messages/messageTypes';
import type { Settings } from '../domains/settings/settings';
import { settingsDefaults } from '../domains/settings/settings';
import type { SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import {
  deriveSessionListRenderableHasUnreadMessagesFromReadableSeq,
  type SessionListRenderableSession,
} from '../domains/session/listing/sessionListRenderable';
import {
  areServerProfileIdentifiersEquivalent,
  resolveServerProfileScopeIdForIdentifier,
} from '../domains/server/serverProfiles';
import {
  resolveLatestUnreadAffectingCommittedMessageSeq,
  resolveSessionReadableSeq,
} from '../domains/session/readCursor/resolveSessionReadableSeq';
import { resolveSessionWorkspacePath } from '../domains/session/resolveSessionWorkspacePath';
import { resolveSessionMachineId } from '../domains/session/directSessions/resolveSessionMachineId';
import { buildSessionMetadataStabilitySignature } from '../domains/session/metadata/sessionMetadataStability';
import {
  buildSessionOrganizationProjection,
  type SessionOrganizationProjection,
} from '../domains/session/organization';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '../domains/sessionActions/sessionActionDraftTypes';
import { buildSessionMessageRouteId, resolveSessionMessageRouteId } from '../domains/messages/messageRouteIds';
import {
  buildMessageLegacySignature,
  buildMessageRefsSelectionKey,
  createMessagesByRefsSelector,
  type MessageStoreRef,
} from './messageSelection';
import { useApplyLocalSettings, useApplySettings } from './settingsWriters';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';
import type { StorageState } from './types';

import { getStorage } from '../domains/state/storageStore';
import type { KnownEntitlements } from '../domains/state/storageStore';
import type { ForkedTranscriptSnapshot } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { getForkedTranscriptSnapshotCached } from '../domains/sessionFork/forkedTranscriptSnapshot';
import type { SessionForkSupportSource } from '../domains/sessionFork/forkUiSupport';
import { getPermissionsInUiWhileLocal } from '../domains/state/agentStateCapabilities';
import { getSessionLocalControlState, type SessionLocalControlState } from '../domains/session/control/sessionLocalControl';
import { resolveVisibleMachinesForActiveServerFromState } from './domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineVisibleForLaunchSelection } from '../domains/machines/identity/filterVisibleMachines';
import { resolveServerIdForSessionIdFromLocalState } from '../runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import { buildSessionFolderAssignmentKey } from '../domains/session/folders';
import { buildSessionRecentPathEntries } from '../domains/session/listing/sessionRecentPathEntries';
import { createProjectForSessionResolver, resolveProjectForSession } from '../runtime/orchestration/projectForSessionResolver';
import type { SessionRecentPathEntry } from '@/utils/sessions/recentPathEntries';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
  buildSessionRealtimeScmScopeFromSnapshot,
  getMountedSessionRealtimeScmConsumerScopeResetVersion,
  registerSessionRealtimeScmConsumerScope,
  subscribeMountedSessionRealtimeScmConsumerScopeResets,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import {
  agentTextLooksLikeExecutionRunSignal,
  shouldIncludeSubagentSourceMessage,
} from '../domains/session/subagents/subagentSourceMessageDetection';
import { readExecutionRunResultStatus } from '../domains/session/subagents/executionRuns/executionRunSubagentStatus';
import {
  compareTranscriptMessagesOldestFirst,
  normalizeTranscriptSeq,
} from '../domains/messages/transcriptOrdering';
import { readStoredSessionMessagesFromStateLike } from '../domains/messages/readStoredSessionMessages';
import { registerSessionTranscriptDerivedCacheClear } from '../runtime/sessionTranscriptDerivedCaches';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import type { AgentEvent } from '../typesRaw';

export type { MessageStoreRef } from './messageSelection';

const EMPTY_OPEN_APPROVAL_SESSION_IDS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_OPEN_APPROVAL_ARTIFACTS_FOR_SESSION: ReadonlyArray<OpenApprovalArtifactForSession> = Object.freeze([]);
const EMPTY_SESSION_AGENT_EVENTS: ReadonlyArray<SessionAgentEventSource> = Object.freeze([]);

export type SessionAgentEventSource = Readonly<{
  event: AgentEvent;
  createdAtMs: number;
}>;

type SessionAgentEventSourceCacheEntry = Readonly<{
  sourceVersion: number;
  signature: string;
  events: ReadonlyArray<SessionAgentEventSource>;
}>;

const sessionAgentEventSourceCache = new Map<string, SessionAgentEventSourceCacheEntry>();

function trimSessionAgentEventSourceCache(): void {
  while (sessionAgentEventSourceCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
    const oldestKey = sessionAgentEventSourceCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    sessionAgentEventSourceCache.delete(oldestKey);
  }
}

function buildConnectedServiceAccountSwitchEventSignature(
  message: Extract<Message, { kind: 'agent-event' }>,
): string {
  const event = message.event;
  if (event.type !== 'connected-service-account-switch') return '';
  return [
    message.id,
    message.createdAt,
    event.mode,
    event.reason,
  ].join(':');
}

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

export function useSessionsReady(): boolean {
  return getStorage()((state) => state.isDataReady);
}

/**
 * Derived here, in the selector zustand runs as its snapshot-equality check on every `setState`.
 *
 * That is affordable because the derivation is genuinely a *read* and it is skipped outright when
 * neither of its two source records moved:
 *
 *  - `createProjectForSessionResolver` computes the project key `addSession` would file a session
 *    under instead of registering it; the store's own `getProjectForSession` writes three `Map`s
 *    per path-bearing session, which is what made this selector a write.
 *  - the display resolver indexes the store's id-keyed machine record instead of rebuilding an
 *    index per session, so the walk allocates nothing.
 *  - `getStableSessionRecentPathEntries` returns the previous array whenever `sessions` and
 *    `machines` still hold the same object identities, and re-uses it when a rebuild produced the
 *    same entries — so a plain `Object.is` snapshot check is enough and no `useShallow` (which
 *    builds two entry `Map`s per publish) is involved.
 *
 * `hooks.useSessions.test.tsx` pins both counts — `addSession` calls and `Map` constructions — at
 * zero for an unrelated publish *and* for a publish that forces the full rebuild.
 *
 * A store-owned projection field was tried instead and removed: it bought nothing measurable on
 * device and cost a hand-maintained invariant — every machine or session field the display
 * resolver ever starts reading would have had to be added to a change gate, silently going stale
 * if it were not. Keying on whole-record identity has no such failure mode.
 *
 * `null` still means "not hydrated yet", which recent-path consumers read as "keep the last known
 * paths" rather than "there are none".
 */
export function useSessionRecentPathEntries(): SessionRecentPathEntry[] | null {
  return getStorage()((state) => (state.isDataReady ? getStableSessionRecentPathEntries(state) : null));
}

export function useSession(id: string): Session | null {
  return getStorage()(useShallow((state) => state.sessions[id] ?? null));
}

export type SessionReferenceTarget = Readonly<{
  /**
   * `true` only when this viewer has positive evidence the session is gone. A cache miss is not
   * evidence: see the note below.
   */
  deleted: boolean;
  metadata: SessionListRenderableSession['metadata'] | Session['metadata'] | null;
}>;

/**
 * The exact projection a transcript session reference consumes. A reference's identity is the
 * session id, so only two things can change what it renders: whether that session is still
 * present for this viewer, and the metadata its title is derived from. Turn-lifecycle churn
 * (thinking, agentState, seq, presence, updatedAt) changes neither, so a reference chip must
 * not re-render for it.
 *
 * **A cache miss is not evidence that the session is gone**, which is the whole content of this
 * hook. Both session maps are list-scoped caches, and neither is a record of what exists:
 *
 * - `sessionListRenderables` holds one entry per row the session list currently covers. A
 *   replace-mode `/v2/sessions` page evicts every previously-known row it omits inside its
 *   removal window (`replaceSessionListRenderables` → `planSessionListRenderableReplacement`),
 *   and that endpoint filters `archivedAt: null` **server-side**, so archiving a session is by
 *   itself enough to empty this map of it.
 * - `sessions` holds only the full records this run hydrated, which is a deliberately small set
 *   (`sessionListEagerHydrationCount: 4`, `sessionListBackgroundHydrationMaxRows: 0` in
 *   `sync/runtime/syncTuning.ts`). Measured on the running app at the moment an archived
 *   reference broke: `sessions \ sessionListRenderables` was **empty** and
 *   `sessionListRenderables \ sessions` held 97 rows — `sessions` is in practice a *subset*, so
 *   it can never rescue a row the renderable eviction removed. That is why answering presence
 *   from either map, or from their union, produced the same false "Unavailable session" for an
 *   archived target twice over.
 *
 * An archived session is fully readable: opening `/session/<id>` from exactly that
 * both-maps-empty state loads and renders it. So an uncached reference stays pressable, and the
 * session route — which already answers a genuinely missing id with its own explicit
 * "Session isn't available" screen — owns the failure the client cannot predict.
 *
 * `deleted` therefore comes from `deletedSessionIds`, written only by `deleteSession` — reached
 * on a `delete-session` update, a `session-share-revoked` update, or an exact session fetch
 * answering `not_found`, which is the server telling this viewer it cannot have the session at
 * all. That is the same ground the route states. `metadata` is whichever cached copy exists so
 * a known session still shows its live title; it is always a *stored* object, never a projection,
 * so the selection stays referentially stable.
 */
export function useSessionReferenceTarget(sessionId: string): SessionReferenceTarget {
  return getStorage()(
    useShallow((state) => ({
      deleted: state.deletedSessionIds[sessionId] === true,
      metadata: state.sessionListRenderables[sessionId]?.metadata
        ?? state.sessions[sessionId]?.metadata
        ?? null,
    })),
  );
}

const sessionForkSupportSourceCache = new Map<string, Readonly<{
  signature: string;
  value: SessionForkSupportSource;
}>>();

export function useSessionForkSupportSource(sessionId: string | null): SessionForkSupportSource | null {
  return getStorage()(
    useShallow((state) => {
      const session = sessionId ? state.sessions[sessionId] ?? null : null;
      if (!session || !sessionId) return null;

      const signature = buildSessionMetadataStabilitySignature(session.metadata);
      const cached = sessionForkSupportSourceCache.get(sessionId);
      if (cached?.signature === signature) return cached.value;

      const value: SessionForkSupportSource = { metadata: session.metadata };
      sessionForkSupportSourceCache.set(sessionId, { signature, value });
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
      const session = sessionId ? state.sessions[sessionId] ?? null : null;
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

export function useSessionListRenderable(id: string): SessionListRenderableSession | null {
  return getStorage()(useShallow((state) => state.sessionListRenderables[id] ?? null));
}

export function useSessionFolderAssignment(serverId: string | null | undefined, sessionId: string): string | null {
  return getStorage()(useShallow((state) => (
    state.sessionFolderAssignmentsBySessionKey[buildSessionFolderAssignmentKey(serverId, sessionId)] ?? null
  )));
}

export function useSessionFolderAssignmentsBySessionKey(): Record<string, string | null> {
  return getStorage()(useShallow((state) => state.sessionFolderAssignmentsBySessionKey));
}

export function useSessionOrganizationProjection(serverId: string | null | undefined): SessionOrganizationProjection | null {
  const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
  const snapshot = getStorage()(
    useShallow((state) => ({
      schemaVersionByServerId: state.sessionOrganizationSchemaVersionByServerId,
      snapshotVersionByServerId: state.sessionOrganizationSnapshotVersionByServerId,
      pinsBySessionKey: state.sessionOrganizationPinsBySessionKey,
      foldersByFolderKey: state.sessionOrganizationFoldersByFolderKey,
      folderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
      tagsByTagKey: state.sessionOrganizationTagsByTagKey,
      tagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey,
      attentionStandingsBySessionKey: state.sessionOrganizationAttentionStandingsBySessionKey,
      orderEntriesByScopeKey: state.sessionOrganizationOrderEntriesByScopeKey,
      labelsByLabelKey: state.sessionOrganizationLabelsByLabelKey,
    })),
  );

  return React.useMemo(() => {
    if (!normalizedServerId) return null;
    return buildSessionOrganizationProjection(snapshot, normalizedServerId);
  }, [normalizedServerId, snapshot]);
}

export function useSessionOrganizationPinnedSessionKeys(): readonly string[] {
  return getStorage()(
    useShallow((state) => Object.keys(state.sessionOrganizationPinsBySessionKey).sort()),
  );
}

export function useSessionOrganizationSnapshotVersions(serverId: string | null | undefined): Readonly<{
  schemaVersion: number | null;
  version: number | null;
}> {
  const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
  return getStorage()(
    useShallow((state) => ({
      schemaVersion: normalizedServerId ? state.sessionOrganizationSchemaVersionByServerId[normalizedServerId] ?? null : null,
      version: normalizedServerId ? state.sessionOrganizationSnapshotVersionByServerId[normalizedServerId] ?? null : null,
    })),
  );
}

export function useSessionServerId(sessionId: string): string | null {
  return getStorage()((state) => resolveServerIdForSessionIdFromLocalState({
    sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
    sessionListViewDataByServerId: state.sessionListViewDataByServerId,
  }, sessionId));
}

const emptyArray: unknown[] = [];
const emptyRecord: Record<string, any> = {};
const emptyReviewCommentDrafts: ReviewCommentDraft[] = [];
const emptyActionDrafts: SessionActionDraft[] = [];

type SessionMessagesArrayCacheEntry = Readonly<{
  idsRef: readonly string[];
  messagesByIdRef: Record<string, Message>;
  messagesVersion: number;
  messages: readonly Message[];
}>;

const SESSION_MESSAGES_ARRAY_CACHE_MAX = 16;
const sessionMessagesArrayCache = new Map<string, SessionMessagesArrayCacheEntry>();
const latestCommittedMessageSeqBySessionMessagesRef = new WeakMap<object, number | null>();

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

// These module-scoped caches can root a session's materialized Message objects
// outside the store. Register them with the canonical transcript-memory release
// seam so bounded-retention eviction and deleteSession free them together with
// the store entry.
registerSessionTranscriptDerivedCacheClear((sessionId) => {
  sessionAgentEventSourceCache.delete(sessionId);
  sessionMessagesArrayCache.delete(sessionId);
  sessionSubagentSourceMessagesCache.delete(sessionId);
});

function stringifySignatureValue(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return String(value);
  }
}

function buildExecutionRunSignalTextSignature(text: string): string {
  const runIds = Array.from(new Set(text.match(/run_[0-9a-z-]{8,}/gi) ?? []))
    .map((value) => value.trim().toLowerCase())
    .sort();
  return JSON.stringify({
    signal: agentTextLooksLikeExecutionRunSignal(text),
    runIds,
  });
}

function appendSubagentSourceMessageSignature(parts: string[], message: Message): void {
  const cached = sessionSubagentSourceMessageSignatureCache.get(message);
  if (cached !== undefined) {
    parts.push(cached);
    return;
  }

  const messageParts: string[] = [];
  const seq = normalizeTranscriptSeq((message as any).seq) ?? '';
  messageParts.push(`${message.id}:${message.kind}:${seq}:${message.createdAt ?? ''}`);
  if (message.kind === 'agent-text') {
    messageParts.push(buildExecutionRunSignalTextSignature(
      typeof (message as any).text === 'string' ? String((message as any).text) : '',
    ));
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
    // A still-running run streams its result, so the signature carries only the field the roster
    // derivation actually reads — the structured status the execution-run manager wrote — through
    // that derivation's own owner. Reading it any other way (a regex over the payload's prose, a
    // walk for any nested key named `status`) is D-3: a subagent that *writes about* a status
    // would change the signature and hand every consumer a fresh array to re-derive.
    result: tool?.state === 'running'
      ? { status: readExecutionRunResultStatus(tool?.result) }
      : tool?.result ?? null,
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
  return getStorage()((state) => {
    const session = state.sessionMessages[sessionId];
    if (!session) return emptyArray as any as readonly Message[];

    const sourceVersion = typeof session.subagentSourceVersion === 'number' && Number.isFinite(session.subagentSourceVersion)
      ? Math.trunc(session.subagentSourceVersion)
      : session.messagesVersion;
    const cached = sessionSubagentSourceMessagesCache.get(sessionId);
    if (cached && cached.sourceVersion === sourceVersion) {
      sessionSubagentSourceMessagesCache.delete(sessionId);
      sessionSubagentSourceMessagesCache.set(sessionId, cached);
      return cached.messages;
    }

    const sourceMessages: Message[] = [];
    const signatureParts: string[] = [];
    const ids = session.messageIdsOldestFirst;
    const orderedMessages = Array.isArray(ids) && ids.length > 0
      ? ids.map((id) => session.messagesById[id]).filter((message): message is Message => message != null)
      : Object.values(session.messagesById ?? {}).sort(compareTranscriptMessagesOldestFirst);

    for (const message of orderedMessages) {
      if (!shouldIncludeSubagentSourceMessage(message)) continue;
      sourceMessages.push(message);
      appendSubagentSourceMessageSignature(signatureParts, message);
    }

    const signature = signatureParts.join('\u0000');
    if (cached && cached.signature === signature) {
      sessionSubagentSourceMessagesCache.delete(sessionId);
      const nextCached = { ...cached, sourceVersion };
      sessionSubagentSourceMessagesCache.set(sessionId, nextCached);
      return cached.messages;
    }

    const next = {
      sourceVersion,
      signature,
      messages: sourceMessages.length > 0 ? sourceMessages : (emptyArray as any as readonly Message[]),
    } satisfies SessionSubagentSourceMessagesCacheEntry;
    sessionSubagentSourceMessagesCache.delete(sessionId);
    sessionSubagentSourceMessagesCache.set(sessionId, next);
    trimSessionSubagentSourceMessagesCache();
    return next.messages;
  });
}

export function useSessionMessages(
  sessionId: string,
  options?: UseSessionMessagesOptions,
): { messages: Message[]; isLoaded: boolean } {
  const enabled = options?.enabled !== false;

  // IMPORTANT:
  // Do not derive new arrays inside the Zustand selector. React 18 can call getSnapshot twice, and if the
  // selector allocates new references for unchanged store state it can trigger:
  // - "The result of getSnapshot should be cached…"
  // - "Maximum update depth exceeded"
  //
  // Subscribe to stable primitives instead (ids + version), then derive via useMemo.
  const { ids, isLoaded } = useSessionTranscriptIds(sessionId, enabled);
  const messagesById = useSessionMessagesById(sessionId, enabled);
  const version = useSessionMessagesVersion(sessionId, enabled);

  const messages = React.useMemo(() => {
    if (!enabled) {
      return emptyArray as any as Message[];
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      if (messagesById && Object.keys(messagesById).length > 0) {
        const cached = sessionMessagesArrayCache.get(sessionId);
        if (
          cached &&
          cached.messagesVersion === version &&
          cached.idsRef === ids &&
          cached.messagesByIdRef === messagesById
        ) {
          sessionMessagesArrayCache.delete(sessionId);
          sessionMessagesArrayCache.set(sessionId, cached);
          return cached.messages as Message[];
        }

        const out = Object.values(messagesById).slice().sort(compareTranscriptMessagesOldestFirst);
        sessionMessagesArrayCache.delete(sessionId);
        sessionMessagesArrayCache.set(sessionId, {
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

      const cached = sessionMessagesArrayCache.get(sessionId);
      if (cached && !isLoaded) {
        sessionMessagesArrayCache.delete(sessionId);
        sessionMessagesArrayCache.set(sessionId, cached);
        return cached.messages as Message[];
      }

      if (cached && isLoaded) {
        sessionMessagesArrayCache.delete(sessionId);
      }

      return emptyArray as any as Message[];
    }

    const cached = sessionMessagesArrayCache.get(sessionId);
    if (
      cached &&
      cached.messagesVersion === version &&
      cached.idsRef === ids &&
      cached.messagesByIdRef === messagesById
    ) {
      sessionMessagesArrayCache.delete(sessionId);
      sessionMessagesArrayCache.set(sessionId, cached);
      return cached.messages as Message[];
    }

    const out: Message[] = [];
    for (const id of ids) {
      const m = messagesById[id];
      if (m) out.push(m);
    }

    sessionMessagesArrayCache.delete(sessionId);
    sessionMessagesArrayCache.set(sessionId, {
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
  }, [enabled, ids, isLoaded, messagesById, sessionId, version]);

  return React.useMemo(() => ({ messages, isLoaded }), [isLoaded, messages]);
}

export function useSessionConnectedServiceAccountSwitchEvents(
  sessionId: string,
  enabled: boolean = true,
): ReadonlyArray<SessionAgentEventSource> {
  return getStorage()(
    useShallow((state) => {
      if (!enabled) return EMPTY_SESSION_AGENT_EVENTS;
      const sessionMessages = state.sessionMessages[sessionId];
      const cached = sessionAgentEventSourceCache.get(sessionId);
      const sourceVersion = sessionMessages?.agentEventSourceVersion ?? sessionMessages?.messagesVersion ?? 0;
      if (sessionMessages && cached && cached.sourceVersion === sourceVersion) {
        sessionAgentEventSourceCache.delete(sessionId);
        sessionAgentEventSourceCache.set(sessionId, cached);
        return cached.events;
      }
      if (!sessionMessages || sessionMessages.messageIdsOldestFirst.length === 0) {
        if (sessionMessages) {
          sessionAgentEventSourceCache.set(sessionId, {
            sourceVersion,
            signature: 'empty',
            events: EMPTY_SESSION_AGENT_EVENTS,
          });
          trimSessionAgentEventSourceCache();
        } else {
          sessionAgentEventSourceCache.delete(sessionId);
        }
        return EMPTY_SESSION_AGENT_EVENTS;
      }

      const events: SessionAgentEventSource[] = [];
      const signatureParts: string[] = [];
      for (const messageId of sessionMessages.messageIdsOldestFirst) {
        const message = sessionMessages.messagesById[messageId];
        if (!message || message.kind !== 'agent-event') continue;
        if (message.event.type !== 'connected-service-account-switch') continue;
        signatureParts.push(buildConnectedServiceAccountSwitchEventSignature(message));
        events.push({
          event: message.event,
          createdAtMs: message.createdAt,
        });
      }

      if (events.length === 0) {
        sessionAgentEventSourceCache.set(sessionId, {
          sourceVersion,
          signature: 'none',
          events: EMPTY_SESSION_AGENT_EVENTS,
        });
        trimSessionAgentEventSourceCache();
        return EMPTY_SESSION_AGENT_EVENTS;
      }

      const signature = signatureParts.join('|');
      if (cached?.signature === signature) {
        sessionAgentEventSourceCache.set(sessionId, {
          sourceVersion,
          signature,
          events: cached.events,
        });
        trimSessionAgentEventSourceCache();
        return cached.events;
      }

      const next = events;
      sessionAgentEventSourceCache.set(sessionId, {
        sourceVersion,
        signature,
        events: next,
      });
      trimSessionAgentEventSourceCache();
      return next;
    })
  );
}

export function useSessionTranscriptIds(sessionId: string, enabled: boolean = true): { ids: string[]; isLoaded: boolean } {
  const snapshot = getStorage()(
    useShallow((state) => {
      if (!enabled) {
        return {
          committedIds: emptyArray as any as string[],
          isLoaded: false,
        };
      }
      const session = state.sessionMessages[sessionId];
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
  return getStorage()(
    useShallow((state) => getForkedTranscriptSnapshotCached(state, sessionId))
  );
}

/**
 * UI-observable per-session "newer catch-up in flight" signal. True while sync is
 * silently catching the transcript up to newer activity (e.g. after reopening a
 * background-working session). Drives the bottom-anchored
 * {@link '@/components/sessions/transcript/CatchUpProgressOverlay'.CatchUpProgressOverlay}.
 * Fail-closed: unknown session reads false.
 */
export function useSessionCatchingUpNewer(sessionId: string, enabled: boolean = true): boolean {
  return getStorage()((state) => {
    if (!enabled) return false;
    return (state.sessionCatchUpNewerInFlight[sessionId] ?? 0) > 0;
  });
}

/**
 * Tail-contiguity floor for the session's MAIN chain (tail-reset discontinuity walk).
 * Null when the full loaded set is contiguous with the live tail.
 */
export function useSessionTailContiguousFloorSeq(sessionId: string): number | null {
  return getStorage()((state) => {
    const floorSeq = state.sessionTailContiguousFloorSeq[sessionId];
    return typeof floorSeq === 'number' && Number.isFinite(floorSeq) && floorSeq > 0 ? floorSeq : null;
  });
}

export function useSessionMessagesById(sessionId: string, enabled: boolean = true): Record<string, Message> {
  const snapshot = getStorage()(
    useShallow((state) => {
      if (!enabled) {
        return {
          committedIds: emptyArray as any as string[],
          committedMessagesById: emptyRecord as Record<string, Message>,
          messagesVersion: 0,
        };
      }
      const session = state.sessionMessages[sessionId];
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
  return getStorage()(
    useShallow((state) => {
      if (!enabled) return 0;
      const session = state.sessionMessages[sessionId];
      return session?.messagesVersion ?? 0;
    })
  );
}

export function useSessionMetadata(sessionId: string): Session['metadata'] | null {
  return getStorage()((state) => state.sessions[sessionId]?.metadata ?? null);
}

/**
 * The session's machine id, as a PRIMITIVE.
 *
 * Same reason as {@link useSessionInteractionSource}: a caller that only needs "which machine does
 * this session live on" must not subscribe to the whole `Session` record — nor to `metadata`, which
 * is an object the sync layer replaces wholesale on a push and so re-renders a `useShallow` /
 * reference-compared subscriber for every unrelated field it carries. A string compares by value, so
 * the subscription fires exactly when the answer changes.
 *
 * `resolveSessionMachineId` stays the one place that decides where the id lives — including the
 * linked direct-session fallback, which a hand-rolled `metadata.machineId` read silently misses.
 *
 * V-1 (2026-08-18): the agent-transition divider row held `useSession(id)` purely to read this one
 * string. It is a transcript row, so a live turn rewrote the record under it — MEASURED at 1 render
 * per unrelated session write, and 0 once it reads this instead.
 */
export function useSessionMachineId(sessionId: string): string | null {
  return getStorage()((state) => resolveSessionMachineId(state.sessions[sessionId]?.metadata ?? null));
}

export type SessionInteractionSource = Readonly<{
  accessLevel: Session['accessLevel'];
  canApprovePermissions: Session['canApprovePermissions'];
  active: Session['active'];
}>;

/**
 * The exact projection `deriveTranscriptInteractionFromSession` consumes. Transcript rows
 * subscribe to this instead of the whole `Session` record: turn-lifecycle churn (thinking,
 * agentState, agentStateVersion, updatedAt, seq, presence) cannot change interaction rights,
 * so a row must not re-render for it.
 */
export function useSessionInteractionSource(sessionId: string): SessionInteractionSource | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessions[sessionId];
      if (!session) return null;
      return {
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        active: session.active,
      };
    })
  );
}

/**
 * The session's reducer state together with the revision counter that is its only change signal.
 *
 * `sessionMessages[sessionId].reducerState` is mutated in place for streaming performance: every
 * commit re-publishes the same object and bumps `reducerVersion`
 * (`sync/store/domains/messages.ts`). Its identity therefore never changes, and a `useMemo` keyed
 * on the state alone can never recompute — which is exactly how the Agents pane's activity preview
 * became unrefreshable. Derivations must list `reducerVersion` in their dependencies;
 * `useResolvedSessionMessageRouteId` below shows the same shape over `messagesVersion`.
 *
 * Both values come from one subscription so the reducer state never has to be cloned to signal a
 * change: cloning would break the referential stability transcript rows memoize on.
 */
export function useSessionMessagesReducerSnapshot(sessionId: string) {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return {
        reducerState: session?.reducerState ?? null,
        reducerVersion: session?.reducerVersion ?? 0,
      };
    })
  );
}

/**
 * Reducer state only, for consumers that read it during render and so need no change signal.
 * A consumer that memoizes over it must also key on one: {@link useSessionMessagesReducerSnapshot}
 * when the derivation depends on reducer-only state such as sidechains or permissions,
 * {@link useSessionMessagesVersion} when it only follows committed transcript messages.
 */
export function useSessionMessagesReducerState(sessionId: string) {
  return useSessionMessagesReducerSnapshot(sessionId).reducerState;
}

export function useSessionLatestThinkingMessageId(sessionId: string): string | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.latestThinkingMessageId ?? null;
    })
  );
}

export function useSessionLatestThinkingMessageActivityAtMs(sessionId: string): number | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.latestThinkingMessageActivityAtMs ?? null;
    })
  );
}

export function useHasUnreadMessages(sessionId: string): boolean {
  return getStorage()((state) => {
    const session = state.sessions[sessionId];
    if (!session) {
      return state.sessionListRenderables[sessionId]?.hasUnreadMessages === true;
    }
    return resolveSessionHasUnreadForHooks(
      session,
      state.sessionMessages[sessionId],
      state.sessionListRenderables[sessionId],
    );
  });
}

export function useSessionReadyActivity(sessionId: string): {
  latestReadyEventSeq: number | null;
  latestReadyEventAt: number | null;
} {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessions[sessionId];
      const sessionMessages = state.sessionMessages[sessionId];
      const renderable = state.sessionListRenderables[sessionId];
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

/**
 * Subscribes to the *visible read sequence* number for a session transcript and nothing else.
 *
 * `resolveSessionReadableSeq` only reads `message.seq`, so a streaming token update that mutates
 * message content (and bumps `messagesVersion`) without adding a new message or changing any seq
 * does not change the result. Computing the number inside the Zustand selector means the consumer
 * re-renders only when the derived number actually changes, instead of every streaming token (as
 * a broad `useSessionMessagesById` subscription would).
 */
export function useSessionVisibleReadSeq(
  sessionId: string,
  params: Readonly<{
    sessionSeq: number | null;
    latestTurnStatus: PrimaryTurnStatusV1 | null | undefined;
  }>,
): number | null {
  const { sessionSeq, latestTurnStatus } = params;
  return getStorage()((state) => {
    const sessionMessages = state.sessionMessages[sessionId];
    if (!sessionMessages || sessionMessages.isLoaded !== true) {
      return null;
    }
    const session = state.sessions[sessionId];
    const renderable = state.sessionListRenderables[sessionId];
    return resolveSessionReadableSeq({
      latestMessageSeq: resolveLatestUnreadAffectingCommittedMessageSeqForHooksCached(sessionMessages),
      sessionSeq,
      latestReadyEventSeq:
        sessionMessages.latestReadyEventSeq
        ?? session?.latestReadyEventSeq
        ?? renderable?.latestReadyEventSeq
        ?? null,
      latestTurnStatus,
      includeTerminalSessionSeq: true,
    });
  });
}

function resolveLatestUnreadAffectingCommittedMessageSeqForHooks(
  sessionMessages: StorageState['sessionMessages'][string],
): number | null {
  return resolveLatestUnreadAffectingCommittedMessageSeq(
    readStoredSessionMessagesFromStateLike(sessionMessages),
  );
}

function resolveLatestUnreadAffectingCommittedMessageSeqForHooksCached(
  sessionMessages: StorageState['sessionMessages'][string],
): number | null {
  if (latestCommittedMessageSeqBySessionMessagesRef.has(sessionMessages)) {
    return latestCommittedMessageSeqBySessionMessagesRef.get(sessionMessages) ?? null;
  }

  const latestSeq = resolveLatestUnreadAffectingCommittedMessageSeqForHooks(sessionMessages);
  latestCommittedMessageSeqBySessionMessagesRef.set(sessionMessages, latestSeq);
  return latestSeq;
}

function resolveSessionHasUnreadForHooks(
  session: Session,
  sessionMessages: StorageState['sessionMessages'][string] | undefined,
  renderable: SessionListRenderableSession | undefined,
): boolean {
  const readableMessageSeq = sessionMessages
    ? resolveLatestUnreadAffectingCommittedMessageSeqForHooksCached(sessionMessages)
    : null;
  const readableSeq = resolveSessionReadableSeq({
    latestMessageSeq: readableMessageSeq,
    sessionSeq: session.seq,
    latestReadyEventSeq: sessionMessages?.latestReadyEventSeq ?? session.latestReadyEventSeq,
    latestTurnStatus: session.latestTurnStatus,
    includeTerminalSessionSeq: true,
  }) ?? 0;
  const hasUnread = deriveSessionListRenderableHasUnreadMessagesFromReadableSeq(session, readableSeq);
  if (hasUnread) return true;
  if (readableSeq > 0) return false;
  if (readableMessageSeq !== null) return false;
  return renderable?.hasUnreadMessages === true;
}

export function useSessionPendingMessages(
  sessionId: string
): { messages: PendingMessage[]; discarded: DiscardedPendingMessage[]; isLoaded: boolean } {
  return getStorage()(
    useShallow((state) => {
      const pending = state.sessionPending[sessionId];
      return {
        messages: pending?.messages ?? emptyArray,
        discarded: pending?.discarded ?? emptyArray,
        isLoaded: pending?.isLoaded ?? false,
      };
    })
  );
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

export function useMessage(sessionId: string, messageId: string): Message | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      const message = session?.messagesById?.[messageId] ?? null;
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

export function useMessagesByRefs(messageRefs: readonly MessageStoreRef[]): readonly (Message | null)[] {
  const selectionKey = React.useMemo(
    () => buildMessageRefsSelectionKey(messageRefs),
    [messageRefs],
  );
  const selector = React.useMemo(
    () => createMessagesByRefsSelector(messageRefs.slice()),
    [selectionKey],
  );
  return getStorage()(selector).messages;
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
  const messageRefs = React.useMemo(
    () => (Array.isArray(messageIds) ? messageIds : []).map((messageId) => ({ sessionId, messageId })),
    [messageIds, sessionId],
  );
  const selectedMessages = useMessagesByRefs(messageRefs);
  return React.useMemo(() => {
    const messages = selectedMessages.filter((message): message is Message => message !== null);
    return messages.length > 0 ? messages : (emptyArray as Message[]);
  }, [selectedMessages]);
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
      const machines = resolveVisibleMachinesForActiveServerFromState(
        state.isDataReady
          ? state
          : {
              ...state,
              machineListByServerId: {},
            }
      );
      if (machines.length > 0) {
        return machines;
      }
      return state.isDataReady ? machines : [];
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
    String(machine.activeAt ?? ''),
    String(machine.updatedAt ?? ''),
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
    const machines = resolveVisibleMachinesForActiveServerFromState(
      state.isDataReady
        ? state
        : {
            ...state,
            machineListByServerId: {},
          }
    );
    const visibleMachines = machines.length > 0
      ? machines
      : state.isDataReady
        ? machines
        : [];
    return getStableLaunchSelectionMachines(visibleMachines);
  });
}

export function useMachineRecordValues(): Machine[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return Object.values(state.machines);
    })
  );
}

const EMPTY_MACHINE_DISPLAY_BY_ID: Record<string, MachineDisplayRenderable> = {};

export function useMachineDisplayById(): Record<string, MachineDisplayRenderable> {
  return getStorage()(useShallow((state) => state.machineDisplayById ?? EMPTY_MACHINE_DISPLAY_BY_ID));
}

const EMPTY_MACHINE_LIST_BY_SERVER_ID: Record<string, Machine[] | null> = {};

export function useMachineListByServerId(): Record<string, Machine[] | null> {
  const machineListByServerIdRaw = getStorage()(useShallow((state) => state.machineListByServerId));
  const machineListByServerId = machineListByServerIdRaw ?? EMPTY_MACHINE_LIST_BY_SERVER_ID;
  return React.useMemo(() => {
    let hasChanges = false;
    const nextByServerId: Record<string, Machine[] | null> = {};

    for (const [serverId, machines] of Object.entries(machineListByServerId)) {
      if (!Array.isArray(machines)) {
        nextByServerId[serverId] = machines;
        continue;
      }

      const visibleMachines = machines.filter(isMachineVisibleForLaunchSelection);
      if (visibleMachines.length !== machines.length) {
        hasChanges = true;
        nextByServerId[serverId] = visibleMachines;
        continue;
      }

      nextByServerId[serverId] = machines;
    }

    return hasChanges ? nextByServerId : machineListByServerId;
  }, [machineListByServerId]);
}

export function useMachineListStatusByServerId(): Record<string, 'idle' | 'loading' | 'signedOut' | 'error'> {
  return getStorage()(useShallow((state) => state.machineListStatusByServerId));
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

export function useSessionListViewData(): SessionListViewItem[] | null {
  return getStorage()((state) => getStableSessionListShellViewData(state.sessionListViewData));
}

const EMPTY_SESSION_LIST_VIEW_DATA_BY_SERVER_ID: Readonly<Record<string, SessionListViewItem[] | null>> = Object.freeze({});

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

function resolveSelectedSessionListServerId(
  dataByServerId: Readonly<Record<string, SessionListViewItem[] | null>>,
  requestedServerId: string,
): string | null {
  if (Object.prototype.hasOwnProperty.call(dataByServerId, requestedServerId)) return requestedServerId;

  const scopedServerId = resolveServerProfileScopeIdForIdentifier(requestedServerId);
  if (scopedServerId && Object.prototype.hasOwnProperty.call(dataByServerId, scopedServerId)) return scopedServerId;

  for (const cachedServerId of Object.keys(dataByServerId)) {
    if (areServerProfileIdentifiersEquivalent(cachedServerId, requestedServerId)) return cachedServerId;
  }
  return null;
}

export function useSessionListViewDataByServerId(
  serverIds?: ReadonlyArray<string>,
): Record<string, SessionListViewItem[] | null> {
  const hasExplicitServerSelection = Array.isArray(serverIds);
  const serverIdsKey = hasExplicitServerSelection ? serverIds.join('\u0001') : null;
  const selectedServerIds = React.useMemo(
    () => hasExplicitServerSelection ? normalizeSelectedSessionListServerIds(serverIds) : [],
    [hasExplicitServerSelection, serverIds, serverIdsKey],
  );

  return getStorage()((state) => {
    if (!hasExplicitServerSelection) {
      return getStableSessionListShellViewDataByServerId(state.sessionListViewDataByServerId);
    }
    if (selectedServerIds.length === 0) {
      return EMPTY_SESSION_LIST_VIEW_DATA_BY_SERVER_ID;
    }

    return getStableSelectedSessionListShellViewDataByServerId(
      state.sessionListViewDataByServerId,
      selectedServerIds,
    );
  });
}

type SessionListShellViewDataCache = Readonly<{
  source: SessionListViewItem[] | null;
  data: SessionListViewItem[] | null;
  /** Row signatures aligned with `data`, so a cached row is never read again. */
  signatures: ReadonlyArray<string> | null;
}>;

type SessionListShellViewDataByServerId = Record<string, SessionListViewItem[] | null>;

type SessionListShellViewDataByServerIdCache = Readonly<{
  source: SessionListShellViewDataByServerId;
  entries: ReadonlyArray<readonly [string, SessionListViewItem[] | null]>;
  dataByServerId: SessionListShellViewDataByServerId;
}>;

type SelectedSessionListShellViewDataByServerIdCache = Readonly<{
  source: SessionListShellViewDataByServerId;
  entries: ReadonlyArray<readonly [string, SessionListViewItem[] | null]>;
  dataByServerId: SessionListShellViewDataByServerId;
}>;

let sessionListShellViewDataCache: SessionListShellViewDataCache | null = null;
let sessionListShellViewDataByServerIdCache: SessionListShellViewDataByServerIdCache | null = null;
const sessionListShellViewDataPerServerCache = new Map<string, SessionListShellViewDataCache>();
const selectedSessionListShellViewDataByServerIdCache = new Map<string, SelectedSessionListShellViewDataByServerIdCache>();

type SessionListShellViewDataReconciliation = Readonly<{
  equivalent: boolean;
  signatures: ReadonlyArray<string> | null;
}>;

/**
 * Reconcile a pushed session list against the cached one, carrying row signatures forward.
 *
 * A push rebuilds the array but carries every row it did not change by identity, so a row whose
 * object survived inherits its cached signature and only genuinely new row objects are signed.
 * The cached array's rows are never read again — the previous side of every comparison is a
 * signature this cache already holds — which is the invariant the "must not be signed again"
 * probes in `hooks.useSessions.test.tsx` pin. Signing the whole array to compare one string cost
 * O(all rows) for a push that changed one session.
 */
function reconcileSessionListShellViewData(
  cached: SessionListShellViewDataCache | null,
  next: SessionListViewItem[] | null,
): SessionListShellViewDataReconciliation {
  const previousData = cached?.data ?? null;
  const previousSignatures = cached?.signatures ?? null;
  if (!next) {
    return { equivalent: cached != null && previousData === null, signatures: null };
  }

  const signatures = new Array<string>(next.length);
  let equivalent = cached != null
    && previousData != null
    && previousSignatures != null
    && previousData.length === next.length;
  for (let index = 0; index < next.length; index += 1) {
    const nextItem = next[index];
    const previousSignature = previousSignatures?.[index];
    if (previousSignature != null && previousData?.[index] === nextItem) {
      signatures[index] = previousSignature;
      continue;
    }
    const signature = buildSessionListShellViewItemSignature(nextItem);
    signatures[index] = signature;
    if (equivalent && signature !== previousSignature) equivalent = false;
  }
  return { equivalent, signatures };
}

export function buildSessionListShellViewItemSignature(item: SessionListViewItem): string {
  if (item.type === 'header') {
    return [
      'h',
      item.headerKind ?? '',
      item.groupKey ?? '',
      item.workspaceKey ?? '',
      item.renderWorkspaceKey ?? '',
      item.folderId ?? '',
      item.parentFolderId ?? '',
      item.depth ?? '',
      item.sessionCount ?? '',
      item.seedSessionId ?? '',
      item.serverId ?? '',
      item.serverName ?? '',
      item.title,
      item.subtitle ?? '',
      buildSessionListWorkspaceSignature(item.workspace),
      item.workspaceScopeHint?.serverId ?? '',
      item.workspaceScopeHint?.machineId ?? '',
      item.workspaceScopeHint?.rootPath ?? '',
      item.machine?.id ?? '',
    ].join('\u0001');
  }

  const metadata = item.session.metadata;
  const readState = metadata?.readStateV1;
  const issue = item.session.lastRuntimeIssue;
  return [
    's',
    item.serverId ?? '',
    item.serverName ?? '',
    item.session.id,
    item.section ?? '',
    item.groupKey ?? '',
    item.groupKind ?? '',
    item.folderId ?? '',
    item.folderDepth ?? '',
    item.pinned === true ? '1' : '0',
    item.attentionPromotionReason ?? '',
    item.workingPlacementReason ?? '',
    item.variant ?? '',
    buildSessionListWorkspaceSignature(item.workspace),
    item.session.meaningfulActivityAt ?? '',
    item.session.active === true ? '1' : '0',
    item.session.archivedAt ?? '',
    item.session.keepVisibleWhenInactive === true ? '1' : '0',
    item.session.pendingCount ?? '',
    item.session.pendingBlockedCount ?? '',
    metadata?.name ?? '',
    metadata?.summaryText ?? '',
    metadata?.path ?? '',
    metadata?.homeDir ?? '',
    metadata?.host ?? '',
    metadata?.machineId ?? '',
    metadata?.flavor ?? '',
    metadata?.directSessionV1?.providerId ?? '',
    metadata?.hiddenSystemSession === true ? '1' : '0',
    readState?.sessionSeq ?? '',
    readState?.pendingActivityAt ?? '',
    item.session.thinking === true ? '1' : '0',
    item.session.presence,
    item.session.latestTurnStatus ?? '',
    item.session.latestTurnStatusObservedAt ?? '',
    issue?.v ?? '',
    issue?.scope ?? '',
    issue?.status ?? '',
    issue?.occurredAt ?? '',
    item.session.latestReadyEventSeq ?? '',
    item.session.latestReadyEventAt ?? '',
    item.session.optimisticThinkingAt != null ? '1' : '0',
    item.session.thinkingGraceUntil != null ? '1' : '0',
    item.session.hasPendingPermissionRequests === true ? '1' : '0',
    item.session.hasPendingUserActionRequests === true ? '1' : '0',
    item.session.pendingRequestObservedAt ?? '',
    item.session.hasUnreadMessages === true ? '1' : '0',
    item.session.metadataUnavailable === true ? '1' : '0',
  ].join('\u0001');
}

function buildSessionListWorkspaceSignature(workspace: SessionListViewItem['workspace']): string {
  if (!workspace) return '';
  if (workspace.t === 'workspaceRef') {
    return ['workspaceRef', workspace.serverId ?? '', workspace.workspaceRefId].join('\u0003');
  }
  return ['workspaceScope', workspace.serverId ?? '', workspace.machineId ?? '', workspace.rootPath].join('\u0003');
}

type SessionRecentPathEntriesCache = Readonly<{
  sessions: unknown;
  machines: unknown;
  entries: SessionRecentPathEntry[];
}>;

let sessionRecentPathEntriesCache: SessionRecentPathEntriesCache | null = null;

/**
 * The recent-path projection, derived at most once per change to the two records it reads.
 *
 * The identity check is the whole gate — not a list of fields the projection is believed to care
 * about. `applySessions` and `applyMachines` replace the record they write, so a moved input is
 * always a new object; an unrelated publish keeps both identities and costs one comparison.
 */
function getStableSessionRecentPathEntries(state: {
  sessions: Record<string, Session>;
  machines: Record<string, Machine>;
}): SessionRecentPathEntry[] {
  const cached = sessionRecentPathEntriesCache;
  if (cached && cached.sessions === state.sessions && cached.machines === state.machines) {
    return cached.entries;
  }

  const next = buildSessionRecentPathEntries({
    sessions: state.sessions,
    machines: state.machines,
    getProjectForSession: createProjectForSessionResolver(state.sessions),
  });
  // A rebuild that produced the same rows must not re-render every recent-path consumer.
  const entries = cached && hasSameSessionRecentPathEntries(cached.entries, next) ? cached.entries : next;
  sessionRecentPathEntriesCache = { sessions: state.sessions, machines: state.machines, entries };
  return entries;
}

function hasSameSessionRecentPathEntries(
  previous: readonly SessionRecentPathEntry[],
  next: readonly SessionRecentPathEntry[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function getStableSessionListShellViewData(data: SessionListViewItem[] | null): SessionListViewItem[] | null {
  const cached = sessionListShellViewDataCache;
  if (cached?.source === data) {
    return cached.data;
  }
  const reconciliation = reconcileSessionListShellViewData(cached, data);
  if (cached && reconciliation.equivalent) {
    sessionListShellViewDataCache = { ...cached, source: data };
    return cached.data;
  }
  sessionListShellViewDataCache = { source: data, data, signatures: reconciliation.signatures };
  return data;
}

function getStableSessionListShellViewDataForServer(
  serverId: string,
  data: SessionListViewItem[] | null,
): SessionListViewItem[] | null {
  const cached = sessionListShellViewDataPerServerCache.get(serverId) ?? null;
  if (cached?.source === data) {
    return cached.data;
  }
  const reconciliation = reconcileSessionListShellViewData(cached, data);
  if (cached && reconciliation.equivalent) {
    sessionListShellViewDataPerServerCache.set(serverId, { ...cached, source: data });
    return cached.data;
  }
  sessionListShellViewDataPerServerCache.set(serverId, { source: data, data, signatures: reconciliation.signatures });
  return data;
}

function getSortedSessionListShellViewDataByServerIdEntries(
  dataByServerId: SessionListShellViewDataByServerId,
): Array<readonly [string, SessionListViewItem[] | null]> {
  return Object.entries(dataByServerId).sort(([left], [right]) => left.localeCompare(right));
}

function areSessionListShellViewDataByServerIdEntriesReferenceEqual(
  left: ReadonlyArray<readonly [string, SessionListViewItem[] | null]>,
  right: ReadonlyArray<readonly [string, SessionListViewItem[] | null]>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index][0] !== right[index][0] || left[index][1] !== right[index][1]) {
      return false;
    }
  }
  return true;
}

function getStableSessionListShellViewDataByServerId(
  dataByServerId: SessionListShellViewDataByServerId,
): SessionListShellViewDataByServerId {
  const cached = sessionListShellViewDataByServerIdCache;
  if (cached?.source === dataByServerId) {
    return cached.dataByServerId;
  }
  const entries = getSortedSessionListShellViewDataByServerIdEntries(dataByServerId);
  if (cached && areSessionListShellViewDataByServerIdEntriesReferenceEqual(cached.entries, entries)) {
    sessionListShellViewDataByServerIdCache = { ...cached, source: dataByServerId, entries };
    return cached.dataByServerId;
  }
  // Each server reconciles against its own cache, so an unchanged server contributes its previous
  // stable array by identity. When every server does, the map itself is unchanged and the cached
  // object is kept — no combined signature of every server's rows is needed to decide that.
  const next: Record<string, SessionListViewItem[] | null> = {};
  let equivalent = cached != null && Object.keys(cached.dataByServerId).length === entries.length;
  for (const [serverId, data] of entries) {
    const stable = getStableSessionListShellViewDataForServer(serverId, data);
    next[serverId] = stable;
    if (equivalent && cached!.dataByServerId[serverId] !== stable) equivalent = false;
  }
  if (cached && equivalent) {
    sessionListShellViewDataByServerIdCache = { ...cached, source: dataByServerId, entries };
    return cached.dataByServerId;
  }
  sessionListShellViewDataByServerIdCache = {
    source: dataByServerId,
    entries,
    dataByServerId: next,
  };
  return next;
}

function getStableSelectedSessionListShellViewDataByServerId(
  dataByServerId: SessionListShellViewDataByServerId,
  selectedServerIds: ReadonlyArray<string>,
): SessionListShellViewDataByServerId {
  const selectedServerIdsKey = selectedServerIds.join('\u0001');
  const cached = selectedSessionListShellViewDataByServerIdCache.get(selectedServerIdsKey);
  if (cached?.source === dataByServerId) {
    return cached.dataByServerId;
  }

  const selectedDataByServerId: SessionListShellViewDataByServerId = {};
  let hasSelectedData = false;
  for (const serverId of selectedServerIds) {
    const cachedServerId = resolveSelectedSessionListServerId(dataByServerId, serverId);
    if (!cachedServerId || Object.prototype.hasOwnProperty.call(selectedDataByServerId, cachedServerId)) continue;
    selectedDataByServerId[cachedServerId] = dataByServerId[cachedServerId] ?? null;
    hasSelectedData = true;
  }

  if (!hasSelectedData) {
    return EMPTY_SESSION_LIST_VIEW_DATA_BY_SERVER_ID;
  }

  const entries = getSortedSessionListShellViewDataByServerIdEntries(selectedDataByServerId);
  if (cached && areSessionListShellViewDataByServerIdEntriesReferenceEqual(cached.entries, entries)) {
    selectedSessionListShellViewDataByServerIdCache.set(selectedServerIdsKey, {
      ...cached,
      source: dataByServerId,
      entries,
    });
    return cached.dataByServerId;
  }

  const stableSelectedDataByServerId = getStableSessionListShellViewDataByServerId(selectedDataByServerId);
  selectedSessionListShellViewDataByServerIdCache.set(selectedServerIdsKey, {
    source: dataByServerId,
    entries,
    dataByServerId: stableSelectedDataByServerId,
  });
  return stableSelectedDataByServerId;
}

function sortValuesByUpdatedAtDescending<T extends { updatedAt: number }>(values: Record<string, T>): T[] {
  return Object.values(values).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useAllSessions(): Session[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
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
      if (!state.isDataReady) return [];
      return sortValuesByUpdatedAtDescending(state.sessionListRenderables);
    })
  );
}

export function useAllSessionListRenderablesForAttention(): SessionListRenderableSession[] {
  return getStorage()(
    useShallow((state) => sortValuesByUpdatedAtDescending(state.sessionListRenderables))
  );
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

/**
 * The session's own recorded path, falling back to the path of the project it is filed under.
 *
 * The fallback is resolved only when it can be reached, and through the pure resolver rather than
 * the store's `getProjectForSession`. Both halves of that matter:
 *
 *  - the store's `getProjectForSession` reads *by writing* — it calls `projectManager.addSession`,
 *    which re-sets `sessionToProject` and rescans the project's session list on every call — and
 *    this selector is what zustand runs as its snapshot-equality check, so it re-executes for every
 *    mounted consumer on every publish. A transcript mounts one consumer per row wrapper
 *    (`useTranscriptSessionCommon`) and a streaming session publishes continuously, so one write
 *    per evaluation multiplies by rows x publishes;
 *  - in the branch that used to pay for it the fallback is redundant anyway. `addSession` files a
 *    path-bearing session under `metadata.path`, so the project path it would return is the trimmed
 *    session path that already outranks it. Only a session with no usable path of its own can take
 *    the fallback, and that is exactly the case the pure resolver forwards to the manager's
 *    surviving mapping.
 */
export function useSessionWorkspacePath(sessionId: string | null): string | null {
  return getStorage()((state) => {
    if (!sessionId) return null;
    const sessionPath = resolveSessionWorkspacePath({
      sessionPath: state.sessions[sessionId]?.metadata?.path ?? null,
    });
    if (sessionPath !== null) return sessionPath;
    return resolveSessionWorkspacePath({
      projectPath: resolveProjectForSession(state.sessions, sessionId)?.key?.path ?? null,
    });
  });
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
    useShallow((state) => (sessionId ? state.getSessionRepositoryTreeExpandedPaths(sessionId) : emptyArray as string[]))
  );
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
  return getStorage()(useShallow((state) => state.localSettings[name]));
}

function normalizeSessionLocalSettingScopeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildSessionLastMobileSurfaceStorageKey(
  sessionId: string | null | undefined,
  serverId?: string | null,
): string | null {
  const normalizedSessionId = normalizeSessionLocalSettingScopeId(sessionId);
  if (!normalizedSessionId) return null;

  const normalizedServerId = normalizeSessionLocalSettingScopeId(serverId);
  if (!normalizedServerId) return normalizedSessionId;
  return buildSessionFolderAssignmentKey(normalizedServerId, normalizedSessionId);
}

function buildSessionLastMobileSurfaceLookupKeys(params: Readonly<{
  sessionId: string | null | undefined;
  explicitServerId?: string | null;
  resolvedServerId?: string | null;
}>): readonly string[] {
  const normalizedSessionId = normalizeSessionLocalSettingScopeId(params.sessionId);
  if (!normalizedSessionId) return emptyArray as string[];

  const keys: string[] = [];
  for (const candidateServerId of [params.explicitServerId, params.resolvedServerId]) {
    const scopedKey = buildSessionLastMobileSurfaceStorageKey(normalizedSessionId, candidateServerId);
    if (scopedKey && !keys.includes(scopedKey)) {
      keys.push(scopedKey);
    }
  }
  if (!keys.includes(normalizedSessionId)) {
    keys.push(normalizedSessionId);
  }
  return keys;
}

export function readSessionLastMobileSurfaceFromMap(
  values: LocalSettings['sessionLastMobileSurfaceBySessionId'] | null | undefined,
  params: Readonly<{
    sessionId: string | null | undefined;
    explicitServerId?: string | null;
    resolvedServerId?: string | null;
  }>,
): LocalSettings['sessionLastMobileSurfaceBySessionId'][string] | null {
  const keys = buildSessionLastMobileSurfaceLookupKeys(params);
  const current = values ?? {};
  for (const key of keys) {
    const value = current[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function resolvePreferredSessionLastMobileSurfaceStorageKey(
  state: Pick<StorageState, 'sessions' | 'sessionListViewDataByServerId'>,
  sessionId: string | null | undefined,
  explicitServerId?: string | null,
): string | null {
  const normalizedSessionId = normalizeSessionLocalSettingScopeId(sessionId);
  if (!normalizedSessionId) return null;

  const resolvedServerId = normalizeSessionLocalSettingScopeId(explicitServerId)
    ?? resolveServerIdForSessionIdFromLocalState({
      sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
      sessionListViewDataByServerId: state.sessionListViewDataByServerId,
    }, normalizedSessionId);
  return buildSessionLastMobileSurfaceStorageKey(normalizedSessionId, resolvedServerId);
}

export function useSessionLastMobileSurface(
  sessionId: string | null,
  explicitServerId?: string | null,
): LocalSettings['sessionLastMobileSurfaceBySessionId'][string] | null {
  return getStorage()(useShallow((state) => {
    const normalizedSessionId = normalizeSessionLocalSettingScopeId(sessionId);
    if (!normalizedSessionId) return null;
    const resolvedServerId = normalizeSessionLocalSettingScopeId(explicitServerId)
      ?? resolveServerIdForSessionIdFromLocalState({
        sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
        sessionListViewDataByServerId: state.sessionListViewDataByServerId,
      }, normalizedSessionId);
    return readSessionLastMobileSurfaceFromMap(
      state.localSettings.sessionLastMobileSurfaceBySessionId,
      {
        sessionId: normalizedSessionId,
        explicitServerId,
        resolvedServerId,
      },
    );
  }));
}

export function usePersistSessionLastMobileSurface(): (
  sessionId: string,
  surface: LocalSettings['sessionLastMobileSurfaceBySessionId'][string],
  serverId?: string | null,
) => void {
  const applyLocalSettings = useApplyLocalSettings();
  return React.useCallback((sessionId, surface, serverId) => {
    const state = getStorage().getState();
    const current = state.localSettings.sessionLastMobileSurfaceBySessionId ?? {};
    const nextKey = resolvePreferredSessionLastMobileSurfaceStorageKey(state, sessionId, serverId);
    if (!nextKey) return;
    if (current[nextKey] === surface) return;
    applyLocalSettings({
      sessionLastMobileSurfaceBySessionId: {
        ...current,
        [nextKey]: surface,
      },
    });
  }, [applyLocalSettings]);
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Filter out draft artifacts from the main list
      return Object.values(state.artifacts)
        .filter((artifact) => !artifact.draft)
        .sort((a, b) => b.updatedAt - a.updatedAt);
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
  return ids.size === 0
    ? EMPTY_OPEN_APPROVAL_SESSION_IDS
    : Array.from(ids).sort();
}

export function useOpenApprovalSessionIds(): ReadonlyArray<string> {
  const selectorRef = React.useRef<((state: StorageState) => ReadonlyArray<string>) | null>(null);
  if (!selectorRef.current) {
    let previousIsDataReady: boolean | null = null;
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousIds: ReadonlyArray<string> = EMPTY_OPEN_APPROVAL_SESSION_IDS;

    selectorRef.current = (state) => {
      if (state.isDataReady === previousIsDataReady && state.artifacts === previousArtifacts) {
        return previousIds;
      }

      previousIsDataReady = state.isDataReady;
      previousArtifacts = state.artifacts;
      previousIds = state.isDataReady
        ? collectOpenApprovalSessionIdListFromArtifacts(state.artifacts)
        : EMPTY_OPEN_APPROVAL_SESSION_IDS;
      return previousIds;
    };
  }

  return getStorage()(useShallow(selectorRef.current));
}

function buildOpenApprovalArtifactsForSessionSignature(
  entries: ReadonlyArray<OpenApprovalArtifactForSession>,
): string {
  if (entries.length === 0) return '';
  return entries.map((entry) => [
    entry.artifact.id,
    entry.artifact.headerVersion,
    entry.artifact.bodyVersion ?? '',
    entry.artifact.seq,
    entry.artifact.updatedAt,
    JSON.stringify(entry.approval),
  ].join(':')).join('\u0000');
}

function collectVisibleArtifacts(artifacts: Readonly<Record<string, DecryptedArtifact>>): DecryptedArtifact[] {
  const visibleArtifacts: DecryptedArtifact[] = [];
  for (const artifact of Object.values(artifacts)) {
    if (artifact.draft === true) continue;
    visibleArtifacts.push(artifact);
  }
  return visibleArtifacts;
}

export function useOpenApprovalArtifactsForSession(
  sessionId: string,
  enabled: boolean = true,
): ReadonlyArray<OpenApprovalArtifactForSession> {
  const selector = React.useMemo(() => {
    let previousIsDataReady: boolean | null = null;
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousSignature = '';
    let previousResult: ReadonlyArray<OpenApprovalArtifactForSession> = EMPTY_OPEN_APPROVAL_ARTIFACTS_FOR_SESSION;

    return (state: StorageState): ReadonlyArray<OpenApprovalArtifactForSession> => {
      const normalizedSessionId = sessionId.trim();
      if (!enabled || !normalizedSessionId || !state.isDataReady) {
        previousIsDataReady = state.isDataReady;
        previousArtifacts = state.artifacts;
        previousSignature = '';
        previousResult = EMPTY_OPEN_APPROVAL_ARTIFACTS_FOR_SESSION;
        return previousResult;
      }

      if (state.isDataReady === previousIsDataReady && state.artifacts === previousArtifacts) {
        return previousResult;
      }

      previousIsDataReady = state.isDataReady;
      previousArtifacts = state.artifacts;

      const visibleArtifacts = collectVisibleArtifacts(state.artifacts);
      visibleArtifacts.sort((a, b) => b.updatedAt - a.updatedAt);

      const next = listOpenApprovalArtifactsForSession(visibleArtifacts, normalizedSessionId);
      const nextSignature = buildOpenApprovalArtifactsForSessionSignature(next);
      if (nextSignature === previousSignature) {
        return previousResult;
      }

      previousSignature = nextSignature;
      previousResult = next.length > 0 ? next : EMPTY_OPEN_APPROVAL_ARTIFACTS_FOR_SESSION;
      return previousResult;
    };
  }, [enabled, sessionId]);

  return getStorage()(useShallow(selector));
}

export function useAllArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Return all artifacts including drafts
      return Object.values(state.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useAutomations(): Automation[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return Object.values(state.automations).sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useSessionAutomationsEnabledCount(
  sessionId: string,
  enabled: boolean = true,
): number {
  const selector = React.useMemo(() => {
    let previousIsDataReady: boolean | null = null;
    let previousAutomations: StorageState['automations'] | null = null;
    let previousCount = 0;

    return (state: StorageState): number => {
      const normalizedSessionId = sessionId.trim();
      if (!enabled || !normalizedSessionId || !state.isDataReady) {
        previousIsDataReady = state.isDataReady;
        previousAutomations = state.automations;
        previousCount = 0;
        return previousCount;
      }

      if (state.isDataReady === previousIsDataReady && state.automations === previousAutomations) {
        return previousCount;
      }

      previousIsDataReady = state.isDataReady;
      previousAutomations = state.automations;

      let count = 0;
      for (const automation of Object.values(state.automations)) {
        if (!automation.enabled) continue;
        if (isAutomationLinkedToSession(automation, normalizedSessionId)) {
          count += 1;
        }
      }
      previousCount = count;
      return previousCount;
    };
  }, [enabled, sessionId]);

  return getStorage()(selector);
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
      if (!state.isDataReady) return [];
      // Return only draft artifacts
      return Object.values(state.artifacts)
        .filter((artifact) => artifact.draft === true)
        .sort((a, b) => b.updatedAt - a.updatedAt);
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
      return Object.values(state.friends).filter((friend) => friend.status === 'pending');
    })
  );
}

export function useAcceptedFriends() {
  return getStorage()(
    useShallow((state) => {
      return Object.values(state.friends).filter((friend) => friend.status === 'friend');
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
      return Object.values(state.friends).filter((friend) => friend.status === 'requested');
    })
  );
}
