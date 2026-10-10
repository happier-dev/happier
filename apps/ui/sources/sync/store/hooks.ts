import React from 'react';
import { readTranscriptBrowserActionIdentity } from '@/components/sessions/transcript/references/transcriptBrowserActionReference';
import { useAiLaunchProfiles } from './useAiLaunchProfiles';
import type { AuthoringMemory } from './domains/authoringMemory';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { applyProfileSecretBindingSelectionV1 } from '@happier-dev/protocol/profiles/profileOperations';
import type { SessionMessagesTailBoundary } from '@/sync/runtime/sessionMessagesTailDiscontinuity';
import { isPendingMessageForRecipient } from '@/sync/domains/pending/pendingMessageRecipient';
import { useShallow } from 'zustand/react/shallow';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import {
  resolveAutomationRunProjections,
  resolveWorkflowRunRows,
  type WorkflowRunRow,
} from '@/sync/store/domains/workflowRuns';
import { isSessionRetiredForServer } from '@/sync/store/domains/sessions';
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { listSessionAddressesForSessionIdFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';

import type {
  AutomationDefinition,
  AutomationDefinitionRun,
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
  collectOpenApprovalSessionReferences,
  listOpenApprovalArtifactsForSession,
  type OpenApprovalArtifactForSession,
  type OpenApprovalSessionReference,
} from '../domains/artifacts/approvalArtifacts';
import { countEnabledAutomationDefinitionsLinkedToSession } from '../domains/automations/automationSessionLink';
import type { LocalSettings } from '../domains/settings/localSettings';
import {
    readRealmQualifiedMobileSurface,
    readSessionMobileSurfaceWithPredecessor,
    resolveProjectMobileSurfaceStorageKey,
    resolveSessionMobileSurfacePersistenceKeys,
    type SessionMobileSurfacePersistenceKeys,
} from '../domains/settings/mobileSurfacePersistence';
import { buildRealmQualifiedSessionCompanionPreferenceKey } from '@/components/sessions/companion/state/sessionCompanionPreferenceKey';
import { resolveSessionLocalPreferenceRealm } from '../domains/settings/sessionLocalPreferenceKey';
import type { AgentTextMessage, Message } from "@happier-dev/session-core/messages";
import { messageAttentionImpact } from "@happier-dev/session-core/messages";
import { projectSidechainMessages } from "@happier-dev/session-core/reducer";
import type {
  Settings,
  SettingsWriteDelta,
  WritableSettingsKey,
} from '../domains/settings/settings';
import { settingsDefaults } from '../domains/settings/settings';
import { projectCurrentSecretBindingsByProfileId, type CurrentSecretBindingsByProfileId } from '../domains/settings/secretBindings';
import {
  deriveSessionListRenderableHasUnreadMessagesFromSession,
  isSessionListRenderableWarmCacheProgressOnlyChange,
  resolveSessionListReadableSeq,
  summarizeSessionListReadableActivityFromMessageRecords,
  type SessionListRenderableSession,
} from '../domains/session/listing/sessionListRenderable';
import {
  buildSessionListHomeObservations,
  type SessionListHomeObservationByServerId,
} from '../domains/session/listing/sessionListHomeObservation';
import type { SessionListQueryHomeState } from '../domains/session/listing/sessionListQueryController';
import type { SessionListIndexItem } from '../domains/sessionList/sessionListIndex';
import { deriveSessionListMeaningfulActivityAt } from '../domains/session/listing/deriveSessionListActivity';
import { getPermissionsInUiWhileLocal } from '../domains/state/agentStateCapabilities';
import { getSessionLocalControlState, type SessionLocalControlState } from '../domains/session/control/sessionLocalControl';
import { readExternalSessionLink } from '../domains/session/external/readExternalSessionLink';
import { resolveSessionMachineId } from '../domains/session/external/resolveSessionMachineId';
import type { SessionForkSupportSource } from '../domains/sessionFork/forkUiSupport';
import { agentTextLooksLikeExecutionRunSignal, shouldIncludeSubagentSourceMessage } from '../domains/session/subagents/subagentSourceMessageDetection';
import { readExecutionRunResultStatus } from '../domains/session/subagents/executionRuns/executionRunSubagentStatus';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '../domains/sessionActions/sessionActionDraftTypes';
import type { UserProfile } from '../domains/social/friendTypes';
import { buildSessionMessageRouteId, resolveSessionMessageRouteId } from "@happier-dev/session-core/messages";
import {
  buildMessageLegacySignature,
  buildMessageRefsSelectionKey,
  createMessagesByRefsSelector,
  type MessageStoreRef,
} from './messageSelection';
import {
  useApplyLocalSettings,
  useApplyFavoriteModelSelectionReplacementIntent,
  useApplyRememberedEngineSelectionReplacementIntent,
  requireUpdatedProfileOperation,
  useProfileOperations,
  useApplySettings,
} from './settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSessionFromState } from '../domains/session/resolveWorkspaceTargetForSessionFromState';
import { createProjectForSessionResolver } from '../runtime/orchestration/projectForSessionResolver';
import { normalizeSessionId } from '../domains/session/normalizeSessionId';
import { buildSessionMetadataStabilitySignature } from '../domains/session/metadata/sessionMetadataStability';
import { readSessionOwnerMetadataView } from '../domains/session/readSessionOwnerMetadataView';
import { buildMachineDisplayRenderableFromMachine } from '../domains/machines/machineDisplayRenderable';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import { normalizeTrimmedString } from '../domains/session/listing/normalizeTrimmedString';
import {
  buildSessionListServerScopedRowKey,
} from '../domains/session/listing/sessionListKeyNormalization';
import {
  buildSessionListRuntimePriorityRowKeys,
  resolveSessionListRuntimePriorityRowNextFreshnessAtMs,
} from '../domains/session/listing/sessionListRuntimePriorityRows';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '../domains/scope/activeServerAccountScope';
import {
  subscribeAppliedActiveServer,
  subscribeAppliedActiveServerRuntimeAvailability,
} from '../runtime/orchestration/connectionManager';
import {
  areServerProfileIdentifiersEquivalent,
  resolveServerProfileScopeIdForIdentifier,
} from '../domains/server/serverProfiles';
import { resolveServerScopedMachineInventoryKeys } from '../domains/machines/resolveServerScopedMachines';
import {
  readSessionListRowForServerId,
  readSessionListRowsForServerId,
} from '../domains/session/listing/sessionListRowStateLookup';
import { buildSessionFolderAssignmentKey } from '../domains/session/folders';
import {
  buildSessionOrganizationProjection,
  buildSessionOrganizationProjections,
  type SessionOrganizationProjection,
} from '../domains/session/organization';
import { countMachinePresence, isMachineOnline, type MachinePresenceCounts } from '@/utils/sessions/machineUtils';
import { resolveServerScopedMachine } from './domains/machines/resolveServerScopedMachine';
import {
  buildSessionRealtimeScmScopeFromSnapshot,
  getMountedSessionRealtimeScmConsumerScopeResetVersion,
  registerSessionRealtimeScmConsumerScope,
  subscribeMountedSessionRealtimeScmConsumerScopeResets,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { registerSessionTranscriptDerivedCacheClear } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '../domains/session/attention/runtimePresentation';
import {
  compareTranscriptMessagesOldestFirst,
  normalizeTranscriptSeq,
} from "@happier-dev/session-core/messages";

import { getStorage } from '../domains/state/storageStore';
import {
  emptySessionMessagesSnapshot,
  readSessionMessagesSnapshot,
  sessionMessagesArrayCache,
  SESSION_MESSAGES_ARRAY_CACHE_MAX,
} from './sessionMessagesSnapshot';
export { readSessionMessagesSnapshot } from './sessionMessagesSnapshot';
import type { KnownEntitlements } from '../domains/state/storageStore';
import type { ForkedTranscriptSnapshot } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { getForkedTranscriptSnapshotCached } from '../domains/sessionFork/forkedTranscriptSnapshot';
import {
  findSessionListLookupSession,
  resolveSessionListLookupSessionServerScopeFromState,
  resolveSessionListPreferredSessionMetadataFromState,
  type SessionMetadataLike,
} from '../domains/session/listing/sessionListLookupState';
import { resolveVisibleMachinesForActiveServerFromState } from './domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import type { SessionsDomainSlice, StorageState } from './types';
import { createFriendRequestCountSelector } from './friendRequestCount';
import {
  readProjectWorkspaceRefs,
  readCurrentProjectAccountRows,
  EMPTY_PINNED_WORKSPACE_REF_IDS,
  EMPTY_WORKSPACE_RELATIONSHIPS,
  EMPTY_PROJECT_ORGANIZATIONS,
} from './domains/projectAccountRows';

/** Opened row projections are scoped by the sync owner's captured Account/Home. */
export function useProjectAccountRows() {
  return getStorage()(readCurrentProjectAccountRows);
}

export function useWorkspaceRefs() {
  return getStorage()(readProjectWorkspaceRefs);
}

export function useProjectOrganizations() {
  return getStorage()((state) => readCurrentProjectAccountRows(state)?.organizations ?? EMPTY_PROJECT_ORGANIZATIONS);
}

export function useWorkspaceSyncRelationships() {
  return getStorage()((state) => readCurrentProjectAccountRows(state)?.relationships ?? EMPTY_WORKSPACE_RELATIONSHIPS);
}

export function usePinnedWorkspaceRefIds() {
  return getStorage()((state) => readCurrentProjectAccountRows(state) ? state.pinnedWorkspaceRefIds : EMPTY_PINNED_WORKSPACE_REF_IDS);
}

export { useAccountSettingsScope } from './settingsWriters';
export type { MessageStoreRef } from './messageSelection';

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

export function useSession(id: string, serverId?: string | null): Session | null {
  return useSessionSelector(id, serverId ?? undefined, useShallow((session: Session | null) => session));
}

/** One Home-qualified live carrier owner; projections retain their own subscription granularity. */
export function useSessionSelector<T>(id: string, serverId: string | null | undefined, select: (session: Session | null) => T): T {
  const normalizedSessionId = normalizeSessionId(id);
  const normalizedServerId = normalizeTrimmedString(serverId);
  const activeServerId = useActiveServerSnapshot(Boolean(normalizedServerId)).serverId;
  return getStorage()((state) => {
    if (serverId !== undefined && !normalizedServerId) return select(null);
    const session = state.sessions[normalizedSessionId] ?? null;
    if (!normalizedServerId || !session) return select(session);
    if (normalizeTrimmedString(session.serverId)) {
      return select(areServerProfileIdentifiersEquivalent(session.serverId, normalizedServerId) ? session : null);
    }
    // Older live carriers omitted serverId and belong only to the applied Home.
    return select(areServerProfileIdentifiersEquivalent(activeServerId, normalizedServerId)
      && areServerProfileIdentifiersEquivalent(state.sessionLocalStateScope?.serverId, normalizedServerId) ? session : null);
  });
}

/**
 * The exact Session fields used to derive a displayed title. Current UI context
 * needs this projection, not turn-lifecycle facts such as `thinking` or
 * `agentState`, so it remains stable for updates that cannot change its output.
 */
export type SessionDisplayNameSource = Readonly<Pick<
  Session,
  'id' | 'serverId' | 'metadataLayoutVersion' | 'ownerMetadataView'
> & { metadata: Session['metadata'] | SessionListRenderableSession['metadata'] }>;

export function useSessionDisplayNameSource(sessionId: string, serverId?: string | null): SessionDisplayNameSource | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedServerId = normalizeTrimmedString(serverId);
  return getStorage()(
    useShallow((state) => selectSessionDisplayNameSource(state, normalizedSessionId, normalizedServerId)),
  );
}

/**
 * The display-name projection of one Home-qualified session: the hydrated record when it belongs to
 * that Home, else its list row. One selection owner for every title reader (a session header, a
 * workspace tab), so they cannot disagree about which record names a session.
 */
export function selectSessionDisplayNameSource(
  state: StorageState,
  sessionId: string,
  serverId?: string | null,
): SessionDisplayNameSource | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedServerId = normalizeTrimmedString(serverId);
  const directSession = state.sessions[normalizedSessionId];
  const session = !normalizedServerId || areServerProfileIdentifiersEquivalent(directSession?.serverId, normalizedServerId)
    ? directSession
    : findSessionListLookupSession(state, { serverId: normalizedServerId, sessionId: normalizedSessionId })?.session;
  if (!session) return null;
  return {
    id: session.id,
    serverId: normalizedServerId || directSession?.serverId,
    metadata: session.metadata,
    metadataLayoutVersion: session.metadataLayoutVersion,
    ownerMetadataView: session === directSession
      ? directSession?.ownerMetadataView
      : readSessionListRenderableOwnerMetadataView(session),
  };
}

