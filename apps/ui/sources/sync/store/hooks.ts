import { readSessionArchivePending, readSessionArchiveOperationsForServers, projectSessionArchiveRow, projectSessionArchiveRowsByServerId } from '../domains/session/listing/sessionArchiveState';
import { resolveSessionRpcAvailabilityState } from '../domains/session/sessionRpcAvailability';
import React from 'react';
import { retainAutomationRunHistoryDemand } from '../domains/automations/automationReadDemand';
import { readMachineField, type MachineFieldContent } from './machineFieldRead';
import { subscribeMachineField, subscribeMachineFields } from './machineFieldSubscription';
import { useSetting, useLocalSetting } from './settingsReadHooks';
import { projectAtmospherePreviewKey, settingsPreviewScopeMatches, useSettingsPreviewStore } from './settingsPreview';
export {
  useSettings,
  useSettingsSelector,
  useSettingsVersion,
  useSettingsReady,
  useSetting,
  useLocalSettings,
  useLocalSetting,
} from './settingsReadHooks';
import { useAiLaunchProfiles } from './useAiLaunchProfiles';
export { useThemeProfiles, useThemeProfilesSnapshot } from './useThemeProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { sync } from '@/sync/sync';
import type { PeripheralFeed } from '@/sync/engine/viewDemandSync';
import { log } from '@/log';
import type { AuthoringMemory } from './domains/authoringMemory';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readSavedSecretCatalog } from '@/sync/api/account/apiSavedSecretCatalog';
import type { SessionMessagesTailBoundary } from '@/sync/runtime/sessionMessagesTailDiscontinuity';
import { isPendingMessageForRecipient } from '@/sync/domains/pending/pendingMessageRecipient';
import { useShallow } from 'zustand/react/shallow';
import type { ReturnedAnswerEntry } from './sessionReturnedAnswers';
import { EMPTY_SESSION_USER_MESSAGE_HISTORY, EMPTY_USER_MESSAGE_HISTORY, type SessionUserMessageHistory } from './sessionUserMessageHistory';
import { hasExecutionRunSignals } from '../domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { shallow } from 'zustand/shallow';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readSessionListRenderableOwnerMetadataView, readSessionListRenderableSharedMetadata } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import {
  resolveAutomationRunProjections,
  resolveWorkflowRunRows,
  workflowRunStoreKey,
  type WorkflowRunRow,
} from '@/sync/store/domains/workflowRuns';
import { isSessionRetiredForServer, resolveSessionListMachineDisplaysForServer } from '@/sync/store/domains/sessions';
import { buildSessionListIndexWithServerScope } from './sessionListIndex/buildSessionListIndexWithServerScope';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
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
  Machine,
  PendingMessage,
  Session,
} from '../domains/state/storageTypes';
import type { DecryptedArtifact } from '../domains/artifacts/artifactTypes';
import { isArtifactInventoryReady, type ArtifactInventorySelection } from '../domains/artifacts/artifactInventory';
import type { ArtifactInventoryView } from '../domains/artifacts/artifactInventory';
import { listInboxArtifactBodyHydrationRequests } from '../domains/artifacts/inboxArtifacts';
import type { DiscussionApprovalAttentionFact } from '@/activity/attention/buildDiscussionListAttention';
import {
  collectOpenApprovalSessionReferenceFacts,
  listComposerApprovalArtifactsForSession,
  listOpenApprovalArtifactsForSession,
  listApprovalArtifactIdsNeedingHydrationForSession,
  listOpenApprovalInboxArtifactHydrationRequests,
  listDiscussionRequesterApprovals,
  listTranscriptApprovalArtifactsForSession,
  type ApprovalSettledPresentation,
  type DiscussionRequesterApproval,
  type OpenApprovalAttentionArtifactForSession,
  type OpenApprovalArtifactForSession,
  type OpenApprovalSessionReference,
} from '../domains/artifacts/approvalArtifacts';
import { countEnabledAutomationDefinitionsLinkedToSession } from '../domains/automations/automationSessionLink';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import type { ProjectRememberedSelectionId } from '@/components/workspaceCockpit/project/projectCockpitState';
import { sessionLastMobileSurfaceState, projectLastMobileSurfaceState } from '../domains/state/navigationUiState';
import { usePersistentUiStateValue } from '../domains/state/persistentUiState';
import {
    readSessionMobileSurfaceWithPredecessor,
    resolveProjectMobileSurfaceStorageKey,
    resolveSessionMobileSurfacePersistenceKeys,
    type SessionMobileSurfacePersistenceKeys,
} from '../domains/settings/mobileSurfacePersistence';
import type { AgentTextMessage, Message } from "@happier-dev/session-core/messages";
import { messageAttentionImpact } from "@happier-dev/session-core/messages";
import { projectSidechainMessages } from "@happier-dev/session-core/reducer";
import type {
  Settings,
  SettingsWriteDelta,
  WritableSettingsKey,
} from '../domains/settings/settings';
import { projectCurrentSecretBindingsByProfileId, type CurrentSecretBindingsByProfileId } from '../domains/settings/secretBindings';
import {
  areSessionListRenderablesEqual,
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
import { reconcileSubagentSourceMessageProjection, type SubagentSourceMessageProjection } from './subagentSourceMessageProjection';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
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
  useAccountSettingsScope,
  useProfileActionExecute,
  useApplySettings,
} from './settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSessionFromState } from '../domains/session/resolveWorkspaceTargetForSessionFromState';
import { createProjectForSessionResolver } from '../runtime/orchestration/projectForSessionResolver';
import { normalizeSessionId } from '../domains/session/normalizeSessionId';
import { selectHomeQualifiedSession } from '../domains/session/selectHomeQualifiedSession';
export { useProjectAccountRows } from '../domains/workspaces/projectAccountRows';
import { buildSessionMetadataStabilitySignature } from '../domains/session/metadata/sessionMetadataStability';
import { readSessionOwnerMetadataView } from '../domains/session/readSessionOwnerMetadataView';
import { areMachineDisplaySemanticsEqual, buildMachineDisplayRenderableFromMachine } from '../domains/machines/machineDisplayRenderable';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import { normalizeTrimmedString } from '../domains/session/listing/normalizeTrimmedString';
import {
  buildSessionListServerScopedRowKey,
  type NormalizedSessionListKeyParts,
} from '../domains/session/listing/sessionListKeyNormalization';
import {
  buildSessionListRuntimePriorityRowKeys,
  resolveSessionListRuntimePriorityRowNextFreshnessAtMs,
} from '../domains/session/listing/sessionListRuntimePriorityRows';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope, selectActiveServerAccountScopeForServer, type ActiveServerAccountScopeLifetime } from '../domains/scope/activeServerAccountScope';
import {
  subscribeAppliedActiveServer,
  subscribeAppliedActiveServerRuntimeAvailability,
} from '../runtime/orchestration/connectionManager';
import {
  areServerProfileIdentifiersEquivalent,
  captureServerProfileScopeResolver,
  getServerProfileById,
  getServerProfilesGeneration,
  resolveServerProfileScopeIdForIdentifier,
  subscribeServerProfiles,
} from '../domains/server/serverProfiles';
import { resolveServerScopedMachineInventory, resolveServerScopedMachineInventoryKeys } from '../domains/machines/resolveServerScopedMachines';
import {
  readSessionListRowForServerId,
  readSessionListRowsForServerId,
  resolveSessionListHomeKey,
} from '../domains/session/listing/sessionListRowStateLookup';
import { buildSessionFolderAssignmentKey } from '../domains/session/folders';
import {
  buildSessionOrganizationProjection,
  buildSessionOrganizationProjections,
  type SessionOrganizationProjection,
} from '../domains/session/organization';
import type { MachinePresenceCounts } from '@/utils/sessions/machineUtils';
import { getSettledMachineDisplayName, isMachineDisplayHydrating, readDisplayedMachineName } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceSummary, useMachinePresenceSummaries, useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import {
  buildSessionRealtimeScmScopeFromSnapshot,
  getMountedSessionRealtimeScmConsumerScopeResetVersion,
  registerSessionRealtimeScmConsumerScope,
  subscribeMountedSessionRealtimeScmConsumerScopeResets,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { registerSessionTranscriptDerivedCacheClear } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { isLiveSessionRuntime, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '../domains/session/attention/runtimePresentation';
import {
  sortTranscriptMessagesOldestFirst,
} from "@happier-dev/session-core/messages";

import { getStorage } from '../domains/state/storageStore';
import { resolveSessionActionDefaultBackend } from '../domains/session/resolveSessionActionDefaultBackend';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
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
import { areMachineLaunchInputsEqual } from './domains/areStoredMachinesEqual';
import { machineInventoryPresentation } from './machineInventoryPresentation';
import { linkMachineActivity } from '@/sync/domains/machines/machineActivity';
import { isMachineVisibleForSelection, isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import type { SessionsDomainSlice, StorageState } from './types';
import { retainDeep } from '../domains/state/structuralSharing';
import { createFriendRequestCountSelector } from './friendRequestCount';
import {
  readProjectWorkspaceRefs,
  readProjectAtmosphere,
  readCurrentProjectAccountRows,
  EMPTY_PINNED_WORKSPACE_REF_IDS,
  EMPTY_WORKSPACE_RELATIONSHIPS,
  EMPTY_PROJECT_ORGANIZATIONS,
} from './domains/projectAccountRows';

export function useWorkspaceRefs() {
  return getStorage()(readProjectWorkspaceRefs);
}

export function useProjectOrganizations() {
  return getStorage()((state) => readCurrentProjectAccountRows(state)?.organizations ?? EMPTY_PROJECT_ORGANIZATIONS);
}

export function useProjectAtmosphere(project?: Readonly<{ serverId: string; projectKey: string }>) {
  const scope = getStorage()(state => state.settingsScope);
  const key = project ? projectAtmospherePreviewKey(project) : null;
  const preview = useSettingsPreviewStore(state => key && settingsPreviewScopeMatches(scope, state.scope) ? state.projects[key]?.value : undefined);
  const value = getStorage()(state => project ? readProjectAtmosphere(state, project) : undefined);
  return preview ?? value;
}

export function useWorkspaceSyncRelationships() {
  return getStorage()((state) => readCurrentProjectAccountRows(state)?.relationships ?? EMPTY_WORKSPACE_RELATIONSHIPS);
}

export function usePinnedWorkspaceRefIds() {
  return getStorage()((state) => readCurrentProjectAccountRows(state) ? state.pinnedWorkspaceRefIds : EMPTY_PINNED_WORKSPACE_REF_IDS);
}

/** One workspace ref's pin bit: a boolean selection, so only the row whose pin state changed re-renders. */
export function useIsWorkspaceRefPinned(workspaceRefId: string | undefined): boolean {
  return getStorage()((state) => workspaceRefId !== undefined && readCurrentProjectAccountRows(state) !== null
    && state.pinnedWorkspaceRefIds.includes(workspaceRefId));
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
  return getStorage()((state) => select(selectHomeQualifiedSession(state, normalizedSessionId, serverId, activeServerId)),
    { sessions: normalizedSessionId ? [normalizedSessionId] : [] });
}

/**
 * The exact Session fields used to derive a displayed title and its readability. Current UI context
 * needs this projection, not turn-lifecycle facts such as `thinking` or
 * `agentState`, so it remains stable for updates that cannot change its output.
 */
export type SessionDisplayNameSource = Readonly<Pick<
  Session,
  'id' | 'serverId' | 'archivedAt' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'encryptionMode' | 'encryptedContentAvailability'
  | 'lockedDisplayTitle' | 'access' | 'accessLevel'
> & { metadata: Session['metadata'] | SessionListRenderableSession['metadata'] }>;

export function useSessionDisplayNameSource(sessionId: string, serverId?: string | null): SessionDisplayNameSource | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedServerId = normalizeTrimmedString(serverId);
  return getStorage()(
    useShallow((state) => selectSessionDisplayNameSource(state, normalizedSessionId, normalizedServerId)),
  );
}

/**
 * The display-name projection of one Home-qualified session: its canonical sidebar row when held,
 * otherwise the hydrated record for that Home. The row already composes opened owner metadata and
 * transcript-derived titles; a still-loading live shell must not replace it with an encrypted label.
 */
export function selectSessionDisplayNameSource(
  state: StorageState,
  sessionId: string,
  serverId?: string | null,
): SessionDisplayNameSource | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedServerId = normalizeTrimmedString(serverId);
  const directSession = state.sessions[normalizedSessionId];
  const session = findSessionListLookupSession(state, normalizedServerId
    ? { serverId: normalizedServerId, sessionId: normalizedSessionId } : normalizedSessionId)?.session
    ?? (!normalizedServerId || areServerProfileIdentifiersEquivalent(directSession?.serverId, normalizedServerId)
      ? directSession : undefined);
  if (!session) return null;
  return {
    id: session.id,
    archivedAt: session.archivedAt,
    serverId: normalizedServerId || directSession?.serverId,
    encryptionMode: session.encryptionMode,
    encryptedContentAvailability: session.encryptedContentAvailability,
    lockedDisplayTitle: session.lockedDisplayTitle,
    access: session.access,
    accessLevel: session.accessLevel,
    metadata: session === directSession ? session.metadata : readSessionListRenderableSharedMetadata(session),
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

type SessionForkSupportSourceCacheEntry = Readonly<{
  signature: string;
  value: SessionForkSupportSource;
}>;

export function useSessionForkSupportSource(
  sessionId: string | null,
  serverId?: string | null,
): SessionForkSupportSource | null {
  // Previous metadata is useful only to this mounted target. An address-keyed
  // process cache outlived both deleted Sessions and retired Homes.
  const cache = React.useMemo(() => ({ current: null as SessionForkSupportSourceCacheEntry | null }),
    [sessionId, serverId]);
  return getStorage()(
    useShallow((state) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const normalizedServerId = normalizeTrimmedString(serverId);
      if (!normalizedSessionId) {
        cache.current = null;
        return null;
      }
      const directSession = state.sessions[normalizedSessionId] ?? null;
      const session = normalizedServerId
        ? directSession && areServerProfileIdentifiersEquivalent(directSession.serverId, normalizedServerId)
          ? directSession
          : findSessionListLookupSession(state, {
              serverId: normalizedServerId,
              sessionId: normalizedSessionId,
            })?.session ?? null
        : directSession;
      if (!session) {
        cache.current = null;
        return null;
      }

      const ownerMetadataView = 'ownerMetadataView' in session
        ? readSessionOwnerMetadataView(session)
        : null;
      const resolvedServerId = normalizedServerId || directSession?.serverId || null;
      const signature = [
        resolvedServerId ?? '',
        'metadataLayoutVersion' in session
          ? readSessionMetadataLayoutVersion(session.metadataLayoutVersion)
          : 0,
        buildSessionMetadataStabilitySignature(ownerMetadataView ?? session.metadata),
      ].join('\u0000');
      const cached = cache.current;
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
      cache.current = { signature, value };
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
 * The Session's own Agent target key, as a primitive (see {@link useSessionMachineId}). Owned by
 * `resolveSessionActionDefaultBackend`, the identity fork/replay/Run already use.
 */
export function useSessionAgentTargetKey(sessionId: string): string | null {
  return getStorage()((state) => {
    const session = state.sessions[sessionId];
    const resolved = session ? resolveSessionActionDefaultBackend({ session }) : null;
    const target = resolved?.agentTarget ?? resolved?.backendTarget ?? null;
    return target ? buildBackendTargetKeyV2(target) : null;
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
type SessionListRowRenderableProjection = Readonly<{
  source: SessionListRenderableSession;
  projected: SessionListRenderableSession;
}>;

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
  /** The projections of `previous` and `next`: the row compares what it renders, not the dropped clocks. */
  previousProjected: SessionListRenderableSession;
  nextProjected: SessionListRenderableSession;
  nowMs: number;
}>): boolean {
  const { previous, next, nowMs } = input;
  if (previous === next) return false;
  // A turn re-versions the Session's documents without changing what the row shows; those versions and
  // clocks are zeroed in the projection, so equal projections are not a change.
  if (areSessionListRenderablesEqual(input.previousProjected, input.nextProjected)) return true;
  if (!isSessionListRenderableWarmCacheProgressOnlyChange(input.previousProjected, input.nextProjected)) return false;
  if (!canReuseActiveHeartbeatAdvance({ previous, next, nowMs })) return false;

  const previousTimestamp = resolveProgressTimestamp(previous);
  const nextTimestamp = resolveProgressTimestamp(next);
  if (previousTimestamp === null || nextTimestamp === null) return false;
  if (nextTimestamp <= previousTimestamp) return false;
  if (nextTimestamp - previousTimestamp >= ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS) return false;

  return hasSameRelativeProgressLabels(previous, next, nowMs);
}

function buildProjectedSessionListRowRenderable(renderable: SessionListRenderableSession): SessionListRenderableSession {
  const isActiveStreaming = isLiveSessionRuntime(renderable) && renderable.thinking === true;
  return {
    ...renderable,
    updatedAt: isActiveStreaming ? 0 : renderable.updatedAt,
    thinkingAt: 0,
    pendingVersion: undefined,
    metadataVersion: 0,
    agentStateVersion: 0,
  };
}

function createSessionListRowRenderableProjector() {
  // Progress reuse belongs to a mounted address, not a process-lifetime row
  // inventory. The weak raw-row cache still shares projections across readers.
  let previousProjection: SessionListRowRenderableProjection | null = null;
  return (renderable: SessionListRenderableSession | null | undefined): SessionListRenderableSession | null => {
    if (!renderable) {
      previousProjection = null;
      return null;
    }
    const cached = sessionListRowRenderableProjectionCache.get(renderable);
    if (cached) {
      previousProjection = { source: renderable, projected: cached };
      return cached;
    }

    const projected = buildProjectedSessionListRowRenderable(renderable);
    if (previousProjection && shouldReusePreviousProgressProjection({
      previous: previousProjection.source,
      next: renderable,
      previousProjected: previousProjection.projected,
      nextProjected: projected,
      nowMs: Date.now(),
    })) {
      sessionListRowRenderableProjectionCache.set(renderable, previousProjection.projected);
      // Keep the source this projection was taken from: progress timing compares against it.
      return previousProjection.projected;
    }

    sessionListRowRenderableProjectionCache.set(renderable, projected);
    previousProjection = { source: renderable, projected };
    return projected;
  };
}

export function useSessionListRenderableWithServerScope(
  serverId: string | null | undefined,
  sessionId: string,
): SessionListRenderableSession | null {
  // Correspondence belongs to the existing profile publication lifecycle,
  // not to unrelated row-store notifications. A real profile publication
  // replaces these selectors with a fresh captured resolver.
  useServerProfilesGeneration();
  const resolveScopeId = captureServerProfileScopeResolver();
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedServerId = normalizeTrimmedString(serverId);
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  const effectiveServerId = normalizedServerId || activeServerId;
  const projectionScopeKey = React.useMemo(() => {
    if (!normalizedSessionId) return null;
    return effectiveServerId
      ? sessionAddressKey({ serverId: effectiveServerId, sessionId: normalizedSessionId })
      : JSON.stringify(['legacy_unscoped_session', normalizedSessionId]);
  }, [effectiveServerId, normalizedSessionId]);
  const projectSessionListRowRenderable = React.useMemo(createSessionListRowRenderableProjector, [projectionScopeKey]);

  const row = getStorage()(useShallow((state) => {
    if (!normalizedSessionId) {
      return projectSessionListRowRenderable(null);
    }

    if (normalizedServerId) {
      const scoped = readSessionListRowsForServerId(state.sessionListRowsByServerId, normalizedServerId, resolveScopeId);
      if (scoped && typeof scoped === 'object') {
        return projectSessionListRowRenderable(
          scoped[normalizedSessionId],
        );
      }

      return projectSessionListRowRenderable(null);
    }

    return projectSessionListRowRenderable(
      readSessionListRowForServerId(state.sessionListRowsByServerId, activeServerId, normalizedSessionId, resolveScopeId),
    );
  }));
  const targetServerId = normalizedServerId ?? activeServerId;
  const pending = getStorage()(state => Boolean(targetServerId && normalizedSessionId
    && readSessionArchivePending(state, { serverId: targetServerId, sessionId: normalizedSessionId }, resolveScopeId)));
  return projectSessionArchiveRow(row, pending);
}

/** One fact of a Home-qualified list row; a reader subscribes to that fact, not to the whole row. */
export function useSessionListRowSelector<T>(
  serverId: string | null | undefined,
  sessionId: string,
  select: (row: SessionListRenderableSession | null) => T,
): T {
  useServerProfilesGeneration();
  const resolveScopeId = captureServerProfileScopeResolver();
  return getStorage()((state) => select(
    readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, sessionId, resolveScopeId),
  ));
}

const EMPTY_SESSION_LIST_RENDERABLES_BY_ID: Record<string, SessionListRenderableSession> = {};

export function useSessionListRenderablesById(): Record<string, SessionListRenderableSession> {
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  const rows = useSessionListRowsByServerId(activeServerId ? [activeServerId] : []);
  return activeServerId ? rows[activeServerId] ?? EMPTY_SESSION_LIST_RENDERABLES_BY_ID : EMPTY_SESSION_LIST_RENDERABLES_BY_ID;
}

export type SessionListAttentionRow = Readonly<{
  serverId: string | null;
  serverName: string | null;
  session: SessionListRenderableSession;
}>;

const EMPTY_SESSION_LIST_ROWS_BY_SERVER_ID: SessionsDomainSlice['sessionListRowsByServerId'] = Object.freeze({});

/**
 * The Session ids whose rows can differ from `previousRows`, taken from the store's row delta.
 * `null` means unknown (first read, a revision gap, an archive overlay change): read every row.
 */
export type SessionListRowChanges = Readonly<{
  previousRows: SessionsDomainSlice['sessionListRowsByServerId'];
  sessionIds: ReadonlySet<string>;
}>;

/**
 * Session rows, keyed by Home. Pass `serverIds` to subscribe to those Homes only: a row write on any
 * other Home then re-renders nothing, and an empty selection (a disabled consumer) never re-renders.
 * Without it the consumer follows every Home's rows. `select` also receives the row changes since its
 * previous call, so a projection can re-read only those rows.
 */
export function useSessionListRowsByServerId<T>(
  serverIds: ReadonlyArray<string> | undefined,
  select: (rows: SessionsDomainSlice['sessionListRowsByServerId'], changes: SessionListRowChanges | null) => T,
): T;
export function useSessionListRowsByServerId(
  serverIds?: ReadonlyArray<string>,
): SessionsDomainSlice['sessionListRowsByServerId'];
export function useSessionListRowsByServerId<T>(
  serverIds?: ReadonlyArray<string>,
  select?: (rows: SessionsDomainSlice['sessionListRowsByServerId'], changes: SessionListRowChanges | null) => T,
) {
  const serverProfilesGeneration = useServerProfilesGeneration();
  const serverIdsKey = serverIds ? serverIds.join('\u0001') : null;
  const selectedServerIds = React.useMemo(
    () => (serverIds
      ? [...new Set(serverIds.map((serverId) => normalizeTrimmedString(serverId)).filter((serverId): serverId is string => Boolean(serverId)))]
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the selection's identity
    [serverIdsKey],
  );
  const selector = React.useMemo(() => {
    const resolveScopeId = captureServerProfileScopeResolver();
    let previous: Readonly<{ rows: SessionsDomainSlice['sessionListRowsByServerId']; value: T | SessionsDomainSlice['sessionListRowsByServerId'] }> | undefined;
    // The row delta revision at which `previous.rows` was still current, and the archive overlay it saw.
    let previousRevision: number | null = null;
    let previousArchiveOperations: StorageState['sessionArchiveOperations'];
    return (state: StorageState) => {
      const revision = state.sessionListRenderableDelta?.revision ?? null;
      let rows = selectedServerIds?.length === 0 ? EMPTY_SESSION_LIST_ROWS_BY_SERVER_ID : state.sessionListRowsByServerId;
      if (selectedServerIds?.length) {
        const selected: Record<string, SessionsDomainSlice['sessionListRowsByServerId'][string]> = {};
        for (const serverId of selectedServerIds) {
          const bucket = readSessionListRowsForServerId(rows, serverId, resolveScopeId);
          if (bucket) selected[serverId] = bucket;
        }
        rows = selected;
      }
      const projected = projectSessionArchiveRowsByServerId(rows,
        readSessionArchiveOperationsForServers(state, selectedServerIds, resolveScopeId));
      // A caller may allocate nested results. Produce that snapshot only when its admitted row buckets change.
      const archiveOperations = state.sessionArchiveOperations;
      if (previous && shallow(previous.rows, projected)) {
        previousRevision = revision;
        previousArchiveOperations = archiveOperations;
        return previous.value;
      }
      // Exactly the next revision with the same archive overlay: its row lists name every changed row.
      const delta = state.sessionListRenderableDelta;
      const changes = previous && delta && previousRevision !== null && delta.revision === previousRevision + 1
        && archiveOperations === previousArchiveOperations
        ? { previousRows: previous.rows, sessionIds: new Set([...delta.changedSessionIds, ...delta.removedSessionIds]) }
        : null;
      const value = select ? select(projected, changes) : projected;
      previous = { rows: projected, value };
      previousRevision = revision;
      previousArchiveOperations = archiveOperations;
      return value;
    };
  }, [selectedServerIds, select, serverProfilesGeneration]);
  return getStorage()(useShallow(selector));
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

type SessionListReachabilityMetadata = Pick<NonNullable<SessionListRenderableSession['metadata']>,
  'machineId' | 'host' | 'homeDir' | 'path' | 'sessionDirectoryV1' | 'externalSessionV1'>;
export type SessionListReachabilityRenderable = Readonly<{
  id: string;
  metadata: SessionListReachabilityMetadata | null;
}>;

const SESSION_LIST_REACHABILITY_METADATA_FIELDS = [
  'machineId', 'host', 'homeDir', 'path', 'sessionDirectoryV1', 'externalSessionV1',
] as const satisfies readonly (keyof SessionListReachabilityMetadata)[];

type SessionListReachabilityItemKey = Readonly<{
  key: string;
  serverId: string;
  sessionId: string;
}>;

const emptySessionListReachabilityRenderablesByKey =
  new Map<string, SessionListReachabilityRenderable>() as ReadonlyMap<string, SessionListReachabilityRenderable>;

export function buildSessionListReachabilityRenderableKey(
  serverId: string | null | undefined,
  sessionId: string | null | undefined,
  keyParts?: NormalizedSessionListKeyParts,
): string | null {
  return buildSessionListServerScopedRowKey(serverId, sessionId, keyParts);
}

function projectSessionListReachabilityRenderable(
  renderable: SessionListRenderableSession,
  cached: SessionListReachabilityRenderable | undefined,
): SessionListReachabilityRenderable {
  if (cached?.id === renderable.id && (cached.metadata === renderable.metadata
    || (Boolean(cached.metadata) === Boolean(renderable.metadata)
      && SESSION_LIST_REACHABILITY_METADATA_FIELDS.every(field =>
        Object.is(cached.metadata?.[field], renderable.metadata?.[field]))))) {
    return cached;
  }

  const value: SessionListReachabilityRenderable = {
    id: renderable.id,
    metadata: renderable.metadata ? {
      machineId: renderable.metadata.machineId,
      host: renderable.metadata.host,
      homeDir: renderable.metadata.homeDir,
      path: renderable.metadata.path,
      sessionDirectoryV1: renderable.metadata.sessionDirectoryV1,
      externalSessionV1: renderable.metadata.externalSessionV1,
    } : null,
  };
  return value;
}

export function useSessionListReachabilityRenderablesForItems(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
): ReadonlyMap<string, SessionListReachabilityRenderable> {
  const profileGeneration = useServerProfilesGeneration();
  const resolveScopeId = React.useMemo(() => captureServerProfileScopeResolver(), [profileGeneration]);
  const itemKeys = React.useMemo(() => {
    if (!items || items.length === 0) return emptyArray as SessionListReachabilityItemKey[];
    const next: SessionListReachabilityItemKey[] = [];
    for (const item of items) {
      if (!item || item.type !== 'session') continue;
      const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId, item.keyParts);
      if (!key) continue;
      next.push({
        key,
        serverId: normalizeTrimmedString(item.serverId)!,
        sessionId: normalizeSessionId(item.sessionId)!,
      });
    }
    return next.length === 0 ? (emptyArray as SessionListReachabilityItemKey[]) : next;
  }, [items]);

  const previousMap = React.useRef(emptySessionListReachabilityRenderablesByKey);
  const selector = React.useMemo(() => {
    let previousRows: StorageState['sessionListRowsByServerId'] | undefined;
    return (state: StorageState) => {
      const previous = previousMap.current;
      // Machine/profile-independent notifications do not change this input owner.
      if (previousRows === state.sessionListRowsByServerId) return previous;
      previousRows = state.sessionListRowsByServerId;
      const next = new Map<string, SessionListReachabilityRenderable>();
      for (const itemKey of itemKeys) {
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId,
          itemKey.serverId, itemKey.sessionId, resolveScopeId);
        if (row) next.set(itemKey.key, projectSessionListReachabilityRenderable(row, previous.get(itemKey.key)));
      }
      if (next.size !== previous.size || [...next].some(([key, row]) => previous.get(key) !== row)) {
        previousMap.current = next.size === 0 ? emptySessionListReachabilityRenderablesByKey : next;
      }
      return previousMap.current;
    };
  }, [itemKeys, resolveScopeId]);
  return getStorage()(selector);
}

const emptySessionListRowRenderablesByKey =
  new Map<string, SessionListRenderableSession>() as ReadonlyMap<string, SessionListRenderableSession>;

export function useSessionListRowRenderablesForItems(
  items: ReadonlyArray<SessionListIndexItem> | null | undefined,
): ReadonlyMap<string, SessionListRenderableSession> {
  useServerProfilesGeneration();
  const resolveScopeId = captureServerProfileScopeResolver();
  const itemKeys = React.useMemo(() => {
    if (!items || items.length === 0) return emptyArray as SessionListReachabilityItemKey[];
    const next: SessionListReachabilityItemKey[] = [];
    for (const item of items) {
      if (!item || item.type !== 'session') continue;
      const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId, item.keyParts);
      if (!key) continue;
      next.push({
        key,
        serverId: normalizeTrimmedString(item.serverId)!,
        sessionId: normalizeSessionId(item.sessionId)!,
      });
    }
    return next.length === 0 ? (emptyArray as SessionListReachabilityItemKey[]) : next;
  }, [items]);

  const previousProjectors = React.useRef(new Map<string, ReturnType<typeof createSessionListRowRenderableProjector>>());
  const projectors = React.useMemo(() => {
    // Keep progress history only for this mounted reader's current addresses.
    // Removing an item drops its projector; missing rows clear it on selection.
    const next = new Map<string, ReturnType<typeof createSessionListRowRenderableProjector>>();
    for (const item of itemKeys) {
      next.set(item.key, previousProjectors.current.get(item.key) ?? createSessionListRowRenderableProjector());
    }
    previousProjectors.current = next;
    return next;
  }, [itemKeys]);

  return getStorage()(useShallow((state) => {
    if (itemKeys.length === 0) return emptySessionListRowRenderablesByKey;
    const next = new Map<string, SessionListRenderableSession>();
    for (const itemKey of itemKeys) {
      const row = readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        itemKey.serverId,
        itemKey.sessionId,
        resolveScopeId,
      );
      const projected = projectSessionArchiveRow(projectors.get(itemKey.key)!(row),
        readSessionArchivePending(state, { serverId: itemKey.serverId, sessionId: itemKey.sessionId }, resolveScopeId));
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

export function useSessionListIndexByServerId(
  serverIds?: ReadonlyArray<string>,
): Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> {
  const hasExplicitServerSelection = Array.isArray(serverIds);
  const serverIdsKey = hasExplicitServerSelection ? serverIds.join('\u0001') : null;
  const selectedServerIds = React.useMemo(
    () => hasExplicitServerSelection ? normalizeSelectedSessionListServerIds(serverIds) : [],
    [hasExplicitServerSelection, serverIds, serverIdsKey],
  );

  const source = getStorage()(useShallow((state) => {
    const indexByServerId = state.sessionListIndexByServerId ?? EMPTY_SESSION_LIST_INDEX_BY_SERVER_ID;
    if (!hasExplicitServerSelection) return indexByServerId;
    if (selectedServerIds.length === 0) return EMPTY_SESSION_LIST_INDEX_BY_SERVER_ID;
    const resolveScopeId = captureServerProfileScopeResolver();
    const selected: Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined> = {};
    for (const serverId of selectedServerIds) {
      const resolvedServerId = resolveSessionListHomeKey(indexByServerId, serverId, resolveScopeId);
      if (!resolvedServerId) continue;
      selected[resolvedServerId] = indexByServerId[resolvedServerId] ?? null;
    }
    return Object.keys(selected).length > 0 ? selected : EMPTY_SESSION_LIST_INDEX_BY_SERVER_ID;
  }));
  const retained = getStorage()(useShallow(state => {
    const resolveScopeId = captureServerProfileScopeResolver();
    return readSessionArchiveOperationsForServers(
      state, hasExplicitServerSelection ? selectedServerIds : null, resolveScopeId,
    ).filter(operation => {
      const key = resolveSessionListHomeKey(source, operation.serverId, resolveScopeId);
      return !key || !source[key]?.some(item => item.type === 'session' && item.sessionId === operation.sessionId);
    });
  }));
  const retainedRows = getStorage()(useShallow(state => {
    const resolveScopeId = captureServerProfileScopeResolver();
    return retained.map(operation => readSessionListRowForServerId(
      state.sessionListRowsByServerId, operation.serverId, operation.sessionId, resolveScopeId));
  }));
  const retainedMachines = getStorage()(useShallow(state => {
    const resolveScopeId = captureServerProfileScopeResolver();
    return retained.map(operation => {
      const key = resolveSessionListHomeKey(state.machineListByServerId, operation.serverId, resolveScopeId) ?? operation.serverId;
      return state.machineListByServerId[key] ?? state.machineDisplayById;
    });
  }));
  const layoutV1 = useSetting('sessionListLayoutV1');
  return React.useMemo(() => {
    if (retained.length === 0) return source;
    const resolveScopeId = captureServerProfileScopeResolver();
    const state = getStorage().getState();
    const retainedByServerId = new Map<string, SessionListRenderableSession[]>();
    for (let index = 0; index < retained.length; index += 1) {
      const operation = retained[index];
      const retainedRow = retainedRows[index];
      if (!retainedRow) continue;
      const serverId = resolveSessionListHomeKey(source, operation.serverId, resolveScopeId)
        ?? resolveScopeId(operation.serverId);
      const previousIndex = source[serverId] ?? [];
      if (previousIndex.some(item => item.type === 'session' && item.sessionId === operation.sessionId)) continue;
      const rows = retainedByServerId.get(serverId) ?? [];
      rows.push(retainedRow);
      retainedByServerId.set(serverId, rows);
    }
    if (retainedByServerId.size === 0) return source;
    const result = { ...source };
    for (const [serverId, rows] of retainedByServerId) {
      const previousIndex = source[serverId] ?? [];
      const candidates: Record<string, SessionListRenderableSession> = {};
      for (const item of previousIndex) {
        if (item.type !== 'session') continue;
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, item.sessionId, resolveScopeId);
        if (row) candidates[item.sessionId] = row;
      }
      for (const row of rows) candidates[row.id] = projectSessionArchiveRow(row, true)!;
      const machineKey = resolveSessionListHomeKey(state.machineListByServerId, serverId, resolveScopeId) ?? serverId;
      result[serverId] = buildSessionListIndexWithServerScope({
        sessions: candidates,
        machines: resolveSessionListMachineDisplaysForServer(state, machineKey),
        layoutV1, previousIndex,
        serverScope: { serverId, serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId) },
      });
    }
    return result;
    // Raw index changes own ordinary structural invalidation. Retained rows and
    // Home machine inputs add only the missing pending candidates above.
  }, [source, retained, retainedRows, retainedMachines, layoutV1]);
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

type SessionOrganizationProjectionCache = {
  inputs: WeakMap<object, SessionOrganizationProjectionCache>;
  projections?: Map<string, SessionOrganizationProjection>;
};

// The tuple of admitted input identities owns shared projection reuse. Every
// edge is weak: a different Home's projection cannot root obsolete full maps
// after Session organization changes or Account/Home retirement.
const sessionOrganizationProjectionCache: SessionOrganizationProjectionCache = { inputs: new WeakMap() };

export function readSessionOrganizationProjectionCached(
  state: StorageState,
  serverId: string,
): SessionOrganizationProjection {
  let cache = sessionOrganizationProjectionCache;
  for (const input of [
    state.sessionOrganizationSchemaVersionByServerId,
    state.sessionOrganizationSnapshotVersionByServerId,
    state.sessionOrganizationFolderAssignmentsCompleteByServerId,
    state.sessionOrganizationPinsBySessionKey,
    state.sessionOrganizationFoldersByFolderKey,
    state.sessionOrganizationFolderAssignmentsBySessionKey,
    state.sessionOrganizationTagsByTagKey,
    state.sessionOrganizationTagAssignmentsBySessionKey,
    state.sessionOrganizationAttentionStandingsBySessionKey,
    state.sessionOrganizationAppearancesBySessionKey,
    state.sessionOrganizationSessionAppearancesSupportedByServerId,
    state.sessionOrganizationOrderEntriesByScopeKey,
    state.sessionOrganizationLabelsByLabelKey,
  ]) {
    let next = cache.inputs.get(input);
    if (!next) {
      next = { inputs: new WeakMap() };
      cache.inputs.set(input, next);
    }
    cache = next;
  }
  const cached = cache.projections?.get(serverId);
  if (cached) return cached;

  const value = buildSessionOrganizationProjection({
    schemaVersionByServerId: state.sessionOrganizationSchemaVersionByServerId,
    snapshotVersionByServerId: state.sessionOrganizationSnapshotVersionByServerId,
    folderAssignmentsCompleteByServerId: state.sessionOrganizationFolderAssignmentsCompleteByServerId,
    pinsBySessionKey: state.sessionOrganizationPinsBySessionKey,
    foldersByFolderKey: state.sessionOrganizationFoldersByFolderKey,
    folderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
    tagsByTagKey: state.sessionOrganizationTagsByTagKey,
    tagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey,
    attentionStandingsBySessionKey: state.sessionOrganizationAttentionStandingsBySessionKey,
    appearancesBySessionKey: state.sessionOrganizationAppearancesBySessionKey,
    sessionAppearancesSupportedByServerId: state.sessionOrganizationSessionAppearancesSupportedByServerId,
    orderEntriesByScopeKey: state.sessionOrganizationOrderEntriesByScopeKey,
    labelsByLabelKey: state.sessionOrganizationLabelsByLabelKey,
  }, serverId);
  cache.projections ??= new Map();
  cache.projections.set(serverId, value);
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

export function useMachineDisplayById<T>(select: (machines: Record<string, MachineDisplayRenderable>) => T): T;
export function useMachineDisplayById(): Record<string, MachineDisplayRenderable>;
export function useMachineDisplayById<T>(select?: (machines: Record<string, MachineDisplayRenderable>) => T) {
  return getStorage()(useShallow((state) => {
    const machines = state.machineDisplayById ?? EMPTY_MACHINE_DISPLAY_BY_ID;
    return select ? select(machines) : machines;
  }));
}

/**
 * Home-scoped display inventory: daemon content and heartbeat clocks have their own subscribers. `machineIds` keeps
 * only those Machines (one Machine's page), so the rest of the fleet changing publishes nothing to it.
 */
export function useMachineDisplaysByServerId(serverIds: readonly string[], options?: Readonly<{ machineIds?: readonly string[] }>): Readonly<Record<string, Record<string, MachineDisplayRenderable>>> {
  const onlyKey = options?.machineIds ? [...new Set(options.machineIds)].sort().join('\n') : null;
  const select = React.useMemo(() => {
    const only = onlyKey === null ? null : new Set(onlyKey ? onlyKey.split('\n') : []);
    const heldByServer = new Map<string, Readonly<{
      machines: Machine[] | null;
      displays: Record<string, MachineDisplayRenderable>;
    }>>();
    return (state: StorageState) => {
      const next: Record<string, Record<string, MachineDisplayRenderable>> = {};
      for (const serverId of serverIds) {
        const machines = readMachineListForServer(state, serverId);
        const held = heldByServer.get(serverId);
        if (held?.machines === machines) {
          next[serverId] = held.displays;
          continue;
        }
        const displays: Record<string, MachineDisplayRenderable> = {};
        for (const machine of selectVisibleMachines(machines) ?? []) {
          if (only && !only.has(machine.id)) continue;
          const display = buildMachineDisplayRenderableFromMachine(machine);
          const previous = held?.displays[machine.id];
          if (previous && areMachineDisplaySemanticsEqual(previous, display)) {
            linkMachineActivity(display, previous);
            displays[machine.id] = previous;
          } else displays[machine.id] = display;
        }
        const value = held && shallow(held.displays, displays) ? held.displays : displays;
        heldByServer.set(serverId, { machines, displays: value });
        next[serverId] = value;
      }
      return next;
    };
  }, [serverIds, onlyKey]);
  return usePresentedMachineInventory(select, true);
}

/** The display names of an already-bounded machine set, read once from a store snapshot. */
export function readMachineDisplayNamesById(
  state: Readonly<{ machineDisplayById?: StorageState['machineDisplayById'] }> & Partial<Pick<StorageState,
    'machines' | 'machineListByServerId' | 'machineRecordsByServerId' | 'machineListStatusByServerId'>>,
  machineIds: readonly string[],
  serverId?: string,
): Record<string, string> {
  const names: Record<string, string> = {};
  const scopedState = serverId === undefined ? null : { machines: state.machines ?? {}, machineListByServerId: state.machineListByServerId,
    machineRecordsByServerId: state.machineRecordsByServerId, machineListStatusByServerId: state.machineListStatusByServerId };
  for (const machineId of machineIds) {
    // The name the Machine list shows, same-named Machines told apart (R3-3); none while it has nothing to show.
    const machine = scopedState ? resolveServerScopedMachine(scopedState, serverId, machineId)
      : state.machineDisplayById?.[machineId];
    const name = readDisplayedMachineName(machine);
    if (name) names[machineId] = name;
  }
  return names;
}

/** Subscribe only to display-name changes for an already-bounded machine set. */
export function useMachineDisplayNamesById(machineIds: readonly string[],
  options: Readonly<{ serverId?: string; presented?: boolean }> = {},
): Readonly<Record<string, string>> {
  const normalizedIds = React.useMemo(
    () => [...new Set(machineIds.map((id) => id.trim()).filter(Boolean))].sort(),
    [machineIds],
  );
  const select = React.useCallback((state: StorageState) => readMachineDisplayNamesById(state, normalizedIds, options.serverId),
    [normalizedIds, options.serverId]);
  return usePresentedMachineInventory(select, options.presented !== false);
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
    const subscribe = React.useCallback((listener: () => void) => store.subscribe(listener, {
      sessions: true, sessionListIndexByServerId: true, sessionListRowsByServerId: true,
      ordinarySessionListMembershipByServerId: true, concurrentSessionListCacheByServerId: true,
    }), [store]);
    return React.useSyncExternalStore(
      enabled ? subscribe : noopSessionServerIdSubscribe,
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

const emptyArray: unknown[] = emptySessionMessagesSnapshot;
const emptyRecord: Record<string, any> = {};
const emptyReviewCommentDrafts: ReviewCommentDraft[] = [];
const emptyOpenApprovalSessionReferences: ReadonlyArray<OpenApprovalSessionReference> = Object.freeze([]);
const emptyOpenApprovalArtifactsForSession: ReadonlyArray<OpenApprovalAttentionArtifactForSession> = Object.freeze([]);

type UseSessionMessagesOptions = Readonly<{
  enabled?: boolean;
  /**
   * False for readers that never present streamed agent text (tool/user/structure facts): they then
   * follow `transcriptStructureVersion` and skip text-only deltas, exactly like `useSessionMessagesById`.
   */
  textUpdates?: boolean;
}>;

type SessionSubagentSourceMessagesCacheEntry = Readonly<{
  sourceVersion: number;
  projection: SubagentSourceMessageProjection;
}>;

const sessionSubagentSourceMessagesCache = new Map<string, SessionSubagentSourceMessagesCacheEntry>();

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
      return cached.projection.messages;
    }

    const sourceMessages: Message[] = [];
    const ids = session.messageIdsOldestFirst;
    const orderedMessages = Array.isArray(ids) && ids.length > 0
      ? ids.map((id) => session.messagesById[id]).filter((message): message is Message => message != null)
      : sortTranscriptMessagesOldestFirst(Object.values(session.messagesById ?? {}));

    for (const message of orderedMessages) {
      if (!shouldIncludeSubagentSourceMessage(message)) continue;
      sourceMessages.push(message);
    }

    const projection = reconcileSubagentSourceMessageProjection(sourceMessages, cached?.projection);
    const next = { sourceVersion, projection } satisfies SessionSubagentSourceMessagesCacheEntry;
    sessionSubagentSourceMessagesCache.delete(normalizedSessionId);
    sessionSubagentSourceMessagesCache.set(normalizedSessionId, next);
    trimSessionSubagentSourceMessagesCache();
    return next.projection.messages;
  }, { sessionMessages: [normalizedSessionId] });
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
  const textUpdates = options?.textUpdates !== false;
  const { ids, isLoaded } = useSessionTranscriptIds(normalizedSessionId, enabled);
  const messagesById = useSessionMessagesById(normalizedSessionId, enabled, { textUpdates });
  const version = useSessionMessagesVersion(normalizedSessionId, enabled, { textUpdates });

  const messages = React.useMemo(() => enabled
    ? readSessionMessagesSnapshot(normalizedSessionId, ids, messagesById, version, isLoaded)
    : emptyArray as Message[], [enabled, ids, isLoaded, messagesById, normalizedSessionId, version]);

  return React.useMemo(() => ({ messages, isLoaded }), [isLoaded, messages]);
}

/** Whether the Session's transcript has been read at least once; a boolean subscription, no ids. */
export function useSessionTranscriptLoaded(sessionId: string): boolean {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => state.sessionMessages[normalizedSessionId]?.isLoaded ?? false, { sessionMessages: [normalizedSessionId] });
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
    }), { sessionMessages: enabled ? [normalizedSessionId] : [] }
  );
  return React.useMemo(
    () => ({ ids: snapshot.committedIds as string[], isLoaded: snapshot.isLoaded }),
    [snapshot.committedIds, snapshot.isLoaded],
  );
}

/**
 * Whether the Session's transcript holds committed messages, and whether it has loaded. A reader that decides only
 * on emptiness (show the timeline or a placeholder) subscribes here, so a message arriving in a non-empty transcript
 * publishes nothing to it; `useSessionTranscriptIds` re-publishes on every arrival.
 */
export function useSessionTranscriptCommittedPresence(sessionId: string): Readonly<{ hasCommittedMessages: boolean; isLoaded: boolean }> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[normalizedSessionId];
      return {
        hasCommittedMessages: (session?.messageIdsOldestFirst?.length ?? 0) > 0,
        isLoaded: session?.isLoaded ?? false,
      };
    }), { sessionMessages: [normalizedSessionId] }
  );
}

