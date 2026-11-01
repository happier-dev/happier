import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSessionArchivePending } from '@/hooks/session/useSessionArchivePending';
import {
  useWorkspaceRefs,
  storage,
  useProfile,
  useSetting,
  useSettings,
  useSessionOrganizationProjection,
  useMachineListByServerId,
} from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
  getSessionName,
  resolveLockedSessionTitle,
  useSessionStatus,
} from '@/utils/sessions/sessionUtils';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import {
  isVersionSupported,
  MINIMUM_CLI_VERSION,
} from '@/utils/system/versionUtils';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { HappyError } from '@/utils/errors/errors';
import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { useOpenSessionCollaboration } from '@/components/sessions/collaboration/useOpenSessionCollaboration';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
  isSessionContentReadable,
  readSessionContentAvailability,
} from '@/sync/domains/session/encryptedContentAvailability';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';
import { runSessionHandoffPickerFlow } from '@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow';
import { resolveSessionHandoffSourceMachineId } from '@/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId';
import { resolveSessionHandoffUiAvailability } from '@/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useSessionHandoffSourceReachability } from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { confirmSessionDelete } from '@/components/sessions/actions/confirmSessionDelete';
import { selectSessionViewShellSessionForRouteState, useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import {
  resolveSessionActionDefaultBackend,
  resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveSessionActionDefaultBackendTitle } from '@/sync/domains/session/resolveSessionActionDefaultBackendTitle';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import {
  SessionHabitsSection,
  SessionSetupSections,
} from '@/components/sessions/work/SessionSetupSections';
import { readSessionFollowHeaderPreset } from '@/components/sessions/follow/sessionFollowHeaderPreset';
import { sessionFollowPresetLabel } from '@/components/sessions/follow/SessionFollowHeaderChip';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import {
  SESSION_ACTION_ARCHIVE_ID,
  SESSION_ACTION_DELETE_ID,
  SESSION_ACTION_EDIT_TAGS_ID,
  SESSION_ACTION_FOLLOW_ID,
  SESSION_ACTION_MOVE_TO_FOLDER_ID,
  SESSION_ACTION_PIN_ID,
  SESSION_ACTION_RENAME_ID,
  SESSION_ACTION_RESUME_ID,
  SESSION_ACTION_STOP_ID,
  SESSION_ACTION_UNARCHIVE_ID,
  SESSION_ACTION_UNPIN_ID,
} from '@/components/sessions/actions/sessionActionIds';
import {
  listVisibleSessionActionIds,
  resolveSessionAttentionStandingActionId,
  resolveSessionReadStateActionId,
} from '@/components/sessions/actions/sessionActionAvailability';
import { createSessionActionInfoItemProps } from '@/components/sessions/actions/sessionActionPresentation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { sessionSetManualReadStateWithServerScope } from '@/sync/ops/sessionReadState';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { sessionTagKey } from '@/components/sessions/shell/sessionTagUtils';
import { openSessionFolderSelection } from '@/components/sessions/organization/SessionFolderSelection';
import {
  buildSessionFolderWorkspaceTargets,
  normalizeSessionFolderWorkspaceRef,
  normalizeSessionFolders,
  type SessionFolderWorkspaceRefV1,
  type SessionFolderMoveTarget,
} from '@/sync/domains/session/folders';
import {
  requireSessionOrganizationMutationScope,
  writeSessionOrganizationFolderAssignment,
  writeSessionOrganizationTagLabels,
  type SessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationTagLabelById } from '@/sync/domains/session/organization/tagLabels';
import { buildSessionTagsMenuContent } from '@/components/sessions/organization/SessionTagsMenuContent';
import { resolveSessionAttentionStanding } from '@/sync/domains/session/organization/attentionStanding';
import { useSessionAttentionStandingInputs } from '@/hooks/session/useSessionAttentionStandingInputs';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import {
  useSessionAddressForSessionId,
  useSessionPluginRuntime,
} from '@/components/sessions/plugins/useSessionPluginRuntime';
import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import { evaluatePluginUiPolicy } from '@/sync/domains/plugins/ui/policy';
import { usePluginUiSessionPolicyEvaluationContext } from '@/components/sessions/model/usePluginUiSessionPolicyEvaluationContext';
import { WorkspaceSyncRelationshipList } from '@/components/workspaces/sync/WorkspaceSyncRelationshipList';
import { openWorkspaceSyncAddMachine } from '@/components/workspaces/sync/openWorkspaceSyncAddMachine';
import { openWorkspaceSyncRelationshipDetails } from '@/components/workspaces/sync/openWorkspaceSyncRelationshipDetails';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { getSessionMachineLabel } from '@/utils/sessions/machineDisplayNames';
import {
  emitSessionResumeRequest,
  useSessionResumeRequestAvailable,
} from '@/components/sessions/model/sessionResumeRequests';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

import { SessionInfoAboutSection } from './SessionInfoAboutSection';
import { SessionInfoDeveloperSection } from './SessionInfoDeveloperSection';
import {
  SessionInfoIdentity,
  type SessionInfoContextAction,
} from './SessionInfoIdentity';
import { useSessionRetentionSummary } from './SessionRetentionNotice';

export type SessionInfoPresentation = 'pane' | 'route';

/**
 * The Session's Info, as one body for both hosts (P2 U2): the right-rail Info panel on desktop and
 * the `/session/[id]/info` route on phones and direct links. The caller owns the exact address and
 * the frame (pane header or route chrome); nothing below this boundary reads route params, a focused
 * Home or a bare-id fallback.
 */
export type SessionInfoBodyProps = Readonly<{
  address: SessionAddress;
  presentation: SessionInfoPresentation;
  /** Leaving the body after an effect that ends this Session's page (Delete; Stop on the route). */
  onRequestClose: () => void;
}>;

export const SessionInfoBody = React.memo(function SessionInfoBody(
  props: SessionInfoBodyProps,
) {
  const session = useSessionViewShellSession(
    props.address.sessionId,
    props.address.serverId,
  );
  if (!session) {
    // A record the viewer no longer has (deleted, or access lost): one sized state, never another
    // Home's Session of the same id.
    return (
      <View testID="session-info-screen" style={stylesheet.stateHost}>
        <SurfaceStateCard
          testID="session-info-missing"
          kind="unavailable"
          title={t('errors.sessionDeleted')}
          reason={t('errors.sessionDeletedDescription')}
        />
      </View>
    );
  }
  return (
    <View testID="session-info-screen" style={stylesheet.content}>
      <SessionInfoContent
        session={session}
        serverId={props.address.serverId}
        presentation={props.presentation}
        onRequestClose={props.onRequestClose}
      />
    </View>
  );
});

// Session info is a private-detail surface. Once the canonical content
// availability owner says this viewer cannot open the Session, retain only
// the safe title and identity shell; metadata and actions must not bypass
// the locked Session surface's privacy boundary.
function isSessionInfoContentUnavailable(session: Session): boolean {
  return !isSessionContentReadable(readSessionContentAvailability(session));
}

function resolveSessionInfoWorkspaceRef(
  session: Session,
  serverId: string | null,
): SessionFolderWorkspaceRefV1 | null {
  const metadata = isSessionInfoContentUnavailable(session)
    ? null
    : readSessionOwnerMetadataView(session);
  if (!metadata || typeof metadata !== 'object') return null;
  const record = metadata as Record<string, unknown>;
  // A no-folder session lives in its machine's Chats scope for session folders.
  if (readSessionDirectoryKind(metadata) === 'managed') {
    return normalizeSessionFolderWorkspaceRef({
      t: 'managedSessions',
      serverId,
      machineId: typeof record.machineId === 'string' ? record.machineId : null,
    });
  }
  const rootPath = typeof record.path === 'string' ? record.path : null;
  if (!rootPath) return null;
  return normalizeSessionFolderWorkspaceRef({
    t: 'workspaceScope',
    serverId,
    machineId: typeof record.machineId === 'string' ? record.machineId : null,
    rootPath,
  });
}

function buildSessionInfoMoveTargets(
  params: Readonly<{
    sessionFolders: unknown;
    workspace: SessionFolderWorkspaceRefV1 | null;
  }>,
): SessionFolderMoveTarget[] {
  if (!params.workspace) return [];
  const normalized = normalizeSessionFolders(params.sessionFolders);
  const targets: SessionFolderMoveTarget[] = [
    {
      id: 'session-info-move-folder:root',
      folderId: null,
      title: t('sessionsList.moveToWorkspaceRoot'),
      depth: 0,
      disabled: false,
    },
  ];
  targets.push(
    ...buildSessionFolderWorkspaceTargets({
      folders: normalized,
      workspace: params.workspace,
    }).map<SessionFolderMoveTarget>((folder) => ({
      ...folder,
      id: `session-info-move-folder:${folder.folderId}`,
      disabled: false,
    })),
  );
  return targets;
}

function SessionInfoContent({
  session: shellSession,
  serverId: sessionServerId,
  presentation,
  onRequestClose,
}: Readonly<{
  session: Session;
  serverId: string;
  presentation: SessionInfoPresentation;
  onRequestClose: () => void;
}>) {
  // The shared shell deliberately retains its Session across read-state updates.
  // Info consumes the viewer/cursor itself: never invalidate the whole shell or
  // subscribe this detail surface to unrelated Sessions or transcript arrivals.
  const readStateInputs = storage(useShallow((state) => {
    const current = selectSessionViewShellSessionForRouteState(state, shellSession.id, sessionServerId) ?? shellSession;
    return [current.viewer, current.lastViewedSessionSeq] as const;
  }));
  const session = React.useMemo(
    () => selectSessionViewShellSessionForRouteState(storage.getState(), shellSession.id, sessionServerId) ?? shellSession,
    [shellSession, sessionServerId, readStateInputs],
  );
  const contentUnavailable = isSessionInfoContentUnavailable(session);
  const metadata = contentUnavailable
    ? null
    : readSessionOwnerMetadataView(session);
  const { theme } = useUnistyles();
  const router = useRouter();
  const sessionActions = useMountedActionExecution(sessionServerId);
  const profile = useProfile();
  const sessionPluginAddress = useSessionAddressForSessionId(
    session.id,
    sessionServerId,
  );
  const pluginRuntime = useSessionPluginRuntime({
    address: sessionPluginAddress,
  });
  const sessionName = contentUnavailable
    ? resolveLockedSessionTitle(getSessionName(session))
    : getSessionName(session);
  const sessionStatus = useSessionStatus(session, {
    subscribeToSession: false,
    subscribeToTranscript: false,
  });
  const enabledAgentIds = useEnabledAgentIds();
  const executionRunsEnabled = useFeatureEnabled('execution.runs', {
    scopeKind: 'spawn',
    serverId: sessionServerId,
  });
  const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
  const sessionFoldersEnabled = useFeatureEnabled('sessions.folders', {
    scopeKind: 'spawn',
    serverId: sessionServerId,
  });
  // Scoped to THIS Session's server, like the in-Session picker: the child is
  // created on that server, so an unrelated selected server must not decide
  // whether this conversation may continue with another Agent.
  const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
    scopeKind: 'spawn',
    serverId: sessionServerId,
  });
  const serverSnapshot = useServerFeaturesSnapshotForServerId(sessionServerId, {
    enabled: true,
  });
  const { snapshot: acpCatalog } = useAcpCatalogForServer(sessionServerId);
  const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
  const actionsSettingsV1 = useSetting('actionsSettingsV1');
  const sessionReplayEnabled = useSetting('sessionReplayEnabled') === true;
  const settings = useSettings();
  const workspaceRefsV1 = useWorkspaceRefs();
  const machineListByServerId = useMachineListByServerId();
  const workspaceDisplay = React.useMemo(
    () =>
      resolveSessionWorkspaceDisplayPresentation({
        serverId: sessionServerId,
        metadata,
        workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
      }),
    [metadata, sessionServerId, workspaceRefsV1],
  );
  const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
  const collaborationAdmitted =
    useSessionCollaborationDestinationAdmitted(sessionServerId);
  const collaborationTarget = React.useMemo(
    () => ({ serverId: sessionServerId, sessionId: session.id }),
    [session.id, sessionServerId],
  );
  // People opens the destination's default mode; Sharing asks it for the Access focus target.
  const openSessionCollaboration = useOpenSessionCollaboration({
    target: collaborationTarget,
    replace: presentation === 'route',
  });
  const openSessionSharing = useOpenSessionCollaboration({
    target: collaborationTarget,
    replace: presentation === 'route',
    focusTarget: 'access',
  });
  const automationsSupport = useAutomationsSupport();
  const showAutomations = automationsSupport?.enabled !== false;
  // Check if CLI version is outdated
  const isCliOutdated = Boolean(
    metadata?.version &&
    !isVersionSupported(metadata.version, MINIMUM_CLI_VERSION),
  );
  // A session whose Agent the presentation reader cannot name has no brand to
  // show. Substituting the product default would present it as Claude's.
  const agentId = readSessionPresentationAgentId(session);
  const core = isBundledAgentId(agentId) ? getAgentCore(agentId) : null;
  const daemonProjectionMachineId = React.useMemo(() => {
    const raw =
      typeof (metadata as any)?.machineId === 'string'
        ? (metadata as any).machineId
        : '';
    const trimmed = String(raw ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }, [metadata]);
  const daemonMergedProjection = useDaemonMergedProjectionInputs({
    machineId: daemonProjectionMachineId,
    serverId: sessionServerId,
  });
  const daemonMergedProjectionInputs =
    daemonMergedProjection.phase === 'ready'
      ? daemonMergedProjection.inputs
      : null;
  const currentAgentCapabilities = React.useMemo(
    () =>
      readCurrentProjectedAgentCapabilities({
        projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        agentId: resolveAgentIdFromSessionMetadata(metadata),
      }),
    [daemonMergedProjectionInputs?.pluginProjectionV2, metadata],
  );
  // The mounted Session owns these availability facts. Feature decisions
  // reuse the exact Session server snapshot and canonical feature owner;
  // Session capability ids remain unknown until an exact capability owner
  // supplies them rather than being inferred from presentation state.
  const pluginPolicyContext = usePluginUiSessionPolicyEvaluationContext({
    platform: pluginRuntime.platform,
    settings,
    serverId: sessionServerId,
    serverFeaturesSnapshot: serverSnapshot,
    facts: {
      pluginEnabled: true,
      sessionAgentId: agentId,
      sessionState: sessionStatus.state,
      machineId: pluginRuntime.machineId,
      projectId: null,
      browserExists: false,
    },
  });
  const sessionInfoSections = React.useMemo(() => {
    if (contentUnavailable) return [];
    return Object.values(
      pluginRuntime.pluginUiProjection?.sessionInfoSectionsById ?? {},
    )
      .map((section) => ({
        section,
        policy: evaluatePluginUiPolicy(section, pluginPolicyContext),
      }))
      .filter((entry) => entry.policy.visible)
      .sort(
        (left, right) =>
          (left.section.order ?? 0) - (right.section.order ?? 0) ||
          left.section.id.localeCompare(right.section.id),
      );
  }, [
    contentUnavailable,
    pluginRuntime.pluginUiProjection?.sessionInfoSectionsById,
    pluginPolicyContext,
  ]);
  const sessionActionDefaultBackend = React.useMemo(
    () =>
      resolveSessionActionDefaultBackend({
        session,
        enabledAgentIds,
        fallbackAgentId: core?.id ?? null,
      }),
    [core?.id, enabledAgentIds, session],
  );
  const sessionActionDefaultBackendEntry = React.useMemo(() => {
    const target = resolveSessionActionDefaultTarget(
      sessionActionDefaultBackend,
    );
    if (!target) return null;
    if (acpCatalog?.catalog.status !== 'ready' || acpCatalog.stale) return null;
    const selectedTargetKey = resolveBackendTargetKeyV2(target);
    return (
      getResolvedBackendCatalogEntries({
        enabledAgentIds,
        acpCatalogSnapshot: acpCatalog.catalog,
        backendEnabledByTargetKey: (backendEnabledByTargetKey as any) ?? null,
        mergedProviderProjectionById:
          daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById:
          daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
        discoveredBackendIds:
          daemonMergedProjectionInputs?.discoveredBackendIds ?? undefined,
      }).find((entry) => entry.backendTargetKey === selectedTargetKey) ?? null
    );
  }, [
    acpCatalog,
    backendEnabledByTargetKey,
    daemonMergedProjectionInputs?.discoveredBackendIds,
    daemonMergedProjectionInputs?.mergedBackendProjectionById,
    daemonMergedProjectionInputs?.mergedProviderProjectionById,
    enabledAgentIds,
    sessionActionDefaultBackend,
  ]);
  const executor = React.useMemo(
    () =>
      createDefaultActionExecutor({
        resolveServerIdForSessionId: (childSessionId) => {
          const normalizedChildSessionId = normalizeSessionId(childSessionId);
          const resolvedServerId =
            resolvePreferredServerIdForSessionId(normalizedChildSessionId) ??
            sessionServerId;
          const normalizedServerId = String(resolvedServerId).trim();
          return normalizedServerId || null;
        },
        openSession: (childSessionId, options) => {
          router.push(
            buildScopedSessionRouteHref({
              sessionId: childSessionId,
              serverId: options?.serverId ?? sessionServerId,
              query: options?.query,
            }) as any,
          );
        },
      }),
    [router, sessionServerId],
  );

  const forkActionEnabled = React.useMemo(() => {
    return isActionEnabledInState(
      storage.getState() as any,
      'session.fork' as any,
      { surface: 'ui', placement: 'session_info' } as any,
    );
  }, [actionsSettingsV1]);

  const forkSupported = React.useMemo(() => {
    return (
      canForkConversation({
        session,
        replayEnabled: sessionReplayEnabled,
        agentSwitchingEnabled,
        currentAgentCapabilities,
      }) === true
    );
  }, [
    agentSwitchingEnabled,
    currentAgentCapabilities,
    session,
    sessionReplayEnabled,
  ]);
  const handoffActionEnabled = React.useMemo(() => {
    return isActionEnabledInState(
      storage.getState() as any,
      'session.handoff' as any,
      { surface: 'ui', placement: 'session_info' } as any,
    );
  }, [actionsSettingsV1]);
  const reachableMachineTarget = useSessionReachableMachineTarget(
    session.id,
    sessionServerId,
  );
  const reachableMachineId = reachableMachineTarget?.machineId ?? null;
  const sourceMachineIdForHandoff = React.useMemo(
    () =>
      resolveSessionHandoffSourceMachineId({
        reachableMachineId,
        sessionMetadata: readSessionOwnerMetadataView(session) as any,
      }),
    [reachableMachineId, session],
  );
  const runtimeAvailability = useSessionHandoffSourceReachability({
    serverId: sessionServerId,
    sourceMachineId: sourceMachineIdForHandoff,
  });
  const currentExecutionMachineId =
    reachableMachineId ?? sourceMachineIdForHandoff;
  const currentExecutionMachinePresence = useMachinePresenceSummary(
    sessionServerId,
    currentExecutionMachineId,
  );
  const currentExecutionMachine = currentExecutionMachineId
    ? (machineListByServerId[sessionServerId] ?? []).find(
        (machine) => machine.id === currentExecutionMachineId,
      )
    : null;
  const currentExecutionMachineLabel = currentExecutionMachineId
    ? getSessionMachineLabel({
        machineId: currentExecutionMachineId,
        machine: currentExecutionMachine,
        session: { machineId: metadata?.machineId, host: metadata?.host },
      })
    : null;
  const handoffAvailability = resolveSessionHandoffUiAvailability({
    sessionId: session.id,
    serverId: sessionServerId,
    reachableMachineId,
    session,
    sessionHandoffFeatureEnabled: sessionHandoffEnabled,
    serverSnapshot,
    runtimeAvailability,
  });
  const handoffSupported = handoffAvailability.available;
  // The empty Workspace sync section offers the one thing sync starts with: another machine for this folder.
  const workspaceSyncSource = workspaceDisplay.workspaceScope;
  const workspaceSyncRefId = workspaceDisplay.workspaceRefId;
  const addMachineToWorkspace = React.useMemo(
    () =>
      workspaceSyncSource
        ? () =>
            openWorkspaceSyncAddMachine(
              {
                ...workspaceSyncSource,
                ...(workspaceSyncRefId ? { id: workspaceSyncRefId } : {}),
              },
              (summary) =>
                openWorkspaceSyncRelationshipDetails(
                  summary,
                  workspaceSyncRefId,
                ),
            )
        : undefined,
    [workspaceSyncRefId, workspaceSyncSource],
  );

  const vendorResumeId = React.useMemo(
    () => getAgentVendorResumeId(metadata, agentId),
    [agentId, metadata],
  );
  const providerDisplayName = React.useMemo(
    () =>
      core ? t(core.displayNameKey) : formatAgentLikeIdForDisplay(agentId),
    [agentId, core],
  );

  const handleOpenSameSetup = React.useCallback(async () => {
    const result = await sessionActions.execute('session.authoring.open', {
      sourceSession: { serverId: sessionServerId, sessionId: session.id },
    });
    requireActionSuccess(result);
    const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
    if (opened.kind !== 'opened') throw new HappyError(t('errors.unknownError'), false,
      { code: opened.reason });
  }, [sessionActions.execute, session.id, sessionServerId]);
  const [openingSameSetup, handleNewSessionSameSetup] = useHappyAction(handleOpenSameSetup);

  // The route leaves for the Session, then the list; the panel's host decides where its pane goes.
  const handleExitAfterSessionMutation = React.useCallback(() => {
    if (presentation === 'pane') {
      onRequestClose();
      return;
    }
    safeRouterBack({
      router,
      fallbackHref: buildScopedSessionRouteHref({
        sessionId: session.id,
        serverId: sessionServerId,
      }),
    });
    safeRouterBack({
      router,
      fallbackHref: '/',
    });
  }, [onRequestClose, presentation, router, session.id, sessionServerId]);

  const organizationProjection =
    useSessionOrganizationProjection(sessionServerId);
  const organizationListViewState = React.useMemo(
    () =>
      buildSessionOrganizationListViewState({
        serverId: sessionServerId,
        projection: organizationProjection,
      }),
    [organizationProjection, sessionServerId],
  );
  const pinnedSessionKeysV1 = organizationListViewState.pinnedSessionKeysV1;
  const sessionTagsV1 = organizationListViewState.sessionTagsV1;
  const sessionFoldersV1 = organizationListViewState.sessionFoldersV1;
  const sessionSettingsKey = sessionTagKey(sessionServerId, session.id);
  const isPinnedSession = pinnedSessionKeysV1.includes(sessionSettingsKey);
  const isArchivedSession = session.archivedAt != null;
  const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
  const attentionStanding = useSessionAttentionStandingInputs(
    organizationListViewState.attentionStandingOverridesBySessionKey,
  );
  const attentionStandingEnabled = attentionStanding.actionEnabled;
  const isAttentionStandingSession = resolveSessionAttentionStanding(
    attentionStanding.policy,
    sessionSettingsKey,
  );
  const followEditor = useAccountSessionFollowEditorHost({
    serverId: sessionServerId,
    sessionId: session.id,
  });
  // Follow opens the one shared editor (header chip, menu and People use the same host) through the
  // Session Action, so an Agent and this row reach it the same way.
  const followPreset = readSessionFollowHeaderPreset(session);
  const followLevelLabel =
    followPreset && followPreset !== 'none' ? sessionFollowPresetLabel(followPreset) : null;
  const handleOpenFollow = async () => {
    await executeSessionAction({
      actionId: SESSION_ACTION_FOLLOW_ID,
      target: sessionActionTarget,
      context: { operations: { openFollowEditor: followEditor.openEditor } },
    });
  };
  const [, openFollow] = useHappyAction(handleOpenFollow);
  const sessionActionTarget = React.useMemo(
    () =>
      createSessionActionTarget({
        session,
        serverId: sessionServerId,
        currentUserId,
        isConnected: sessionStatus.isConnected,
        isPinned: isPinnedSession,
        isRailPinned:
          organizationProjection?.pinsBySessionId[session.id]?.railPinned ===
          true,
        attentionStandingEnabled,
        followEnabled: followEditor.enabled,
        attentionStanding: isAttentionStandingSession,
      }),
    [
      attentionStandingEnabled,
      followEditor.enabled,
      currentUserId,
      isAttentionStandingSession,
      isPinnedSession,
      organizationProjection,
      sessionServerId,
      session,
      sessionStatus.isConnected,
    ],
  );
  const canStopSession =
    sessionActionTarget.isActive && sessionActionTarget.canStop;
  const canArchiveSession = sessionActionTarget.canArchive;
  const archivePending = useSessionArchivePending(collaborationTarget);
  const visibleSessionActionIds = React.useMemo(() => {
    const actionIds = listVisibleSessionActionIds({
      target: sessionActionTarget,
      surface: 'sessionInfo',
    });
    return new Set(
      contentUnavailable
        ? actionIds.filter(
            (actionId) =>
              actionId === SESSION_ACTION_ARCHIVE_ID ||
              actionId === SESSION_ACTION_DELETE_ID,
          )
        : actionIds,
    );
  }, [contentUnavailable, sessionActionTarget]);
  const canRenameSession = visibleSessionActionIds.has(
    SESSION_ACTION_RENAME_ID,
  );
  const sessionInfoTagEntries = sessionTagsV1[sessionSettingsKey] ?? [];
  const sessionInfoTags = sessionInfoTagEntries.flatMap((tag) =>
    tag.display.status === 'available' ? [tag.display.value] : [],
  );
  const sessionInfoTagIds = sessionInfoTagEntries.map((tag) => tag.tagId);
  const sessionInfoTagLabelById = buildSessionOrganizationTagLabelById(
    organizationProjection?.tagsById ?? {},
  );
  const sessionInfoTagDetail = sessionInfoTagEntries
    .map((tag) =>
      tag.display.status === 'available'
        ? tag.display.value
        : t('common.unavailable'),
    )
    .join(', ');
  const getSessionOrganizationMutationScopeOrThrow = React.useCallback(
    async (
      serverIdRaw?: string | null,
    ): Promise<SessionOrganizationMutationScope> => {
      const serverId =
        typeof serverIdRaw === 'string' && serverIdRaw.trim()
          ? serverIdRaw.trim()
          : sessionServerId;
      return await requireSessionOrganizationMutationScope(serverId);
    },
    [sessionServerId],
  );
  const pinInfoItemProps = React.useMemo(
    () =>
      createSessionActionInfoItemProps({
        actionId: isPinnedSession
          ? SESSION_ACTION_UNPIN_ID
          : SESSION_ACTION_PIN_ID,
      }),
    [isPinnedSession],
  );
  const tagsInfoItemProps = React.useMemo(
    () =>
      createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_EDIT_TAGS_ID,
      }),
    [],
  );
  const moveToFolderInfoItemProps = React.useMemo(
    () =>
      createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
      }),
    [],
  );
  const stopInfoItemProps = React.useMemo(
    () =>
      createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_STOP_ID,
        archivePending,
      }),
    [archivePending],
  );
  const archiveInfoItemProps = React.useMemo(
    () =>
      createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_ARCHIVE_ID,
        archivePending,
      }),
    [archivePending],
  );
  const unarchiveInfoItemProps = React.useMemo(
    () =>
      createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_UNARCHIVE_ID,
      }),
    [],
  );
  const deleteInfoItemProps = React.useMemo(
    () =>
      createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_DELETE_ID,
      }),
    [],
  );
  const readStateActionId = React.useMemo(
    () => resolveSessionReadStateActionId(sessionActionTarget),
    [sessionActionTarget],
  );
  const readStateInfoItem = React.useMemo(
    () =>
      readStateActionId
        ? createSessionActionInfoItemProps({ actionId: readStateActionId })
        : null,
    [readStateActionId],
  );
  const attentionStandingActionId = React.useMemo(
    () => resolveSessionAttentionStandingActionId(sessionActionTarget),
    [sessionActionTarget],
  );
  const moveTargets = React.useMemo(
    () =>
      buildSessionInfoMoveTargets({
        sessionFolders: sessionFoldersV1,
        workspace: resolveSessionInfoWorkspaceRef(session, sessionServerId),
      }),
    [sessionServerId, session, sessionFoldersV1],
  );

  const handleReadStateAction = React.useCallback(async () => {
    if (!readStateActionId) return;
    await executeSessionAction({
      actionId: readStateActionId,
      target: sessionActionTarget,
      context: { operations: { setManualReadState: (sessionId, state) => sessionSetManualReadStateWithServerScope(
        sessionId, state, { serverId: sessionServerId, executeAction: sessionActions.execute }),
      } },
    });
  }, [readStateActionId, sessionActionTarget, sessionActions.execute, sessionServerId]);
  const [updatingReadState, performReadStateAction] = useHappyAction(
    handleReadStateAction,
  );

  const handleAttentionStandingAction = React.useCallback(async () => {
    if (!attentionStandingActionId) return;
    await executeSessionAction({
      actionId: attentionStandingActionId,
      target: sessionActionTarget,
      context: { operations: { setAttentionStanding: async (sessionId, standing) => {
        const result = await sessionActions.execute('session.attention.set', { sessionId, standing });
        requireActionSuccess(result);
        return { success: true };
      } } },
    });
  }, [attentionStandingActionId, sessionActionTarget, sessionActions.execute]);
  const [updatingAttentionStanding, performAttentionStandingAction] =
    useHappyAction(handleAttentionStandingAction);

  const handleTogglePinned = React.useCallback(async () => {
    await executeSessionAction({
      actionId: isPinnedSession
        ? SESSION_ACTION_UNPIN_ID
        : SESSION_ACTION_PIN_ID,
      target: sessionActionTarget,
      context: {
        operations: {
          setPinned: async (_sessionId, pinned) => {
            const result = await sessionActions.execute('session.organization.pin.set', {
              sessionId: session.id, pinned, surface: 'list',
            });
            requireActionSuccess(result);
          },
        },
      },
    });
  }, [sessionActions.execute, isPinnedSession, session.id, sessionActionTarget]);
  const [pinningSession, performTogglePinned] =
    useHappyAction(handleTogglePinned);

  const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
  const [editingTags, setEditingTags] = React.useState(false);
  const applySessionInfoTagLabels = React.useCallback(
    async (nextTags: readonly string[]) => {
      await executeSessionAction({
        actionId: SESSION_ACTION_EDIT_TAGS_ID,
        target: sessionActionTarget,
        input: { tags: [...nextTags] },
        context: {
          operations: {
            setTags: async (_sessionId, tags, opts) => {
              const scope = await getSessionOrganizationMutationScopeOrThrow(
                opts?.serverId ?? sessionServerId,
              );
              await writeSessionOrganizationTagLabels({
                scope,
                sessionId: session.id,
                tags: [...tags],
              });
            },
          },
        },
      });
    },
    [
      sessionActions.execute,
      getSessionOrganizationMutationScopeOrThrow,
      sessionServerId,
      session.id,
      sessionActionTarget,
    ],
  );
  const runSessionInfoTagUpdate = React.useCallback(
    (nextTags: readonly string[]) => {
      setEditingTags(true);
      void applySessionInfoTagLabels(nextTags)
        .catch((error) => {
          Modal.alert(
            t('common.error'),
            error instanceof HappyError
              ? error.message
              : t('errors.unknownError'),
          );
        })
        .finally(() => setEditingTags(false));
    },
    [applySessionInfoTagLabels],
  );
  const tagMenuContent = React.useMemo(
    () =>
      buildSessionTagsMenuContent({
        tags: Object.entries(sessionInfoTagLabelById).map(([id, label]) => ({
          id,
          label,
        })),
        selectedTagIds: sessionInfoTagIds,
        iconColor: theme.colors.text.secondary,
        onToggle: (tagId) => {
          const nextTagIds = sessionInfoTagIds.includes(tagId)
            ? sessionInfoTagIds.filter((candidate) => candidate !== tagId)
            : [...sessionInfoTagIds, tagId];
          runSessionInfoTagUpdate(
            nextTagIds.flatMap((id) => sessionInfoTagLabelById[id] ?? []),
          );
        },
        onCreate: (label) =>
          runSessionInfoTagUpdate([...sessionInfoTags, label]),
      }),
    [
      runSessionInfoTagUpdate,
      sessionInfoTagIds,
      sessionInfoTagLabelById,
      sessionInfoTags,
      theme.colors.text.secondary,
    ],
  );

  const handleMoveToFolder = React.useCallback(async () => {
    if (!sessionFoldersEnabled || moveTargets.length === 0) return;
    const selectedTarget = await openSessionFolderSelection({
      sourceLabel: sessionName,
      targets: moveTargets,
    });
    if (!selectedTarget) return;
    const folderId = selectedTarget.folderId;
    await executeSessionAction({
      actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
      target: sessionActionTarget,
      input: { folderId },
      context: {
        operations: {
          moveToFolder: async (_target, input) => {
            const scope =
              await getSessionOrganizationMutationScopeOrThrow(sessionServerId);
            await writeSessionOrganizationFolderAssignment({
              scope,
              sessionId: session.id,
              folderId: input?.folderId ?? null,
            });
          },
        },
      },
    });
  }, [
    getSessionOrganizationMutationScopeOrThrow,
    moveTargets,
    sessionServerId,
    session.id,
    sessionActionTarget,
    sessionFoldersEnabled,
    sessionName,
  ]);
  const [movingToFolder, performMoveToFolder] =
    useHappyAction(handleMoveToFolder);

  const handleStopAndMaybeArchive = React.useCallback(async () => {
    await executeSessionAction({
      actionId: SESSION_ACTION_STOP_ID,
      target: sessionActionTarget,
      context: { hideInactiveSessions },
    });
    // A stopped Session keeps its page: the panel stays beside it; the route returns to it.
    if (presentation === 'route') handleExitAfterSessionMutation();
  }, [
    handleExitAfterSessionMutation,
    hideInactiveSessions,
    presentation,
    sessionActionTarget,
  ]);
  const [stoppingSession, handleStopSession] = useHappyAction(
    handleStopAndMaybeArchive,
  );

  const handleArchive = React.useCallback(async () => {
    await executeSessionAction({
      actionId: SESSION_ACTION_ARCHIVE_ID,
      target: sessionActionTarget,
      context: { hideInactiveSessions },
    });
  }, [hideInactiveSessions, sessionActionTarget]);
  const [archivingSession, performArchive] = useHappyAction(handleArchive);

  const handleUnarchive = React.useCallback(async () => {
    await executeSessionAction({
      actionId: SESSION_ACTION_UNARCHIVE_ID,
      target: sessionActionTarget,
    });
  }, [sessionActionTarget]);
  const [unarchivingSession, performUnarchive] =
    useHappyAction(handleUnarchive);

  // Resume belongs to the Session's own composer (its reachability, pending activation and folder
  // recovery): Info only asks it, and only while that exact Home's composer is listening.
  const resumeListenerAvailable = useSessionResumeRequestAvailable(
    session.id,
    sessionServerId,
  );
  const handleResume = React.useCallback(async () => {
    await executeSessionAction({
      actionId: SESSION_ACTION_RESUME_ID,
      target: sessionActionTarget,
      context: {
        operations: {
          resumeSession: async (sessionId: string) => {
            await emitSessionResumeRequest(sessionId, sessionServerId);
          },
        },
      },
    });
  }, [sessionActionTarget, sessionServerId]);
  const [resumingSession, performResume] = useHappyAction(handleResume);
  const openSessionToResume = React.useCallback(() => {
    router.push(
      buildScopedSessionRouteHref({
        sessionId: session.id,
        serverId: sessionServerId,
      }) as any,
    );
  }, [router, session.id, sessionServerId]);

  // A launcher only, exactly like the Session header: strategy is chosen
  // before any fork effect is issued, from every UI entry point.
  const performFork = React.useCallback(() => {
    openSessionForkStrategyFlow({
      navigation: router,
      sessionId: session.id,
      forkSupportSource: session,
      serverId: sessionServerId,
      machineId:
        reachableMachineId ??
        readSessionOwnerMetadataView(session)?.machineId ??
        null,
      forkPoint: { type: 'latest' },
      settings,
      replayEnabled: sessionReplayEnabled,
      currentAgentCapabilities,
      executionRunsEnabled,
      agentSwitchingEnabled,
      navigateToSession: (childSessionId, options) => {
        router.push(
          buildScopedSessionRouteHref({
            sessionId: childSessionId,
            serverId: options?.serverId ?? sessionServerId,
          }) as any,
        );
      },
      navigateToNewSession: (route) => {
        router.push(route as any);
      },
    });
  }, [
    agentSwitchingEnabled,
    currentAgentCapabilities,
    executionRunsEnabled,
    reachableMachineId,
    router,
    session,
    sessionReplayEnabled,
    sessionServerId,
    settings,
  ]);

  const handleHandoffAction = React.useCallback(async () => {
    const res = await runSessionHandoffPickerFlow({
      execute: executor.execute as any,
      sessionId: session.id,
      sourceMachineId: sourceMachineIdForHandoff,
      serverId: sessionServerId,
      placement: 'session_info',
    });
    if (!res?.ok) return;
  }, [
    executor.execute,
    session.id,
    sessionServerId,
    sourceMachineIdForHandoff,
  ]);
  const [handingOffSession, performHandoff] =
    useHappyAction(handleHandoffAction);

  const handleArchiveSession = React.useCallback(async () => {
    const confirmed = await Modal.confirm(
      t('sessionInfo.archiveSession'),
      t('sessionInfo.archiveSessionConfirm'),
      {
        cancelText: t('common.cancel'),
        confirmText: t('sessionInfo.archiveSession'),
        destructive: true,
      },
    );
    if (!confirmed) return;
    await performArchive();
  }, [performArchive]);

  const [deletingSession, performDelete] = useHappyAction(async (target: typeof sessionActionTarget) => {
    await executeSessionAction({
      actionId: SESSION_ACTION_DELETE_ID,
      target,
      context: { presentUserConfirmation: { actionId: 'session.delete' } },
    });
    handleExitAfterSessionMutation();
  });

  const handleDeleteSession = React.useCallback(async () => {
    const deleteTarget = sessionActionTarget;
    const confirmed = await confirmSessionDelete({
      metadata,
      machineOnline: currentExecutionMachinePresence.reachability === 'unknown'
        ? null : currentExecutionMachinePresence.reachability === 'reachable',
      machineLabel: currentExecutionMachineLabel ?? metadata?.host ?? null,
    });
    if (!confirmed) return;
    await performDelete(deleteTarget);
  }, [currentExecutionMachinePresence.reachability, currentExecutionMachineLabel, metadata, performDelete, sessionActionTarget]);

  const [, handleRenameSession] = useHappyAction(async () => {
    if (!canRenameSession) return;
    const newName = await Modal.prompt(
      t('sessionInfo.renameSession'),
      t('sessionInfo.renameSessionSubtitle'),
      {
        defaultValue: sessionName,
        placeholder: t('sessionInfo.renameSessionPlaceholder'),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    if (newName?.trim()) {
      await executeSessionAction({
        actionId: SESSION_ACTION_RENAME_ID,
        target: sessionActionTarget,
        input: { title: newName },
      });
    }
  });

  const updateCommand = 'happier self update';
  const aiProviderTitle = resolveSessionActionDefaultBackendTitle({
    session,
    sessionActionDefaultBackendEntryTitle:
      sessionActionDefaultBackendEntry?.title ?? null,
    fallbackTitle: providerDisplayName,
  });
  const identityMachineLabel =
    currentExecutionMachineLabel ?? metadata?.host ?? null;
  const identityPath =
    metadata?.path && readSessionDirectoryKind(metadata) !== 'managed'
      ? formatSessionPath(metadata.path, metadata.homeDir)
      : null;

  // One contextual action, only while it applies: what blocks use (the CLI notice carries its own
  // Copy), then Unarchive, then Resume through the Session's composer (or open it there).
  const contextAction: SessionInfoContextAction | null =
    contentUnavailable || isCliOutdated
      ? null
      : isArchivedSession &&
          sessionActionTarget.canUnarchive &&
          unarchiveInfoItemProps
        ? {
            id: 'unarchive',
            label: t('sessionPages.info.unarchive'),
            icon: 'archive',
            loading: unarchivingSession,
            onPress: performUnarchive,
          }
        : !isArchivedSession && sessionActionTarget.canResume
          ? resumeListenerAvailable
            ? {
                id: 'resume',
                label: t('sessionPages.info.resume'),
                icon: 'play',
                loading: resumingSession,
                onPress: performResume,
              }
            : presentation === 'route'
              ? {
                  id: 'open-to-resume',
                  label: t('sessionPages.info.openToResume'),
                  icon: 'arrow-right',
                  loading: false,
                  onPress: openSessionToResume,
                }
              : null
          : null;

  const showStop =
    sessionStatus.isConnected && canStopSession && stopInfoItemProps;
  const showArchive =
    !isArchivedSession && canArchiveSession && archiveInfoItemProps;
  const showUnarchive =
    isArchivedSession &&
    sessionActionTarget.canUnarchive &&
    unarchiveInfoItemProps &&
    !contentUnavailable;
  const showDelete =
    visibleSessionActionIds.has(SESSION_ACTION_DELETE_ID) &&
    deleteInfoItemProps;
  const showPin = !isArchivedSession && Boolean(pinInfoItemProps);
  const showFolder =
    sessionFoldersEnabled &&
    moveTargets.length > 0 &&
    Boolean(moveToFolderInfoItemProps);
  const retentionSummary = useSessionRetentionSummary(
    contentUnavailable ? null : sessionServerId,
  );
  // The model the Session runs now, named by its own catalog; an unknown model is left out, never guessed.
  const sessionModels = readSessionModelsState(metadata);
  const currentModelName =
    sessionModels?.availableModels.find((model) => model.id === sessionModels.currentModelId)?.name ?? null;
  // The route's title is the Session's name, renamed in place through the same Action as the menu.
  const [titleDraft, setTitleDraft] = React.useState<string | null>(null);
  const commitTitle = React.useCallback(() => {
    const next = titleDraft?.trim() ?? '';
    setTitleDraft(null);
    if (!next || next === sessionName) return;
    void executeSessionAction({
      actionId: SESSION_ACTION_RENAME_ID,
      target: sessionActionTarget,
      input: { title: next },
    }).catch((error) => {
      Modal.alert(t('common.error'), error instanceof HappyError ? error.message : t('errors.unknownError'));
    });
  }, [sessionActionTarget, sessionName, titleDraft]);
  const routeTitleEditor =
    presentation === 'route' && canRenameSession
      ? {
          value: titleDraft ?? sessionName,
          placeholder: t('sessionInfo.renameSessionPlaceholder'),
          accessibilityLabel: t('sessionInfo.renameSession'),
          onChangeText: setTitleDraft,
          onCommit: commitTitle,
          testID: 'session-info-title-field',
        }
      : undefined;
  const routeMenuActions =
    presentation === 'route' && canRenameSession
      ? [
          {
            id: 'rename',
            testID: 'session-info-rename',
            title: t('sessionInfo.renameSession'),
            onSelect: handleRenameSession,
          },
        ]
      : [];

  useCurrentUiContextLocalCommands(React.useMemo(() => contentUnavailable ? [] : [
    { key: 'session.info.same-setup', title: t('sessionInfo.newSessionSameSetup'), invoke: handleOpenSameSetup },
    ...(followEditor.enabled ? [{ key: 'session.info.follow', title: t('sessionPages.info.follow'), invoke: handleOpenFollow }] : []),
    ...(collaborationAdmitted ? [
      { key: 'session.info.people', title: t('sessionPages.info.people'), invoke: openSessionCollaboration },
      { key: 'session.info.sharing', title: t('sessionPages.info.sharing'), invoke: openSessionSharing },
    ] : []),
    ...(showUnarchive ? [{ key: 'session.info.unarchive', title: t('sessionPages.info.unarchive'), invoke: handleUnarchive }] : []),
    ...(contextAction?.id === 'resume' ? [{ key: 'session.info.resume', title: t('sessionPages.info.resume'), invoke: handleResume }] : []),
    ...(contextAction?.id === 'open-to-resume' ? [{ key: 'session.info.open-to-resume', title: t('sessionPages.info.openToResume'), invoke: openSessionToResume }] : []),
  ], [collaborationAdmitted, contentUnavailable, contextAction?.id, followEditor.enabled,
    handleOpenSameSetup, handleOpenFollow, openSessionCollaboration, openSessionSharing,
    openSessionToResume, handleResume, handleUnarchive, showUnarchive]));

  return (
    <ItemList style={{ paddingTop: 0 }}>
      <SessionInfoIdentity
        presentation={presentation}
        session={session}
        sessionName={sessionName}
        agentId={agentId}
        status={sessionStatus}
        meta={[aiProviderTitle, currentModelName, identityMachineLabel].filter(
          (fact): fact is string => Boolean(fact),
        )}
        titleEditor={routeTitleEditor}
        path={identityPath}
        agentMark={
          agentId ? (
            <SessionAgentCatalogIdentityIcon
              agentId={agentId}
              machineId={daemonProjectionMachineId}
              serverId={sessionServerId}
              size={14}
              color={theme.colors.text.secondary}
            />
          ) : undefined
        }
        contextAction={contextAction}
        menuActions={routeMenuActions}
        onClose={onRequestClose}
      />

      {/* What blocks use comes first: an outdated CLI, with the command to copy. */}
      {!contentUnavailable && isCliOutdated ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="session-info-cli-notice"
            kind="warning"
            layout="inline"
            title={
              identityMachineLabel
                ? t('sessionPages.info.cliNoticeTitle', {
                    machine: identityMachineLabel,
                  })
                : t('sessionInfo.cliVersionOutdated')
            }
            reason={t('sessionPages.info.cliNoticeReason', {
              version: MINIMUM_CLI_VERSION,
              command: updateCommand,
            })}
            action={{
              label: t('common.copy'),
              onPress: () => {
                void setClipboardStringSafe(updateCommand);
              },
            }}
          />
        </ItemGroup>
      ) : null}

      {/* Setup: how the agent works here. Habits: what starts from it and what writes into it. */}
      {!contentUnavailable ? (
        <SessionSetupSections session={session} serverId={sessionServerId} />
      ) : null}
      {!contentUnavailable ? (
        <SessionHabitsSection
          sessionId={session.id}
          serverId={sessionServerId}
          onOpenAllAutomations={
            showAutomations
              ? () =>
                  router.push(
                    buildScopedSessionRouteHref({
                      sessionId: session.id,
                      serverId: sessionServerId,
                      suffix: '/automations',
                    }) as any,
                  )
              : undefined
          }
        />
      ) : null}

      {/* Organize: where this session shows up in your lists, and what reaches you about it. */}
      {!contentUnavailable ? (
        <ItemGroup title={t('sessionPages.info.organizeTitle')}>
          {showFolder && moveToFolderInfoItemProps ? (
            <Item
              {...moveToFolderInfoItemProps}
              icon={<Icon name="folder" />}
              subtitle={undefined}
              onPress={performMoveToFolder}
              loading={movingToFolder}
            />
          ) : null}
          {tagsInfoItemProps ? (
            <DropdownMenu
              open={tagMenuOpen}
              onOpenChange={setTagMenuOpen}
              items={tagMenuContent.dropdownItems}
              onSelect={tagMenuContent.dropdownOnSelect}
              closeOnSelect={false}
              onCreateItem={tagMenuContent.dropdownOnCreate}
              search
              searchPlaceholder={t('sessionTags.searchOrAddPlaceholder')}
              emptyLabel={t('sessionTags.noTagsFound')}
              placement="auto-vertical"
              variant="slim"
              matchTriggerWidth={false}
              maxWidthCap={320}
              trigger={({ toggle }) => (
                <Item
                  {...tagsInfoItemProps}
                  title={t('sessionPages.info.tags')}
                  subtitle={undefined}
                  icon={<Icon name="tag" />}
                  detail={sessionInfoTagDetail || t('sessionPages.info.addTag')}
                  onPress={toggle}
                  loading={editingTags}
                />
              )}
            />
          ) : null}
          {showPin && pinInfoItemProps ? (
            <Item
              testID={pinInfoItemProps.testID}
              title={t('sessionPages.info.pinned')}
              icon={<Icon name="push-pin" />}
              onPress={performTogglePinned}
              loading={pinningSession}
              showChevron={false}
              rightElement={
                <Switch
                  value={isPinnedSession}
                  onValueChange={() => performTogglePinned()}
                  disabled={pinningSession}
                  accessibilityLabel={t('sessionPages.info.pinned')}
                />
              }
            />
          ) : null}
          {followEditor.enabled ? (
            <View ref={followEditor.anchorRef} collapsable={false}>
              <Item
                testID="session-info-follow"
                title={t('sessionPages.info.follow')}
                icon={<Icon name="bell" />}
                pressableRef={followEditor.triggerRef}
                detail={followLevelLabel ?? undefined}
                onPress={openFollow}
              />
              {followEditor.editor}
            </View>
          ) : null}
          {attentionStandingActionId ? (
            <Item
              testID="session-info-attention-standing"
              title={t('sessionPages.info.keepInNeedsYou')}
              subtitle={t('sessionPages.info.keepInNeedsYouSubtitle')}
              icon={<Icon name="tray" />}
              onPress={performAttentionStandingAction}
              loading={updatingAttentionStanding}
              showChevron={false}
              rightElement={
                <Switch
                  value={isAttentionStandingSession}
                  onValueChange={() => performAttentionStandingAction()}
                  disabled={updatingAttentionStanding}
                  accessibilityLabel={t('sessionPages.info.keepInNeedsYou')}
                />
              }
            />
          ) : null}
          {readStateInfoItem ? (
            <Item
              {...readStateInfoItem}
              subtitle={undefined}
              icon={<Icon name="circle" />}
              showChevron={false}
              onPress={performReadStateAction}
              loading={updatingReadState}
            />
          ) : null}
        </ItemGroup>
      ) : null}

      {/* Continue: new work from where this session is. */}
      {!contentUnavailable ? (
        <ItemGroup title={t('sessionPages.info.continueTitle')}>
          <Item
            testID="session-info-new-session-same-setup"
            title={t('sessionInfo.newSessionSameSetup')}
            icon={<Icon name="plus-square" />}
            showChevron={false}
            onPress={handleNewSessionSameSetup}
            loading={openingSameSetup}
          />
          {session.access?.role === 'owner' &&
          forkActionEnabled &&
          forkSupported ? (
            <Item
              testID="session-info-fork-session"
              title={t('sessionPages.info.fork')}
              detail={t('sessionPages.info.forkDetail')}
              icon={<Icon name="git-branch" />}
              showChevron={false}
              onPress={performFork}
            />
          ) : null}
          {session.access?.role === 'owner' &&
          handoffActionEnabled &&
          handoffSupported ? (
            <Item
              testID="session-info-hand-off"
              title={t('sessionPages.info.handOff')}
              detail={t('sessionPages.info.handOffDetail')}
              accessibilityHint={getActionSpec('session.handoff').description}
              icon={<Icon name="arrows-left-right" />}
              showChevron={false}
              onPress={performHandoff}
              loading={handingOffSession}
            />
          ) : null}
        </ItemGroup>
      ) : null}

      {/* People and access: navigation only; the People pane owns who hears about it and access. */}
      {!contentUnavailable &&
      (collaborationAdmitted || sessionActionTarget.isOwnedByCurrentUser) ? (
        <ItemGroup title={t('sessionPages.info.peopleTitle')}>
          {collaborationAdmitted ? (
            <Item
              testID="session-info-collaboration"
              icon={<Icon name="users" />}
              title={t('sessionPages.info.people')}
              onPress={openSessionCollaboration}
            />
          ) : null}
          {collaborationAdmitted ? (
            <Item
              testID="session-info-sharing"
              icon={<Icon name="share" />}
              title={t('sessionPages.info.sharing')}
              onPress={openSessionSharing}
            />
          ) : null}
          {sessionActionTarget.isOwnedByCurrentUser ? (
            <Item
              testID="session-info-remote-permission-grants"
              icon={<Icon name="shield-check" />}
              title={t('sessionRemotePermissionGrants.entryTitle')}
              onPress={() =>
                router.push(
                  buildScopedSessionRouteHref({
                    sessionId: session.id,
                    serverId: sessionServerId,
                    suffix: '/permissions',
                  }) as any,
                )
              }
            />
          ) : null}
        </ItemGroup>
      ) : null}

      {!contentUnavailable ? (
        <WorkspaceSyncRelationshipList
          workspaceRefId={workspaceDisplay.workspaceRefId}
          onAddMachine={addMachineToWorkspace}
        />
      ) : null}

      {sessionInfoSections.map(({ section, policy }) => (
        <ItemGroup key={section.id} surface="none">
          <PluginInlineSurfaceHost
            placement={section.placement}
            inlineMount={{
              role: 'sessionInfoSection',
              presentation: 'content',
            }}
            sessionId={session.id}
            machineId={pluginRuntime.machineId}
            serverId={pluginRuntime.serverId}
            pluginUiProjection={pluginRuntime.pluginUiProjection}
            platform={pluginRuntime.platform}
            projectionInteractionEnabled={
              pluginRuntime.phase === 'current' &&
              pluginRuntime.interactionEnabled === true &&
              policy.enabled
            }
            policyContext={pluginPolicyContext}
          />
        </ItemGroup>
      ))}

      {!contentUnavailable ? (
        <SessionInfoAboutSection
          session={session}
          metadata={metadata}
          serverId={sessionServerId}
          agentId={agentId}
          agentTitle={aiProviderTitle}
          providerDisplayName={providerDisplayName}
          isConnected={sessionStatus.isConnected}
          isCliOutdated={isCliOutdated}
          vendorResumeId={vendorResumeId}
          vendorResumeLabel={
            core?.resume.uiVendorResumeIdLabelKey
              ? t(core.resume.uiVendorResumeIdLabelKey)
              : null
          }
          executionMachineId={reachableMachineId}
          executionMachineLabel={currentExecutionMachineLabel}
          machineList={machineListByServerId[sessionServerId] ?? undefined}
          showUsage
        />
      ) : null}

      {!contentUnavailable ? (
        <SessionInfoDeveloperSection
          session={session}
          metadata={metadata}
          serverId={sessionServerId}
          providerDisplayName={providerDisplayName}
          vendorResumeIdField={core?.resume.vendorResumeIdField}
          status={sessionStatus}
        />
      ) : null}

      {/* Leave: quiet buttons; the irreversible one stands apart at the end. */}
      {showStop || showArchive || showUnarchive || showDelete ? (
        <ItemGroup
          title={t('sessionPages.info.leaveTitle')}
          description={
            retentionSummary
              ? `${t('sessionPages.info.leaveFootnote')} ${retentionSummary}`
              : t('sessionPages.info.leaveFootnote')
          }
          surface="none"
          accessibilityLabel={t('sessionPages.info.leaveLabel')}
        >
          <View
            testID="session-info-leave-actions"
            style={stylesheet.leaveActions}
          >
            {showStop && stopInfoItemProps ? (
              <RoundButton
                testID={stopInfoItemProps.testID}
                size="small"
                display="secondary"
                title={stopInfoItemProps.title}
                titleNumberOfLines="complete"
                accessibilityHint={stopInfoItemProps.subtitle}
                onPress={handleStopSession}
                loading={stoppingSession}
                disabled={stopInfoItemProps.disabled}
              />
            ) : null}
            {showArchive && archiveInfoItemProps ? (
              <RoundButton
                testID={archiveInfoItemProps.testID}
                size="small"
                display="secondary"
                title={archiveInfoItemProps.title}
                titleNumberOfLines="complete"
                accessibilityHint={archiveInfoItemProps.subtitle}
                onPress={handleArchiveSession}
                loading={archivingSession || archivePending}
                disabled={archiveInfoItemProps.disabled}
              />
            ) : null}
            {showUnarchive && unarchiveInfoItemProps ? (
              <RoundButton
                testID={unarchiveInfoItemProps.testID}
                size="small"
                display="secondary"
                title={unarchiveInfoItemProps.title}
                titleNumberOfLines="complete"
                accessibilityHint={unarchiveInfoItemProps.subtitle}
                onPress={performUnarchive}
                loading={unarchivingSession}
              />
            ) : null}
            <View style={stylesheet.leaveSpacer} />
            {showDelete && deleteInfoItemProps ? (
              <RoundButton
                testID={deleteInfoItemProps.testID}
                size="small"
                display="destructive"
                title={deleteInfoItemProps.title}
                titleNumberOfLines="complete"
                accessibilityHint={deleteInfoItemProps.subtitle}
                onPress={handleDeleteSession}
                loading={deletingSession}
              />
            ) : null}
          </View>
        </ItemGroup>
      ) : null}
    </ItemList>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  content: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  stateHost: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.s16,
  },
  leaveActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  // Pushes "Delete" to the far edge when the row fits, apart from the recoverable actions.
  leaveSpacer: {
    flexGrow: 1,
  },
}));