/**
 * Projects several sessions through `project` in one subscription; the result keeps its identity
 * while every projected value is unchanged (`project` should return a primitive, such as a title).
 */
export function useSessionDisplayNameProjections<T>(
  addresses: ReadonlyArray<Readonly<{ sessionId: string; serverId?: string | null }>>,
  project: (source: SessionDisplayNameSource | null) => T,
): readonly T[] {
  return getStorage()(
    useShallow((state) => addresses.map((address) => project(selectSessionDisplayNameSource(state, address.sessionId, address.serverId)))),
  );
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
 * The exact projection a transcript session reference consumes. A reference's identity is its
 * Home-qualified session address, so only two things can change what it renders: whether that
 * exact session is still present for this viewer, and the metadata its title is derived from. Turn-lifecycle churn
 * (thinking, agentState, seq, presence, updatedAt) changes neither, so a reference chip must
 * not re-render for it.
 *
 * **A cache miss is not evidence that the session is gone**, which is the whole content of this
 * hook. Both the qualified row cache and hydrated Session map are scoped caches, and neither is
 * a record of what exists:
 *
 * - `sessionListRowsByServerId` holds rows learned for a Home; ordinary and archived membership
 *   are separate. A replace-mode `/v2/sessions` page can remove ordinary membership, and that
 *   endpoint filters `archivedAt: null` **server-side**.
 * - `sessions` holds only the full records this run hydrated, which is a deliberately small set.
 *   It is in practice a *subset* of the renderables, so it can never rescue a row the renderable
 *   eviction removed. That is why answering presence from either map, or from their union,
 *   produces the same false "Unavailable session" for an archived target.
 *
 * An archived session is fully readable: opening `/session/<id>` from exactly that
 * both-maps-empty state loads and renders it. So an uncached reference stays pressable, and the
 * session route — which already answers a genuinely missing id with its own explicit
 * "Session isn't available" screen — owns the failure the client cannot predict.
 *
 * `deleted` therefore comes from `deletedSessionIds`, written only by `deleteSession`, and is read
 * for this reference's own Home: a deletion on another Home says nothing about this target. A
 * current exact-Home row stays positive evidence that this Home's target exists.
 * `metadata` comes from the canonical exact-Home row (or the active Session record at the legacy
 * unqualified boundary), so a known session still shows its live title without cross-Home bleed.
 */
export function useSessionReferenceTarget(
  sessionId: string,
  serverId?: string | null,
): SessionReferenceTarget {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedServerId = normalizeTrimmedString(serverId);
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot(!normalizedServerId).serverId);
  const lookupServerId = normalizedServerId || activeServerId;
  return getStorage()(
    useShallow((state) => {
      const exactRow = lookupServerId && normalizedSessionId
        ? findSessionListLookupSession(state, {
            serverId: lookupServerId,
            sessionId: normalizedSessionId,
          })?.session ?? null
        : null;
      return {
        // A current exact row is positive evidence that this Home's target exists,
        // even if the active-Home compatibility deletion map holds the same bare id.
        deleted: exactRow
          ? false
          : isSessionRetiredForServer(state.deletedSessionIds, normalizedSessionId, lookupServerId),
        metadata: exactRow?.metadata
          ?? (!normalizedServerId ? state.sessions[normalizedSessionId]?.metadata : null)
          ?? null,
      };
    }),
  );
}

const sessionForkSupportSourceCache = new Map<string, Readonly<{
  signature: string;
  value: SessionForkSupportSource;
}>>();

export function useSessionForkSupportSource(
  sessionId: string | null,
  serverId?: string | null,
): SessionForkSupportSource | null {
  return getStorage()(
    useShallow((state) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const normalizedServerId = normalizeTrimmedString(serverId);
      if (!normalizedSessionId) return null;
      const directSession = state.sessions[normalizedSessionId] ?? null;
      const session = normalizedServerId
        ? directSession && areServerProfileIdentifiersEquivalent(directSession.serverId, normalizedServerId)
          ? directSession
          : findSessionListLookupSession(state, {
              serverId: normalizedServerId,
              sessionId: normalizedSessionId,
            })?.session ?? null
        : directSession;
      if (!session) return null;

      const ownerMetadataView = 'ownerMetadataView' in session
        ? readSessionOwnerMetadataView(session)
        : null;
      const resolvedServerId = normalizedServerId || directSession?.serverId || null;
      const cacheKey = resolvedServerId
        ? sessionAddressKey({ serverId: resolvedServerId, sessionId: normalizedSessionId })
        : `legacy:${normalizedSessionId}`;
      const signature = [
        resolvedServerId ?? '',
        'metadataLayoutVersion' in session
          ? readSessionMetadataLayoutVersion(session.metadataLayoutVersion)
          : 0,
        buildSessionMetadataStabilitySignature(ownerMetadataView ?? session.metadata),
      ].join('\u0000');
      const cached = sessionForkSupportSourceCache.get(cacheKey);
      if (cached?.signature === signature) return cached.value;

      const value: SessionForkSupportSource = {
        metadata: session.metadata,
        ...('ownerMetadataView' in session
          ? {
              metadataLayoutVersion: session.metadataLayoutVersion,
              ownerMetadataView: session.ownerMetadataView,
            }
          : {}),
        serverId: resolvedServerId,
      };
      sessionForkSupportSourceCache.set(cacheKey, { signature, value });
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

      const localControl = getSessionLocalControlState(session);
      const value: SessionChatFooterState = {
        controlledByUser: localControl?.attached === true && localControl.topology === 'exclusive',
        localControl,
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

export function useSessionMetadata(sessionId: string, serverId?: string | null): Session['metadata'] | null {
  return useSessionSelector(sessionId, serverId, (session) => session?.metadata ?? null);
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
 * V-2 (2026-08-11): the transcript reached this through `useExecutionRunsBackendsForSession`, which
 * held `useSession(id)` purely to read `metadata` and hand it to `resolveSessionMachineId`. With an
 * `action-draft` row present that put a whole-session subscription in the transcript producer, so
 * every unrelated session-field write re-ran the option hook — MEASURED at 1 render per write, and 0
 * once it reads this instead.
 *
 * V-3 (2026-08-18): it resolves the OWNER view, not raw `metadata`. `machineId` is an owner key, so
 * a layout-v1 session's shared `metadata` cannot carry it and the raw read answered `null` for every
 * such session. `readSessionOwnerMetadataView` is the layout owner and returns `metadata` unchanged
 * on layout 0, so this is strictly the same answer where the old read had one and a real answer
 * where it did not. Callers that need this id keep asking one hook rather than each re-deciding
 * where the id lives — the agent-transition divider row was the second such decision and is now a
 * consumer.
 */
export function useSessionMachineId(sessionId: string): string | null {
  return getStorage()((state) => {
    const session = state.sessions[sessionId];
    return session ? resolveSessionMachineId(readSessionOwnerMetadataView(session)) : null;
  });
}

/**
 * Whether the session works in a user folder (`'path'`) or a private one (`'managed'`), as a
 * PRIMITIVE for the same reason as {@link useSessionMachineId}: the directory record is an owner
 * key, read through the owner view, and a surface that only names its root must not re-render for
 * every unrelated metadata push. `null` while the session is unknown here.
 */
export function useSessionDirectoryKind(sessionId: string, serverId?: string | null): 'path' | 'managed' | null {
  return useSessionSelector(sessionId, serverId ?? undefined, (session) => session ? readSessionDirectoryKind(readSessionOwnerMetadataView(session)) : null);
}

export type SessionInteractionSource = Readonly<{
  access: Session['access'];
  active: Session['active'];
}>;

/**
 * The exact projection `deriveTranscriptInteractionFromSession` consumes. Transcript rows
 * subscribe to this instead of the whole `Session` record: turn-lifecycle churn (thinking,
 * agentState, agentStateVersion, updatedAt, seq, presence) cannot change interaction rights,
 * so a row must not re-render for it.
 */
export function useSessionInteractionSource(
  sessionId: string,
  serverId?: string | null,
): SessionInteractionSource | null {
  return getStorage()(
    useShallow((state) => {
      const normalizedServerId = normalizeTrimmedString(serverId);
      const session = normalizedServerId
        ? state.sessionListRowsByServerId[normalizedServerId]?.[sessionId]
        : state.sessions[sessionId];
      if (!session) return null;
      return {
        access: session.access,
        active: session.active,
      };
    })
  );
}

export function useSessionListPreferredMetadata(
  target: SessionAddress | string | null | undefined,
): SessionMetadataLike {
  const normalizedTarget = typeof target === 'object' && target !== null
    ? normalizeSessionAddress(target.serverId, target.sessionId)
    : normalizeSessionId(target);
  return getStorage()(useShallow((state) =>
    resolveSessionListPreferredSessionMetadataFromState(state, normalizedTarget ?? '')));
}

export function useSessionListRenderable(id: string): SessionListRenderableSession | null {
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  return getStorage()(useShallow((state) => (
    readSessionListRowForServerId(state.sessionListRowsByServerId, activeServerId, id)
  )));
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

function canReuseActiveHeartbeatAdvance(input: Readonly<{
  previous: SessionListRenderableSession;
  next: SessionListRenderableSession;
  nowMs: number;
}>): boolean {
  const { previous, next, nowMs } = input;
  if (previous.activeAt === next.activeAt) return true;

  const previousActiveAt = finiteTimestamp(previous.activeAt);
  const nextActiveAt = finiteTimestamp(next.activeAt);
  if (previousActiveAt === null || nextActiveAt === null) return false;
  if (nextActiveAt <= previousActiveAt) return false;
  if (nextActiveAt - previousActiveAt >= ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS) return false;

  return previousActiveAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - nowMs
    > ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS;
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
  if (!canReuseActiveHeartbeatAdvance({ previous, next, nowMs })) return false;

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
      const scoped = readSessionListRowsForServerId(state.sessionListRowsByServerId, normalizedServerId);
      if (scoped && typeof scoped === 'object') {
        return projectSessionListRowRenderable(
          scoped[normalizedSessionId],
          sessionAddressKey({ serverId: normalizedServerId, sessionId: normalizedSessionId }),
        );
      }

      return null;
    }

    return projectSessionListRowRenderable(
      readSessionListRowForServerId(state.sessionListRowsByServerId, activeServerId, normalizedSessionId),
      activeServerId
        ? sessionAddressKey({ serverId: activeServerId, sessionId: normalizedSessionId })
        : JSON.stringify(['legacy_unscoped_session', normalizedSessionId]),
    );
  }));
}

const EMPTY_SESSION_LIST_RENDERABLES_BY_ID: Record<string, SessionListRenderableSession> = {};

export function useSessionListRenderablesById(): Record<string, SessionListRenderableSession> {
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  return getStorage()(useShallow((state) => (
    readSessionListRowsForServerId(state.sessionListRowsByServerId, activeServerId)
    ?? EMPTY_SESSION_LIST_RENDERABLES_BY_ID
  )));
}

export type SessionListAttentionRow = Readonly<{
  serverId: string | null;
  serverName: string | null;
  session: SessionListRenderableSession;
}>;

const EMPTY_SESSION_LIST_ROWS_BY_SERVER_ID: SessionsDomainSlice['sessionListRowsByServerId'] = Object.freeze({});

/**
 * Session rows, keyed by Home. Pass `serverIds` to subscribe to those Homes only: a row write on any
 * other Home then re-renders nothing, and an empty selection (a disabled consumer) never re-renders.
 * Without it the consumer follows every Home's rows.
 */
export function useSessionListRowsByServerId(
  serverIds?: ReadonlyArray<string>,
): SessionsDomainSlice['sessionListRowsByServerId'] {
  const serverIdsKey = serverIds ? serverIds.join('\u0001') : null;
  const selectedServerIds = React.useMemo(
    () => (serverIds
      ? [...new Set(serverIds.map((serverId) => normalizeTrimmedString(serverId)).filter((serverId): serverId is string => Boolean(serverId)))]
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the selection's identity
    [serverIdsKey],
  );
  return getStorage()(useShallow((state) => {
    if (!selectedServerIds) return state.sessionListRowsByServerId;
    if (selectedServerIds.length === 0) return EMPTY_SESSION_LIST_ROWS_BY_SERVER_ID;
    const selected: Record<string, SessionsDomainSlice['sessionListRowsByServerId'][string]> = {};
    for (const serverId of selectedServerIds) {
      const rows = readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId);
      if (rows) selected[serverId] = rows;
    }
    return selected;
  }));
}

export function useOrdinarySessionListMembershipByServerId(): SessionsDomainSlice['ordinarySessionListMembershipByServerId'] {
  return getStorage()(useShallow((state) => state.ordinarySessionListMembershipByServerId ?? {}));
}

export function useSessionListQueryMembershipByKey(): SessionsDomainSlice['sessionListQueryMembershipByKey'] {
  return getStorage()((state) => state.sessionListQueryMembershipByKey);
}

export function useArchivedSessionListMembershipByServerId(): SessionsDomainSlice['archivedSessionListMembershipByServerId'] {
  return getStorage()(useShallow((state) => state.archivedSessionListMembershipByServerId ?? {}));
}

const emptySessionListRuntimePriorityRowKeys = new Set<string>() as ReadonlySet<string>;

function areSessionListRuntimePriorityKeySetsEqual(
  previous: ReadonlySet<string> | null,
  next: ReadonlySet<string>,
): boolean {
  if (previous === null || previous.size !== next.size) return false;
  for (const key of next) {
    if (!previous.has(key)) return false;
  }
  return true;
}

function createSessionListRuntimePriorityRowKeysSelector(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
  nowMs: number,
): (state: StorageState) => ReadonlySet<string> {
  const stableItems = items ?? (emptyArray as ReadonlyArray<SessionListIndexItem>);
  let previousOutput: ReadonlySet<string> | null = null;

  return (state) => {
    const nextRaw = buildSessionListRuntimePriorityRowKeys(
      stableItems,
      state.sessionListRowsByServerId,
      nowMs,
    );
    const next = nextRaw.size === 0 ? emptySessionListRuntimePriorityRowKeys : nextRaw;
    if (areSessionListRuntimePriorityKeySetsEqual(previousOutput, next)) {
      return previousOutput ?? emptySessionListRuntimePriorityRowKeys;
    }

    previousOutput = next;
    return next;
  };
}

function resolveNextSessionListRuntimePriorityFreshnessAtMs(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
  rowStateByServerId: StorageState['sessionListRowsByServerId'],
  nowMs: number,
): number | null {
  let nextAt: number | null = null;
  for (const item of items ?? []) {
    if (item.type !== 'session') continue;
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
    if (!serverId || !sessionId) continue;
    const freshnessAt = resolveSessionListRuntimePriorityRowNextFreshnessAtMs(
      rowStateByServerId[serverId]?.[sessionId],
      nowMs,
    );
    if (freshnessAt === null) continue;
    nextAt = nextAt === null ? freshnessAt : Math.min(nextAt, freshnessAt);
  }
  return nextAt;
}

function useSessionListRuntimePriorityNowMs(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
): number {
  const [runtimeNowMs, setRuntimeNowMs] = React.useState(() => Date.now());
  const nextFreshnessAtMs = getStorage()(
    React.useMemo(
      () => (state: StorageState) => resolveNextSessionListRuntimePriorityFreshnessAtMs(
        items,
        state.sessionListRowsByServerId,
        runtimeNowMs,
      ),
      [items, runtimeNowMs],
    ),
  );

  React.useEffect(() => {
    if (nextFreshnessAtMs === null) return undefined;
    const delayMs = Math.max(0, nextFreshnessAtMs - Date.now() + 1);
    const timeoutId = setTimeout(() => {
      setRuntimeNowMs(Date.now());
    }, delayMs);
    return () => clearTimeout(timeoutId);
  }, [nextFreshnessAtMs]);

  return runtimeNowMs;
}

export function useSessionListRuntimePriorityRowKeysForItems(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
  options: Readonly<{ enabled?: boolean }> = {},
): ReadonlySet<string> {
  const activeItems = options.enabled === false ? null : items;
  const runtimeNowMs = useSessionListRuntimePriorityNowMs(activeItems);
  const selector = React.useMemo(
    () => createSessionListRuntimePriorityRowKeysSelector(activeItems, runtimeNowMs),
    [activeItems, runtimeNowMs],
  );
  return getStorage()(selector);
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
  return buildSessionListServerScopedRowKey(serverId, sessionId);
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
      const row = readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        itemKey.serverId,
        itemKey.sessionId,
      );
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
      const row = readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        itemKey.serverId,
        itemKey.sessionId,
      );
      const projected = projectSessionListRowRenderable(row, itemKey.key);
      if (!projected) continue;
      next.set(itemKey.key, projected);
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
    state.sessionOrganizationFolderAssignmentsBySessionKey[buildSessionFolderAssignmentKey(serverId, sessionId)]?.folderId ?? null
  )));
}