export function useForkedTranscriptSnapshot(sessionId: string, options?: Readonly<{ textUpdates?: boolean }>): ForkedTranscriptSnapshot | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => getForkedTranscriptSnapshotCached(state, normalizedSessionId, options))
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

/** Key-scoped presentation facts; unrelated transcript arrivals retain the selected array's identity. */
export function useSessionReturnedAnswers(sessionId: string, requestKeys: readonly string[]): readonly ReturnedAnswerEntry[] {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(useShallow((state) => {
    const index = state.sessionMessages[normalizedSessionId]?.returnedAnswersByRequest;
    return requestKeys.flatMap(key => index?.[key] ?? []);
  }), { sessionMessages: [normalizedSessionId] });
}

/** Shell support is one fact, not a subscription to the transcript's token-wide snapshot. */
export function useSessionHasExecutionRunSignals(sessionId: string, enabled = true): boolean {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => {
    const transcript = enabled ? state.sessionMessages[normalizedSessionId] : undefined;
    if (!transcript) return false;
    return transcript.executionRunSignalMessageIds !== undefined
      ? transcript.executionRunSignalMessageIds.size > 0
      // Retained development snapshots are admitted by the next message/load write.
      : hasExecutionRunSignals(readSessionMessagesSnapshot(normalizedSessionId,
        transcript.messageIdsOldestFirst, transcript.messagesById,
        transcript.messagesVersion, transcript.isLoaded));
  }, { sessionMessages: enabled ? [normalizedSessionId] : [] });
}

