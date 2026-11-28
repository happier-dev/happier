import { openSessionTagsEditor, useSessionOrganizationEditors } from '@/components/sessions/organization/useSessionOrganizationEditors';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SESSION_INFO_SAME_SETUP_ACTION_ID, SESSION_INFO_SESSION_LOG_ACTION_ID, SESSION_INFO_MACHINE_ACTION_ID, SESSION_INFO_ALL_AUTOMATIONS_ACTION_ID } from './sessionActionIds';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
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
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
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
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { DropdownMenu, type DropdownMenuItem, type DropdownMenuSelection } from '@/components/ui/forms/dropdown/DropdownMenu';
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
import { useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
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
import { setExternalSessionFollowPolicy, useExternalSessionFollowPolicyIntent } from '@/components/sessions/external/follow/setExternalSessionFollowPolicy';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { getSessionName, getSessionStatus } from '@/utils/sessions/sessionUtils';
import { EXACT_TURN_AUTOMATION_HEADER_ACTION_ID, readExactActiveParentTurn } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
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
  SESSION_ACTION_EDIT_TAGS_ID,
  SESSION_ACTION_MOVE_TO_FOLDER_ID,
  SESSION_ACTION_RENAME_ID,
  SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
  SESSION_ACTION_RESUME_ID,
  resolveManualReadStateFromSessionActionId,
} from '@/components/sessions/actions/sessionActionIds';
import { buildSessionMetadataStabilitySignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { HappyError } from '@/utils/errors/errors';
import { alertActionFailure, readSafeFailureDetails } from '@/utils/errors/alertActionFailure';
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
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
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
import { getSessionActionMetadata, resolveSessionActionTitle } from './sessionActionMetadata';
import { useOpenSessionComputerScreen } from '@/components/computer/useOpenSessionComputerScreen';
import { useOpenSessionSimulatorPreview } from '@/components/sessions/simulator/useOpenSessionSimulatorPreview';
import { SESSION_HEADER_TASK_MENU_ID_PREFIX, useSessionHeaderTaskLinks, type SessionHeaderTaskSession } from '@/components/sessions/shell/view/SessionHeaderTaskLinks';
import { SessionHeaderOptionalEntriesFoldedContext } from '@/components/sessions/shell/view/sessionHeaderTitleCompact';
import { buildSessionMenuCommands } from './sessionMenuCommands';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';

const SESSION_FOLLOW_IN_ANOTHER_SESSION_ACTION_ID = 'follow.set';

function resolveSessionHandoffMenuSubtitle(handoffAvailability: ReturnType<typeof resolveSessionHandoffUiAvailability>): string | undefined {
  if (handoffAvailability.available) {
    return undefined;
  }

  // Each row says why, never the bare word "Unavailable".
  switch (handoffAvailability.reason) {
    case 'handoff_feature_disabled':
      return t('session.actionMenu.handoffUnavailable.disabled');
    case 'handoff_unsupported':
      return t('session.actionMenu.handoffUnavailable.agentUnsupported');
    case 'session_ineligible':
      return t('session.actionMenu.handoffUnavailable.noSource');
    case 'transport_unavailable':
      return t('session.actionMenu.handoffUnavailable.noRoute');
    case 'runtime_direct_peer_unavailable':
      return t('session.actionMenu.handoffUnavailable.peerUnavailable');
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
  }>;
  /**
   * The Session's right rail is not on screen: People and Computer, which the rail carries, are reached
   * from this menu instead (calm-shell R2-1), through their own openers.
   */
  destinationsInMenu?: boolean;
  /** A header control that sits just before the ⋯ (the no-rail (i)), after Follow (lab cshead H1p). */
  beforeMenu?: React.ReactNode;
  /** The Session's linked Tasks: rows here while the header's measured fit folds them out of the facts line. */
  taskSession?: SessionHeaderTaskSession;
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
    alertActionFailure({ reason: error.message, code: error.code ?? null, requestId: error.requestId, failureCause: error.failureCause,
      context: { ...readSafeFailureDetails(error.details),
        ...(error.effectAttempted === undefined ? {} : { effectAttempted: error.effectAttempted }) } });
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
  if (prev.taskSession !== next.taskSession) return true;
  if (prev.session.serverId !== next.session.serverId) return true;
  if (!areSessionActionMenuMetadataSemanticallyEqual(prev.session, next.session)) return true;
  if (prev.session.active !== next.session.active) return true;
  if (prev.session.owner !== next.session.owner) return true;
  if (prev.session.archivedAt !== next.session.archivedAt) return true;
  if (prev.session.access !== next.session.access) return true;
  return (prev.session.seq > 0) !== (next.session.seq > 0);
}

type SessionHeaderMenuRows = Readonly<{
  items: ReadonlyArray<DropdownMenuItem>;
  select: (actionId: string, selection?: DropdownMenuSelection) => void;
}>;

const NO_MENU_ROWS: ReadonlyArray<DropdownMenuItem> = [];

type SessionHeaderMenuRowsStore = Readonly<{
  get: () => SessionHeaderMenuRows | null;
  set: (rows: SessionHeaderMenuRows) => void;
  subscribe: (listener: () => void) => () => void;
}>;

function createSessionHeaderMenuRowsStore(): SessionHeaderMenuRowsStore {
  let rows: SessionHeaderMenuRows | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => rows,
    set: (next) => {
      if (rows && next.items === rows.items && next.select === rows.select) return;
      rows = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** The ⋯ menu: the only reader of the published rows, so a row change redraws the menu, not the header. */
function SessionHeaderMenuDropdown(props: Omit<React.ComponentProps<typeof DropdownMenu>, 'items' | 'onSelect'> & Readonly<{
  rows: SessionHeaderMenuRowsStore;
}>) {
  const { rows: store, ...menuProps } = props;
  const rows = React.useSyncExternalStore(store.subscribe, store.get, store.get);
  const onSelect = React.useCallback((actionId: string, selection?: DropdownMenuSelection) => {
    store.get()?.select(actionId, selection);
  }, [store]);
  return <DropdownMenu {...menuProps} items={props.open ? rows?.items ?? NO_MENU_ROWS : NO_MENU_ROWS} onSelect={onSelect} />;
}

type SessionHeaderMenuRowsProps = SessionHeaderActionMenuProps & Readonly<{
  open: boolean;
  palettePresented: boolean;
  paletteModalId: string | null | undefined;
  setOpen: (open: boolean) => void;
  session: Session;
  sessionServerId: ReturnType<typeof resolveSessionTargetServerId>;
  companionAddress: ReturnType<typeof normalizeSessionAddress>;
  followEditor: ReturnType<typeof useAccountSessionFollowEditorHost>;
  showCompanionInOverflow: boolean;
  companionHeaderIntent: SessionCompanionHeaderIntent | null | undefined;
  applyCompanionHeaderIntent: () => Promise<void>;
  invokePluginHeaderAction: (menuActionId: string, anchor?: PopoverAnchor) => void;
  /** The open menu's rows and their selection, handed to the trigger's DropdownMenu. */
  publish: (rows: SessionHeaderMenuRows) => void;
}>;

/**
 * Everything only the menu's rows read: Action availability, handoff, approvals, Machine and daemon
 * facts. Mounted when the menu first opens, then kept: an approval a row started outlives the menu.
 */
function SessionHeaderActionMenuRows(props: SessionHeaderMenuRowsProps) {
  const { open, setOpen, session, sessionServerId, companionAddress, followEditor, showCompanionInOverflow,
    companionHeaderIntent, applyCompanionHeaderIntent, invokePluginHeaderAction } = props;
  const detailPresented = open || props.palettePresented;
  const automationsSupport = useAutomationsSupport();
  const openExecutionRunDraft = useOpenExecutionRunLauncherDraft();
  const commandBridge = useCurrentUiContextCommandBridge();
  const presentationActiveSignal = useLayoutPresentationSignal();
  const followControllerRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
    const start = (presentationActive: boolean): (() => void) | void => {
      const controller = new AbortController();
      followControllerRef.current = controller;
      const retirement = props.actionAccountLifetime?.onRetire(() => controller.abort());
      if (!presentationActive) controller.abort();
      return () => { controller.abort(); retirement?.dispose(); };
    };
    let current = presentationActiveSignal.get();
    let stop = start(current);
    const unsubscribe = presentationActiveSignal.subscribe(() => {
      if (presentationActiveSignal.get() === current) return;
      current = presentationActiveSignal.get();
      stop?.();
      stop = start(current);
    });
    return () => { unsubscribe(); stop?.(); };
  }, [props.actionAccountLifetime, props.sessionId, presentationActiveSignal]);
  const { theme } = useUnistyles();
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
  // People is a rail destination; the header's ⋯ carries it (with its conversation attention) only
  // while the rail is not on screen. No named-viewer presence is read for a header entry any more.
  const collaborationAttentionLabel = useSessionPeopleAttentionLabel(
    props.destinationsInMenu === true ? props.collaborationHeader?.target ?? null : null,
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
  const writeClipboard = useClipboardWrite(sessionServerId ?? null, { enabled: detailPresented });
  const followApproval = useActionApprovalContinuation({
    scopeKey: JSON.stringify([sessionServerId, props.sessionId, profileId]),
    serverId: sessionServerId ?? '', onExecuted: () => {},
  });
  const archivePending = useSessionArchivePending(companionAddress);
  // The one Computer opener; offline keeps the entry with its presence reason (calm-shell R2-2).
  const computerOpener = useOpenSessionComputerScreen({ sessionId: props.sessionId, serverId: sessionServerId ?? null });
  const openComputer = props.destinationsInMenu === true ? computerOpener : null;
  // The rail does not carry the simulator, so the ⋯ is its entry wherever the Session is open.
  const openSimulator = useOpenSessionSimulatorPreview({
    sessionId: props.sessionId, serverId: sessionServerId ?? null, active: open,
  });
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
  const sessionAppearancesSupported = useSessionAppearancesSupported(sessionServerId, { enabled: detailPresented });
  const appearanceDataActive = detailPresented && sessionAppearancesSupported;
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
  const openSessionActionSnapshot = storage((state) => detailPresented ? readSessionActionSnapshot(state) : null);
  const closedSessionActionDecisions = storage((state) => detailPresented
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
  const organizationActions = useMountedActionExecution(sessionServerId ?? null);
  const organizationEditors = useSessionOrganizationEditors({ target: sessionActionTarget,
    sourceLabel: getSessionName(session), projection: organizationProjection,
    listView: organizationListViewState, actions: organizationActions });
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
  const desiredExternalSessionFollowPolicy = useExternalSessionFollowPolicyIntent(sessionServerId ?? null, externalSessionLink);
  const externalSessionFollowPolicy = desiredExternalSessionFollowPolicy ?? readExternalSessionFollowPolicy(ownerMetadata);
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
  const compactAgentTitle = React.useMemo(() => (declaredAgentId
    ? resolveAgentCatalogProjection(declaredAgentId, { enabledAgentIds: [] }).title
    : t('status.unknown')), [declaredAgentId]);
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
  const accountShowToolCalls = useSetting('transcriptShowToolCalls');
  // Rows mount on first open and stay: later opens list the Tasks at once, as the chip form would. Only a
  // folded header lists them; otherwise its facts line carries them as chips.
  const tasksFolded = React.useContext(SessionHeaderOptionalEntriesFoldedContext);
  const taskLinks = useSessionHeaderTaskLinks(tasksFolded ? props.taskSession ?? null : null);
  const actions = React.useMemo(() => {
    if (!detailPresented) return NO_MENU_ROWS;
    const actionItems: DropdownMenuItem[] = listActionSpecs()
      // Placement first: only the few specs placed in this menu reach the enablement check.
      .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('session_action_menu' as any))
      .filter((spec) => spec.surfaces.ui === true)
      .filter((spec) => isActionEnabledInState({ settings } as any, spec.id, { surface: 'ui', placement: 'session_action_menu' } as any))
      .filter((spec) => spec.id !== 'session.fork' || canForkConversation({
        session,
        replayEnabled: sessionReplayEnabled,
        agentSwitchingEnabled,
        currentAgentCapabilities,
      }) === true)
      .map((spec) => {
        // Named after the Agent (D24: "Muse can't compact a session yet"); the capability owner decides.
        const compactDisabledReason = spec.id === 'session.compact' && compactAvailability.status !== 'supported'
          ? t(compactAvailability.status === 'unsupported' ? 'session.actionMenu.compactUnsupported' : 'session.actionMenu.compactChecking',
            { agent: compactAgentTitle })
          : undefined;
        return {
          id: spec.id,
          title: spec.title,
          // A spec's description is written for agents; a menu row says only why it can't be used right now.
          subtitle: compactDisabledReason ?? (spec.id === 'session.handoff'
            ? resolveSessionHandoffMenuSubtitle(handoffAvailability)
            : undefined),
          ...(compactDisabledReason ? { disabled: true, accessibilityLabel: `${spec.title}. ${compactDisabledReason}` } : {}),
          ...(spec.id === 'session.handoff' && handoffAvailability.available !== true
            ? { disabled: true }
            : {}),
        };
      });

    const iconColor = theme.colors.chrome.header.foreground;
    const out: Array<Readonly<{ group: SessionHeaderMenuGroup; item: DropdownMenuItem }>> = [];
    const push = (group: SessionHeaderMenuGroup, item: DropdownMenuItem) => { out.push({ group, item }); };
    for (const link of taskLinks) {
      push('open', { id: `${SESSION_HEADER_TASK_MENU_ID_PREFIX}${link.key}`, title: `${t('boards.kinds.task')} · ${link.title}`,
        icon: <Icon name="check-square" size={16} color={iconColor} /> });
    }
    push('open', { id: 'header.findChat', title: t('find.surface.chat'), icon: <Icon name="magnifying-glass" size={16} color={iconColor} /> });
    for (const item of workspaceOpen.presentationItems) push('open', item);
    if (openComputer) {
      push('open', { id: 'header.openComputer', title: t('computerUse.presentation.sourceComputer'),
        disabled: Boolean(openComputer.disabledReason), subtitle: openComputer.disabledReason ?? undefined,
        icon: <Icon name="desktop" size={16} color={iconColor} /> });
    }
    if (openSimulator) {
      push('open', { id: 'header.openSimulator', title: t('simulatorPreview.title'),
        icon: <Icon name="device-mobile" size={16} color={iconColor} /> });
    }

    if (props.collaborationHeader && props.destinationsInMenu === true) {
      push('open', createSessionPeopleMenuItem({
        iconColor: theme.colors.chrome.header.foreground,
        attentionColor: theme.colors.text.link,
        attentionLabel: collaborationAttentionLabel,
      }));
    }

    if (Array.isArray(props.extraItems) && props.extraItems.length > 0) {
      for (const item of props.extraItems) {
        // The open menu reads the live row; the exact-turn action exists only while a turn is in progress.
        if (item.id === EXACT_TURN_AUTOMATION_HEADER_ACTION_ID && !readExactActiveParentTurn(session)) continue;
        push(resolveSessionHeaderExtraItemGroup(item.id), item);
      }
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
      organizationEditors,
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
    if (externalSessionLink && (externalSessionFollowPolicy === 'background_follow' || supportsExternalSessionBackgroundFollowForLink)) {
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
        // The glyph the following Session's transcript shows for these inputs, distinct from Share.
        icon: <Icon name="arrow-elbow-down-right" size={16} color={iconColor} />,
        title: t('session.follow.sources.add'),
        subtitle: t('session.follow.sources.includeNextTurn'),
      });
    }

    if (sessionServerId) {
      push('open', { id: SESSION_INFO_SESSION_LOG_ACTION_ID, title: resolveSessionActionTitle(getSessionActionMetadata(SESSION_INFO_SESSION_LOG_ACTION_ID)!),
        icon: <Icon name="file-text" size={16} color={iconColor} /> });
      if (reachableMachineId) push('open', { id: SESSION_INFO_MACHINE_ACTION_ID, title: resolveSessionActionTitle(getSessionActionMetadata(SESSION_INFO_MACHINE_ACTION_ID)!),
        icon: <Icon name="desktop" size={16} color={iconColor} /> });
    }
    if (props.actionAccountLifetime && sessionServerId) {
      push('work', { id: SESSION_INFO_SAME_SETUP_ACTION_ID, title: resolveSessionActionTitle(getSessionActionMetadata(SESSION_INFO_SAME_SETUP_ACTION_ID)!),
        icon: <Icon name="copy" size={16} color={iconColor} /> });
    }
    if (automationsSupport?.enabled !== false && sessionServerId) {
      push('open', { id: SESSION_INFO_ALL_AUTOMATIONS_ACTION_ID, title: resolveSessionActionTitle(getSessionActionMetadata(SESSION_INFO_ALL_AUTOMATIONS_ACTION_ID)!),
        icon: <Icon name="clock" size={16} color={iconColor} /> });
    }
    push('session', { id: 'header.reportIssue', title: resolveSessionActionTitle(getSessionActionMetadata('header.reportIssue')!),
      icon: <Icon name="bug" size={16} color={iconColor} /> });

    if (detailPresented) push('session', createSessionCopyMenuItem({
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
    detailPresented,
    automationsSupport?.enabled,
    props.actionAccountLifetime,
    sessionAppearancesSupported,
    organizationEditors.tagsAvailable,
    organizationEditors.foldersAvailable,
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
    openSimulator,
    showCompanionInOverflow,
    companionHeaderIntent?.accessibility,
    companionHeaderIntent?.checked,
    companionHeaderIntent?.itemCount,
    agentSwitchingEnabled,
    currentAgentCapabilities,
    compactAvailability,
    compactAgentTitle,
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
    reachableMachineId,
    sessionActionTarget,
    accountShowToolCalls,
    workspaceOpen.presentationItems,
    props.pluginHeaderActionPlacement,
    props.pluginHeaderActions,
    taskLinks,
    theme.colors.chrome.header.foreground,
  ]);
  const select = (actionId: string, selection?: DropdownMenuSelection) => {
    if (actionId === SESSION_ACTION_EDIT_TAGS_ID) {
      setOpen(false);
      openSessionTagsEditor({ target: sessionActionTarget, sourceLabel: getSessionName(session), binding: organizationActions.binding });
      return;
    }
    if (actionId === SESSION_ACTION_MOVE_TO_FOLDER_ID) {
      setOpen(false);
      organizationEditors.performMoveToFolder();
      return;
    }
    if (actionId === SESSION_INFO_SAME_SETUP_ACTION_ID) {
      const lifetime = props.actionAccountLifetime;
      if (lifetime && sessionServerId) fireAndForget(openSessionAuthoringAction({
        sourceSession: { sessionId: props.sessionId, serverId: sessionServerId },
      }, lifetime), { tag: 'SessionHeaderActionMenu.sameSetup' });
      return;
    }
    if (actionId === SESSION_INFO_SESSION_LOG_ACTION_ID) {
      router.push(buildScopedSessionRouteHref({ sessionId: props.sessionId, serverId: sessionServerId, suffix: '/log' }) as never);
      return;
    }
    if (actionId === SESSION_INFO_MACHINE_ACTION_ID) {
      if (reachableMachineId && sessionServerId) router.push(machinePageHref({ door: 'rail', target: { machineId: reachableMachineId, serverId: sessionServerId } }) as never);
      return;
    }
    if (actionId === SESSION_INFO_ALL_AUTOMATIONS_ACTION_ID) {
      router.push(buildScopedSessionRouteHref({ sessionId: props.sessionId, serverId: sessionServerId, suffix: '/automations' }) as never);
      return;
    }
    if (workspaceOpen.select(actionId)) { setOpen(false); return; }
    if (actionId === SESSION_ACTION_SET_APPEARANCE_COLOR_ID || actionId.startsWith(`${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}:`)) {
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
    if (actionId.startsWith(SESSION_HEADER_TASK_MENU_ID_PREFIX)) {
      // The Task's owning page, the same destination its chip opens.
      const link = taskLinks.find(candidate => `${SESSION_HEADER_TASK_MENU_ID_PREFIX}${candidate.key}` === actionId);
      if (link) navigateWithBlurOnWeb(() => router.push(link.href as never));
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
    if (actionId === 'header.openSimulator') {
      openSimulator?.open();
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
        commandBridge,
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
  };
  const latestSelect = React.useRef(select);
  latestSelect.current = select;
  const stableSelect = React.useCallback((actionId: string, selection?: DropdownMenuSelection) => latestSelect.current(actionId, selection), []);
  const paletteCommands = React.useMemo(() => props.palettePresented ? buildSessionMenuCommands({
    items: actions, select: stableSelect,
  }) : [], [actions, props.palettePresented, stableSelect]);
  useCurrentUiContextLocalCommands(paletteCommands, { contextKey: JSON.stringify(companionAddress), foregroundModalId: props.paletteModalId });
  const { publish } = props;
  // Only an open menu draws rows; a shut one keeps whatever it last showed and publishes nothing.
  React.useLayoutEffect(() => { if (open) publish({ items: actions, select: stableSelect }); }, [actions, open, publish, stableSelect]);
  return null;
}

function SessionHeaderActionMenuInner(props: SessionHeaderActionMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [palettePresented, setPalettePresented] = React.useState(false);
  const [paletteModalId, setPaletteModalId] = React.useState<string | null | undefined>(undefined);
  // A shut menu is its trigger (DropdownMenu's rule): the rows, and the hooks that feed only them, mount
  // when the menu first opens.
  const [rowsMounted, setRowsMounted] = React.useState(false);
  const [rowsStore] = React.useState(createSessionHeaderMenuRowsStore);
  const rowsDemanded = rowsMounted || palettePresented;
  const handleOpenChange = React.useCallback((next: boolean) => {
    if (next) setRowsMounted(true);
    setOpen(next);
  }, []);
  const setCommandPalettePresented = React.useCallback((presented: boolean, modalId?: string | null) => {
    setPaletteModalId(presented ? modalId : undefined);
    if (presented) setRowsMounted(true);
    setPalettePresented(presented);
  }, []);
  const currentUiContextReader = useOptionalCurrentUiContextReader();
  const session = React.useMemo(
    () => open || palettePresented ? readCurrentSessionForOpenMenu(props.sessionId, props.session) : props.session,
    [open, palettePresented, props.session, props.sessionId],
  );
  const preferredSessionServerId = usePreferredServerIdForSession({
    serverId: session.serverId ?? null,
    sessionId: props.sessionId,
  });
  const sessionServerId = React.useMemo(
    () => resolveSessionTargetServerId(props.sessionId, preferredSessionServerId ?? session.serverId ?? null),
    [preferredSessionServerId, session.serverId, props.sessionId],
  );
  const companionAddress = React.useMemo(
    () => normalizeSessionAddress(sessionServerId, props.sessionId),
    [props.sessionId, sessionServerId],
  );
  useCurrentUiContextLocalCommands([{ key: 'session.menu.open', title: t('session.actionMenu.openA11y'),
    setCommandPalettePresented,
    invoke: () => handleOpenChange(true) }], { contextKey: JSON.stringify(companionAddress), foregroundModalId: paletteModalId });
  const companionRevealPort = useSessionCompanionRevealPort(companionAddress);
  const openCompanionFullSurface = React.useCallback(() => {
    companionRevealPort?.openFullSurface();
  }, [companionRevealPort]);
  const companion = useSessionCompanionController({
    sessionId: props.sessionId,
    serverId: sessionServerId,
    openFullSurface: openCompanionFullSurface,
  });
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
  // The Follow editor opens under the header chip (lab P2-A), or under ⋯ where no chip is drawn.
  const menuAnchorRef = React.useRef<View>(null);
  const followChipAnchorRef = React.useRef<View>(null);
  const followAnchorRef = React.useMemo(() => ({
    get current() { return followChipAnchorRef.current ?? menuAnchorRef.current; },
  }) as React.RefObject<View | null>, []);
  const followEditor = useAccountSessionFollowEditorHost({ serverId: sessionServerId ?? null, sessionId: props.sessionId, anchorRef: followAnchorRef });
  // A tight header (the band's measured compact fit: a narrow pane, a session column beside the editor) folds
  // Follow into ⋯, where its row stays and the editor anchors, so the title keeps its room. A phone keeps the icon.
  const headerCompact = useDetailsTabHeaderActionsCompact();
  const followChipCompact = !useIsTablet();
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
  const directPluginHeaderActions = props.pluginHeaderActionPlacement === 'direct'
    ? props.pluginHeaderActions ?? []
    : [];

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
      {followEditor.enabled && sessionServerId && !headerCompact ? (
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
      {rowsDemanded ? (
        <SessionHeaderActionMenuRows
          {...props}
          open={open}
          palettePresented={palettePresented}
          paletteModalId={paletteModalId}
          setOpen={setOpen}
          session={session}
          sessionServerId={sessionServerId}
          companionAddress={companionAddress}
          followEditor={followEditor}
          showCompanionInOverflow={showCompanionInOverflow}
          companionHeaderIntent={companionHeaderIntent}
          applyCompanionHeaderIntent={applyCompanionHeaderIntent}
          invokePluginHeaderAction={invokePluginHeaderAction}
          publish={rowsStore.set}
        />
      ) : null}
    <View ref={menuAnchorRef} collapsable={false}>
    <SessionHeaderMenuDropdown
      rows={rowsStore}
      open={open}
      onOpenChange={handleOpenChange}
      showCategoryTitles
      // On a phone the menu is the anchored panel under its ⋯ (owner R2), named by the session it acts on.
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
    </>
  );
}

export const SessionHeaderActionMenu = React.memo(
  SessionHeaderActionMenuInner,
  (prev, next) => !didSessionHeaderActionMenuPropsChange(prev, next),
);