const sessionFolderAssignmentsProjectionCache = new WeakMap<
  StorageState['sessionOrganizationFolderAssignmentsBySessionKey'],
  Record<string, string | null>
>();

function projectSessionFolderAssignmentValues(
  assignments: StorageState['sessionOrganizationFolderAssignmentsBySessionKey'],
): Record<string, string | null> {
  const cached = sessionFolderAssignmentsProjectionCache.get(assignments);
  if (cached) return cached;
  const projected = Object.fromEntries(
    Object.entries(assignments).map(([key, assignment]) => [key, assignment.folderId]),
  );
  sessionFolderAssignmentsProjectionCache.set(assignments, projected);
  return projected;
}

export function useSessionFolderAssignmentsBySessionKey(): Record<string, string | null> {
  return getStorage()(useShallow((state) => projectSessionFolderAssignmentValues(
    state.sessionOrganizationFolderAssignmentsBySessionKey,
  )));
}

type SessionOrganizationProjectionCacheEntry = Readonly<{
  schemaVersionByServerId: StorageState['sessionOrganizationSchemaVersionByServerId'];
  snapshotVersionByServerId: StorageState['sessionOrganizationSnapshotVersionByServerId'];
  pinsBySessionKey: StorageState['sessionOrganizationPinsBySessionKey'];
  foldersByFolderKey: StorageState['sessionOrganizationFoldersByFolderKey'];
  folderAssignmentsBySessionKey: StorageState['sessionOrganizationFolderAssignmentsBySessionKey'];
  tagsByTagKey: StorageState['sessionOrganizationTagsByTagKey'];
  tagAssignmentsBySessionKey: StorageState['sessionOrganizationTagAssignmentsBySessionKey'];
  attentionStandingsBySessionKey: StorageState['sessionOrganizationAttentionStandingsBySessionKey'];
  orderEntriesByScopeKey: StorageState['sessionOrganizationOrderEntriesByScopeKey'];
  labelsByLabelKey: StorageState['sessionOrganizationLabelsByLabelKey'];
  value: SessionOrganizationProjection;
}>;

const sessionOrganizationProjectionCacheByServerId = new Map<string, SessionOrganizationProjectionCacheEntry>();

export function readSessionOrganizationProjectionCached(
  state: StorageState,
  serverId: string,
): SessionOrganizationProjection {
  const cached = sessionOrganizationProjectionCacheByServerId.get(serverId);
  if (
    cached
    && cached.schemaVersionByServerId === state.sessionOrganizationSchemaVersionByServerId
    && cached.snapshotVersionByServerId === state.sessionOrganizationSnapshotVersionByServerId
    && cached.pinsBySessionKey === state.sessionOrganizationPinsBySessionKey
    && cached.foldersByFolderKey === state.sessionOrganizationFoldersByFolderKey
    && cached.folderAssignmentsBySessionKey === state.sessionOrganizationFolderAssignmentsBySessionKey
    && cached.tagsByTagKey === state.sessionOrganizationTagsByTagKey
    && cached.tagAssignmentsBySessionKey === state.sessionOrganizationTagAssignmentsBySessionKey
    && cached.attentionStandingsBySessionKey === state.sessionOrganizationAttentionStandingsBySessionKey
    && cached.orderEntriesByScopeKey === state.sessionOrganizationOrderEntriesByScopeKey
    && cached.labelsByLabelKey === state.sessionOrganizationLabelsByLabelKey
  ) {
    return cached.value;
  }

  const value = buildSessionOrganizationProjection({
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
  }, serverId);
  sessionOrganizationProjectionCacheByServerId.set(serverId, {
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
    value,
  });
  return value;
}

export function useSessionOrganizationProjection(serverId: string | null | undefined): SessionOrganizationProjection | null {
  const normalizedServerId = String(serverId ?? '').trim();
  return getStorage()(useShallow((state) => {
    if (!normalizedServerId) return null;
    return readSessionOrganizationProjectionCached(state, normalizedServerId);
  }));
}

const EMPTY_SESSION_ORGANIZATION_PROJECTIONS_BY_SERVER_ID: Readonly<Record<string, SessionOrganizationProjection>> = Object.freeze({});

/**
 * The canonical multi-Home organization projection selector. Every value is
 * produced by the same cache as the single-Home hook, so mounted list filters
 * do not create another organization-state owner.
 */
export function useSessionOrganizationProjections(
  serverIds: readonly string[],
): Readonly<Record<string, SessionOrganizationProjection>> {
  return getStorage()(useShallow((state) => {
    const projections = buildSessionOrganizationProjections(
      serverIds,
      (serverId) => readSessionOrganizationProjectionCached(state, serverId),
    );
    return Object.keys(projections).length > 0
      ? projections
      : EMPTY_SESSION_ORGANIZATION_PROJECTIONS_BY_SERVER_ID;
  }));
}

export function useSessionOrganizationSnapshotVersions(serverId: string | null | undefined): Readonly<{
  schemaVersion: number | null;
  version: number | null;
}> {
  const normalizedServerId = String(serverId ?? '').trim();
  return getStorage()(useShallow((state) => ({
    schemaVersion: normalizedServerId ? state.sessionOrganizationSchemaVersionByServerId[normalizedServerId] ?? null : null,
    version: normalizedServerId ? state.sessionOrganizationSnapshotVersionByServerId[normalizedServerId] ?? null : null,
  })));
}

const EMPTY_MACHINE_DISPLAY_BY_ID: Record<string, MachineDisplayRenderable> = {};

export function useMachineDisplayById(): Record<string, MachineDisplayRenderable> {
  return getStorage()(useShallow((state) => state.machineDisplayById ?? EMPTY_MACHINE_DISPLAY_BY_ID));
}

/** Subscribe only to display-name changes for an already-bounded machine set. */
export function useMachineDisplayNamesById(machineIds: readonly string[]): Readonly<Record<string, string>> {
  const normalizedIds = React.useMemo(
    () => [...new Set(machineIds.map((id) => id.trim()).filter(Boolean))].sort(),
    [machineIds],
  );
  return getStorage()(useShallow((state) => {
    const names: Record<string, string> = {};
    for (const machineId of normalizedIds) {
      const metadata = state.machineDisplayById?.[machineId]?.metadata;
      const name = metadata?.displayName?.trim() || metadata?.host?.trim() || '';
      if (name) names[machineId] = name;
    }
    return names;
  }));
}