/** Only inventory membership/order facts enter history; message seq/runtime changes do not. */
export function useUserMessageHistorySessionIds(serverId: string | null, enabled: boolean): readonly string[] {
  return getStorage()(useShallow((state) => {
    if (!enabled || !serverId) return emptyArray as readonly string[];
    const rows = readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId) ?? {};
    const sessions = new Map(Object.entries(rows));
    for (const session of Object.values(state.sessions)) {
      if (session.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, serverId)) continue;
      if (!sessions.has(session.id)) sessions.set(session.id, session);
    }
    const activityAt = (id: string) => {
      const session = sessions.get(id);
      return deriveSessionListMeaningfulActivityAt({ sessionMeaningfulActivityAt: session?.meaningfulActivityAt,
        sessionCreatedAt: session?.createdAt, latestCommittedMessageCreatedAt: undefined,
        latestPendingMessageCreatedAt: undefined }) ?? 0;
    };
    return [...sessions.keys()].sort((a, b) => activityAt(b) - activityAt(a) || a.localeCompare(b));
  }));
}

export function useUserMessageHistorySessionServerIds(enabled: boolean): Readonly<Record<string, string | undefined>> {
  return getStorage()(useShallow((state) => enabled
    ? Object.fromEntries(Object.values(state.sessions).map(session => [session.id, session.serverId])) : {}));
}

