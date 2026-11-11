import { useOpenBotTemplate } from '@/components/sessions/bots/templates/openBotTemplate';
import { useDeleteBotTemplate } from '@/components/sessions/bots/templates/useDeleteBotTemplate';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { SessionActionId } from './sessionActionTypes';
import { useSessionActionNavigation } from '@/hooks/session/useSessionActionNavigation';
import { confirmSessionDelete } from './confirmSessionDelete';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useSessionArchivePending } from '@/hooks/session/useSessionArchivePending';
import { confirmSessionArchive } from '@/components/sessions/actions/confirmSessionArchive';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';
import {
  buildSessionAppearanceColorMenuItem,
  resolveSessionAppearanceColorMenuChoice,
} from '@/components/sessions/organization/sessionAppearanceColorMenu';
import {
  useCustomSessionAppearanceColors,
  useSessionAppearancesSupported,
  useSessionOwnAppearanceColor,
} from '@/hooks/session/useSessionAppearance';
import { requireSessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/requireSessionOrganizationMutationScope';
import { writeSessionOrganizationAppearance } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { useDetailsTabHeaderActionsCompact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Platform, View } from 'react-native';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useWorkspaceOpenActions } from '@/components/appShell/workspace/useWorkspaceOpenActions';

import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import { storage, useProfile, useSetting, useSessionOrganizationProjection } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { readAgentSessionCompactionAvailability, readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { useOpenExecutionRunLauncherDraft } from '@/components/sessions/runs/launcher/useOpenExecutionRunLauncherDraft';
import { t } from '@/text';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';
import { useSessionHandoffAction } from '@/sync/domains/sessionHandoff/useSessionHandoffAction';
import {
  resolveSessionHandoffUiAvailability,
} from '@/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { SessionFollowHeaderChip } from '@/components/sessions/follow/SessionFollowHeaderChip';
import { useIsTablet } from '@/utils/platform/responsive';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
  resolveSessionActionDefaultBackend,
  resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { resolveSessionTargetServerId } from '@/components/sessions/model/resolveSessionTargetServerId';
import { getVoiceAgentSessionTeleportAvailability } from '@/voice/agent/getVoiceAgentSessionTeleportAvailability';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { useHasGlobalVoiceAgentConversation } from '@/voice/agent/useHasGlobalVoiceAgentConversation';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { readExternalSessionFollowPolicy } from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { setExternalSessionFollowPolicy } from '@/components/sessions/external/follow/setExternalSessionFollowPolicy';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import {
  executeSessionAction,
} from '@/components/sessions/actions/sessionActionExecution';
import {
  createSessionActionTarget,
  describeSessionActionTargetDecisions,
} from '@/components/sessions/actions/sessionActionContext';
import {
  createSessionActionDropdownItem,
} from '@/components/sessions/actions/sessionActionPresentation';
import {
  listVisibleSessionActionIds,
} from '@/components/sessions/actions/sessionActionAvailability';
import {
  SESSION_ACTION_ARCHIVE_ID,
  SESSION_ACTION_DELETE_ID,
  SESSION_ACTION_RENAME_ID,
  SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
  SESSION_ACTION_RESUME_ID,
  resolveManualReadStateFromSessionActionId,
} from '@/components/sessions/actions/sessionActionIds';
import { buildSessionMetadataStabilitySignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { HappyError } from '@/utils/errors/errors';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import {
  PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX,
  dispatchPluginSessionHeaderAction,
  type PluginSessionHeaderActionPresentation,
} from './pluginHeaderActions';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { resolveSessionAttentionStanding } from '@/sync/domains/session/organization/attentionStanding';
import { useSessionAttentionStandingInputs } from '@/hooks/session/useSessionAttentionStandingInputs';
import { sessionTagKey } from '@/components/sessions/shell/sessionTagUtils';
import {
  SESSION_HEADER_ACTION_SIZE_PX,
} from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { SessionHeaderActionButton, SessionHeaderGlyph, useSessionHeaderActionHitReach } from '@/components/sessions/actions/SessionHeaderActionButton';
import { ChromeGlyphEmphasisContext } from '@/components/ui/icons/chromeGlyphInk';
import { useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { buildSessionDebugInformationForSession } from '@/components/sessions/debug/sessionDebugInformation';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { copySessionDebugInformationToClipboard, isSessionCopyActionId } from '@/components/sessions/debug/sessionDebugClipboard';
import { createSessionCopyMenuItem } from '@/components/sessions/debug/sessionDebugMenuItem';
import { resolveBugReportAccountIdForServer } from '@/components/settings/bugReports/bugReportSessionTarget';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { supportsExternalSessionBackgroundFollow } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { openSessionFollowDestinationPicker } from '@/components/sessions/follow/openSessionFollowDestinationPicker';
import { useSessionCompanionController } from '@/components/sessions/companion/state/useSessionCompanionController';
import {
  resolveSessionCompanionHeaderAccessibilityLabel,
  type SessionCompanionHeaderIntent,
} from '@/components/sessions/companion/sessionCompanionHeaderIntent';
import { SessionCompanionHeaderButton } from '@/components/sessions/companion/SessionCompanionHeaderButton';
import { applySessionCompanionHumanIntent } from '@/components/sessions/companion/presentation/sessionCompanionHumanAction';
import type { SessionCompanionMutationOutcome } from '@/components/sessions/companion/state/useSessionCompanionController';
import { useSessionCompanionRevealPort } from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createSessionPeopleMenuItem, useSessionPeopleAttentionLabel } from './sessionHeaderPeopleMenuItem';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
  SESSION_HEADER_MENU_SPEC_PRESENTATION,
  composeSessionHeaderMenu,
  resolveSessionHeaderExtraItemGroup,
  type SessionHeaderMenuGroup,
} from './sessionHeaderMenuGroups';
import { getSessionActionMetadata } from './sessionActionMetadata';
import { useOpenSessionComputerScreen } from '@/components/computer/useOpenSessionComputerScreen';

const SESSION_FOLLOW_IN_ANOTHER_SESSION_ACTION_ID = 'follow.set';

function resolveSessionHandoffMenuSubtitle(handoffAvailability: ReturnType<typeof resolveSessionHandoffUiAvailability>, fallbackSubtitle: string | undefined): string | undefined {
  if (handoffAvailability.available) {
    return fallbackSubtitle;
  }

  switch (handoffAvailability.reason) {
    case 'handoff_feature_disabled':
      return t('common.disabled');
    case 'session_ineligible':
    case 'transport_unavailable':
    case 'runtime_direct_peer_unavailable':
      return t('common.unavailable');
  }
}

type SessionHeaderActionMenuProps = Readonly<{
  sessionId: string;
  session: Session;
  /**
   * Optional extra items to include in the action menu (typically from adjacent header icon actions
   * that are folded into the three-dots menu on narrow layouts).
   *
   * Extra item IDs must not collide with protocol action spec IDs.
   */
  extraItems?: ReadonlyArray<DropdownMenuItem>;
  /**
   * Optional handler for selecting extra items. Return `true` when the selection was handled.
   * This is primarily used to bridge extra items that need access to parent-owned state (e.g.
   * opening a pane tab) without adding new cross-cutting dependencies here.
   */
  onSelectExtraItem?: (actionId: string) => boolean;
  pluginUiProjection?: PluginUiProjectionModel | null;
  /** Exact Session-scope authority; never reconstruct it from header state. */
  pluginUiScopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
  /** Existing Account-scope lifetime predicate for the rendered header authority. */
  pluginUiScopeIsCurrent?: (() => boolean) | null;
  /** Exact route Account authority for draft-producing Session actions. */
  actionAccountLifetime?: ServerAccountScopeLifetime | null;
  onOpenPluginSurface?: PluginSurfaceOpenHandler;
  /** One normalized list from the Session header's responsive-policy owner. */
  pluginHeaderActions?: readonly PluginSessionHeaderActionPresentation[];
  /** The Session header's bounded direct/overflow policy, never plugin metadata. */
  pluginHeaderActionPlacement?: 'direct' | 'overflow';
  /** Final placement from the Session header's one optional-action selector. */
  companionHeaderActionPlacement?: 'direct' | 'overflow' | null;
  /** One semantic descriptor consumed by both Companion presentations. */
  companionHeaderIntent?: SessionCompanionHeaderIntent | null;
  /** Live collaboration presentation stays inside this memoized header child. */
  collaborationHeader?: Readonly<{
    target: SessionAddress;
    compact: boolean;
  }>;
  /**
   * The Session's right rail is not on screen: People and Computer, which the rail carries, are reached
   * from this menu instead (calm-shell R2-1), through their own openers.
   */
  destinationsInMenu?: boolean;
  /** A header control that sits just before the ⋯ (the no-rail (i)), after Follow (lab cshead H1p). */
  beforeMenu?: React.ReactNode;
}>;

function readCurrentSessionForOpenMenu(sessionId: string, fallback: Session): Session {
  const current = storage.getState().sessions[sessionId];
  if (!current) return fallback;

  const fallbackServerId = typeof fallback.serverId === 'string' ? fallback.serverId.trim() : '';
  if (!fallbackServerId) return current;

  const currentServerId = typeof current.serverId === 'string' ? current.serverId.trim() : '';
  return currentServerId
    && areServerProfileIdentifiersEquivalent(currentServerId, fallbackServerId)
    ? current
    : fallback;
}

function readCurrentSessionActionTargetSnapshot(
  state: Pick<StorageState, 'sessionListRowsByServerId'>,
  sessionId: string,
  serverId: string | null,
  fallback: Session,
) {
  const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
  const scopedRenderable = normalizedServerId
    ? state.sessionListRowsByServerId?.[normalizedServerId]?.[sessionId]
    : undefined;
  return scopedRenderable ?? fallback;
}

function showSessionHeaderActionError(error: unknown): void {
  if (error instanceof HappyError) {
    Modal.alert(t('common.error'), error.message);
    return;
  }
  Modal.alert(t('common.error'), t('errors.unknownError'));
}

type WebActionMenuTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & Readonly<{
  'data-testid': string;
  ref?: React.Ref<HTMLButtonElement>;
  style: React.CSSProperties;
}>;

const WEB_MENU_TRIGGER_STYLE: React.CSSProperties = {
  position: 'relative',
  width: SESSION_HEADER_ACTION_SIZE_PX,
  height: SESSION_HEADER_ACTION_SIZE_PX,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  margin: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
};
const WEB_MENU_TRIGGER_RESTING_STYLE = { width: SESSION_HEADER_ACTION_SIZE_PX, height: SESSION_HEADER_ACTION_SIZE_PX };

/**
 * The header ⋯ on the web is a native `button` (its click opens the menu from the keyboard and the
 * pointer alike). It is drawn at the header action square; a finger reaches past it through the
 * shared hit-area frame, never through a larger button.
 */
function SessionHeaderMenuWebTrigger(props: Readonly<{
  label: string;
  onToggle: () => void;
  triggerRef: { current: View | null };
  children: React.ReactNode;
}>) {
  const [engaged, setEngaged] = React.useState(false);
  const hitArea = useHappierHitArea({
    restingStyle: () => WEB_MENU_TRIGGER_RESTING_STYLE,
    hitReach: useSessionHeaderActionHitReach(),
  });
  const webTriggerProps: WebActionMenuTriggerProps = {
    type: 'button',
    ref: (node) => { props.triggerRef.current = node as unknown as View; },
    'data-testid': 'session-header-action-menu-trigger',
    role: 'button',
    'aria-label': props.label,
    onClick: (event) => {
      if (!event) return;
      event.stopPropagation();
      props.onToggle();
    },
    style: WEB_MENU_TRIGGER_STYLE,
    // A raw button has no pressable state: it feeds pointer and keyboard engagement to the chrome ink.
    onMouseEnter: () => setEngaged(true),
    onMouseLeave: () => setEngaged(false),
    onFocus: (event) => setEngaged(event.currentTarget.matches(':focus-visible')),
    onBlur: () => setEngaged(false),
  };
  return React.createElement('button', webTriggerProps, hitArea.frame,
    <ChromeGlyphEmphasisContext.Provider value={engaged}>{props.children}</ChromeGlyphEmphasisContext.Provider>);
}

function areSessionActionMenuMetadataSemanticallyEqual(
  prev: Session,
  next: Session,
): boolean {
  if (prev === next) return true;
  return (
    buildSessionMetadataStabilitySignature(prev.metadata)
      === buildSessionMetadataStabilitySignature(next.metadata)
    && buildSessionMetadataStabilitySignature(readSessionOwnerMetadataView(prev))
      === buildSessionMetadataStabilitySignature(readSessionOwnerMetadataView(next))
  );
}

function didSessionHeaderActionMenuPropsChange(
  prev: SessionHeaderActionMenuProps,
  next: SessionHeaderActionMenuProps,
): boolean {
  if (prev.sessionId !== next.sessionId) return true;
  if (prev.extraItems !== next.extraItems) return true;
  if (prev.onSelectExtraItem !== next.onSelectExtraItem) return true;
  if (prev.pluginUiProjection !== next.pluginUiProjection) return true;
  if (prev.pluginUiScopedLaunchFacts !== next.pluginUiScopedLaunchFacts) return true;
  if (prev.pluginUiScopeIsCurrent !== next.pluginUiScopeIsCurrent) return true;
  if (prev.actionAccountLifetime !== next.actionAccountLifetime) return true;
  if (prev.onOpenPluginSurface !== next.onOpenPluginSurface) return true;
  if (prev.pluginHeaderActions !== next.pluginHeaderActions) return true;
  if (prev.pluginHeaderActionPlacement !== next.pluginHeaderActionPlacement) return true;
  if (prev.companionHeaderActionPlacement !== next.companionHeaderActionPlacement) return true;
  if (prev.companionHeaderIntent !== next.companionHeaderIntent) return true;
  if (prev.collaborationHeader !== next.collaborationHeader) return true;
  if (prev.destinationsInMenu !== next.destinationsInMenu) return true;
  // The header's resolved props are cached, so this element changes only with the header's own facts.
  if (prev.beforeMenu !== next.beforeMenu) return true;
  if (prev.session.serverId !== next.session.serverId) return true;
  if (!areSessionActionMenuMetadataSemanticallyEqual(prev.session, next.session)) return true;
  if (prev.session.active !== next.session.active) return true;
  if (prev.session.owner !== next.session.owner) return true;
  if (prev.session.archivedAt !== next.session.archivedAt) return true;
  if (prev.session.access !== next.session.access) return true;
  return (prev.session.seq > 0) !== (next.session.seq > 0);
}

function SessionHeaderActionMenuInner(props: SessionHeaderActionMenuProps) {
  const openExecutionRunDraft = useOpenExecutionRunLauncherDraft();
  const presentationActive = useLayoutPresentationActive();
  const followControllerRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    followControllerRef.current = controller;
    const retirement = props.actionAccountLifetime?.onRetire(() => controller.abort());
    if (!presentationActive) controller.abort();
    return () => { controller.abort(); retirement?.dispose(); };
  }, [presentationActive, props.actionAccountLifetime, props.sessionId]);
  const { theme } = useUnistyles();
  const currentUiContextReader = useOptionalCurrentUiContextReader();
  const findSurfaceRuntime = useFindSurfaceRuntime();
  const cockpitNavigation = useSessionCockpitSurfaceNavigation();
  const router = useRouter();
  const enabledAgentIds = useEnabledAgentIds();
  const settings = useSettingsValues(['actionsSettingsV1', 'experiments', 'featureToggles', 'backendEnabledByTargetKey']);
  const profileId = useProfile(profile => profile?.id ?? null);
  const actionDraftAccountScope = props.actionAccountLifetime?.isCurrent() === true
    ? props.actionAccountLifetime.scope
    : null;
  const sessionReplayEnabled = useSetting('sessionReplayEnabled');
  const voice = useSetting('voice');
  const hasGlobalVoiceAgentConversation = useHasGlobalVoiceAgentConversation();
  const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
  const [open, setOpen] = React.useState(false);
  // People is a rail destination; the header's ⋯ carries it (with its conversation attention) only
  // while the rail is not on screen. No named-viewer presence is read for a header entry any more.
  const collaborationAttentionLabel = useSessionPeopleAttentionLabel(
    props.destinationsInMenu === true ? props.collaborationHeader?.target ?? null : null,
  );
  const session = React.useMemo(
    () => open ? readCurrentSessionForOpenMenu(props.sessionId, props.session) : props.session,
    [open, props.session, props.sessionId],
  );
  const preferredSessionServerId = usePreferredServerIdForSession({
    serverId: session.serverId ?? null,
    sessionId: props.sessionId,
  });
  const sessionServerId = React.useMemo(
    () => resolveSessionTargetServerId(props.sessionId, preferredSessionServerId ?? session.serverId ?? null),
    [preferredSessionServerId, session.serverId, props.sessionId],
  );
  const giveBotCopy = useOpenBotTemplate(session, sessionServerId ?? '', true);
  const deleteBotTemplate = useDeleteBotTemplate(session);
  const workspaceOpen = useWorkspaceOpenActions(buildScopedSessionRouteHref({
    sessionId: props.sessionId, serverId: sessionServerId ?? null,
  }));
  const navigateAfterDelete = useSessionActionNavigation({
    sessionId: props.sessionId, serverId: sessionServerId ?? null,
    onNavigate: React.useCallback(() => safeRouterBack({ router, fallbackHref: '/' }), [router]),
  });
  const writeClipboard = useClipboardWrite(sessionServerId ?? null, { enabled: open });
  const followApproval = useActionApprovalContinuation({
    scopeKey: JSON.stringify([sessionServerId, props.sessionId, profileId]),
    serverId: sessionServerId ?? '', onExecuted: () => {},
  });
  const companionAddress = React.useMemo(
    () => normalizeSessionAddress(sessionServerId, props.sessionId),
    [props.sessionId, sessionServerId],
  );
  const archivePending = useSessionArchivePending(companionAddress);
  const companionRevealPort = useSessionCompanionRevealPort(companionAddress);
  const openCompanionFullSurface = React.useCallback(() => {
    companionRevealPort?.openFullSurface();
  }, [companionRevealPort]);
  const companion = useSessionCompanionController({
    sessionId: props.sessionId,
    serverId: sessionServerId,
    openFullSurface: openCompanionFullSurface,
  });
  // The one Computer opener; offline keeps the entry with its presence reason (calm-shell R2-2).
  const computerOpener = useOpenSessionComputerScreen({ sessionId: props.sessionId, serverId: sessionServerId ?? null });
  const openComputer = props.destinationsInMenu === true ? computerOpener : null;
  const showCompanionInOverflow = props.companionHeaderActionPlacement === 'overflow'
    && companionRevealPort !== null
    && companion.availability === 'ready'
    && props.companionHeaderIntent !== null
    && props.companionHeaderIntent !== undefined;
  const showCompanionDirect = props.companionHeaderActionPlacement === 'direct'
    && companionRevealPort !== null
    && companion.availability === 'ready'
    && props.companionHeaderIntent !== null
    && props.companionHeaderIntent !== undefined;
  const companionHeaderIntent = props.companionHeaderIntent;
  const applyCompanionHeaderIntent = React.useCallback(async () => {
    if (!companionHeaderIntent) return;
    switch (companionHeaderIntent.operation) {
      case 'hide':
        await applySessionCompanionHumanIntent({ address: companionAddress, intent: { kind: 'companion.hide' } });
        return;
      case 'expand':
        await applySessionCompanionHumanIntent({ address: companionAddress, intent: { kind: 'companion.collapse.set', collapsed: false } });
        return;
      case 'show':
      case 'show_and_open_full':
        {
          const mutation: { outcome: SessionCompanionMutationOutcome | null } = { outcome: null };
          const admitted = await applySessionCompanionHumanIntent({
            address: companionAddress,
            intent: { kind: 'companion.show' },
            onCompanionMutation: outcome => { mutation.outcome = outcome; },
          });
          if (admitted && mutation.outcome) {
            if (companionHeaderIntent.operation === 'show') companionRevealPort?.revealAfterMutation(mutation.outcome);
            else companionRevealPort?.openFullSurface();
          }
        }
        return;
      case 'open_full':
        companionRevealPort?.openFullSurface();
        return;
    }
  }, [companionAddress, companionHeaderIntent, companionRevealPort]);
  const executionRunsEnabled = useFeatureEnabled('execution.runs', sessionServerId
    ? { scopeKind: 'spawn', serverId: sessionServerId }
    : undefined);
  // Scoped to THIS Session's server, like the in-Session picker: the child is
  // created on that server, so an unrelated selected server must not decide
  // whether this conversation may continue with another Agent.
  const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
    scopeKind: 'spawn',
    serverId: sessionServerId,
  });
  // The Follow editor opens under the header chip (lab P2-A), or under ⋯ where no chip is drawn.
  const menuAnchorRef = React.useRef<View>(null);
  const followChipAnchorRef = React.useRef<View>(null);
  const followAnchorRef = React.useMemo(() => ({
    get current() { return followChipAnchorRef.current ?? menuAnchorRef.current; },
  }) as React.RefObject<View | null>, []);
  const followEditor = useAccountSessionFollowEditorHost({ serverId: sessionServerId ?? null, sessionId: props.sessionId, anchorRef: followAnchorRef });
  // A tight header (a session column beside the editor) takes the chip's icon form too, so the title keeps its room.
  const headerCompact = useDetailsTabHeaderActionsCompact();
  const followChipCompact = !useIsTablet() || headerCompact;
  const currentUserId = typeof profileId === 'string' ? profileId : null;
  const reachableMachineId = useSessionReachableMachineTarget(props.sessionId, sessionServerId)?.machineId ?? null;
  const ownerMetadata = readSessionOwnerMetadataView(session);
  const declaredAgentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
  const resumeAgentId = declaredAgentId
    ?? resolveAgentIdFromFlavor(ownerMetadata?.flavor ?? null);
  const { resumeCapabilityOptions } = useResumeCapabilityOptions({
    agentId: resumeAgentId,
    machineId: reachableMachineId,
    serverId: sessionServerId,
    settings,
    enabled: session.active !== true,
  });
  const organizationProjection = useSessionOrganizationProjection(sessionServerId ?? null);
  const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
    serverId: sessionServerId ?? '',
    projection: organizationProjection,
  }), [organizationProjection, sessionServerId]);
  const attentionStanding = useSessionAttentionStandingInputs(
    organizationListViewState.attentionStandingOverridesBySessionKey,
  );
  const sessionAttentionStandingKey = typeof sessionServerId === 'string' && sessionServerId.trim()
    ? sessionTagKey(sessionServerId, props.sessionId)
    : null;
  const attentionStandingEnabled = attentionStanding.actionEnabled && sessionAttentionStandingKey != null;
  const isAttentionStandingSession = sessionAttentionStandingKey != null
    && resolveSessionAttentionStanding(attentionStanding.policy, sessionAttentionStandingKey);
  // Colour data is detail: read only while this menu is open (closed-popover rule).
  const sessionAppearancesSupported = useSessionAppearancesSupported(sessionServerId, { enabled: open });
  const appearanceDataActive = open && sessionAppearancesSupported;
  const ownAppearanceColor = useSessionOwnAppearanceColor(sessionServerId, props.sessionId, { enabled: appearanceDataActive });
  const customAppearanceColors = useCustomSessionAppearanceColors(sessionServerId, { enabled: appearanceDataActive });
  const [customColorPickerLoading, setCustomColorPickerLoading] = React.useState(false);
  // Give a copy… drafts the template before its editor opens; the row shows that work instead of the menu vanishing.
  const [giveBotCopyPending, setGiveBotCopyPending] = React.useState(false);
  const isSessionConnected = getSessionStatus(session).isConnected;
  const isListPinned = organizationProjection?.pinsBySessionId[props.sessionId]?.listPinned === true;
  const isRailPinned = organizationProjection?.pinsBySessionId[props.sessionId]?.railPinned === true;
  const readSessionActionSnapshot = (state: StorageState) => readCurrentSessionActionTargetSnapshot(
    state, props.sessionId, sessionServerId ?? null, session,
  );
  const buildSessionActionTarget = (snapshot: ReturnType<typeof readSessionActionSnapshot>) => createSessionActionTarget({
    session: snapshot,
    ownerSession: session,
    serverId: sessionServerId ?? null,
    currentUserId,
    isConnected: isSessionConnected,
    attentionStandingEnabled,
    followEnabled: followEditor.enabled,
    attentionStanding: isAttentionStandingSession,
    resumeCapabilityOptions,
    isPinned: isListPinned,
    isRailPinned,
  });
  // Open, the executable target follows the live row. Closed, the header needs only which Actions the
  // row offers, so it subscribes to those decisions: a streamed row write (seq, activity, thinking) or
  // a text-only message revision commits nothing, while a read, access or lifecycle change does.
  const openSessionActionSnapshot = storage((state) => open ? readSessionActionSnapshot(state) : null);
  const closedSessionActionDecisions = storage((state) => open
    ? null
    : describeSessionActionTargetDecisions(buildSessionActionTarget(readSessionActionSnapshot(state))));
  const sessionActionTarget = React.useMemo(
    () => buildSessionActionTarget(openSessionActionSnapshot ?? readSessionActionSnapshot(storage.getState())),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the builders close over exactly these inputs.
    [
      attentionStandingEnabled,
      closedSessionActionDecisions,
      currentUserId,
      followEditor.enabled,
      isAttentionStandingSession,
      isListPinned,
      isRailPinned,
      isSessionConnected,
      openSessionActionSnapshot,
      props.sessionId,
      resumeCapabilityOptions,
      session,
      sessionServerId,
    ],
  );
  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: () => sessionServerId,
      openSession: (childSessionId, options) => {
        router.push(buildScopedSessionRouteHref({
          sessionId: childSessionId,
          serverId: options?.serverId ?? sessionServerId,
          query: options?.query,
        }) as any);
      },
    }),
    [router, sessionServerId],
  );
  const { availability: handoffAvailability, run: runHandoff } = useSessionHandoffAction({
    sessionId: props.sessionId, session, serverId: sessionServerId, reachableMachineId,
    sessionHandoffFeatureEnabled: sessionHandoffEnabled, execute: executor.execute, placement: 'session_action_menu',
  });
  const teleportAvailability = React.useMemo(
    () => getVoiceAgentSessionTeleportAvailability({ voice, sessionId: props.sessionId }),
    [props.sessionId, voice],
  );
  const showTeleportAction = teleportAvailability.ok && hasGlobalVoiceAgentConversation;
  const externalSessionLink = readExternalSessionLink(ownerMetadata);
  const externalSessionFollowPolicy = readExternalSessionFollowPolicy(ownerMetadata);
  const daemonMergedProjection = useDaemonMergedProjectionInputs({
    sections: ['agentsById'],
    machineId: externalSessionLink?.machineId ?? reachableMachineId ?? ownerMetadata?.machineId ?? null,
    serverId: sessionServerId,
    enabled: externalSessionLink !== null || declaredAgentId !== null,
  });
  const currentAgentCapabilities = React.useMemo(() => (
    daemonMergedProjection.phase === 'ready'
      ? readCurrentProjectedAgentCapabilities({
        projection: daemonMergedProjection.inputs?.pluginProjectionV2,
        agentId: declaredAgentId,
      })
      : null
  ), [daemonMergedProjection.inputs?.pluginProjectionV2, daemonMergedProjection.phase, declaredAgentId]);
  const publishedRuntimeCapabilities = ownerMetadata?.agentRuntimeCapabilitiesV1;
  const runtimeDescriptor = ownerMetadata?.runtimeDescriptorV1;
  const compactAvailability = React.useMemo(() => readAgentSessionCompactionAvailability({
    agentId: declaredAgentId,
    metadata: { agentRuntimeCapabilitiesV1: publishedRuntimeCapabilities, runtimeDescriptorV1: runtimeDescriptor },
    currentAgentCapabilities,
  }), [declaredAgentId, publishedRuntimeCapabilities, runtimeDescriptor, currentAgentCapabilities]);
  const supportsExternalSessionBackgroundFollowForLink = React.useMemo(() => {
    if (!externalSessionLink || daemonMergedProjection.phase !== 'ready') {
      return false;
    }
    return supportsExternalSessionBackgroundFollow({
      providerId: externalSessionLink.agentId,
      source: externalSessionLink.source,
      projection: daemonMergedProjection.inputs?.pluginProjectionV2,
    });
  }, [daemonMergedProjection.inputs?.pluginProjectionV2, daemonMergedProjection.phase, externalSessionLink]);
  const invokePluginHeaderAction = React.useCallback((menuActionId: string, anchor?: PopoverAnchor) => {
    // Both responsive controls re-resolve the selected descriptor against the
    // current projection through this one callback. The descriptor list never
    // gains execution authority merely by being rendered directly.
    fireAndForget((async () => {
      const outcome = await dispatchPluginSessionHeaderAction({
        projection: props.pluginUiProjection,
        menuActionId,
        anchor,
        scopedLaunchFacts: props.pluginUiScopedLaunchFacts,
        scopeIsCurrent: props.pluginUiScopeIsCurrent,
        sessionId: props.sessionId,
        openSurface: props.onOpenPluginSurface,
        ...(currentUiContextReader
          ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
          : {}),
      });
      if (outcome && 'ok' in outcome && !outcome.ok) {
        Modal.alert(t('common.error'), t('pluginRuntime.unavailableGeneric'));
      }
    })(), { tag: 'SessionHeaderActionMenu.execute.pluginHeaderAction' });
  }, [
    props.onOpenPluginSurface,
    props.pluginUiScopedLaunchFacts,
    props.pluginUiScopeIsCurrent,
    props.pluginUiProjection,
    props.sessionId,
    currentUiContextReader,
  ]);
  const accountShowToolCalls = useSetting('transcriptShowToolCalls');
  const actions = React.useMemo(() => {
    const actionItems: DropdownMenuItem[] = listActionSpecs()
      .filter((spec) => spec.surfaces.ui === true)
      .filter((spec) => isActionEnabledInState({ settings } as any, spec.id, { surface: 'ui', placement: 'session_action_menu' } as any))
      .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('session_action_menu' as any))
      .filter((spec) => spec.id !== 'session.fork' || canForkConversation({
        session,
        replayEnabled: sessionReplayEnabled,
        agentSwitchingEnabled,
        currentAgentCapabilities,
      }) === true)
      .map((spec) => {
        const compactDisabledReason = spec.id === 'session.compact' && compactAvailability.status !== 'supported'
          ? compactAvailability.status === 'unsupported' ? t('settingsAgents.notSupported') : t('common.unavailable')
          : undefined;
        return {
          id: spec.id,
          title: spec.title,
          subtitle: compactDisabledReason ?? (spec.id === 'session.handoff'
            ? resolveSessionHandoffMenuSubtitle(handoffAvailability, spec.description)
            : spec.description),
          ...(compactDisabledReason ? { disabled: true, accessibilityLabel: `${spec.title}. ${compactDisabledReason}` } : {}),
          ...(spec.id === 'session.handoff' && handoffAvailability.available !== true
            ? { disabled: true }
            : {}),
        };
      });

    const iconColor = theme.colors.chrome.header.foreground;
    const out: Array<Readonly<{ group: SessionHeaderMenuGroup; item: DropdownMenuItem }>> = [];
    const push = (group: SessionHeaderMenuGroup, item: DropdownMenuItem) => { out.push({ group, item }); };
    push('open', { id: 'header.findChat', title: t('find.surface.chat'), icon: <Icon name="magnifying-glass" size={16} color={iconColor} /> });
    for (const item of workspaceOpen.presentationItems) push('open', item);
    if (openComputer) {
      push('open', { id: 'header.openComputer', title: t('computerUse.presentation.sourceComputer'),
        disabled: Boolean(openComputer.disabledReason), subtitle: openComputer.disabledReason ?? undefined,
        icon: <Icon name="desktop" size={16} color={iconColor} /> });
    }

    if (props.collaborationHeader && props.destinationsInMenu === true) {
      push('open', createSessionPeopleMenuItem({
        iconColor: theme.colors.chrome.header.foreground,
        attentionColor: theme.colors.text.link,
        attentionLabel: collaborationAttentionLabel,
      }));
    }

    if (Array.isArray(props.extraItems) && props.extraItems.length > 0) {
      for (const item of props.extraItems) push(resolveSessionHeaderExtraItemGroup(item.id), item);
    }

    if (showCompanionInOverflow && companionHeaderIntent) {
      push('open', {
        id: 'header.openCompanion',
        title: `${t('sessionBoard.companion.title')} · ${t('sessionBoard.companion.pane.itemCount', {
          count: companionHeaderIntent.itemCount,
        })}`,
        accessibilityLabel: resolveSessionCompanionHeaderAccessibilityLabel(companionHeaderIntent),
        checked: companionHeaderIntent.checked,
        icon: <Icon name="stack-simple" size={16} color={theme.colors.chrome.header.foreground} />,
      });
    }

    if (props.pluginHeaderActionPlacement === 'overflow') {
      for (const item of (props.pluginHeaderActions ?? []).map((action): DropdownMenuItem => ({
        id: action.menuActionId,
        title: action.title,
        icon: <Icon name={action.iconName} size={16} color={theme.colors.chrome.header.foreground} />,
        ...(action.enabled ? {} : { disabled: true }),
      }))) push('open', item);
    }

    for (const actionId of listVisibleSessionActionIds({
      target: sessionActionTarget,
      surface: 'sessionHeader',
      sessionAppearancesSupported,
    })) {
      if (actionId === SESSION_ACTION_SET_APPEARANCE_COLOR_ID) {
        push(getSessionActionMetadata(actionId)?.group ?? 'session', buildSessionAppearanceColorMenuItem({
          menuId: SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
          iconColor: theme.colors.chrome.header.foreground,
          base: createSessionActionDropdownItem({ actionId, iconColor: theme.colors.chrome.header.foreground }),
          current: ownAppearanceColor,
          customColors: customAppearanceColors,
          theme,
          customPickerLoading: customColorPickerLoading,
        }));
        continue;
      }
      const item = createSessionActionDropdownItem({
        actionId,
        target: sessionActionTarget,
        iconColor: theme.colors.chrome.header.foreground,
        accountShowToolCalls,
        archivePending,
      });
      if (item) push(getSessionActionMetadata(actionId)?.group ?? 'session', item);
    }


    if (props.collaborationHeader) {
      push('session', { id: 'header.share', title: t('common.share'),
        icon: <Icon name="share-network" size={16} color={iconColor} /> });
    }
    if (giveBotCopy) {
      push('session', { id: 'header.giveBotCopy', title: t('botTemplates.giveCopyEllipsis'),
        subtitle: t('botTemplates.giveCopyDescription'), keepMenuOpen: true,
        ...(giveBotCopyPending ? { loading: true, disabled: true } : {}),
        icon: <Icon name="copy" size={16} color={iconColor} /> });
    }
    if (deleteBotTemplate) {
      push('finish', { id: 'header.deleteBotTemplate', title: t('botTemplates.deleteTemplateEllipsis'), destructive: true,
        icon: <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} /> });
    }

    // After the session's own rows: "This session" opens with its name, the rail choice and Talk (lab
    // `b-promote`); following rows come after them.
    if (externalSessionLink && supportsExternalSessionBackgroundFollowForLink) {
      push('session', {
        id: 'session.externalSession.backgroundFollow',
        title: t('session.actionMenu.backgroundFollow'),
        icon: <Icon name="arrows-clockwise" size={16} color={iconColor} />,
        subtitle: externalSessionFollowPolicy === 'background_follow' ? t('common.enabled') : t('common.disabled'),
      });
    }

    if (followEditor.enabled && sessionServerId) {
      push('session', {
        id: SESSION_FOLLOW_IN_ANOTHER_SESSION_ACTION_ID,
        icon: <Icon name="share-network" size={16} color={iconColor} />,
        title: t('session.follow.sources.add'),
        subtitle: t('session.follow.sources.includeNextTurn'),
      });
    }

    push('session', { id: 'header.reportIssue', title: t('bugReports.reportSession'),
      icon: <Icon name="bug" size={16} color={iconColor} /> });

    if (open) push('session', createSessionCopyMenuItem({
      iconColor,
      information: buildSessionDebugInformationForSession(session),
    }));

    if (showTeleportAction) {
      push('open', {
        id: 'voice.teleport',
        title: t('voiceSurface.a11y.teleport'),
        subtitle: undefined,
        icon: <Icon name="microphone" size={16} color={iconColor} />,
      });
    }

    for (const item of actionItems) {
      const presentation = SESSION_HEADER_MENU_SPEC_PRESENTATION[item.id];
      push(presentation?.group ?? 'work', presentation
        ? { ...item, icon: <Icon name={presentation.icon} size={16} color={iconColor} /> }
        : item);
    }
    // Grouped by what each row does; destructive operations close the menu, after everything else.
    return composeSessionHeaderMenu(out);
  }, [
    open,
    sessionAppearancesSupported,
    ownAppearanceColor,
    customAppearanceColors,
    customColorPickerLoading,
    theme,
    archivePending,
    collaborationAttentionLabel,
    props.destinationsInMenu,
    props.collaborationHeader,
    props.extraItems,
    openComputer,
    showCompanionInOverflow,
    companion.preference.items.length,
    companion.preference.visible,
    companionHeaderIntent?.accessibility,
    companionHeaderIntent?.checked,
    companionHeaderIntent?.itemCount,
    agentSwitchingEnabled,
    currentAgentCapabilities,
    compactAvailability,
    session,
    giveBotCopy,
    giveBotCopyPending,
    deleteBotTemplate,
    sessionReplayEnabled,
    settings,
    showTeleportAction,
    handoffAvailability,
    externalSessionLink,
    externalSessionFollowPolicy,
    supportsExternalSessionBackgroundFollowForLink,
    followEditor.enabled,
    sessionServerId,
    sessionActionTarget,
    accountShowToolCalls,
    workspaceOpen.presentationItems,
    props.pluginHeaderActionPlacement,
    props.pluginHeaderActions,
    theme.colors.chrome.header.foreground,
  ]);

  const directPluginHeaderActions = props.pluginHeaderActionPlacement === 'direct'
    ? props.pluginHeaderActions ?? []
    : [];

  if (actions.length === 0 && directPluginHeaderActions.length === 0 && !showCompanionDirect) return <>{props.beforeMenu ?? null}</>;

  return (
    <>
      {showCompanionDirect && companionHeaderIntent ? (
        <SessionCompanionHeaderButton
          intent={companionHeaderIntent}
          onPress={applyCompanionHeaderIntent}
        />
      ) : null}
      {directPluginHeaderActions.map((action) => (
        <SessionHeaderActionButton
          key={action.menuActionId}
          onPress={(event) => {
            if (action.enabled) {
              invokePluginHeaderAction(action.menuActionId, resolvePressTriggerAnchor(event));
            }
          }}
          disabled={!action.enabled}
          testID={`session-header-plugin-action-${action.menuActionId}`}
          accessibilityLabel={action.title}
        >
          <SessionHeaderGlyph name={action.iconName} />
        </SessionHeaderActionButton>
      ))}
      {followEditor.enabled && sessionServerId ? (
        <SessionFollowHeaderChip
          sessionId={props.sessionId}
          serverId={sessionServerId}
          compact={followChipCompact}
          anchorRef={followChipAnchorRef}
          open={followEditor.open}
          onPress={() => followEditor.openEditor({ address: { serverId: sessionServerId, sessionId: props.sessionId }, archived: session.archivedAt != null })}
        />
      ) : null}
      {followEditor.editor}
      {props.beforeMenu ?? null}
      {actions.length > 0 ? (
    <View ref={menuAnchorRef} collapsable={false}>
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={actions}
      showCategoryTitles
      // On a phone the menu is the anchored panel under its ⋯ (owner R2), named by the session it acts on.
      popoverAccessibilityLabel={readSessionDisplayTitleField(session).value || ownerMetadata?.name || t('session.actionMenu.openA11y')}
      onSelect={(actionId, selection) => {
        if (workspaceOpen.select(actionId)) { setOpen(false); return; }
        if (actionId.startsWith(`${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}:`)) {
          // Custom color… keeps the menu open while the picker loads; the choice closes it when ready.
          fireAndForget((async () => {
            const color = await resolveSessionAppearanceColorMenuChoice({
              menuId: SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
              itemId: actionId,
              current: ownAppearanceColor,
              serverId: sessionServerId ?? null,
              onPickerLoading: setCustomColorPickerLoading,
              closeMenus: () => setOpen(false),
            });
            if (color === undefined) return;
            setOpen(false);
            await writeSessionOrganizationAppearance({
              scope: await requireSessionOrganizationMutationScope(sessionServerId ?? null),
              sessionId: props.sessionId,
              color,
            });
          })(), {
            tag: 'SessionHeaderActionMenu.execute.sessionAppearance',
            onError: () => Modal.alert(t('common.error'), t('errors.unknownError')),
          });
          return;
        }
        if (actionId === 'header.giveBotCopy') {
          // The menu stays open with the row's spinner until the editor is ready (the Custom color… pattern).
          if (!giveBotCopy || giveBotCopyPending) return;
          setGiveBotCopyPending(true);
          fireAndForget(giveBotCopy().finally(() => {
            setGiveBotCopyPending(false);
            setOpen(false);
          }), { tag: 'SessionHeaderActionMenu.execute.giveBotCopy' });
          return;
        }
        setOpen(false);
        if (actionId === 'header.deleteBotTemplate') {
          void deleteBotTemplate?.();
          return;
        }
        if (actionId === 'header.findChat') {
          // On a phone cockpit the transcript stays mounted behind other tabs: bring it forward first.
          cockpitNavigation?.switchSurface('chat');
          // The transcript registers once its tab is in front; it opens then.
          findSurfaceRuntime.open(`transcript:${sessionServerId ?? ''}:${props.sessionId}`, { whenRegistered: cockpitNavigation !== null });
          return;
        }
        if (actionId === 'header.openComputer') {
          openComputer?.open();
          return;
        }
        if (actionId === 'header.openCompanion' && showCompanionInOverflow) {
          applyCompanionHeaderIntent();
          return;
        }
        if (props.onSelectExtraItem?.(actionId) === true) return;
        if (actionId === 'header.reportIssue') {
          fireAndForget((async () => {
            const serverId = sessionServerId ?? '';
            const accountId = await resolveBugReportAccountIdForServer(serverId);
            navigateWithBlurOnWeb(() => router.push({
              pathname: '/settings/report-issue',
              params: { sessionId: props.sessionId, serverId, accountId: accountId ?? '' },
            }));
          })(), { tag: 'SessionHeaderActionMenu.execute.reportIssue' });
          return;
        }
        if (isSessionCopyActionId(actionId)) {
          const currentSession = readCurrentSessionForOpenMenu(props.sessionId, session);
          fireAndForget(copySessionDebugInformationToClipboard(buildSessionDebugInformationForSession(currentSession), actionId, writeClipboard), {
            tag: 'SessionHeaderActionMenu.execute.copyInformation',
          });
          return;
        }
        if (actionId.startsWith(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX)) {
          invokePluginHeaderAction(actionId, selection?.anchor);
          return;
        }
        if (actionId === 'session.externalSession.backgroundFollow') {
          const nextPolicy = externalSessionFollowPolicy === 'background_follow' ? 'attached_only' : 'background_follow';
          fireAndForget((async () => {
            const signal = followControllerRef.current?.signal;
            if (!externalSessionLink || !signal || signal.aborted) return;
            // One shared operation owner with the External Sessions settings
            // surface: it fences the settlement on the exact link identity and
            // the active Account lifetime, and applies the canonical local
            // projection catch-up on success.
            const outcome = await setExternalSessionFollowPolicy({
              sessionId: props.sessionId,
              serverId: sessionServerId ?? null,
              link: externalSessionLink,
              policy: nextPolicy,
              registerApproval: followApproval.requestApproval,
              signal,
            });
            if (outcome.kind === 'stale') return;
            if (outcome.kind !== 'applied') {
              // The daemon owns live follow eligibility, so a refusal here is a
              // real outcome the user asked for. Report it the same way the
              // External Sessions settings surface reports the same operation
              // instead of silently discarding the tap.
              await Modal.alert(
                t('common.error'),
                t('externalSessions.followUpdateFailed'),
              );
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.externalSessionBackgroundFollow' });
          return;
        }
        if (actionId === SESSION_FOLLOW_IN_ANOTHER_SESSION_ACTION_ID) {
          if (!sessionServerId) return;
          openSessionFollowDestinationPicker({
            serverId: sessionServerId,
            sessionId: props.sessionId,
          }, followEditor.triggerRef);
          return;
        }
        if (actionId === 'voice.teleport') {
          fireAndForget(teleportVoiceAgentToSessionRoot({ sessionId: props.sessionId }), {
            tag: 'SessionHeaderActionMenu.execute.voiceTeleport',
          });
          return;
        }
        const manualReadState = resolveManualReadStateFromSessionActionId(actionId);
        const handledSessionActionIds: ReadonlySet<string> = new Set(listVisibleSessionActionIds({
          target: sessionActionTarget,
          surface: 'sessionHeader',
        }));
        if (manualReadState || handledSessionActionIds.has(actionId)) {
          fireAndForget((async () => {
            try {
              if (actionId === SESSION_ACTION_RENAME_ID) {
                const currentSessionTitle = readSessionDisplayTitleField(session).value ?? ownerMetadata?.name ?? '';
                const newName = await Modal.prompt(
                  t('sessionInfo.renameSession'),
                  undefined,
                  {
                    defaultValue: currentSessionTitle,
                    placeholder: t('sessionInfo.renameSessionPlaceholder'),
                    confirmText: t('common.save'),
                    cancelText: t('common.cancel'),
                  },
                );
                if (!newName?.trim()) return;
                await executeSessionAction({
                  actionId: SESSION_ACTION_RENAME_ID,
                  target: sessionActionTarget,
                  input: { title: newName },
                });
                return;
              }
              if (actionId === SESSION_ACTION_DELETE_ID) {
                if (!await confirmSessionDelete({ target: sessionActionTarget })) return;
                const result = await executeSessionAction({ actionId, target: sessionActionTarget,
                  context: { confirmed: true } });
                if (result !== false) navigateAfterDelete();
                return;
              }
              let alsoArchiveReports = false;
              if (actionId === SESSION_ACTION_ARCHIVE_ID) {
                const confirmation = await confirmSessionArchive({ leadSessionId: props.sessionId, serverId: sessionServerId ?? null });
                if (!confirmation.confirmed) return;
                alsoArchiveReports = confirmation.alsoArchiveReports;
              }
              await executeSessionAction({
                actionId: actionId as SessionActionId,
                target: sessionActionTarget,
                ...(actionId === SESSION_ACTION_ARCHIVE_ID ? { input: { alsoArchiveReports } } : {}),
                ...(actionId === 'ui.session.follow'
                  ? { context: { operations: { openFollowEditor: followEditor.openEditor } } }
                  : {}),
                ...(actionId === SESSION_ACTION_RESUME_ID
                  ? {
                      context: {
                        operations: {
                          resumeSession: async (sessionId: string) => {
                            await emitSessionResumeRequest(sessionId, sessionServerId);
                          },
                        },
                      },
                    }
                  : {}),
              });
            } catch (error) {
              showSessionHeaderActionError(error);
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionAction' });
          return;
        }
        if (actionId === 'session.fork') {
          // A launcher only. The header must not also run the old auto-strategy
          // path behind the modal: the user chooses Native, Replay or Configure
          // before any fork effect is issued.
          openSessionForkStrategyFlow({
            navigation: router,
            sessionId: props.sessionId,
            forkSupportSource: session,
            serverId: sessionServerId ?? null,
            machineId: reachableMachineId ?? ownerMetadata?.machineId ?? null,
            forkPoint: { type: 'latest' },
            settings: storage.getState().settings,
            replayEnabled: sessionReplayEnabled,
            currentAgentCapabilities,
            executionRunsEnabled: executionRunsEnabled === true,
            agentSwitchingEnabled,
            navigateToSession: (childSessionId, options) => {
              router.push(buildScopedSessionRouteHref({
                sessionId: childSessionId,
                serverId: options?.serverId ?? sessionServerId,
              }) as any);
            },
            navigateToNewSession: (route) => {
              navigateWithBlurOnWeb(() => router.push(route as any));
            },
          });
          return;
        }
        if (actionId === 'session.compact') {
          fireAndForget((async () => {
            try {
              requireActionSuccess(await executor.execute('session.compact', { sessionId: props.sessionId }, {
                surface: 'ui', defaultSessionId: props.sessionId, serverId: sessionServerId ?? undefined,
              }), 'session.compact');
            } catch (error) { showSessionHeaderActionError(error); }
          })(), { tag: 'SessionHeaderActionMenu.execute.compact' });
          return;
        }
        if (actionId === 'session.handoff') {
          if (!handoffAvailability.available) {
            return;
          }
          fireAndForget((async () => {
            const res = await runHandoff();
            if (!res?.ok) return;
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionHandoff' });
          return;
        }
        const defaultBackend = resolveSessionActionDefaultBackend({
          session,
          enabledAgentIds,
        });
        if (!defaultBackend) return;
        const input = buildExecutionRunActionDraftInputForUi({
          actionId: actionId as ActionId,
          sessionId: props.sessionId,
          defaultBackendTarget: resolveSessionActionDefaultTarget(defaultBackend),
          defaultBackendId: defaultBackend.defaultBackendId,
          instructions: '',
        });
        const actionDraftServerId = typeof sessionServerId === 'string' ? sessionServerId.trim() : '';
        if (
          !actionDraftServerId
          || !actionDraftAccountScope
          || props.actionAccountLifetime?.isCurrent() !== true
          || !areServerProfileIdentifiersEquivalent(actionDraftAccountScope.serverId, actionDraftServerId)
        ) return;
        openExecutionRunDraft({ scope: actionDraftAccountScope, sessionId: props.sessionId, actionId: actionId as ActionId, input });
      }}
      trigger={({ toggle }) => {
        const label = t('session.actionMenu.openA11y');
        const icon = <SessionHeaderGlyph name="dots-three" />;

        if (Platform.OS === 'web') {
          return (
            <SessionHeaderMenuWebTrigger
              label={label}
              onToggle={toggle}
              triggerRef={followEditor.triggerRef}
            >
              {icon}
            </SessionHeaderMenuWebTrigger>
          );
        }

        return (
          <SessionHeaderActionButton
            controlRef={(node) => { followEditor.triggerRef.current = node as unknown as View | null; }}
            onPress={toggle}
            testID="session-header-action-menu-trigger"
            accessibilityLabel={label}
          >
            {icon}
          </SessionHeaderActionButton>
        );
      }}
      placement="bottom"
      variant="slim"
      rowKind="selectableRow"
      search={false}
      matchTriggerWidth={false}
      maxWidthCap={320}
    />
    </View>
      ) : null}
    </>
  );
}

export const SessionHeaderActionMenu = React.memo(
  SessionHeaderActionMenuInner,
  (prev, next) => !didSessionHeaderActionMenuPropsChange(prev, next),
);