const noopSessionServerIdSubscribe = () => () => {};
const readNullSessionServerId = () => null;

export function useSessionServerId(sessionId: string, enabled = true): string | null {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const store = getStorage();
    const getSnapshot = React.useCallback(() => {
      const state = store.getState();
      return resolveSessionListLookupSessionServerScopeFromState({
        sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
        sessionListIndexByServerId: state.sessionListIndexByServerId,
        sessionListRowsByServerId: state.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
      }, normalizedSessionId)?.serverId ?? null;
    }, [normalizedSessionId, store]);
    return React.useSyncExternalStore(
      enabled ? store.subscribe : noopSessionServerIdSubscribe,
      enabled ? getSnapshot : readNullSessionServerId,
      enabled ? getSnapshot : readNullSessionServerId,
    );
}

function resolveSessionLastMobileSurfacePersistenceKeysFromState(
  state: Pick<StorageState, 'profileScope' | 'sessions' | 'sessionListIndexByServerId' | 'sessionListRowsByServerId' | 'ordinarySessionListMembershipByServerId' | 'concurrentSessionListCacheByServerId'>,
  sessionId: string,
  activeServerId: string | null | undefined,
  explicitServerId?: string | null,
): SessionMobileSurfacePersistenceKeys | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  const resolvedExplicitServerId = normalizeTrimmedString(explicitServerId);
  const resolvedServerId = resolvedExplicitServerId
    || (resolveSessionListLookupSessionServerScopeFromState({
      sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
      sessionListIndexByServerId: state.sessionListIndexByServerId,
      sessionListRowsByServerId: state.sessionListRowsByServerId,
      ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
      concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
    }, normalizedSessionId)?.serverId ?? null);
  return resolveSessionMobileSurfacePersistenceKeys({
    sessionId: normalizedSessionId,
    activeScope: state.profileScope,
    activeServerId,
    targetServerId: resolvedServerId,
  });
}

function readSessionLastMobileSurfaceFromMap(
  persistedBySessionId: LocalSettings['sessionLastMobileSurfaceBySessionId'] | null | undefined,
  persistenceKeys: SessionMobileSurfacePersistenceKeys | null,
): Readonly<{
  surface: LocalSettings['sessionLastMobileSurfaceBySessionId'][string] | null;
  predecessorSurface: LocalSettings['sessionLastMobileSurfaceBySessionId'][string] | null;
}> {
  return readSessionMobileSurfaceWithPredecessor(persistedBySessionId, persistenceKeys);
}

function resolveSessionCompanionPreferenceStorageKeyFromState(
  state: Pick<StorageState, 'profileScope' | 'sessions' | 'sessionListIndexByServerId' | 'sessionListRowsByServerId' | 'ordinarySessionListMembershipByServerId' | 'concurrentSessionListCacheByServerId'>,
  sessionId: string,
  activeServerId: string | null | undefined,
  explicitServerId?: string | null,
): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  const resolvedServerId = normalizeTrimmedString(explicitServerId)
    || (resolveSessionListLookupSessionServerScopeFromState({
      sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
      sessionListIndexByServerId: state.sessionListIndexByServerId,
      sessionListRowsByServerId: state.sessionListRowsByServerId,
      ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
      concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
    }, normalizedSessionId)?.serverId ?? null);
  const scope = resolveSessionLocalPreferenceRealm({
    activeScope: state.profileScope,
    activeServerId,
    targetServerId: resolvedServerId,
  });
  return scope
    ? buildRealmQualifiedSessionCompanionPreferenceKey(scope, normalizedSessionId)
    : null;
}

function resolveProjectLastMobileSurfaceStorageKeyFromState(
  state: Pick<StorageState, 'profileScope' | 'projectAccountRows'>,
  workspaceRefId: string,
  activeServerId: string | null | undefined,
  explicitServerId?: string | null,
): string | null {
  return resolveProjectMobileSurfaceStorageKey({
    workspaceRefs: readProjectWorkspaceRefs(state),
    workspaceRefId,
    activeScope: state.profileScope,
    activeServerId,
    targetServerId: explicitServerId,
  });
}

function selectProjectLastMobileSurfacesByWorkspaceRefId(
  state: Pick<StorageState, 'localSettings' | 'profileScope' | 'projectAccountRows'>,
  activeServerId: string | null | undefined,
): Readonly<Record<string, LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'][string]>> {
  const persisted = state.localSettings.projectLastMobileSurfaceByWorkspaceRefId;
  const result: Record<string, LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'][string]> = {};
  for (const workspaceRef of readProjectWorkspaceRefs(state)) {
    const storageKey = resolveProjectLastMobileSurfaceStorageKeyFromState(
      state,
      workspaceRef.id,
      activeServerId,
    );
    const surface = readRealmQualifiedMobileSurface(persisted, storageKey);
    if (surface) {
      result[workspaceRef.id] = surface;
    }
  }
  return result;
}

const emptyArray: unknown[] = emptySessionMessagesSnapshot;
const emptyRecord: Record<string, any> = {};
const emptyReviewCommentDrafts: ReviewCommentDraft[] = [];
const emptyActionDrafts: SessionActionDraft[] = [];
const emptyOpenApprovalSessionReferences: ReadonlyArray<OpenApprovalSessionReference> = Object.freeze([]);
const emptyOpenApprovalArtifactsForSession: ReadonlyArray<OpenApprovalArtifactForSession> = Object.freeze([]);

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

// Transcript memory release seam: these module caches root a session's materialized
// Message objects (the array cache also keeps a ref to the whole messagesById record),
// so `evictSessionMessages`/`deleteSession` must clear them alongside the store entry.
registerSessionTranscriptDerivedCacheClear((sessionId) => {
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

function appendSubagentSourceMessageSignature(parts: string[], message: Message): void {
  const cached = sessionSubagentSourceMessageSignatureCache.get(message);
  if (cached !== undefined) {
    parts.push(cached);
    return;
  }

  const messageParts: string[] = [];
  const seq = normalizeTranscriptSeq((message as any).seq);
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
    // A still-running execution run streams prose into its result, so the signature carries only
    // the field the roster derivation actually reads — the structured status the execution-run
    // manager wrote — through that derivation's own owner. Otherwise every token would change the
    // signature and hand every consumer a fresh array to re-derive.
    //
    // Narrowed to `SubAgentRun` on purpose: the Claude teammate derivation discovers a spawned
    // member from a spawn tool's *result*, so dropping a running tool's result wholesale would
    // delay that roster entry. Once the call leaves `running` the state itself changes the
    // signature, so the full result is read again either way.
    result: tool?.state === 'running' && tool?.name === 'SubAgentRun'
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
      : Object.values(session.messagesById ?? {}).sort(compareTranscriptMessagesOldestFirst);

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

const sortedValuesByUpdatedAtDescendingCache = new WeakMap<object, readonly { updatedAt: number }[]>();

function sortValuesByUpdatedAtDescending<T extends { updatedAt: number }>(values: Record<string, T>): T[] {
  const cached = sortedValuesByUpdatedAtDescendingCache.get(values) as T[] | undefined;
  if (cached) return cached;
  const sorted = Object.values(values).sort((left, right) => right.updatedAt - left.updatedAt);
  sortedValuesByUpdatedAtDescendingCache.set(values, sorted);
  return sorted;
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

  const messages = React.useMemo(() => enabled
    ? readSessionMessagesSnapshot(normalizedSessionId, ids, messagesById, version, isLoaded)
    : emptyArray as Message[], [enabled, ids, isLoaded, messagesById, normalizedSessionId, version]);

  return React.useMemo(() => ({ messages, isLoaded }), [isLoaded, messages]);
}

/** Completion identity consumed by browser discovery, not transcript presentation. */
export function useSessionCompletedBrowserActionKey(sessionId: string, options?: UseSessionMessagesOptions): string {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const enabled = options?.enabled !== false;
  return getStorage()((state) => {
    if (!enabled) return '';
    const transcript = state.sessionMessages[normalizedSessionId];
    const messages = readSessionMessagesSnapshot(normalizedSessionId,
      transcript?.messageIdsOldestFirst ?? emptyArray as string[],
      transcript?.messagesById ?? emptyRecord,
      transcript?.messagesVersion ?? 0, transcript?.isLoaded ?? false);
    return messages.filter(message => message.kind === 'tool-call'
      && message.tool.state === 'completed' && readTranscriptBrowserActionIdentity({
        toolName: message.tool.name, input: message.tool.input,
      }) !== null).map(message => message.id).join('\n');
  });
}

/** Whether the Session's transcript has been read at least once; a boolean subscription, no ids. */
export function useSessionTranscriptLoaded(sessionId: string): boolean {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => state.sessionMessages[normalizedSessionId]?.isLoaded ?? false);
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
export function useSessionTailContiguousBoundary(sessionId: string): SessionMessagesTailBoundary | null {
  return getStorage()((state) => state.sessionTailContiguousBoundary[sessionId] ?? null);
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

/**
 * Committed rows of one sidechain, projected through the transcript reducer's
 * own conversion.
 *
 * A Run whose profile does not materialize a parent tool marker still commits
 * its transcript under the Run's sidechain id, so a surface that has the Run
 * but no marker reads the rows here instead of re-deriving a transcript of its
 * own. The reducer state mutates in place, so the projection is keyed by the
 * same version counter the other transcript readers subscribe to.
 */
export function useSessionSidechainMessages(sessionId: string, sidechainId: string | null): readonly Message[] {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const reducerState = useSessionMessagesReducerState(normalizedSessionId);
  const version = useSessionMessagesVersion(normalizedSessionId, true);
  const normalizedSidechainId = typeof sidechainId === 'string' && sidechainId.trim().length > 0
    ? sidechainId.trim()
    : null;

  return React.useMemo(() => {
    if (!reducerState || !normalizedSidechainId) return emptyArray as any as readonly Message[];
    const projected = projectSidechainMessages(reducerState, normalizedSidechainId);
    return projected.length > 0 ? projected : (emptyArray as any as readonly Message[]);
    // `version` participates because the reducer state object is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedSidechainId, reducerState, version]);
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
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  return getStorage()((state) => {
    const renderable = readSessionListRowForServerId(
      state.sessionListRowsByServerId,
      activeServerId,
      normalizedSessionId,
    );
    const session = state.sessions[normalizedSessionId];
    if (session) {
      const readableActivity = summarizeCommittedSessionMessagesForUnread(state.sessionMessages[normalizedSessionId]);
      const readableSeq = resolveSessionListReadableSeq(session, readableActivity);
      const hasUnreadMessages = deriveSessionListRenderableHasUnreadMessagesFromSession(session, readableActivity);
      if (
        hasUnreadMessages === false
        && readableActivity === undefined
        && readableSeq <= 0
        && !readExternalSessionLink(readSessionOwnerMetadataView(session))
      ) {
        return renderable?.hasUnreadMessages === true;
      }
      return hasUnreadMessages;
    }

    return renderable?.hasUnreadMessages === true;
  });
}

export function useSessionReadyActivity(sessionId: string): {
  latestReadyEventSeq: number | null;
  latestReadyEventAt: number | null;
} {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessions[normalizedSessionId];
      const sessionMessages = state.sessionMessages[normalizedSessionId];
      const renderable = readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        activeServerId,
        normalizedSessionId,
      );
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
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  const { sessionSeq, latestTurnStatus } = params;
  const selector = React.useMemo(() => {
    let previousSessionMessages: StorageState['sessionMessages'][string] | null | undefined;
    let previousSession: StorageState['sessions'][string] | null | undefined;
    let previousRenderable: SessionListRenderableSession | null | undefined;
    let previousResult: number | null = null;

    return (state: StorageState): number | null => {
      const sessionMessages = state.sessionMessages[normalizedSessionId];
      const session = state.sessions[normalizedSessionId];
      const renderable = readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        activeServerId,
        normalizedSessionId,
      );
      if (
        sessionMessages === previousSessionMessages
        && session === previousSession
        && renderable === previousRenderable
      ) {
        return previousResult;
      }

      previousSessionMessages = sessionMessages;
      previousSession = session;
      previousRenderable = renderable;

      if (!sessionMessages || sessionMessages.isLoaded !== true) {
        previousResult = null;
        return previousResult;
      }
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
        previousResult = null;
        return previousResult;
      }
      previousResult = resolveSessionListReadableSeq({
        seq: sessionSeq ?? 0,
        latestReadyEventSeq,
        latestTurnStatus,
      }, readableActivity);
      return previousResult;
    };
  }, [activeServerId, latestTurnStatus, normalizedSessionId, sessionSeq]);

  return getStorage()(selector);
}

function hasTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null | undefined): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export function useSessionPendingMessages(
  sessionId: string,
  recipient?: PendingMessage['recipient'],
): { messages: PendingMessage[]; discarded: DiscardedPendingMessage[]; isLoaded: boolean } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const messages = getStorage()(useShallow((state) =>
    (state.sessionPending[normalizedSessionId]?.messages ?? emptyArray)
      .filter((message) => isPendingMessageForRecipient(message, recipient))
  ));
  const discarded = getStorage()(useShallow((state) =>
    (state.sessionPending[normalizedSessionId]?.discarded ?? emptyArray)
      .filter((message) => isPendingMessageForRecipient(message, recipient))
  ));
  const isLoaded = getStorage()((state) => state.sessionPending[normalizedSessionId]?.isLoaded ?? false);
  return React.useMemo(() => ({ messages, discarded, isLoaded }), [messages, discarded, isLoaded]);
}

export function useSessionListMeaningfulActivityAt(sessionId: string): number | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  return getStorage()(
    useShallow((state) => selectSessionListMeaningfulActivityAt(state, activeServerId, normalizedSessionId))
  );
}