/** User-only producer facts; null selects the applied Account's loaded corpus. */
export function useSessionUserMessageHistory(sessionId: string | null, enabled = true): SessionUserMessageHistory {
  const normalizedSessionId = sessionId === null ? null : normalizeSessionId(sessionId);
  const local = getStorage()((state) => enabled && normalizedSessionId !== null
    ? state.sessionUserMessageHistory?.[normalizedSessionId] ?? EMPTY_USER_MESSAGE_HISTORY : EMPTY_USER_MESSAGE_HISTORY);
  const global = getStorage()(useShallow((state) => enabled && normalizedSessionId === null
    ? Object.fromEntries(Object.entries(state.sessionUserMessageHistory ?? EMPTY_SESSION_USER_MESSAGE_HISTORY)
      .filter(([, rows]) => rows !== EMPTY_USER_MESSAGE_HISTORY)) : EMPTY_SESSION_USER_MESSAGE_HISTORY));
  return React.useMemo(() => normalizedSessionId === null ? global
    : { [normalizedSessionId]: local }, [global, local, normalizedSessionId]);
}

export function useSessionMessagesById(sessionId: string, enabled: boolean = true, options?: Readonly<{ textUpdates?: boolean }>): Record<string, Message> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const textUpdates = options?.textUpdates !== false;
  const selector = React.useMemo(() => {
    let previousVersion: number | undefined;
    let previousTranscript: StorageState['sessionMessages'][string] | undefined;
    let current = { messagesById: emptyRecord as Record<string, Message> };
    return (state: StorageState) => {
      const transcript = enabled ? state.sessionMessages[normalizedSessionId] : undefined;
      const version = textUpdates ? transcript?.messagesVersion ?? 0
        : transcript?.transcriptStructureVersion ?? transcript?.messagesVersion ?? 0;
      if (previousVersion === version
        && previousTranscript?.messageIdsOldestFirst === transcript?.messageIdsOldestFirst
        && (textUpdates ? previousTranscript?.messagesById === transcript?.messagesById
          : previousTranscript?.reducerState === transcript?.reducerState)) return current;
      previousVersion = version;
      previousTranscript = transcript;
      // Keep the revision wrapper: legacy same-map writes still notify live readers.
      current = { messagesById: transcript?.messagesById ?? emptyRecord as Record<string, Message> };
      return current;
    };
  }, [enabled, normalizedSessionId, textUpdates]);
  return getStorage()(selector, { sessionMessages: enabled ? [normalizedSessionId] : [] }).messagesById;
}

export function useSessionMessagesVersion(sessionId: string, enabled: boolean = true, options?: Readonly<{ textUpdates?: boolean }>): number {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const textUpdates = options?.textUpdates !== false;
  return getStorage()(
    useShallow((state) => {
      if (!enabled) return 0;
      const session = state.sessionMessages[normalizedSessionId];
      return textUpdates ? session?.messagesVersion ?? 0
        : session?.transcriptStructureVersion ?? session?.messagesVersion ?? 0;
    }), { sessionMessages: enabled ? [normalizedSessionId] : [] }
  );
}

/**
 * Committed rows of one sidechain, projected through the transcript reducer's
 * own conversion.
 *
 * A Run whose profile does not materialize a parent tool marker still commits
 * its transcript under the Run's sidechain id, so a surface that has the Run
 * but no marker reads the rows here instead of re-deriving a transcript of its
 * own. The reducer state mutates in place, so the projection follows its
 * revision even when a sidechain-only update leaves the main rows unchanged.
 */
export function useSessionSidechainMessages(sessionId: string, sidechainId: string | null): readonly Message[] {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const { reducerState, reducerVersion } = useSessionMessagesReducerSnapshot(normalizedSessionId);
  const normalizedSidechainId = typeof sidechainId === 'string' && sidechainId.trim().length > 0
    ? sidechainId.trim()
    : null;

  return React.useMemo(() => {
    if (!reducerState || !normalizedSidechainId) return emptyArray as any as readonly Message[];
    const projected = projectSidechainMessages(reducerState, normalizedSidechainId);
    return projected.length > 0 ? projected : (emptyArray as any as readonly Message[]);
    // The reducer state object is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedSidechainId, reducerState, reducerVersion]);
}

export function useSessionMessagesReducerState(sessionId: string, options?: Readonly<{ textUpdates?: boolean }>) {
  return useSessionMessagesReducerSnapshot(sessionId, options).reducerState;
}

function useSessionMessagesReducerSnapshot(sessionId: string, options?: Readonly<{ textUpdates?: boolean }>) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[normalizedSessionId];
      return {
        reducerState: session?.reducerState ?? null,
        reducerVersion: options?.textUpdates === false
          ? session?.transcriptStructureVersion ?? session?.messagesVersion ?? 0
          : session?.reducerVersion ?? 0,
      };
    }), { sessionMessages: [normalizedSessionId] }
  );
}

