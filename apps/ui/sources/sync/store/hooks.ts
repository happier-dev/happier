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
import { buildSessionMessageRouteId, resolveSessionMessageRouteId } from '../domains/messages/messageRouteIds';
import { useApplyLocalSettings, useApplySettings } from './settingsWriters';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import { deriveSessionAttentionFlags } from '../domains/session/attention/sessionAttention';
import { normalizeSessionId } from '../domains/session/normalizeSessionId';
import { buildMachineDisplayRenderableFromMachine } from '../domains/machines/machineDisplayRenderable';
import { normalizeTrimmedString } from '../domains/session/listing/normalizeTrimmedString';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

import { getStorage } from '../domains/state/storageStore';
import type { KnownEntitlements } from '../domains/state/storageStore';
import type { ForkedTranscriptSnapshot } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { getForkedTranscriptSnapshotCached } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { resolveSessionListLookupSessionServerScopeFromState } from '../domains/session/listing/sessionListLookupState';
import { resolveVisibleMachinesForActiveServerFromState } from './domains/machines/resolveMachinesForActiveServerFromState';
import type { SessionsDomainSlice } from './types';

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

export function useSessionListRenderable(id: string): SessionListRenderableSession | null {
  return getStorage()(useShallow((state) => state.sessionListRenderables[id] ?? null));
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
        return scoped[normalizedSessionId] ?? null;
      }

      if (activeServerId && activeServerId === normalizedServerId) {
        return state.sessionListRenderables[normalizedSessionId] ?? null;
      }

      return null;
    }

    return state.sessionListRenderables[normalizedSessionId] ?? null;
  }));
}

export function useSessionListRenderablesById(): Record<string, SessionListRenderableSession> {
  return getStorage()(useShallow((state) => state.sessionListRenderables));
}

export function useSessionListRowStateByServerId(): SessionsDomainSlice['sessionListRowStateByServerId'] {
  return getStorage()(useShallow((state) => state.sessionListRowStateByServerId));
}

export function useSessionListIndexByServerId(): Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> {
  return getStorage()(useShallow((state) => state.sessionListIndexByServerId ?? {}));
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

type SessionMessagesArrayCacheEntry = Readonly<{
  idsRef: readonly string[];
  messagesByIdRef: Record<string, Message>;
  messagesVersion: number;
  messages: readonly Message[];
}>;

const SESSION_MESSAGES_ARRAY_CACHE_MAX = 16;
const sessionMessagesArrayCache = new Map<string, SessionMessagesArrayCacheEntry>();

function sortValuesByUpdatedAtDescending<T extends { updatedAt: number }>(values: Record<string, T>): T[] {
  return Object.values(values).sort((left, right) => right.updatedAt - left.updatedAt);
}

export function useSessionMessages(
  sessionId: string
): { messages: Message[]; isLoaded: boolean } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  // IMPORTANT:
  // Do not derive new arrays inside the Zustand selector. React 18 can call getSnapshot twice, and if the
  // selector allocates new references for unchanged store state it can trigger:
  // - "The result of getSnapshot should be cached…"
  // - "Maximum update depth exceeded"
  //
  // Subscribe to stable primitives instead (ids + version), then derive via useMemo.
  const { ids, isLoaded } = useSessionTranscriptIds(normalizedSessionId);
  const messagesById = useSessionMessagesById(normalizedSessionId);
  const version = useSessionMessagesVersion(normalizedSessionId, true);

  const messages = React.useMemo(() => {
    if (!Array.isArray(ids) || ids.length === 0) {
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
  }, [ids, isLoaded, messagesById, normalizedSessionId, version]);

  return React.useMemo(() => ({ messages, isLoaded }), [isLoaded, messages]);
}

export function useSessionTranscriptIds(sessionId: string): { ids: string[]; isLoaded: boolean } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const snapshot = getStorage()(
    useShallow((state) => {
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

export function useSessionMessagesById(sessionId: string): Record<string, Message> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const snapshot = getStorage()(
    useShallow((state) => {
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
    useShallow((state) => {
      const session = state.sessions[normalizedSessionId];
      const transcript = state.sessionMessages[normalizedSessionId];
      const pending = state.sessionPending[normalizedSessionId];

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
  // NOTE:
  // `messagesById` (and message objects within it) are intentionally mutated in-place for streaming
  // performance. The store always creates a new session object when updating messages, so
  // `useSessionMessagesById` (which uses `useShallow` on the session) will detect changes.
  // We also subscribe to `messagesVersion` to ensure re-computation when messages are updated.
  const messagesById = useSessionMessagesById(sessionId);
  const version = useSessionMessagesVersion(sessionId, true);

  return React.useMemo(() => {
    return messagesById?.[messageId] ?? null;
  }, [messageId, messagesById, version]);
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
      if (!state.isDataReady) return [];
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
      if (!state.isDataReady) return [];
      return sortValuesByUpdatedAtDescending(state.sessions);
    })
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
      if (!state.isDataReady) return [];
      // Filter out draft artifacts from the main list
      return sortValuesByUpdatedAtDescending(state.artifacts).filter((artifact) => !artifact.draft);
    })
  );
}

export function useAllArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Return all artifacts including drafts
      return sortValuesByUpdatedAtDescending(state.artifacts);
    })
  );
}

export function useAutomations(): Automation[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
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
      if (!state.isDataReady) return [];
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