function selectSessionListMeaningfulActivityAt(
  state: StorageState,
  activeServerId: string,
  sessionId: string,
): number | null {
  const session = state.sessions[sessionId];
  const renderable = readSessionListRowForServerId(
    state.sessionListRowsByServerId,
    activeServerId,
    sessionId,
  );
  const transcript = state.sessionMessages[sessionId];
  const pending = state.sessionPending[sessionId];

  let latestCommittedMessageCreatedAt: number | null = null;
  for (const messageId of transcript?.messageIdsOldestFirst ?? emptyArray) {
    const message = transcript?.messagesById?.[messageId];
    const createdAt = message?.createdAt;
    if (!message || !messageAttentionImpact(message).affectsMeaningfulActivity) continue;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
    latestCommittedMessageCreatedAt =
      latestCommittedMessageCreatedAt == null ? createdAt : Math.max(latestCommittedMessageCreatedAt, createdAt);
  }

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

/**
 * Action-draft subscribers address a Session before its Home is always resolved
 * (`usePreferredServerIdForSession` returns `null` until it is). An unresolved
 * Home has no draft rows, so the key is simply absent rather than fabricated.
 */
type SessionActionDraftAddressLike = Readonly<{ serverId: string | null | undefined; sessionId: string }>;

function readSessionActionDraftAddressKey(address: SessionActionDraftAddressLike): string | null {
  const normalized = normalizeSessionAddress(address.serverId, address.sessionId);
  return normalized ? sessionAddressKey(normalized) : null;
}

export function useSessionActionDrafts(address: SessionActionDraftAddressLike): SessionActionDraft[] {
  const addressKey = React.useMemo(
    () => readSessionActionDraftAddressKey(address),
    [address.serverId, address.sessionId],
  );
  return getStorage()(
    useShallow((state) => (addressKey ? state.sessionActionDraftsByAddressKey?.[addressKey] ?? emptyActionDrafts : emptyActionDrafts))
  );
}

/**
 * Whether this session has any action-draft row at all.
 *
 * A BOOLEAN selector, not `useSessionActionDrafts(...).length > 0`: the draft objects are rewritten
 * on every keystroke, so the shallow-compared array above re-renders its subscriber constantly. The
 * transcript root uses this to decide whether to pay for the draft-card option subscription
 * (`useSessionActionFieldOptionsForRowHeight`) at all, and it must not itself become a per-keystroke
 * re-render of the whole transcript.
 */
export function useSessionHasActionDrafts(address: SessionActionDraftAddressLike): boolean {
  const addressKey = React.useMemo(
    () => readSessionActionDraftAddressKey(address),
    [address.serverId, address.sessionId],
  );
  return getStorage()(
    (state) => (addressKey ? state.sessionActionDraftsByAddressKey?.[addressKey]?.length ?? 0 : 0) > 0
  );
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

export type ExactSessionUsageScope = Readonly<{
  serverId: string;
  session: Pick<Session, 'id' | 'serverId' | 'latestUsage'>;
}>;

/**
 * Reads the active transcript's usage, with an exact-Home mode for mounted
 * Session surfaces. The transcript reducer is intentionally keyed by the
 * legacy bare Session id because it belongs to the active Home; an exact
 * caller may consume it only while that active Home is equivalent to its
 * target. Its supplied Session remains the fallback for an inactive Home.
 */
export function useSessionUsage(sessionId: string, exactScope?: ExactSessionUsageScope) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const targetServerId = resolveServerProfileScopeIdForIdentifier(exactScope?.serverId);
  const activeServerId = resolveServerProfileScopeIdForIdentifier(
    useActiveServerSnapshot(Boolean(exactScope)).serverId,
  );
  const suppliedSession = exactScope?.session ?? null;
  const suppliedSessionServerId = resolveServerProfileScopeIdForIdentifier(suppliedSession?.serverId);
  const exactSessionMatches = Boolean(
    exactScope
    && normalizedSessionId
    && targetServerId
    && normalizeSessionId(suppliedSession?.id) === normalizedSessionId
    && (
      suppliedSessionServerId
        ? areServerProfileIdentifiersEquivalent(suppliedSessionServerId, targetServerId)
        : areServerProfileIdentifiersEquivalent(activeServerId, targetServerId)
    )
  );
  const activeHomeMatches = exactSessionMatches
    && areServerProfileIdentifiersEquivalent(activeServerId, targetServerId);

  return getStorage()(
    useShallow((state) => {
      if (exactScope && !exactSessionMatches) return null;
      const sessionMessages = activeHomeMatches || !exactScope
        ? state.sessionMessages?.[normalizedSessionId]
        : undefined;
      return sessionMessages?.reducerState?.latestUsage
        ?? (exactScope
          ? suppliedSession?.latestUsage
          : state.sessions?.[normalizedSessionId]?.latestUsage)
        ?? null;
    })
  );
}

export function useSettings(): Settings {
  return getStorage()(useShallow((state) => state.settings ?? settingsDefaults));
}

/** Subscribe to a settings-domain projection while retaining unchanged selected fields. */
export function useSettingsSelector<T>(selector: (settings: Settings) => T): T {
  const selectState = React.useMemo(() => {
    let previous: { settings: Settings; value: T } | null = null;
    return (state: StorageState): T => {
      const settings = state.settings ?? settingsDefaults;
      if (!previous || previous.settings !== settings) {
        previous = { settings, value: selector(settings) };
      }
      return previous.value;
    };
  }, [selector]);
  return getStorage()(useShallow(selectState));
}

export function useSettingsVersion(): number | null {
  return getStorage()((state) => state.settingsVersion);
}

export function useSettingMutable<K extends WritableSettingsKey>(
  name: K
): [Settings[K], (value: Settings[K] | ((current: Settings[K]) => Settings[K] | null)) => void] {
  const applySettings = useApplySettings();
  const setValue = React.useCallback(
    (value: Settings[K] | ((current: Settings[K]) => Settings[K] | null)) => {
      const delta = (next: Settings[K]): SettingsWriteDelta => {
        const result: SettingsWriteDelta = {};
        result[name] = next;
        return result;
      };
      if (typeof value === 'function') {
        applySettings(current => {
          const next = value(current[name]);
          return next === null ? null : delta(next);
        });
      } else {
        applySettings(delta(value));
      }
    },
    [applySettings, name]
  );
  const value = useSetting(name);
  return [value, setValue];
}

/**
 * Profile bindings are the admitted entity/resource projection. Edits apply
 * only changed keys to the private row, never copy shared defaults or Settings.
 */
export function useCurrentSecretBindingsByProfileIdMutable(): [
  CurrentSecretBindingsByProfileId,
  (value: CurrentSecretBindingsByProfileId) => Promise<void>,
] {
  const operations = useProfileOperations();
  const profiles = useAiLaunchProfiles();
  const currentBindings = React.useMemo(() => projectCurrentSecretBindingsByProfileId(profiles), [profiles]);
  const setCurrentBindings = React.useCallback(
    async (nextBindings: CurrentSecretBindingsByProfileId) => {
      if (!operations) throw new Error('Profile Account is unavailable');
      for (const id of new Set([...Object.keys(currentBindings), ...Object.keys(nextBindings)])) {
        const before = currentBindings[id] ?? {};
        const next = nextBindings[id] ?? {};
        const changedNames = [...new Set([...Object.keys(before), ...Object.keys(next)])]
          .filter(name => before[name] !== next[name]);
        if (changedNames.length === 0) continue;
        const admitted = operations.read({ id });
        if (admitted.status !== 'present' && !(admitted.status === 'invalid' && admitted.reason === 'profile-not-found')) {
          throw new Error(admitted.status === 'unavailable' || admitted.status === 'invalid' ? admitted.reason : 'profile_binding_membership_unavailable');
        }
        let bindings: ProfileRecordV1['secretBindings'] = admitted.status === 'present' && 'record' in admitted
          ? { ...admitted.record.secretBindings } : {};
        for (const name of changedNames) {
          const reference = next[name];
          bindings = applyProfileSecretBindingSelectionV1(bindings, name,
            reference === undefined ? { kind: 'none' } : { kind: 'reference', reference });
        }
        requireUpdatedProfileOperation(await operations.setSecretBindings({ id, secretBindings: bindings,
          expectedRevision: profiles.find(profile => profile.id === id)?.profileRecordRevision ?? 'absent' }));
      }
    },
    [operations, currentBindings, profiles],
  );
  return [currentBindings, setCurrentBindings];
}

/**
 * New Session consumes only the strict Favorite projection. Its replacement
 * intent is replayed by the canonical Account Settings CAS owner.
 */
export function useCurrentFavoriteModelSelectionsV1Mutable(): [
  Settings['currentFavoriteModelSelectionsV1'],
  (value: Settings['currentFavoriteModelSelectionsV1']) => void,
] {
  const applyFavoriteReplacement = useApplyFavoriteModelSelectionReplacementIntent();
  const currentFavorites = useSetting('currentFavoriteModelSelectionsV1');
  const setCurrentFavorites = React.useCallback(
    (nextFavorites: Settings['currentFavoriteModelSelectionsV1']) => {
      fireAndForget(
        applyFavoriteReplacement({ base: currentFavorites, proposed: nextFavorites }),
        { tag: 'useCurrentFavoriteModelSelectionsV1Mutable' },
      );
    },
    [applyFavoriteReplacement, currentFavorites],
  );
  return [currentFavorites, setCurrentFavorites];
}

/**
 * New Session consumes only the strict remembered-selection projection. Its
 * replacement intent cannot replace an opaque future value at the same scope
 * key, including after a concurrent CAS winner arrives.
 */
export function useCurrentRememberedEngineSelectionsByScopeV1Mutable(): [
  AuthoringMemory['currentRememberedEngineSelectionsByScopeV1'],
  (value: AuthoringMemory['currentRememberedEngineSelectionsByScopeV1']) => void,
] {
  const applyRememberedReplacement = useApplyRememberedEngineSelectionReplacementIntent();
  const currentSelections = useAuthoringMemoryField('currentRememberedEngineSelectionsByScopeV1');
  const setCurrentSelections = React.useCallback(
    (nextSelections: AuthoringMemory['currentRememberedEngineSelectionsByScopeV1']) => {
      fireAndForget(
        applyRememberedReplacement({ base: currentSelections, proposed: nextSelections }),
        { tag: 'useCurrentRememberedEngineSelectionsByScopeV1Mutable' },
      );
    },
    [applyRememberedReplacement, currentSelections],
  );
  return [currentSelections, setCurrentSelections];
}

export function useAuthoringMemoryField<K extends keyof AuthoringMemory>(name: K): AuthoringMemory[K] {
  return getStorage()((state) => state.authoringMemory[name]);
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

/**
 * This Home's machines online and offline, for always-mounted chrome (the rail's Machines tooltip,
 * the Settings Machines row). The selector returns a primitive key, so a heartbeat or a metadata
 * edit that leaves both counts unchanged re-renders nothing, and the counts keep their identity.
 */
export function useMachinePresenceCounts(): MachinePresenceCounts {
  const key = getStorage()((state) => {
    const counts = countMachinePresence(resolveVisibleMachinesForActiveServerFromState(state));
    return `${counts.online}:${counts.offline}`;
  });
  return React.useMemo(() => {
    const [online = 0, offline = 0] = key.split(':').map(Number);
    return { online, offline };
  }, [key]);
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
        String(machine.activeAt ?? ''),
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

export function useMachineRecordValues(enabled = true): Machine[] {
  return getStorage()(
    useShallow((state) => {
      if (!enabled || !state.isDataReady) return emptyArray as Machine[];
      return Object.values(state.machines);
    })
  );
}

const EMPTY_MACHINE_LIST_BY_SERVER_ID: Record<string, Machine[] | null> = {};

function selectVisibleMachines(machines: Machine[] | null): Machine[] | null {
  if (!Array.isArray(machines)) return machines;
  const visibleMachines = machines.filter(isMachineVisibleForSelection);
  return visibleMachines.length === machines.length ? machines : visibleMachines;
}

/**
 * Raw server-scoped inventory for consumers that must retain unavailable
 * tombstones. Launch and session pickers should use `useMachineListByServerId`
 * instead, which intentionally removes revoked records.
 */
export function useMachineRecordListsByServerId(enabled = true): Record<string, Machine[] | null> {
  const machineListByServerId = getStorage()(useShallow((state) => (
    enabled ? state.machineListByServerId : EMPTY_MACHINE_LIST_BY_SERVER_ID
  )));
  return React.useMemo(() => {
    return machineListByServerId && typeof machineListByServerId === 'object'
      ? (machineListByServerId as Record<string, Machine[] | null>)
      : EMPTY_MACHINE_LIST_BY_SERVER_ID;
  }, [machineListByServerId]);
}

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
      const visibleMachines = selectVisibleMachines(machines);
      if (visibleMachines !== machines) {
        hasChanges = true;
        nextByServerId[serverId] = visibleMachines;
        continue;
      }

      nextByServerId[serverId] = machines;
    }

    return hasChanges ? nextByServerId : source;
  }, [machineListByServerId]);
}