export function useSessionLatestThinkingMessageId(sessionId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[normalizedSessionId];
      return session?.latestThinkingMessageId ?? null;
    }), { sessionMessages: [normalizedSessionId] }
  );
}

export function readSessionLatestThinkingMessageActivityAtMs(sessionId: string): number | null {
  return getStorage().getState().sessionMessages[normalizeSessionId(sessionId)]?.latestThinkingMessageActivityAtMs ?? null;
}

/**
 * A projection of the latest thinking activity stamp. Every thinking delta restamps it, so callers
 * select the displayed fact (e.g. "inside the stale window") instead of subscribing to the stamp.
 */
export function useSessionLatestThinkingMessageActivity<T>(sessionId: string, select: (activityAtMs: number | null) => T): T {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => select(state.sessionMessages[normalizedSessionId]?.latestThinkingMessageActivityAtMs ?? null),
    { sessionMessages: [normalizedSessionId] });
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
  }, { sessionMessages: [normalizedSessionId] });
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
        sessionMessages.renderableAggregate,
      );
      const latestReadyEventSeq =
        sessionMessages.latestReadyEventSeq
        ?? session?.latestReadyEventSeq
        ?? renderable?.latestReadyEventSeq
        ?? null;
      const latestNonRenderableMessageSeq = sessionMessages.latestNonRenderableMessageSeq ?? null;
      if (
        readableActivity?.latestCommittedMessageSeq == null
        && latestReadyEventSeq == null
        && latestNonRenderableMessageSeq == null
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
      if (latestNonRenderableMessageSeq !== null) {
        previousResult = Math.max(previousResult ?? 0, latestNonRenderableMessageSeq);
      }
      return previousResult;
    };
  }, [activeServerId, latestTurnStatus, normalizedSessionId, sessionSeq]);

  return getStorage()(selector, { sessionMessages: [normalizedSessionId] });
}

function hasTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null | undefined): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export function useSessionPendingMessages(
  sessionId: string,
  recipient?: PendingMessage['recipient'],
): { messages: PendingMessage[]; discarded: DiscardedPendingMessage[]; isLoaded: boolean; readState?: 'loading' | 'error' } {
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
  const readState = getStorage()((state) => state.sessionPending[normalizedSessionId]?.readState);
  return React.useMemo(() => ({ messages, discarded, isLoaded, readState }), [messages, discarded, isLoaded, readState]);
}

export function useSessionListMeaningfulActivityAt(sessionId: string): number | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const activeServerId = normalizeTrimmedString(useActiveServerSnapshot().serverId);
  return getStorage()(
    useShallow((state) => selectSessionListMeaningfulActivityAt(state, activeServerId, normalizedSessionId)), { sessionMessages: [normalizedSessionId] }
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

function summarizeCommittedSessionMessagesForUnread(
  sessionMessages: StorageState['sessionMessages'][string] | undefined,
): ReturnType<typeof summarizeSessionListReadableActivityFromMessageRecords> {
  if (!sessionMessages) return undefined;
  return summarizeSessionListReadableActivityFromMessageRecords(
    sessionMessages.messageIdsOldestFirst,
    sessionMessages.messagesById,
    sessionMessages.renderableAggregate,
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
    }), { sessionMessages: [normalizedSessionId] }
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
  return getStorage()(selector, { sessionMessages: messageRefs.map(ref => ref.sessionId) }).messages;
}

export function useResolvedSessionMessageRouteId(sessionId: string, routeMessageId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => {
    const session = state.sessionMessages[normalizedSessionId];
    return resolveSessionMessageRouteId({
      routeMessageId,
      messagesById: session?.messagesById ?? emptyRecord,
      reducerState: session?.reducerState,
    });
  }, { sessionMessages: [normalizedSessionId] });
}