/**
 * Visible machine inventory for one Home. This keeps always-mounted consumers
 * off the whole multi-Home map while preserving the list hook's tombstone
 * filtering and source-array identity for unchanged inventory.
 */
export function useMachineListForServer(serverId: string): Machine[] | null {
  const machines = getStorage()((state) => {
    const inventory = state.machineListByServerId ?? EMPTY_MACHINE_LIST_BY_SERVER_ID;
    for (const key of resolveServerScopedMachineInventoryKeys({ serverId, machineListByServerId: inventory })) {
      const list = inventory[key];
      if (list) return list;
    }
    return null;
  });
  return React.useMemo(() => selectVisibleMachines(machines), [machines]);
}

const EMPTY_MACHINE_LIST_STATUS_BY_SERVER_ID: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'> = {};

export function useMachineListStatusByServerId(enabled = true): Record<string, 'idle' | 'loading' | 'signedOut' | 'error'> {
  const machineListStatusByServerId = getStorage()(useShallow((state) => (
    enabled ? state.machineListStatusByServerId : EMPTY_MACHINE_LIST_STATUS_BY_SERVER_ID
  )));
  return React.useMemo(() => {
    return machineListStatusByServerId && typeof machineListStatusByServerId === 'object'
      ? (machineListStatusByServerId as unknown as Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>)
      : {};
  }, [machineListStatusByServerId]);
}

/**
 * Whether this Home's machine list has been read and applied, so a machine absent from it has
 * really left. App data readiness (sessions) can arrive before the machine list does.
 */
export function useIsMachineListSettled(serverId: string | null | undefined): boolean {
  return getStorage()((state) => Boolean(serverId) && Object.entries(state.machineListStatusByServerId ?? {}).some(([inventoryServerId, status]) => (
    status === 'idle' && areServerProfileIdentifiersEquivalent(inventoryServerId, serverId)
    && Array.isArray(state.machineListByServerId?.[inventoryServerId])
  )));
}

export function useIsActiveMachineListSettled(): boolean {
  return useIsMachineListSettled(useActiveServerSnapshot().serverId);
}

export function useMachineListStatusForServer(serverId: string): 'idle' | 'loading' | 'signedOut' | 'error' {
  return getStorage()((state) => {
    const inventory = state.machineListStatusByServerId ?? EMPTY_MACHINE_LIST_STATUS_BY_SERVER_ID;
    for (const key of resolveServerScopedMachineInventoryKeys({ serverId, machineListByServerId: inventory })) {
      const status = inventory[key];
      if (status) return status;
    }
    return 'idle';
  });
}

const EMPTY_MACHINE_POOL_LIST_BY_SERVER_ID: Record<string, MachinePoolViewV1[] | null> = {};

export function useMachinePoolListByServerId(): Record<string, MachinePoolViewV1[] | null> {
  return getStorage()((state) => state.machinePoolListByServerId ?? EMPTY_MACHINE_POOL_LIST_BY_SERVER_ID);
}

export function useMachinePoolListForServer(serverId: string): MachinePoolViewV1[] | null {
  return getStorage()((state) => state.machinePoolListByServerId[serverId] ?? null);
}

export function useMachinePoolListStatusByServerId(): Record<string, 'idle' | 'loading' | 'signedOut' | 'error'> {
  return getStorage()((state) => state.machinePoolListStatusByServerId ?? {});
}

export function useMachinePoolAccountIdByServerId(): Record<string, string> {
  return getStorage()((state) => state.machinePoolAccountIdByServerId ?? {});
}

const noopMachineSubscribe = () => () => {};
const readNullMachine = () => null;

export function useMachine(machineId: string, enabled = true): Machine | null {
  const store = getStorage();
  const getSnapshot = React.useCallback(
    () => store.getState().machines[machineId] ?? null,
    [machineId, store],
  );
  return React.useSyncExternalStore(
    enabled ? store.subscribe : noopMachineSubscribe,
    enabled ? getSnapshot : readNullMachine,
    enabled ? getSnapshot : readNullMachine,
  );
}

export type MachineCliDetectionTarget = Readonly<{
  daemonStateVersion: number;
  isOnline: boolean;
}>;
export type MachineCliDetectionTargets = Readonly<Record<string, MachineCliDetectionTarget>>;

type MachineCliDetectionTargetCacheEntry = Readonly<{
  signature: string;
  target: MachineCliDetectionTarget;
}>;

const machineCliDetectionTargetCache = new Map<string, MachineCliDetectionTargetCacheEntry>();

function getStableMachineCliDetectionTarget(
  machineId: string,
  machine: Machine | null,
  serverId: string | null = null,
): MachineCliDetectionTarget {
  const daemonStateVersion = machine?.daemonStateVersion ?? 0;
  const isOnline = machine ? isMachineOnline(machine) : false;
  const signature = `${daemonStateVersion}:${isOnline ? 'online' : 'offline'}`;
  // The same machine ID can have different facts on independently observed Homes.
  const cacheKey = JSON.stringify([serverId, machineId]);
  const cached = machineCliDetectionTargetCache.get(cacheKey);
  if (cached?.signature === signature) {
    return cached.target;
  }
  const target = { daemonStateVersion, isOnline };
  machineCliDetectionTargetCache.set(cacheKey, { signature, target });
  return target;
}

export function useMachineCliDetectionTarget(
  machineId: string | null,
  serverId?: string | null,
): MachineCliDetectionTarget {
  const normalizedMachineId = String(machineId ?? '').trim();
  const exactServerId = String(serverId ?? '').trim() || null;
  const cacheServerId = exactServerId
    ? resolveServerProfileScopeIdForIdentifier(exactServerId)
    : null;
  return getStorage()((state) => {
    const machine = !normalizedMachineId ? null
      : exactServerId ? resolveServerScopedMachine(state, exactServerId, normalizedMachineId)
        : state.machines[normalizedMachineId] ?? null;
    return getStableMachineCliDetectionTarget(normalizedMachineId, machine, cacheServerId);
  });
}

function normalizeMachineCliDetectionTargetIds(machineIds: readonly string[]): string[] {
  return [...new Set(machineIds.map((machineId) => String(machineId ?? '').trim()).filter(Boolean))].sort();
}

/**
 * Projects currentness for a dynamic set through one store subscription.
 * Each entry reuses the exact-machine target owner above, so plural callers
 * do not duplicate daemon-version or online normalization.
 */
export function useMachineCliDetectionTargets(machineIds: readonly string[]): MachineCliDetectionTargets {
  const normalizedMachineIds = normalizeMachineCliDetectionTargetIds(machineIds);
  const normalizedMachineIdsKey = normalizedMachineIds.join('\u0000');
  const stableMachineIds = React.useMemo(() => normalizedMachineIds, [normalizedMachineIdsKey]);
  const selectTargets = React.useCallback((state: StorageState): MachineCliDetectionTargets => {
    const targets: Record<string, MachineCliDetectionTarget> = {};
    for (const machineId of stableMachineIds) {
      targets[machineId] = getStableMachineCliDetectionTarget(machineId, state.machines[machineId] ?? null);
    }
    return targets;
  }, [stableMachineIds]);
  return getStorage()(useShallow(selectTargets));
}