export function useSessionMessageRouteId(sessionId: string, messageId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return getStorage()((state) => {
    const session = state.sessionMessages[normalizedSessionId];
    return buildSessionMessageRouteId({
      messageId,
      messagesById: session?.messagesById ?? emptyRecord,
      reducerState: session?.reducerState,
    });
  }, { sessionMessages: [normalizedSessionId] });
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
  const scope = useAccountSettingsScope();
  const execute = useProfileActionExecute();
  const profiles = useAiLaunchProfiles();
  const currentBindings = React.useMemo(() => projectCurrentSecretBindingsByProfileId(profiles), [profiles]);
  const setCurrentBindings = React.useCallback(
    async (nextBindings: CurrentSecretBindingsByProfileId) => {
      if (!scope) throw new Error('Profile Account is unavailable');
      for (const id of new Set([...Object.keys(currentBindings), ...Object.keys(nextBindings)])) {
        const before = currentBindings[id] ?? {};
        const next = nextBindings[id] ?? {};
        const changedNames = [...new Set([...Object.keys(before), ...Object.keys(next)])]
          .filter(name => before[name] !== next[name]);
        if (changedNames.length === 0) continue;
        const catalog = changedNames.some(name => next[name] !== undefined) ? await readSavedSecretCatalog(scope) : null;
        if (catalog && !catalog.ok) throw new Error(catalog.failure.kind);
        const selections = changedNames.map(envName => {
          const reference = next[envName];
          if (reference === undefined) return { envName, selection: { kind: 'none' as const } };
          const parsed = parseSavedSecretRefV1(reference);
          if (parsed.kind !== 'shared_resource') throw new Error('saved-secret-unavailable');
          const resource = catalog?.ok ? catalog.resources.find(entry => 'resourceId' in entry && entry.resourceId === parsed.resourceId) : undefined;
          if (!resource || resource.entry.materialStatus !== 'ready' || resource.entry.revision === null || !resource.entry.capabilities.use) {
            throw new Error('saved-secret-unavailable');
          }
          return { envName, selection: { kind: 'resource' as const, resourceId: parsed.resourceId,
            expectedResourceRevision: resource.entry.revision } };
        });
        requireUpdatedProfileOperation(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.secrets.select'].parse(
          await execute({ actionId: 'launch_profiles.secrets.select', input: { id, selections,
            expectedRevision: profiles.find(profile => profile.id === id)?.profileRecordRevision ?? 'absent' } })));
      }
    },
    [scope, execute, currentBindings, profiles],
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

export function useAllMachines<T>(select: (machines: Machine[]) => T): T;
export function useAllMachines(): Machine[];
export function useAllMachines(select?: (machines: Machine[]) => unknown) {
  return getStorage()(
    useShallow((state) => {
      const machines = resolveVisibleMachinesForActiveServerFromState(state);
      return select ? select(machines) : machines;
    })
  );
}

/**
 * This Home's observed and unknown presence, for always-mounted chrome (the rail's Machines tooltip,
 * the Settings Machines row). Shared presence membership owns recovery and grace expiry;
 * stable verdict counts keep heartbeat and metadata-only changes quiet.
 */
export function useMachinePresenceCounts(): MachinePresenceCounts {
  const scope = useActiveServerAccountScope();
  const membership = useMachinePresenceMembership(scope?.serverId ?? null);
  return membership.counts;
}

/** Whether this Home has any machine at all, online or offline; a boolean, so presence churn stays quiet. */
export function useHomeHasMachines(): boolean {
  const scope = useActiveServerAccountScope();
  return getStorage()((state) => resolveVisibleMachinesForActiveServerFromState(state, { serverId: scope?.serverId })
    .some(isMachineVisibleForLaunchSelection));
}

/** Park presentation-only inventory while retaining the draft's selection.
 * Account withdrawal/replacement still refreshes the snapshot while hidden.
 */
function createPresentedMachineInventorySelector<T>(select: (state: StorageState) => T, presented: boolean, reconcile?: (previous: T | undefined, next: T, state: StorageState) => T) {
    let held: { value: T; serverId: string | undefined; accountId: string | undefined } | null = null;
    return (state: StorageState): T => {
      const scope = state.profileScope;
      const sameScope = held !== null && held.serverId === scope?.serverId && held.accountId === scope?.accountId;
      if (presented || !sameScope) {
        const next = select(state);
        held = { value: reconcile ? reconcile(sameScope && held ? held.value : undefined, next, state) : next,
          serverId: scope?.serverId, accountId: scope?.accountId };
      }
      return held!.value;
    };
}

function usePresentedMachineInventory<T>(select: (state: StorageState) => T, presented: boolean, reconcile?: (previous: T | undefined, next: T, state: StorageState) => T): T {
  const selector = React.useMemo(() => createPresentedMachineInventorySelector(select, presented, reconcile), [presented, select, reconcile]);
  return getStorage()(useShallow(selector));
}

export function useLaunchSelectionMachines(presented = true, enabled = true): Machine[] {
  const owner = machineInventoryPresentation(getStorage());
  const select = React.useCallback((state: StorageState) => enabled
    ? owner.active(state, 'launch') : emptyArray as Machine[], [enabled, owner]);
  return usePresentedMachineInventory(select, presented || !enabled);
}

function createLaunchSelectionReconciler() {
  return (previous: Machine[] | undefined, next: Machine[]): Machine[] => {
    const reconciled = next.map((machine, index) => {
      const held = previous?.[index];
      return held && areMachineLaunchInputsEqual(held, machine) ? held : machine;
    });
    return previous && previous.length === reconciled.length && reconciled.every((machine, index) => machine === previous[index]) ? previous : reconciled;
  };
}

export function useMachineRecordValues(enabled = true): Machine[] {
  return getStorage()(
    useShallow((state) => {
      if (!enabled) return emptyArray as Machine[];
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

/**
 * Visible server-scoped Machine lists (tombstones removed). Rows have facts semantics: a row keeps its identity
 * across publications that change only the daemon resource channel (`areMachineFactsEqual`), so a held row's
 * `daemonStateVersion`, `seq`, `resources` and `managedActivity` can be older than the store's. `launch` keeps
 * launch inputs instead (`areMachineLaunchInputsEqual`). Readers of the live daemon version or resources read the
 * raw records (`useMachineRecordListsByServerId`, `useMachine`) or their own resource hooks.
 * `presented: false` holds the last presented lists while a retained surface is hidden.
 */
export function useMachineListByServerId(presented = true, purpose: 'facts' | 'launch' = 'facts', enabled = true): Record<string, Machine[] | null> {
  const owner = machineInventoryPresentation(getStorage());
  const select = React.useCallback((state: StorageState) => enabled
    ? owner.lists(state, purpose) : EMPTY_MACHINE_LIST_BY_SERVER_ID, [enabled, owner, purpose]);
  return usePresentedMachineInventory(select, presented || !enabled);
}

/**
 * Visible machine inventory for one Home. This keeps always-mounted consumers
 * off the whole multi-Home map while preserving the list hook's tombstone
 * filtering and source-array identity for unchanged inventory.
 */
function readMachineListForServer(state: StorageState, serverId: string): Machine[] | null {
  const inventory = state.machineListByServerId ?? EMPTY_MACHINE_LIST_BY_SERVER_ID;
  for (const key of resolveServerScopedMachineInventoryKeys({ serverId, machineListByServerId: inventory })) {
    const list = inventory[key];
    if (list) return list;
  }
  return null;
}

/** One Home's visible list, with the facts semantics and presentation hold of `useMachineListByServerId`. */
export function useMachineListForServer(serverId: string, enabled = true, presented = true): Machine[] | null {
  const owner = machineInventoryPresentation(getStorage());
  const select = React.useCallback((state: StorageState) => enabled ? owner.home(state, serverId, 'facts') : null, [enabled, owner, serverId]);
  return usePresentedMachineInventory(select, presented || !enabled);
}

/** `presented: false` holds the last presented facts while a retained surface is hidden (see `usePresentedMachineInventory`). */
export function useActiveMachineFacts(enabled = true, presented = true): Machine[] {
  const owner = machineInventoryPresentation(getStorage());
  const select = React.useCallback((state: StorageState) => enabled
    ? owner.active(state, 'facts') : emptyArray as Machine[], [enabled, owner]);
  return usePresentedMachineInventory(select, presented || !enabled);
}

/**
 * One fact derived from one Home's visible inventory. Any machine's publication replaces the list, so a reader
 * that needs only a name, a count or a boolean selects it here and redraws only when that value changes.
 * `select` must be stable and return a value comparable with `Object.is`; it reruns only when the list changes.
 * Field demand uses caller-held membership and the exact Machine field owner, so unrelated publications do no selection work.
 */
export function useMachineListForServerSelection<T>(serverId: string, select: (machines: readonly Machine[]) => T,
  demand?: Readonly<{ machineIds: readonly string[]; fields: readonly {
    [Section in keyof MachineFieldContent]: Readonly<{ section: Section; field: keyof MachineFieldContent[Section] }>
  }[keyof MachineFieldContent][] }>,
): T {
  const store = getStorage();
  const selector = React.useMemo(() => {
    let last: { list: Machine[] | null; value: T } | null = null;
    return (state: StorageState, refresh = false): T => {
      // Exact-field readers retain this selector's snapshot between owner notifications,
      // including incidental renders caused by a sibling inventory subscription.
      if (demand && last && !refresh) return last.value;
      const list = readMachineListForServer(state, serverId);
      if (last?.list === list) return last.value;
      last = { list, value: select(selectVisibleMachines(list) ?? emptyArray as Machine[]) };
      return last.value;
    };
  }, [demand, select, serverId]);
  const getSnapshot = React.useCallback(() => selector(store.getState()), [selector, store]);
  const subscribe = React.useCallback((listener: () => void) => {
    if (!demand) return store.subscribe(listener, { machineListByServerId: true });
    const refresh = () => { selector(store.getState(), true); listener(); };
    const stop = subscribeMachineFields(store, { ...demand, serverId }, refresh);
    // Observe any relevant change between the first render and installing the subscription.
    refresh();
    return stop;
  }, [demand, selector, serverId, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type MachineLaunchInventoryInput = Readonly<{
  activeMachines: Machine[];
  machineListByServerId: Record<string, Machine[] | null>;
  machineListStatusByServerId: StorageState['machineListStatusByServerId'];
}>;

/**
 * A value derived from every Home's launch inventory. A row publication replaces these lists even when the derived
 * answer is unchanged, so a reader that needs a summary selects it here and redraws only when the value changes.
 * `select` must be stable; it reruns only when the inventories change, and an equal result keeps its identity.
 */
export function useMachineLaunchInventorySelection<T>(select: (inventory: MachineLaunchInventoryInput) => T): T {
  const store = getStorage();
  const owner = machineInventoryPresentation(store);
  const retained = React.useRef<T | undefined>(undefined);
  const getSnapshot = React.useMemo(() => {
    let last: { activeMachines: Machine[]; lists: Record<string, Machine[] | null>; statuses: unknown; value: T } | undefined;
    return (): T => {
      const state = store.getState();
      const activeMachines = owner.active(state, 'launch');
      const lists = owner.lists(state, 'launch');
      const statuses = state.machineListStatusByServerId;
      if (last && last.activeMachines === activeMachines && last.lists === lists && last.statuses === statuses) return last.value;
      const value = retainDeep(retained.current, select({ activeMachines, machineListByServerId: lists, machineListStatusByServerId: statuses }));
      retained.current = value;
      last = { activeMachines, lists, statuses, value };
      return value;
    };
  }, [owner, select, store]);
  const subscribe = React.useCallback((listener: () => void) => store.subscribe(listener, {
    machines: true, machineListByServerId: true, machineListStatusByServerId: true,
  }), [store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
  return getStorage()((state) => {
    if (!serverId) return false;
    const inventory = resolveServerScopedMachineInventory<Machine>({
      serverId,
      activeServerId: '',
      activeMachines: [],
      machineListByServerId: state.machineListByServerId ?? {},
      machineListStatusByServerId: state.machineListStatusByServerId,
    });
    return inventory.status === 'idle' && inventory.machines !== null;
  });
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
    return 'loading';
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

/** Exact admitted content field; identity is retained by applyMachines, never by the reader. */
export function useMachineField<Section extends keyof MachineFieldContent, Field extends keyof MachineFieldContent[Section]>(
  machineId: string,
  section: Section,
  field: Field,
  options: Readonly<{ enabled?: boolean; serverId?: string | null }> = {},
): MachineFieldContent[Section][Field] | null {
  const store = getStorage();
  const enabled = options.enabled !== false;
  const serverId = options.serverId?.trim() || null;
  const normalizedMachineId = machineId.trim();
  const getSnapshot = React.useCallback(() => {
    const state = store.getState();
    return readMachineField(state, normalizedMachineId, section, field, serverId);
  }, [field, normalizedMachineId, section, serverId, store]);
  const subscribe = React.useCallback((listener: () => void) => subscribeMachineField(store, {
    machineId: normalizedMachineId, serverId, section, field,
  }, listener), [store, normalizedMachineId, serverId, section, field]);
  return React.useSyncExternalStore(
    enabled ? subscribe : noopMachineSubscribe,
    enabled ? getSnapshot : readNullMachine,
    enabled ? getSnapshot : readNullMachine,
  );
}

export function useMachine(machineId: string, enabled = true): Machine | null {
  const store = getStorage();
  const getSnapshot = React.useCallback(
    () => store.getState().machines[machineId] ?? null,
    [machineId, store],
  );
  const subscribe = React.useCallback((listener: () => void) => store.subscribe(listener, { machines: [machineId] }), [store, machineId]);
  return React.useSyncExternalStore(
    enabled ? subscribe : noopMachineSubscribe,
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

function getStableMachineCliDetectionTarget(
  cache: Map<string, MachineCliDetectionTargetCacheEntry>,
  machineId: string,
  machine: Machine | null,
  isOnline: boolean,
  serverId: string | null = null,
): MachineCliDetectionTarget {
  const daemonStateVersion = machine?.daemonStateVersion ?? 0;
  const signature = `${daemonStateVersion}:${isOnline ? 'online' : 'offline'}`;
  // The same machine ID can have different facts on independently observed Homes.
  const cacheKey = JSON.stringify([serverId, machineId]);
  const cached = cache.get(cacheKey);
  if (cached?.signature === signature) {
    return cached.target;
  }
  const target = { daemonStateVersion, isOnline };
  cache.set(cacheKey, { signature, target });
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
  const presence = useMachinePresenceSummary(serverId, normalizedMachineId);
  // Presence includes this reader's credential binding. A newly mounting
  // reader must not replace a settled reader's external-store snapshot.
  const cache = React.useRef(new Map<string, MachineCliDetectionTargetCacheEntry>());
  return getStorage()((state) => {
    const machine = !normalizedMachineId ? null
      : exactServerId ? resolveServerScopedMachine(state, exactServerId, normalizedMachineId)
        : state.machines[normalizedMachineId] ?? null;
    return getStableMachineCliDetectionTarget(cache.current, normalizedMachineId, machine, presence.reachability === 'reachable', cacheServerId);
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
  const presence = useMachinePresenceSummaries(null, stableMachineIds);
  const cache = React.useRef(new Map<string, MachineCliDetectionTargetCacheEntry>());
  const selectTargets = React.useCallback((state: StorageState): MachineCliDetectionTargets => {
    const targets: Record<string, MachineCliDetectionTarget> = {};
    for (const [index, machineId] of stableMachineIds.entries()) {
      targets[machineId] = getStableMachineCliDetectionTarget(cache.current, machineId, state.machines[machineId] ?? null, presence[index]?.reachability === 'reachable');
    }
    return targets;
  }, [presence, stableMachineIds]);
  return getStorage()(useShallow(selectTargets));
}

/** Launch choices observe semantic inputs; live reachability remains owned by the presence hooks. */
export function useServerScopedLaunchMachine(serverId: string | null | undefined, machineId: string | null | undefined): Machine | null {
  const store = getStorage();
  const activeServerId = useActiveServerSnapshot().serverId;
  const profilesGeneration = useServerProfilesGeneration();
  const select = React.useCallback((state: StorageState): Machine[] => {
    const machine = resolveServerScopedMachine(state, serverId, machineId ?? '');
    return machine ? [machine] : emptyArray as Machine[];
  }, [serverId, machineId, activeServerId, profilesGeneration]);
  const reconcile = React.useMemo(createLaunchSelectionReconciler, []);
  const selector = React.useMemo(() => createPresentedMachineInventorySelector(select, true, reconcile), [select, reconcile]);
  const getSnapshot = React.useCallback(() => selector(store.getState()), [selector, store]);
  return useServerScopedMachineSnapshot(getSnapshot, Boolean(machineId?.trim()))[0] ?? null;
}

export function useServerScopedMachine(serverId: string | null | undefined, machineId: string | null | undefined): Machine | null;
export function useServerScopedMachine<T>(serverId: string | null | undefined, machineId: string | null | undefined, select: (machine: Machine | null) => T): T;
export function useServerScopedMachine<T>(serverId: string | null | undefined, machineId: string | null | undefined, select?: (machine: Machine | null) => T): T | Machine | null {
  const store = getStorage();
  const normalizedMachineId = typeof machineId === 'string' ? machineId.trim() : '';
  const enabled = normalizedMachineId.length > 0;
  const getSnapshot = React.useCallback(
    () => {
      const machine = enabled ? resolveServerScopedMachine(store.getState(), serverId, normalizedMachineId) : null;
      return select ? select(machine) : machine;
    },
    [store, serverId, normalizedMachineId, enabled, select],
  );
  return useServerScopedMachineSnapshot(getSnapshot, enabled);
}

/**
 * A Machine's name as rows show it, subscribed to that name rather than the record presence heartbeats replace.
 * While sync re-reads the row (no content and no availability yet) the name it last settled stands, so a row
 * goes from its locked or previous name straight to the opened one and never through an empty label.
 */
export function useServerScopedMachineLabel(serverId: string | null | undefined, machineId: string | null | undefined): string | null {
  const normalizedMachineId = typeof machineId === 'string' ? machineId.trim() : '';
  const settledRef = React.useRef<Readonly<{ machineId: string; label: string | null }> | null>(null);
  const select = React.useCallback((machine: Machine | null): string | null => {
    const previous = settledRef.current?.machineId === normalizedMachineId ? settledRef.current.label : null;
    const label = machine && isMachineDisplayHydrating(machine) ? previous : getSettledMachineDisplayName(machine);
    settledRef.current = { machineId: normalizedMachineId, label };
    return label;
  }, [normalizedMachineId]);
  return useServerScopedMachine(serverId, normalizedMachineId, select);
}

function useServerScopedMachineSnapshot<T>(getSnapshot: () => T, enabled: boolean): T {
  const store = getStorage();
  const subscribe = React.useCallback((listener: () => void) => {
    const unsubscribeStore = store.subscribe(listener, {
      machines: true, machineListByServerId: true, machineListStatusByServerId: true, profileScope: true,
    });
    // Home/profile changes are resolver inputs even without a store publication.
    const unsubscribeHome = subscribeActiveServer(listener);
    const unsubscribeProfiles = subscribeServerProfiles(listener);
    return () => {
      unsubscribeStore();
      unsubscribeHome();
      unsubscribeProfiles();
    };
  }, [store]);
  return React.useSyncExternalStore(
    enabled ? subscribe : noopMachineSubscribe,
    getSnapshot,
    getSnapshot,
  );
}

export function useAllSessions(): Session[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return emptyArray as Session[];
      return sortValuesByUpdatedAtDescending(state.sessions);
    })
  );
}

export type SessionJoinFact = Readonly<{ id: string; serverId: string | undefined }>;
const NO_SESSION_JOIN_TUPLES: unknown[] = [];

/**
 * The Session identity a consumer joins against (newest first), for owners that only match Sessions to
 * other facts and read the rest from the store when they need it. A streaming Session replaces its record
 * on every update but keeps `metadata`, so the flat (id, serverId, metadata) tuples stay shallow-equal and
 * the consumer does not render for output it cannot show; a metadata change (the input of Machine-target
 * resolution) still does.
 */
export function useSessionJoinFacts(): readonly SessionJoinFact[] {
  const tuples = getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return NO_SESSION_JOIN_TUPLES;
      const flat: unknown[] = [];
      for (const session of sortValuesByUpdatedAtDescending(state.sessions)) flat.push(session.id, session.serverId, session.metadata);
      return flat;
    })
  );
  return React.useMemo(() => {
    const facts: SessionJoinFact[] = [];
    for (let index = 0; index < tuples.length; index += 3) {
      facts.push({ id: tuples[index] as string, serverId: tuples[index + 1] as string | undefined });
    }
    return facts;
  }, [tuples]);
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
    useShallow((state) => resolveSessionRpcAvailabilityState(state, sessionId, serverId))
  );
}

export { useProjectSessions } from '../domains/session/listing/useProjectSessions';
export {
  useProjectScmStatus, useSessionProjectScmStatus, useProjectScmSnapshot,
  useSessionProjectScmIsRepo, useSessionProjectScmSnapshot, useSessionProjectScmSummarySnapshot, useSessionProjectScmSnapshotError,
  useWorkspaceScmStatus, useWorkspaceScmSnapshot, useWorkspaceScmFileSnapshot, useWorkspaceScmSummarySnapshot, useWorkspaceScmSnapshotError,
  useWorkspaceScmCommitSelectionPaths, useWorkspaceScmCommitSelectionPatches,
  useWorkspaceScmOperationLog, useWorkspaceScmInFlightOperation,
  useSessionProjectScmCommitSelectionPaths, useSessionProjectScmCommitSelectionPatches,
  useSessionProjectScmOperationLog, useSessionProjectScmInFlightOperation,
} from './scmHooks';

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

export function useSessionLastMobileSurface(
  sessionId: string | null,
  serverId?: string | null,
): SessionMobileSurface | null {
  const activeServer = useActiveServerSnapshot();
  const persistenceKeys = getStorage()(useShallow((state) => {
    if (!sessionId) return null;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return null;
    return resolveSessionLastMobileSurfacePersistenceKeysFromState(
      state,
      normalizedSessionId,
      activeServer.serverId,
      serverId,
    );
  }));
  const currentStorageKey = persistenceKeys?.realmQualifiedStorageKey ?? null;
  const predecessorStorageKey = persistenceKeys?.predecessorServerQualifiedStorageKey ?? null;
  const current = usePersistentUiStateValue(sessionLastMobileSurfaceState, currentStorageKey);
  const predecessor = usePersistentUiStateValue(sessionLastMobileSurfaceState, predecessorStorageKey);
  const selection = readSessionMobileSurfaceWithPredecessor({
    ...(currentStorageKey && current ? { [currentStorageKey]: current } : {}),
    ...(predecessorStorageKey && predecessor ? { [predecessorStorageKey]: predecessor } : {}),
  }, persistenceKeys);
  const predecessorSurface = selection.predecessorSurface;

  React.useEffect(() => {
    if (!currentStorageKey || !predecessorStorageKey || !predecessorSurface) return;
    const currentPredecessorSurface = sessionLastMobileSurfaceState.read(predecessorStorageKey);
    if (!currentPredecessorSurface) return;
    if (sessionLastMobileSurfaceState.read(currentStorageKey) === undefined) {
      sessionLastMobileSurfaceState.set(currentStorageKey, currentPredecessorSurface);
    }
    sessionLastMobileSurfaceState.remove(predecessorStorageKey);
  }, [currentStorageKey, predecessorStorageKey, predecessorSurface]);

  return selection.surface;
}

export function usePersistSessionLastMobileSurface(): (
  sessionId: string,
  surface: SessionMobileSurface,
  serverId?: string | null,
) => void {
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
    const currentStorageKey = persistenceKeys.realmQualifiedStorageKey;
    const predecessorStorageKey = persistenceKeys.predecessorServerQualifiedStorageKey;
    sessionLastMobileSurfaceState.set(currentStorageKey, surface);
    sessionLastMobileSurfaceState.remove(predecessorStorageKey);
  }, [activeServer.serverId]);
}

export { readSessionCompanionPreferenceSlotFromState, useSessionCompanionPreferenceSlot, useMutateSessionCompanionPreference } from './sessionCompanion';
export type { SessionCompanionPreferenceEntry, SessionCompanionPreferenceSlot } from './sessionCompanion';

export function useProjectLastMobileSurface(workspaceRefId: string | null, explicitServerId?: string | null): ProjectRememberedSelectionId | null {
  const activeServer = useActiveServerSnapshot();
  const storageKey = getStorage()((state) => {
    if (!workspaceRefId) return null;
    return resolveProjectLastMobileSurfaceStorageKeyFromState(
      state,
      workspaceRefId,
      activeServer.serverId,
      explicitServerId,
    );
  });
  return usePersistentUiStateValue(projectLastMobileSurfaceState, storageKey) ?? null;
}

export function usePersistProjectLastMobileSurface(): (
  workspaceRefId: string,
  surface: ProjectRememberedSelectionId,
  serverId?: string | null,
) => void {
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
    projectLastMobileSurfaceState.set(storageKey, surface);
  }, [activeServer.serverId]);
}

// Artifact hooks
export function useArtifacts(view?: ArtifactInventoryView | 'none'): DecryptedArtifact[] {
  const artifacts = getStorage()((state) => view === 'browserListed' ? state.artifactBrowserArtifacts
    : view === 'promptLibrary' ? state.artifactPromptLibraryArtifacts : view === 'none' ? EMPTY_ARTIFACT_ROWS : state.artifacts);
  return React.useMemo(() => sortValuesByUpdatedAtDescending(artifacts)
    .filter((artifact) => !artifact.draft), [artifacts]);
}

/** Attention consumers share the Inbox owner's admitted open requests, never settled receipts. */
/**
 * The Discussion attention facts a list reads (Artifact id and its attention) for its own Discussions, newest
 * first. Projected in the selector and retained: an Artifact write that moves none of these facts (a newer
 * timestamp, a body read, another Discussion's request) renders nothing.
 */
export function useDiscussionApprovalAttentionEntries(discussionIds: readonly string[]): readonly DiscussionApprovalAttentionFact[] {
  const idsKey = JSON.stringify(discussionIds);
  const select = React.useMemo(() => {
    const ids = new Set(JSON.parse(idsKey) as string[]);
    let source: StorageState['artifactDiscussionAttentionEntries'] | undefined;
    let facts: readonly DiscussionApprovalAttentionFact[] | undefined;
    return (state: StorageState) => {
      const entries = state.artifactDiscussionAttentionEntries;
      if (facts && entries === source) return facts;
      source = entries;
      facts = retainDeep(facts, Object.values(entries)
        .filter(entry => entry.discussionAttention !== null && ids.has(entry.discussionAttention.discussionId))
        .sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt)
        .map((entry): DiscussionApprovalAttentionFact => ({ artifact: { id: entry.artifact.id }, discussionAttention: entry.discussionAttention })));
      return facts;
    };
  }, [idsKey]);
  return getStorage()(select);
}

const EMPTY_ARTIFACT_ROWS: Record<string, DecryptedArtifact> = Object.freeze({});

/** One demand owner shared by always-mounted summary chrome and the full Inbox model. */
export function useInboxArtifactBodyHydration(
  artifacts: readonly DecryptedArtifact[] | Readonly<Record<string, DecryptedArtifact>>,
  fallbackServerId: string | null | undefined,
  accountId: string | null | undefined,
  /** Approval bodies follow a presenting consumer; a count-only reader needs only notice bodies. */
  approvalBodies = true,
): Readonly<{ pending: boolean; failed: boolean; retry: () => void }> {
  const requests = React.useMemo(
    () => listInboxArtifactBodyHydrationRequests(Array.isArray(artifacts) ? artifacts : Object.values(artifacts), fallbackServerId, accountId,
      { approvalBodies }),
    [artifacts, fallbackServerId, accountId, approvalBodies],
  );
  const key = JSON.stringify(requests);
  const requestsRef = React.useRef(requests);
  requestsRef.current = requests;
  const [retryVersion, retry] = React.useReducer((value: number) => value + 1, 0);
  const [attempt, setAttempt] = React.useState<Readonly<{ key: string; pending: boolean; failed: boolean }> | null>(null);
  React.useEffect(() => {
    // Nothing to hydrate settles nothing; `pending` is already false for an empty key.
    if (requestsRef.current.length === 0) return;
    // A new key is pending by derivation (`attempt.key !== key`); only a retry of the settled key resets it.
    setAttempt(previous => previous?.key === key ? { key, pending: true, failed: false } : previous);
    let current = true;
    const artifactIdsByServerId = new Map<string, string[]>();
    for (const request of requestsRef.current) {
      const ids = artifactIdsByServerId.get(request.serverId) ?? [];
      ids.push(request.artifactId);
      artifactIdsByServerId.set(request.serverId, ids);
    }
    void Promise.all([...artifactIdsByServerId].map(([serverId, artifactIds]) =>
      sync.hydrateSessionApprovalArtifacts(serverId, artifactIds))).then(() => {
        if (current) setAttempt({ key, pending: false, failed: false });
      }, error => {
        log.log(`Inbox artifact hydration failed: ${error instanceof Error ? error.name : 'unknown'}`);
        if (current) setAttempt({ key, pending: false, failed: true });
      });
    return () => { current = false; };
  }, [key, retryVersion]);
  return { pending: requests.length > 0 && (attempt?.key !== key || attempt.pending),
    failed: requests.length > 0 && attempt?.key === key && attempt.failed, retry };
}

export function useArtifactsLoaded(selection?: ArtifactInventorySelection): boolean {
  return getStorage()((state) => state.isDataReady && isArtifactInventoryReady(state, selection));
}

function collectOpenApprovalSessionReferenceListFromEntries(
  entries: StorageState['artifactOpenApprovalEntries'],
  previousReferences: ReadonlyArray<OpenApprovalSessionReference>,
): ReadonlyArray<OpenApprovalSessionReference> {
  const references = collectOpenApprovalSessionReferenceFacts(Object.values(entries).flatMap(entry => entry.references), previousReferences);
  return references.length === 0 ? emptyOpenApprovalSessionReferences : references;
}

export function useOpenApprovalSessionReferences(): ReadonlyArray<OpenApprovalSessionReference> {
  const selectorRef = React.useRef<((state: StorageState) => ReadonlyArray<OpenApprovalSessionReference>) | null>(null);
  if (!selectorRef.current) {
    let previousIsDataReady: boolean | null = null;
    let previousEntries: StorageState['artifactOpenApprovalEntries'] | null = null;
    let previousReferences: ReadonlyArray<OpenApprovalSessionReference> = emptyOpenApprovalSessionReferences;

    selectorRef.current = (state) => {
      if (state.isDataReady === previousIsDataReady && state.artifactOpenApprovalEntries === previousEntries) {
        return previousReferences;
      }

      previousIsDataReady = state.isDataReady;
      previousEntries = state.artifactOpenApprovalEntries;
      previousReferences = state.isDataReady
        ? collectOpenApprovalSessionReferenceListFromEntries(state.artifactOpenApprovalEntries, previousReferences)
        : emptyOpenApprovalSessionReferences;
      return previousReferences;
    };
  }

  return getStorage()(useShallow(selectorRef.current));
}

export function useOpenApprovalArtifactsForSession(
  target: SessionAddress | null | undefined,
): ReadonlyArray<OpenApprovalAttentionArtifactForSession> {
  useSessionOpenApprovalBodyDemand(target);
  return useSessionApprovalArtifacts(target, null, 'open');
}

/**
 * A mounted approval row reads its own body (quick actions, requester, review). The Inbox list itself
 * groups and counts from header facts, so only rows a person can see read bodies.
 */
export function useOpenApprovalArtifactBodyDemand(artifact: DecryptedArtifact | null | undefined): void {
  const serverId = getStorage()(state => state.isDataReady ? state.profileScope?.serverId ?? null : null);
  const request = artifact ? listOpenApprovalInboxArtifactHydrationRequests([artifact], serverId)[0] ?? null : null;
  const requestServerId = request?.serverId ?? null;
  const artifactId = request?.artifactId ?? null;
  React.useEffect(() => {
    if (!requestServerId || !artifactId) return;
    void sync.hydrateSessionApprovalArtifacts(requestServerId, [artifactId]).catch(error => {
      log.log(`Open approval hydration failed: ${error instanceof Error ? error.name : 'unknown'}`);
    });
  }, [requestServerId, artifactId]);
}

/** A mounted Session surface demands bodies only for its own open requests (the shell count reads headers). */
function useSessionOpenApprovalBodyDemand(target: SessionAddress | null | undefined): void {
  const sessionId = target?.sessionId;
  const rows = getStorage()(state => sessionId
    ? state.artifactApprovalArtifactsBySessionId[sessionId] ?? EMPTY_ARTIFACT_ROWS : EMPTY_ARTIFACT_ROWS);
  const ready = getStorage()(state => state.isDataReady);
  const serverId = target?.serverId;
  const missingKey = React.useMemo(() => serverId && ready
    ? JSON.stringify(listOpenApprovalInboxArtifactHydrationRequests(Object.values(rows), serverId).map(request => request.artifactId).sort())
    : '[]', [rows, serverId, ready]);
  React.useEffect(() => {
    const missingIds: string[] = JSON.parse(missingKey);
    if (!serverId || missingIds.length === 0) return;
    void sync.hydrateSessionApprovalArtifacts(serverId, missingIds).catch(error => {
      log.log(`Open approval hydration failed: ${error instanceof Error ? error.name : 'unknown'}`);
    });
  }, [serverId, missingKey]);
}

/**
 * The composer's approvals: every open request under the same projection as the open hook, plus
 * settled requests whose body declares an attention presentation. It demands bodies for this
 * Session's open requests only; settled receipts stay index-only unless the transcript demands them.
 */
export function useComposerApprovalArtifactsForSession(
  target: SessionAddress | null | undefined,
  settledPresentations: readonly ApprovalSettledPresentation[],
): ReadonlyArray<OpenApprovalAttentionArtifactForSession> {
  useSessionApprovalArtifactDiscovery(target?.serverId, target?.sessionId ? [target.sessionId] : []);
  useSessionOpenApprovalBodyDemand(target);
  return useSessionApprovalArtifacts(target, settledPresentations, 'composer');
}

/** A visible Session discovers its receipts by relationship, independently of the open Inbox census. */
function useSessionApprovalArtifactDiscovery(serverId: string | null | undefined, sessionIds: readonly string[]): void {
  const scope = useAccountSettingsScope();
  const profilesGeneration = useServerProfilesGeneration();
  const key = JSON.stringify([...new Set(sessionIds)].sort());
  React.useEffect(() => {
    if (!scope || !serverId || !areServerProfileIdentifiersEquivalent(scope.serverId, serverId)) return;
    const ids: string[] = JSON.parse(key);
    if (ids.length === 0) return;
    return sync.observeArtifactInventory(scope, { approvalSessionIds: ids }, { refreshOnAdmission: true });
  }, [scope?.serverId, scope?.accountId, serverId, key, profilesGeneration]);
}

/**
 * The transcript's approvals: open ones plus settled ones whose approval body declares a settled
 * presentation (pass a module-stable list). Badges and counts use the open hook; the composer uses
 * its dedicated hook so transcript hydration cannot replace the open-request contract.
 */
export function useTranscriptApprovalArtifactsForSession(
  target: SessionAddress | null | undefined,
  settledPresentations: readonly ApprovalSettledPresentation[],
  /** A detail surface may demand one Action family without opening unrelated private receipts. */
  actionIds?: readonly string[],
): ReadonlyArray<OpenApprovalArtifactForSession> {
  const serverId = target?.serverId;
  const sessionId = target?.sessionId;
  useSessionApprovalArtifactDiscovery(serverId, sessionId ? [sessionId] : []);
  const profilesGeneration = useServerProfilesGeneration();
  const artifacts = getStorage()(state => sessionId
    ? state.artifactApprovalArtifactsBySessionId[sessionId] ?? EMPTY_ARTIFACT_ROWS : EMPTY_ARTIFACT_ROWS);
  const ready = getStorage()(state => state.isDataReady);
  const membership = getStorage()(state => state.ordinarySessionListMembershipByServerId);
  const sessionServerId = getStorage()(state => sessionId ? state.sessions[sessionId]?.serverId : undefined);
  const missingIds = React.useMemo(() => serverId && sessionId && ready
    ? listApprovalArtifactIdsNeedingHydrationForSession(Object.values(artifacts), { serverId, sessionId },
      listSessionAddressesForSessionIdFromLocalState(getStorage().getState(), sessionId), actionIds) : [],
  [artifacts, serverId, sessionId, ready, membership, sessionServerId, profilesGeneration, actionIds]);
  React.useEffect(() => {
    if (!serverId || missingIds.length === 0) return;
    void sync.hydrateSessionApprovalArtifacts(serverId, missingIds).catch(error => {
      log.log(`Approval transcript hydration failed: ${error instanceof Error ? error.name : 'unknown'}`);
    });
  }, [serverId, missingIds, profilesGeneration]);
  return useSessionApprovalArtifacts(target, settledPresentations, 'transcript', actionIds);
}

const emptyDiscussionRequesterApprovals: ReadonlyArray<DiscussionRequesterApproval> = Object.freeze([]);

/**
 * A Discussion's requester-bound outward requests (open and decided), each joined to the message that
 * asked by its admitted cause. Bodies are demanded only for approvals linked to the Sessions this
 * thread names (the Bot that was asked), through the same hydration owner as the transcript.
 */
export function useDiscussionRequesterApprovals(
  discussion: Readonly<{ serverId: string; discussionId: string }> | null,
  /** Exact linked Session demand; equal addresses do not restart hydration. */
  linkedSessions: ReadonlyArray<SessionAddress>,
): ReadonlyArray<DiscussionRequesterApproval> {
  const serverId = discussion?.serverId ?? null;
  const discussionId = discussion?.discussionId ?? null;
  const linkedSessionKey = JSON.stringify(linkedSessions.map(({ serverId, sessionId }) => ({ serverId, sessionId })));
  useSessionApprovalArtifactDiscovery(serverId, linkedSessions.filter(address => serverId
    && areServerProfileIdentifiersEquivalent(address.serverId, serverId)).map(address => address.sessionId));
  const profilesGeneration = useServerProfilesGeneration();
  const ready = getStorage()(state => state.isDataReady);
  const linkedArtifacts = getStorage()(useShallow(state => linkedSessions.map(address =>
    state.artifactApprovalArtifactsBySessionId[address.sessionId] ?? EMPTY_ARTIFACT_ROWS)));
  const membership = getStorage()(state => state.ordinarySessionListMembershipByServerId);
  const sessionHomes = getStorage()(useShallow(state => linkedSessions.map(address => state.sessions[address.sessionId]?.serverId)));
  const missingIds = React.useMemo(() => {
    if (!ready) return [];
    const state = getStorage().getState();
    const ids = new Set<string>();
    const addresses: SessionAddress[] = JSON.parse(linkedSessionKey);
    for (const [index, address] of addresses.entries()) {
      for (const id of listApprovalArtifactIdsNeedingHydrationForSession(Object.values(linkedArtifacts[index]!), address,
        listSessionAddressesForSessionIdFromLocalState(state, address.sessionId))) ids.add(id);
    }
    return [...ids].sort();
  }, [ready, linkedArtifacts, membership, sessionHomes, profilesGeneration, linkedSessionKey]);
  React.useEffect(() => {
    if (!serverId || missingIds.length === 0) return;
    void sync.hydrateSessionApprovalArtifacts(serverId, missingIds).catch(error => {
      log.log(`Discussion approval hydration failed: ${error instanceof Error ? error.name : 'unknown'}`);
    });
  }, [serverId, missingIds, profilesGeneration]);
  const artifacts = getStorage()(state => discussionId
    ? state.artifactApprovalArtifactsByDiscussionId[discussionId] ?? EMPTY_ARTIFACT_ROWS : EMPTY_ARTIFACT_ROWS);
  return React.useMemo(() => serverId && discussionId && ready
    ? listDiscussionRequesterApprovals(Object.values(artifacts), { serverId, discussionId })
    : emptyDiscussionRequesterApprovals, [artifacts, serverId, discussionId, ready, profilesGeneration]);
}

function useSessionApprovalArtifacts(
  target: SessionAddress | null | undefined,
  settledPresentations: readonly ApprovalSettledPresentation[] | null,
  projection: 'open' | 'composer',
): ReadonlyArray<OpenApprovalAttentionArtifactForSession>;
function useSessionApprovalArtifacts(
  target: SessionAddress | null | undefined,
  settledPresentations: readonly ApprovalSettledPresentation[] | null,
  projection: 'transcript',
  actionIds?: readonly string[],
): ReadonlyArray<OpenApprovalArtifactForSession>;
function useSessionApprovalArtifacts(
  target: SessionAddress | null | undefined,
  settledPresentations: readonly ApprovalSettledPresentation[] | null,
  projection: 'open' | 'composer' | 'transcript',
  actionIds?: readonly string[],
): ReadonlyArray<OpenApprovalAttentionArtifactForSession> {
  const targetServerId = target?.serverId ?? null;
  const targetSessionId = target?.sessionId ?? null;
  const profilesGeneration = useServerProfilesGeneration();
  const rows = getStorage()(state => targetSessionId
    ? state.artifactApprovalArtifactsBySessionId[targetSessionId] ?? EMPTY_ARTIFACT_ROWS : EMPTY_ARTIFACT_ROWS);
  const ready = getStorage()(state => state.isDataReady);
  const membership = getStorage()(state => state.ordinarySessionListMembershipByServerId);
  const sessionServerId = getStorage()(state => targetSessionId ? state.sessions[targetSessionId]?.serverId : undefined);
  return React.useMemo(() => {
    if (!targetServerId || !targetSessionId || !ready) return emptyOpenApprovalArtifactsForSession;
    const normalizedTarget = { serverId: targetServerId, sessionId: targetSessionId };
    const visible = Object.values(rows);
    const artifacts = actionIds ? visible.filter(artifact => typeof artifact.header?.actionId === 'string'
      && actionIds.includes(artifact.header.actionId)) : visible;
    const options = {
      knownSessionAddresses: listSessionAddressesForSessionIdFromLocalState(getStorage().getState(), targetSessionId),
      ...(settledPresentations ? { settledPresentations } : {}),
    };
    const approvals = projection === 'open'
      ? listOpenApprovalArtifactsForSession(artifacts, normalizedTarget, options)
      : projection === 'composer'
        ? listComposerApprovalArtifactsForSession(artifacts, normalizedTarget, options)
        : listTranscriptApprovalArtifactsForSession(artifacts, normalizedTarget, options);
    return approvals.length === 0 ? emptyOpenApprovalArtifactsForSession : approvals;
  }, [rows, ready, membership, sessionServerId, targetServerId, targetSessionId, projection,
    settledPresentations, profilesGeneration, actionIds]);
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

export function useAutomation(
  automationId: string,
  options: Readonly<{ serverId?: string | null }> = {},
): AutomationDefinition | null {
  const activeScope = useActiveServerAccountScope(options.serverId);
  return getStorage()(useShallow((state) => (
    options.serverId === undefined || activeScope
      ? state.automations[automationId] ?? null
      : null
  )));
}

/**
 * An Automation's ordered Run window, projected onto the shared Run bodies.
 * The shallow comparison keeps the identity of an unchanged window stable, so
 * a refresh that restates the same revisions does not rerender the history.
 */
export function useAutomationRuns(automationId: string): AutomationDefinitionRun[] {
  const lifetime = useActiveServerAccountScopeLifetime();
  React.useEffect(() => retainAutomationRunHistoryDemand(lifetime, [automationId]), [automationId, lifetime]);
  return getStorage()(
    useShallow((state) => {
      const runIds = state.automationRunIdsByAutomationId[automationId];
      if (!runIds || runIds.length === 0) return emptyArray as AutomationDefinitionRun[];
      return resolveAutomationRunProjections(state.workflowRunsById, runIds, getActiveServerAccountScope());
    })
  ) as AutomationDefinitionRun[];
}

/**
 * One exact Run by its own identity. This is the reader an exact route, a deep
 * link or a notification uses: it resolves the same body an Automation list
 * shows, and it never needs the Run's origin Automation.
 */
export function useWorkflowRun(runId: string | null | undefined, options: Readonly<{ enabled?: boolean; scope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null }> = {}): WorkflowRunRow | null {
  const enabled = options.enabled !== false;
  return getStorage()((state) => (enabled && runId ? state.workflowRunsById[workflowRunStoreKey(runId, options.scope)] ?? null : null));
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
export function useWorkflowRunRows(runIds: readonly string[], scope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null): WorkflowRunRow[] {
  return getStorage()(
    useShallow((state) => (
      runIds.length === 0
        ? (emptyArray as WorkflowRunRow[])
        : resolveWorkflowRunRows(state.workflowRunsById, runIds, scope === undefined ? getActiveServerAccountScope() : scope)
    ))
  ) as WorkflowRunRow[];
}

/**
 * The Automation projection of one exact Run. Automation surfaces keep their
 * existing row contract while resolving the same shared body a workflow route
 * resolves, so the two cannot render divergent copies.
 */
export function useAutomationRunById(runId: string | null | undefined): AutomationDefinitionRun | null {
  return getStorage()((state) => (runId ? state.workflowRunsById[workflowRunStoreKey(runId)]?.automation ?? null : null));
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

/** Exact admitted rows in caller order; unrelated publications never replace the selected input. */
export function useArtifactRows(artifactIds: readonly string[]): readonly (DecryptedArtifact | null)[] {
  return getStorage()(useShallow((state) => artifactIds.map(id => state.artifacts[id] ?? null)));
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
  usePeripheralFeedDemand('purchases');
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

/** Admission over the endpoint verdict: our own supervision restart is not evidence against an online Home. */
export function useEndpointOnlineVerdict(): boolean {
  return getStorage()((state) => state.endpointStatus === 'online' || state.endpointOnlineRetained);
}

export function useEndpointLastConnectedAt(): number | null {
  return getStorage()((state) => state.endpointLastConnectedAt);
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

export function useIsSessionDraftsReady(): boolean {
  return getStorage()((state) => state.isSessionDraftsReady);
}

export function useProfile<T>(select: (profile: StorageState['profile']) => T, keys?: readonly (keyof StorageState['profile'])[]): T;
export function useProfile(): StorageState['profile'];
export function useProfile(select?: (profile: StorageState['profile']) => unknown, keys?: readonly (keyof StorageState['profile'])[]) {
  return getStorage()(useShallow((state) => select ? select(state.profile) : state.profile), keys === undefined ? undefined : { profile: keys });
}

/** Explicit Home readers follow the applied runtime; unscoped Settings retain their Profile scope. */
export function useActiveServerAccountScope(serverId?: string | null) {
  const live = serverId !== undefined;
  const subscribe = React.useCallback((listener: () => void) => {
    const unsubscribeProfile = getStorage().subscribe(listener, { profileScope: true });
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
  const readServerSnapshot = React.useCallback(() => {
    const initialScope = getStorage().getInitialState().profileScope ?? null;
    return serverId === undefined
      ? initialScope
      : selectActiveServerAccountScopeForServer(initialScope, serverId);
  }, [serverId]);
  return React.useSyncExternalStore(subscribe, read, readServerSnapshot);
}

/** Live readers renew demand and subscriptions together when even the same Account is restored. */
export function useActiveServerAccountScopeLifetime(): ActiveServerAccountScopeLifetime | null {
  const subscribe = React.useCallback((listener: () => void) => {
    let disposed = false;
    let retirement: Readonly<{ dispose(): void }> | undefined;
    const changed = () => {
      if (disposed) return;
      retirement?.dispose();
      retirement = captureActiveServerAccountScopeLifetime()?.onRetire(() => {
        // Retirement can occur during a sibling's render; the incumbent owner finishes
        // retiring its token before demand captures the replacement. This is not a reset bus.
        queueMicrotask(changed);
      });
      listener();
    };
    const unsubscribeProfile = getStorage().subscribe(changed, { profileScope: true });
    const unsubscribeApplied = subscribeAppliedActiveServer(changed);
    const unsubscribeAvailability = subscribeAppliedActiveServerRuntimeAvailability(changed);
    changed();
    return () => {
      disposed = true;
      retirement?.dispose();
      unsubscribeProfile();
      unsubscribeApplied();
      unsubscribeAvailability();
    };
  }, []);
  return React.useSyncExternalStore(subscribe, captureActiveServerAccountScopeLifetime, captureActiveServerAccountScopeLifetime);
}

/** Use the existing Account lifetime so mounted readers renew demand after restore or Home switch. */
export function usePeripheralFeedDemand(feed: PeripheralFeed, enabled = true): void {
  const lifetime = useActiveServerAccountScopeLifetime();
  React.useEffect(() => {
    if (!enabled || !lifetime?.isCurrent()) return;
    return sync.acquirePeripheralFeed(feed);
  }, [feed, enabled, lifetime]);
}

export function useFriends() {
  usePeripheralFeedDemand('friends');
  return getStorage()(useShallow((state) => state.friends));
}

export function useFriendRequests(enabled = true) {
  usePeripheralFeedDemand('friends', enabled);
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get pending requests (where status is 'pending')
      const requests = Object.values(state.friends).filter((friend) => friend.status === 'pending');
      return requests.length > 0 ? requests : emptyArray as UserProfile[];
    })
  );
}

const selectFriendRequestCount = createFriendRequestCountSelector();

export function useFriendRequestCount(enabled = true): number {
  usePeripheralFeedDemand('friends', enabled);
  return getStorage()(selectFriendRequestCount);
}

export function useAcceptedFriends() {
  usePeripheralFeedDemand('friends');
  return getStorage()(
    useShallow((state) => {
      const friends = Object.values(state.friends).filter((friend) => friend.status === 'friend');
      return friends.length > 0 ? friends : emptyArray as UserProfile[];
    })
  );
}

export function useFeedItems() {
  usePeripheralFeedDemand('feed');
  return getStorage()(useShallow((state) => state.feedItems));
}
export function useFeedLoaded() {
  return getStorage()((state) => state.feedLoaded);
}
export function useFriendsLoaded() {
  return getStorage()((state) => state.friendsLoaded);
}

export function useFriend(userId: string | undefined) {
  usePeripheralFeedDemand('friends', Boolean(userId));
  return getStorage()(useShallow((state) => (userId ? state.friends[userId] : undefined)));
}

export function useUser(userId: string | undefined) {
  return getStorage()(useShallow((state) => (userId ? state.users[userId] : undefined)));
}

export function useRequestedFriends() {
  usePeripheralFeedDemand('friends');
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get sent requests (where status is 'requested')
      const requests = Object.values(state.friends).filter((friend) => friend.status === 'requested');
      return requests.length > 0 ? requests : emptyArray as UserProfile[];
    })
  );
}