export function useServerScopedMachine(serverId: string | null | undefined, machineId: string): Machine | null {
  return getStorage()(useShallow((state) => {
    return resolveServerScopedMachine(state, serverId, machineId);
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
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as SessionListRenderableSession[];
      return sortValuesByUpdatedAtDescending(
        readSessionListRowsForServerId(state.sessionListRowsByServerId, activeServerId)
        ?? EMPTY_SESSION_LIST_RENDERABLES_BY_ID,
      );
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

    // Structured tuple, never a delimiter: a Home named `local`, a delimiter-bearing Home id and
    // a row with no Home binding must all stay distinct here (L07-R36).
    const key = JSON.stringify([serverId, session.id]);
    if (params.seenKeys.has(key)) continue;
    params.seenKeys.add(key);
    params.rows.push({ serverId, serverName, session });
  }
}

/**
 * The raw per-Home list observation for every currently known Home. It is the one currentness
 * fact Lane 07 surfaces project through `buildSessionContextFacts`; no consumer re-derives
 * staleness from Session timestamps or its own clock.
 */
export function useSessionListHomeObservations(
  queryStatesByServerId?: Readonly<Record<string, SessionListQueryHomeState | undefined>>,
): SessionListHomeObservationByServerId {
  const cacheByServerId = getStorage()((state) => state.concurrentSessionListCacheByServerId);

  return React.useMemo(() => buildSessionListHomeObservations({
    concurrentSessionListCacheByServerId: cacheByServerId,
    queryStatesByServerId,
  }), [cacheByServerId, queryStatesByServerId]);
}

export function useAllSessionListAttentionRows(): SessionListAttentionRow[] {
  const snapshot = getStorage()(
    useShallow((state) => ({
      isDataReady: state.isDataReady,
      sessionListRowsByServerId: state.sessionListRowsByServerId,
      ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
      concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
    }))
  );

  return React.useMemo(() => {
    const rows: SessionListAttentionRow[] = [];
    const seenKeys = new Set<string>();

    for (const serverIdRaw in snapshot.ordinarySessionListMembershipByServerId ?? {}) {
      const serverId = normalizeOptionalString(serverIdRaw);
      if (!serverId) continue;
      const rowsForServer = snapshot.sessionListRowsByServerId?.[serverIdRaw];
      const membership = snapshot.ordinarySessionListMembershipByServerId?.[serverIdRaw] ?? [];
      const sessions = Object.fromEntries(
        membership.flatMap((sessionId) => {
          const row = rowsForServer?.[sessionId];
          return row ? [[sessionId, row] as const] : [];
        }),
      );
      appendSessionListAttentionRows({
        rows,
        seenKeys,
        serverId,
        serverName: snapshot.concurrentSessionListCacheByServerId?.[serverIdRaw]?.serverName ?? null,
        sessions,
      });
    }

    if (rows.length > 1) {
      rows.sort((left, right) => right.session.updatedAt - left.session.updatedAt);
    }
    return rows;
  }, [
    snapshot.concurrentSessionListCacheByServerId,
    snapshot.ordinarySessionListMembershipByServerId,
    snapshot.sessionListRowsByServerId,
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

export function useProjectForSession(sessionId: string | null, serverId?: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getProjectForSession(sessionId, serverId) : null))
  );
}

/**
 * The workspace root the session targets.
 *
 * The project lookup is resolved purely, not through the store's `getProjectForSession`, which
 * reads *by writing*: it calls `projectManager.addSession`, which re-files the session across
 * several `Map`s. This selector is what zustand runs as its snapshot-equality check, so it
 * re-executes for every mounted consumer on every publish — a transcript mounts one consumer per
 * row wrapper and a streaming session publishes continuously — and the machine-target resolver
 * reaches the lookup twice per resolution, so the writes multiply by rows x publishes x 2. The
 * registration is redundant besides: `applySessions` re-files every session whose project grouping
 * fields moved, so the manager is maintained by its producer rather than by its readers.
 *
 * The result is a plain `string | null`, so `useShallow` would only add a ref and a wrapper — the
 * default `Object.is` snapshot check is already exact for a primitive.
 */
export function useSessionWorkspacePath(sessionId: string | null, serverId?: string | null): string | null {
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  const exactServerId = normalizeTrimmedString(serverId);
  return getStorage()((state) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return null;
    return resolveWorkspaceTargetForSessionFromState({
      sessions: state.sessions,
      sessionListRowsByServerId: state.sessionListRowsByServerId,
      ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
      machines: state.machines,
      sessionListIndexByServerId: state.sessionListIndexByServerId,
      getProjectForSession: createProjectForSessionResolver(state.sessions),
      // A qualified caller names the Home; only an unqualified one may fall back to
      // same-id cache discovery, which cannot separate two Homes hosting one Session id.
    }, exactServerId ? { sessionId: normalizedSessionId, serverId: exactServerId } : normalizedSessionId)?.rootPath ?? null;
  });
}

export function useSessionRpcAvailabilityState(sessionId: string | null, serverId?: string | null): Readonly<{
  sessionExists: boolean;
  sessionRpcAvailable: boolean;
}> {
  return getStorage()(
    useShallow((state) => {
      const normalizedServerId = normalizeTrimmedString(serverId);
      const session = sessionId
        ? normalizedServerId
          ? state.sessionListRowsByServerId[normalizedServerId]?.[sessionId] ?? null
          : state.sessions[sessionId] ?? null
        : null;
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

export function useSessionProjectScmStatus(sessionId: string | null, serverId?: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmStatus(sessionId, serverId) : null))
  );
}

export function useProjectScmSnapshot(projectId: string | null): ScmWorkingSnapshot | null {
  return getStorage()(
    useShallow((state) => (projectId ? state.getProjectScmSnapshot(projectId) : null))
  );
}

/** Whether the session's folder is a repository (null until known); re-renders only when that flips. */
export function useSessionProjectScmIsRepo(sessionId: string | null, serverId?: string | null): boolean | null {
  return getStorage()((state) => {
    if (!sessionId) return null;
    const snapshot = state.getSessionProjectScmSnapshot(sessionId, serverId);
    return snapshot ? snapshot.repo.isRepo === true : null;
  });
}

export function useSessionProjectScmSnapshot(sessionId: string | null, serverId?: string | null): ScmWorkingSnapshot | null {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmSnapshot(sessionId, serverId) : null))
  );
}

/**
 * Registers the mounted SCM surface's exact Session address, so realtime routing and the
 * workspace-mutation side channel can never match the same Session id on another Home.
 */
export function useSessionRealtimeScmTranscriptConsumer(
  address: Readonly<{ serverId?: string | null; sessionId: string | null }>,
  snapshot: ScmWorkingSnapshot | null,
): void {
  const mountedScmConsumerResetVersion = React.useSyncExternalStore(
    subscribeMountedSessionRealtimeScmConsumerScopeResets,
    getMountedSessionRealtimeScmConsumerScopeResetVersion,
    getMountedSessionRealtimeScmConsumerScopeResetVersion,
  );
  const sessionId = address.sessionId;
  const serverId = address.serverId ?? null;

  React.useEffect(() => {
    if (!sessionId) return undefined;
    const scope = snapshot
      ? buildSessionRealtimeScmScopeFromSnapshot(getStorage().getState(), { serverId, sessionId }, snapshot)
        ?? { serverId, sessionId }
      : { serverId, sessionId };
    return registerSessionRealtimeScmConsumerScope(scope);
  }, [mountedScmConsumerResetVersion, serverId, sessionId, snapshot]);
}

export function useSessionProjectScmSnapshotError(
  sessionId: string | null, serverId?: string | null
): import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmSnapshotError(sessionId, serverId) : null))
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

export function useWorkspaceScmTouchedPathsForSession(sessionId: string | null, serverId?: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getWorkspaceScmTouchedPathsForSession(sessionId, serverId) : []))
  );
}

export function useSessionProjectScmCommitSelectionPaths(sessionId: string | null, serverId?: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmCommitSelectionPaths(sessionId, serverId) : []))
  );
}

export function useSessionProjectScmCommitSelectionPatches(sessionId: string | null, serverId?: string | null): ScmCommitSelectionPatch[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmCommitSelectionPatches(sessionId, serverId) : []))
  );
}

export function useSessionProjectScmOperationLog(sessionId: string | null, serverId?: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmOperationLog(sessionId, serverId) : []))
  );
}

export function useSessionProjectScmInFlightOperation(sessionId: string | null, serverId?: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmInFlightOperation(sessionId, serverId) : null))
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

export function useSessionLastMobileSurface(
  sessionId: string | null,
  serverId?: string | null,
): LocalSettings['sessionLastMobileSurfaceBySessionId'][string] | null {
  const activeServer = useActiveServerSnapshot();
  const applyLocalSettings = useApplyLocalSettings();
  const selection = getStorage()(useShallow((state) => {
    if (!sessionId) return null;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return null;
    const persistenceKeys = resolveSessionLastMobileSurfacePersistenceKeysFromState(
      state,
      normalizedSessionId,
      activeServer.serverId,
      serverId,
    );
    const persistedSelection = readSessionLastMobileSurfaceFromMap(
      state.localSettings.sessionLastMobileSurfaceBySessionId,
      persistenceKeys,
    );
    return {
      surface: persistedSelection.surface,
      predecessorSurface: persistedSelection.predecessorSurface,
      currentStorageKey: persistenceKeys?.realmQualifiedStorageKey ?? null,
      predecessorStorageKey: persistenceKeys?.predecessorServerQualifiedStorageKey ?? null,
    };
  }));
  const currentStorageKey = selection?.currentStorageKey ?? null;
  const predecessorStorageKey = selection?.predecessorStorageKey ?? null;
  const predecessorSurface = selection?.predecessorSurface ?? null;

  React.useEffect(() => {
    if (!currentStorageKey || !predecessorStorageKey || !predecessorSurface) return;
    const state = getStorage().getState();
    const persisted = state.localSettings.sessionLastMobileSurfaceBySessionId ?? {};
    const currentPredecessorSurface = persisted[predecessorStorageKey];
    if (typeof currentPredecessorSurface !== 'string') return;

    const next = { ...persisted };
    if (typeof next[currentStorageKey] !== 'string') {
      next[currentStorageKey] = currentPredecessorSurface;
    }
    delete next[predecessorStorageKey];
    applyLocalSettings({ sessionLastMobileSurfaceBySessionId: next });
  }, [applyLocalSettings, currentStorageKey, predecessorStorageKey, predecessorSurface]);

  return selection?.surface ?? null;
}

export function usePersistSessionLastMobileSurface(): (
  sessionId: string,
  surface: LocalSettings['sessionLastMobileSurfaceBySessionId'][string],
  serverId?: string | null,
) => void {
  const applyLocalSettings = useApplyLocalSettings();
  const activeServer = useActiveServerSnapshot();
  return React.useCallback((sessionId, surface, serverId) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    const state = getStorage().getState();
    const persistenceKeys = resolveSessionLastMobileSurfacePersistenceKeysFromState(
      state,
      normalizedSessionId,
      activeServer.serverId,
      serverId,
    );
    if (!persistenceKeys) return;
    const current = state.localSettings.sessionLastMobileSurfaceBySessionId ?? {};
    const currentStorageKey = persistenceKeys.realmQualifiedStorageKey;
    const predecessorStorageKey = persistenceKeys.predecessorServerQualifiedStorageKey;
    if (current[currentStorageKey] === surface && !(predecessorStorageKey in current)) return;
    const next = {
      ...current,
      [currentStorageKey]: surface,
    };
    delete next[predecessorStorageKey];
    applyLocalSettings({
      sessionLastMobileSurfaceBySessionId: next,
    });
  }, [activeServer.serverId, applyLocalSettings]);
}

export type SessionCompanionPreferenceEntry = LocalSettings['sessionCompanionPreferencesBySessionV1'][string];

export type SessionCompanionPreferenceSlot = Readonly<{
  /** `null` when the current Account/Home cannot prove this Session's realm. */
  storageKey: string | null;
  /** The raw stored entry, left unparsed so a newer client's value is never rewritten on read. */
  stored: SessionCompanionPreferenceEntry | undefined;
}>;

/** Hook and admitted Actions borrow the same exact realm-qualified read owner. */
export function readSessionCompanionPreferenceSlotFromState(
  state: Pick<StorageState, 'profileScope' | 'sessions' | 'sessionListIndexByServerId' | 'sessionListRowsByServerId' | 'ordinarySessionListMembershipByServerId' | 'concurrentSessionListCacheByServerId' | 'localSettings'>,
  sessionId: string | null,
  activeServerId: string | null | undefined,
  serverId?: string | null,
): SessionCompanionPreferenceSlot {
  if (!sessionId) return { storageKey: null, stored: undefined };
  const storageKey = resolveSessionCompanionPreferenceStorageKeyFromState(state, sessionId, activeServerId, serverId);
  return { storageKey, stored: storageKey ? state.localSettings.sessionCompanionPreferencesBySessionV1?.[storageKey] : undefined };
}

/**
 * Reads one Session's Companion preference slot. The subscription is one map
 * lookup, so a Companion change in another Session does not rerender this one,
 * and reading never writes a default.
 */
export function useSessionCompanionPreferenceSlot(
  sessionId: string | null,
  serverId?: string | null,
): SessionCompanionPreferenceSlot {
  const activeServer = useActiveServerSnapshot();
  return getStorage()(useShallow((state) => readSessionCompanionPreferenceSlotFromState(state, sessionId, activeServer.serverId, serverId)));
}

/**
 * Applies one exact realm key. The updater receives the latest stored entry read
 * inside the mutation, so a stale hook closure can neither resurrect an old value
 * nor drop another Session's concurrent change. Returning `null` writes nothing.
 *
 * There is no CAS, revision or conflict state: this is one device-local preference.
 */
export function useMutateSessionCompanionPreference(): (
  sessionId: string,
  updater: (stored: SessionCompanionPreferenceEntry | undefined) => SessionCompanionPreferenceEntry | null,
  serverId?: string | null,
) => boolean {
  const applyLocalSettings = useApplyLocalSettings();
  const activeServer = useActiveServerSnapshot();
  return React.useCallback((sessionId, updater, serverId) => {
    const state = getStorage().getState();
    const storageKey = resolveSessionCompanionPreferenceStorageKeyFromState(
      state,
      sessionId,
      activeServer.serverId,
      serverId,
    );
    if (!storageKey) return false;
    const current = state.localSettings.sessionCompanionPreferencesBySessionV1 ?? {};
    const next = updater(current[storageKey]);
    if (next === null) return false;
    applyLocalSettings({
      sessionCompanionPreferencesBySessionV1: {
        ...current,
        [storageKey]: next,
      },
    });
    return true;
  }, [activeServer.serverId, applyLocalSettings]);
}

export function useProjectLastMobileSurface(workspaceRefId: string | null, explicitServerId?: string | null): LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'][string] | null {
  const activeServer = useActiveServerSnapshot();
  return getStorage()(useShallow((state) => {
    if (!workspaceRefId) return null;
    const storageKey = resolveProjectLastMobileSurfaceStorageKeyFromState(
      state,
      workspaceRefId,
      activeServer.serverId,
      explicitServerId,
    );
    return readRealmQualifiedMobileSurface(
      state.localSettings.projectLastMobileSurfaceByWorkspaceRefId,
      storageKey,
    );
  }));
}

export function useProjectLastMobileSurfacesByWorkspaceRefId(): Readonly<Record<string, LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'][string]>> {
  const activeServer = useActiveServerSnapshot();
  return getStorage()(useShallow((state) => (
    selectProjectLastMobileSurfacesByWorkspaceRefId(state, activeServer.serverId)
  )));
}

export function usePersistProjectLastMobileSurface(): (
  workspaceRefId: string,
  surface: LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'][string],
  serverId?: string | null,
) => void {
  const applyLocalSettings = useApplyLocalSettings();
  const activeServer = useActiveServerSnapshot();
  return React.useCallback((workspaceRefId, surface, serverId) => {
    const state = getStorage().getState();
    const storageKey = resolveProjectLastMobileSurfaceStorageKeyFromState(
      state,
      workspaceRefId,
      activeServer.serverId,
      serverId,
    );
    if (!storageKey) return;
    const current = state.localSettings.projectLastMobileSurfaceByWorkspaceRefId ?? {};
    if (current[storageKey] === surface) return;
    applyLocalSettings({
      projectLastMobileSurfaceByWorkspaceRefId: {
        ...current,
        [storageKey]: surface,
      },
    });
  }, [activeServer.serverId, applyLocalSettings]);
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
  const artifacts = getStorage()((state) => state.isDataReady ? state.artifacts : null);
  return React.useMemo(() => artifacts
    ? sortValuesByUpdatedAtDescending(artifacts).filter((artifact) => !artifact.draft)
    : emptyArray as DecryptedArtifact[], [artifacts]);
}

export function useArtifactsLoaded(): boolean {
  return getStorage()((state) => state.isDataReady && state.artifactsLoaded);
}

function collectOpenApprovalSessionReferenceListFromArtifacts(
  artifacts: Readonly<Record<string, DecryptedArtifact>>,
): ReadonlyArray<OpenApprovalSessionReference> {
  const visibleArtifacts: DecryptedArtifact[] = [];
  for (const artifact of Object.values(artifacts)) {
    if (artifact.draft === true) continue;
    visibleArtifacts.push(artifact);
  }
  const references = collectOpenApprovalSessionReferences(visibleArtifacts);
  return references.length === 0 ? emptyOpenApprovalSessionReferences : references;
}

export function useOpenApprovalSessionReferences(): ReadonlyArray<OpenApprovalSessionReference> {
  const selectorRef = React.useRef<((state: StorageState) => ReadonlyArray<OpenApprovalSessionReference>) | null>(null);
  if (!selectorRef.current) {
    let previousIsDataReady: boolean | null = null;
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousReferences: ReadonlyArray<OpenApprovalSessionReference> = emptyOpenApprovalSessionReferences;

    selectorRef.current = (state) => {
      if (state.isDataReady === previousIsDataReady && state.artifacts === previousArtifacts) {
        return previousReferences;
      }

      previousIsDataReady = state.isDataReady;
      previousArtifacts = state.artifacts;
      previousReferences = state.isDataReady
        ? collectOpenApprovalSessionReferenceListFromArtifacts(state.artifacts)
        : emptyOpenApprovalSessionReferences;
      return previousReferences;
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
  target: SessionAddress | null | undefined,
): ReadonlyArray<OpenApprovalArtifactForSession> {
  const targetServerId = target?.serverId ?? null;
  const targetSessionId = target?.sessionId ?? null;
  const normalizedTarget = React.useMemo<SessionAddress | null>(() => {
    return targetServerId && targetSessionId
      ? { serverId: targetServerId, sessionId: targetSessionId }
      : null;
  }, [targetServerId, targetSessionId]);
  const selector = React.useMemo(() => {
    let previousIsDataReady: boolean | null = null;
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousSignature = '';
    let previousApprovals: ReadonlyArray<OpenApprovalArtifactForSession> = emptyOpenApprovalArtifactsForSession;

    return (state: StorageState): ReadonlyArray<OpenApprovalArtifactForSession> => {
      if (!normalizedTarget || !state.isDataReady) {
        previousIsDataReady = state.isDataReady;
        previousArtifacts = state.artifacts;
        previousSignature = '';
        previousApprovals = emptyOpenApprovalArtifactsForSession;
        return previousApprovals;
      }

      if (state.isDataReady === previousIsDataReady && state.artifacts === previousArtifacts) {
        return previousApprovals;
      }

      previousIsDataReady = state.isDataReady;
      previousArtifacts = state.artifacts;
      const nextApprovals = listOpenApprovalArtifactsForSession(
        collectVisibleArtifacts(state.artifacts),
        normalizedTarget,
        {
          knownSessionAddresses: listSessionAddressesForSessionIdFromLocalState(state, normalizedTarget.sessionId),
        },
      );
      const nextSignature = buildOpenApprovalArtifactsForSessionSignature(nextApprovals);
      if (nextSignature === previousSignature) {
        return previousApprovals;
      }

      previousSignature = nextSignature;
      previousApprovals = nextApprovals.length === 0
        ? emptyOpenApprovalArtifactsForSession
        : nextApprovals;
      return previousApprovals;
    };
  }, [normalizedTarget]);

  return getStorage()(useShallow(selector));
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

export function useAutomations(): AutomationDefinition[] {
  // An Account can hold a high-cardinality Automation catalog with no aggregate
  // definition ceiling, and a selector runs on every store mutation. Subscribe
  // to the stable record instead and order it once per actual Automation change
  // (see the note on useSessionMessages).
  const isDataReady = getStorage()((state) => state.isDataReady);
  const automations = getStorage()((state) => state.automations);
  return React.useMemo(
    () => (isDataReady
      ? sortValuesByUpdatedAtDescending(automations).sort((left, right) => (
          right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
        ))
      : emptyArray as AutomationDefinition[]),
    [isDataReady, automations],
  );
}

export function useAutomationDefinitionNextCursor(): string | null {
  return getStorage()((state) => state.automationDefinitionNextCursor);
}

export function useEnabledAutomationsCountForSession(
  sessionId: string | null | undefined,
  options: Readonly<{ enabled?: boolean }> = {},
): number {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const enabled = options.enabled !== false;
  const selector = React.useMemo(() => {
    let previousIsDataReady: boolean | null = null;
    let previousAutomations: StorageState['automations'] | null = null;
    let previousCount = 0;

    return (state: StorageState): number => {
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
      previousCount = countEnabledAutomationDefinitionsLinkedToSession(
        Object.values(state.automations),
        normalizedSessionId,
      );
      return previousCount;
    };
  }, [enabled, normalizedSessionId]);

  return getStorage()(selector);
}

export function useAutomation(automationId: string): AutomationDefinition | null {
  return getStorage()(useShallow((state) => state.automations[automationId] ?? null));
}

/**
 * An Automation's ordered Run window, projected onto the shared Run bodies.
 * The shallow comparison keeps the identity of an unchanged window stable, so
 * a refresh that restates the same revisions does not rerender the history.
 */
export function useAutomationRuns(automationId: string): AutomationDefinitionRun[] {
  return getStorage()(
    useShallow((state) => {
      const runIds = state.automationRunIdsByAutomationId[automationId];
      if (!runIds || runIds.length === 0) return emptyArray as AutomationDefinitionRun[];
      return resolveAutomationRunProjections(state.workflowRunsById, runIds);
    })
  ) as AutomationDefinitionRun[];
}

/**
 * One exact Run by its own identity. This is the reader an exact route, a deep
 * link or a notification uses: it resolves the same body an Automation list
 * shows, and it never needs the Run's origin Automation.
 */
export function useWorkflowRun(runId: string | null | undefined, options: Readonly<{ enabled?: boolean }> = {}): WorkflowRunRow | null {
  const enabled = options.enabled !== false;
  return getStorage()((state) => (enabled && runId ? state.workflowRunsById[runId] ?? null : null));
}

/**
 * An ordered window of Run ids, projected onto the shared bodies.
 *
 * Every Run this Account has read shares one map, so reading the map itself
 * subscribes a surface to every other Run's exact refresh — a Run screen
 * settling a control rerendered the whole collection and every mounted Session
 * section. The shallow comparison narrows that to the rows the window actually
 * names: an unrelated body changes nothing here, while a referenced row's new
 * revision still arrives immediately. Ids with no loaded body are skipped by the
 * same canonical projection the collection already uses.
 */
export function useWorkflowRunRows(runIds: readonly string[]): WorkflowRunRow[] {
  return getStorage()(
    useShallow((state) => (
      runIds.length === 0
        ? (emptyArray as WorkflowRunRow[])
        : resolveWorkflowRunRows(state.workflowRunsById, runIds)
    ))
  ) as WorkflowRunRow[];
}

/**
 * The Automation projection of one exact Run. Automation surfaces keep their
 * existing row contract while resolving the same shared body a workflow route
 * resolves, so the two cannot render divergent copies.
 */
export function useAutomationRunById(runId: string | null | undefined): AutomationDefinitionRun | null {
  return getStorage()((state) => (runId ? state.workflowRunsById[runId]?.automation ?? null : null));
}

export function useAutomationRunNextCursor(automationId: string): string | null {
  return getStorage()((state) => state.automationRunNextCursorByAutomationId[automationId] ?? null);
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

export function useEndpointStatus() {
  return getStorage()((state) => state.endpointStatus);
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

/** Explicit Home readers follow the applied runtime; unscoped Settings retain their Profile scope. */
export function useActiveServerAccountScope(serverId?: string | null) {
  const live = serverId !== undefined;
  const subscribe = React.useCallback((listener: () => void) => {
    const unsubscribeProfile = getStorage().subscribe((state, previous) => {
      if (state.profileScope !== previous.profileScope) listener();
    });
    if (!live) return unsubscribeProfile;
    const unsubscribeApplied = subscribeAppliedActiveServer(listener);
    const unsubscribeAvailability = subscribeAppliedActiveServerRuntimeAvailability(listener);
    return () => {
      unsubscribeProfile();
      unsubscribeApplied();
      unsubscribeAvailability();
    };
  }, [live]);
  const selectScope = useShallow(React.useCallback(() => serverId === undefined
    ? getStorage().getState().profileScope ?? null
    : selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), serverId), [serverId]));
  const read = React.useCallback(() => selectScope(undefined), [selectScope]);
  return React.useSyncExternalStore(subscribe, read, read);
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

const selectFriendRequestCount = createFriendRequestCountSelector();

export function useFriendRequestCount(): number {
  return getStorage()(selectFriendRequestCount);
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
