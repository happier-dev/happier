import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { reportSessionTypingEdit, stopSessionTyping } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import * as React from 'react';
import { Image } from 'expo-image';
import {
    View,
    Platform,
    useWindowDimensions,
    ViewStyle,
    Pressable,
    ScrollView,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import { layout } from '@/components/ui/layout/layout';
import { STAGE_SPOTLIGHT_TARGET_IDS } from '@/components/onboarding/tour/stage/stageSpotlightTargetIds';
import {
    useSpotlightTarget,
} from '@/components/onboarding/tour/stage/useSpotlightTarget';
import { useComposerKeyboardLayoutContext } from '@/components/sessions/keyboardAvoidance';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import {
    KeyPressEvent,
    type MultiTextInputSubmitBehavior,
} from '@/components/ui/forms/MultiTextInput';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';
import { composerReferencesFromStructuredMentions, composerStructuredMentionsFromReferences } from '@/components/sessions/composer/composerScopeAdapters';
import type { ComposerEditorReference, ComposerEditorDecoration } from '@/components/ui/forms/composerEditor/composerEditorTypes';
import { buildMentionRefV1, parseMentionRefV1, MENTION_KIND_V1, readMentionRefOpaqueForKindV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { formatSessionInputMentionMarkerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { planComposerReferenceInsertion, recordComposerReferencePublication, readRecentComposerReferenceInsertions, type ComposerReferenceInsertion } from '@/components/sessions/composer/composerReferenceInsertion';
import { applyRecentComposerSkillSelection, buildComposerRecentReferenceSuggestions } from '@/components/sessions/composer/composerRecentReferences';
import { readQuickOpenRecentFiles } from '@/components/workspaces/files/useQuickOpenEmptyState';
import { readComposerSessionSuggestionItems } from '@/sync/domains/input/suggestionSession';
import { readSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListOrderingRules';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { navigateToSession } from '@/hooks/session/useNavigateToSession';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { resolveWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { isAbsoluteLocalPath, normalizeRelativeLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Typography } from '@/constants/Typography';
import type {
    PermissionMode,
    ModelMode,
} from '@/sync/domains/permissions/permissionTypes';
import type { ModelCatalogNames, ModelOption } from '@/sync/domains/models/modelOptions';
import {
    EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID,
    resolveExtendedContextModelIdForToggle,
} from '@/sync/domains/models/extendedContextModelControl';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { ReportedModelStatusIcon } from '@/components/sessions/modelPicker/reportedModelPresentation';
import { buildSessionModelSelectedTriggerPresentation } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { Modal } from '@/modal';
import {
    hapticsLight,
    hapticsError,
} from '@/components/ui/theme/haptics';
import { type ShakeInstance } from '@/components/ui/feedback/Shaker';
import {
    findActiveWord,
    type ActiveWord,
} from '@/components/autocomplete/findActiveWord';
import {
    useActiveSuggestions,
    resolveActiveSuggestionsHandler,
    type ActiveSuggestionsHandler,
    type ActiveSuggestionsSource,
} from '@/components/autocomplete/useActiveSuggestions';
import { resolveComposerSuggestionKind } from '@/components/autocomplete/composerSuggestionKinds';
import { resolveComposerSuggestionKindIdsForTrigger, type ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionGrammar';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import {
    TextInputState,
    MultiTextInputHandle,
} from '@/components/ui/forms/MultiTextInput';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import {
    resolveCommandMenuComboboxAccessibility,
    useCommandMenuKeyboard,
    type CommandMenuAnchor,
} from '@/components/ui/commandMenu';
import { useTextInputCaretRect } from '@/hooks/ui/textInputCaretRect';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import {
    StyleSheet,
    useUnistyles,
} from 'react-native-unistyles';
import {
    useSetting,
    useActiveServerAccountScope,
} from '@/sync/domains/state/storage';
import { useUserMessageHistory } from '@/hooks/session/useUserMessageHistory';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/connectionManager';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@happier-dev/session-core/state';
import {
    getProfileEnvironmentVariables,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';
import {
    DEFAULT_AGENT_ID,
    type AgentId,
} from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
// From the registry rather than the catalog facade: this narrows an id the picker
// supplied, which is the same check the send control's presentation resolver makes.
import { isBundledAgentId } from '@/agents/registry/registryCore';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputScrollableChipRow } from './layout/AgentInputScrollableChipRow';
import { PathAndResumeRow } from './layout/PathAndResumeRow';
import { resolveAgentInputColumn } from './layout/agentInputColumn';
import { resolveAgentInputFolderChipState, type AgentInputFolderChipState } from './definitions/AgentInputFolderChip';
import {
    shouldShowSecondaryControlRow,
    type AgentInputActionBarLayout,
    resolveAgentInputActionBarLayout,
} from './layout/actionBarLogic';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    SessionAuthoringComposer,
    useSessionAuthoringComposerDictation,
} from '@/components/sessions/authoring/SessionAuthoringComposer';
import { VoiceComposerPlanetMount } from '@/components/voice/composer/VoiceComposerPlanetMount';
import {
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL,
    type VoiceAttemptIdleTarget,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import {
    clampNumber,
    computeAgentInputKeyboardOpenVariableSectionMaxHeight,
    computeMeasuredPanelInputMaxHeight,
    resolveAgentInputHostPanelMaxHeight,
    type AgentInputPanelMaxHeightMode,
} from './inputMaxHeight';
import { useAgentInputDefaultMaxHeight } from './useAgentInputDefaultMaxHeight';
import { shouldRenderPermissionChip } from './permissionChipVisibility';
import { type AgentInputContentPopoverConfig } from './components/AgentInputContentPopover';
import { AgentInputEngineDetail } from './components/AgentInputEngineDetail';
import { SessionModelRoutingHint } from '@/components/sessions/modelPicker/SessionModelRoutingHint';
import { SessionModelSourceBrowseHandoffContext, type SessionModelSourceBrowseHandoff } from '@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff';
import {
    SessionInstrumentStrip,
    type SessionInstrumentStripLineAction,
    type SessionInstrumentStripPermission,
    type SessionInstrumentStripQuota,
} from './instrumentStrip';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { AgentInputAttachmentsRow } from './components/AgentInputAttachmentsRow';
import { AgentInputReadOnlyText } from './components/AgentInputReadOnlyText';
import { resolveComposerReferenceChipLabel } from './composerReferenceChipLabel';
import { resolveAgentInputEngineOptionId } from './controls/resolveAgentInputEngineOptionId';
import { openComposerPlacementCustomizer } from './components/openComposerPlacementCustomizer';
import { AgentInputOverlayLayer } from './components/AgentInputOverlayLayer';
import { AgentInputExpansionToggle } from './components/AgentInputExpansionToggle';
import { AgentInputPermissionRequests } from './components/AgentInputPermissionRequests';
import { useOptionalSessionTranscriptSource, useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { resolveArmedComposerContinuation, type ArmedRouteContinuation } from './components/agentContinuationSubmitPresentation';
import { AgentInputSubmitButton } from './components/AgentInputSubmitButton';
import { useAgentInputActionMenuControls } from './controls/useAgentInputActionMenuControls';
import { AGENT_INPUT_COMPACT_CONTROL_IDS } from './controls/agentInputControlRegistry';
import { useAgentInputCoreControlHandlers } from './controls/useAgentInputCoreControlHandlers';
import { useRenderedAgentInputControlRows } from './controls/useRenderedAgentInputControlRows';
import { useSessionAuthoringControls } from '@/components/sessions/authoring/controls/useSessionAuthoringControls';
import { recordLargeTextInputDiagnostic } from '@/utils/system/userInteractionDiagnostics';
import { buildAgentInputSelectionOverlayViewModel } from './selection/buildAgentInputSelectionOverlayViewModel';
import { useAgentInputSelectionAnchors } from './selection/useAgentInputSelectionAnchors';
import { useAgentInputSelectionOverlayController } from './selection/useAgentInputSelectionOverlayController';
import type { AgentInputSelectionOverlayId } from './selection/agentInputSelectionOverlayTypes';
import { deferAgentInputPopoverClose } from './selection/deferAgentInputPopoverClose';
import { useAgentInputExternalPickerRequest } from './selection/useAgentInputExternalPickerRequest';
import type {
    AcpConfigOption,
    AcpConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { isBuiltInOpenApprovalArtifactForSession,
    type OpenApprovalAttentionArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import {
    selectComposerApprovalRequestsForSurface,
    useComposerApprovalRequests,
} from '@/components/tools/shell/approvals/failedApprovalDismissal';
import { Text, TextSelectabilityScope } from '@/components/ui/text/Text';
import { buildGlassCastShadowStyle } from '@/shadowElevation';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import { isGlassComposerSurface } from './composerSurfaceStyle';
import { resolveComposerSelectionRestore } from './composerSelectionRestore';
import {
    AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
    AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE,
    AGENT_INPUT_ACTION_CHIP_STYLE,
    AGENT_INPUT_PANEL_PADDING_BOTTOM,
    AGENT_INPUT_PANEL_PADDING_TOP,
    NATIVE_ACTION_CHIP_GAP_Y,
    resolveAgentInputActionChipTextStyle,
    resolveAgentInputPanelLayoutStyle,
} from './components/agentInputChromeStyles';
import { AGENT_INPUT_CHIP_ROW_HIT_REACH, AgentInputChipRowReach } from './definitions/agentInputChipRowReach';
import { AgentInputReadOnlyChipRow } from './components/AgentInputReadOnlyChipRow';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import { resolveApprovalToolCallLocations } from '@/utils/sessions/approvals/resolveApprovalToolCallLocations';
import {
    resolvePermissionPromptSurface,
    shouldShowGenericPermissionPromptForRequest,
} from '@/utils/sessions/permissions/permissionPromptPolicy';
import { buildSessionMessageRouteId } from "@happier-dev/session-core/messages";
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { useLocalSetting } from '@/sync/store/hooks';
import type { AcpConfigOptionOverridesV1, ComposerRefV1 } from '@happier-dev/protocol';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { readExternalFileDragItems, type WebFileDragEvent } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { useEntityDragDropRuntime, useEntityDropDomBinding, readWindowBounds, measureWindowBounds,
    type TreeDropMeasurableRef, type WindowBounds } from '@/components/ui/treeDragDrop';
import { ExternalFileDropOutcomePill } from '@/components/ui/treeDragDrop/ui/ExternalFileDropOutcomePill';
import { ComposerEntityDropTarget } from '@/components/sessions/composer/ComposerEntityDropTarget';
import type { ComposerReferenceSearchHost } from '@/components/autocomplete/composerSuggestionKinds';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import type { AddWebAttachmentsOptions } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries';
import { groupWebDroppedEntries } from '@/components/sessions/attachments/droppedAttachmentSources';
import type {
    AgentInputAttachmentsRowItem,
    AgentInputComposerDecoration,
    AgentInputComposerInputLock,
    AgentInputControlIntent,
    AgentInputExtraActionChip,
    AgentInputStatusBadge as AgentInputStatusBadgeDescriptor,
} from './agentInputContracts';
import { projectAgentInputAttachmentRowItems, readAgentInputImageNumbers } from './agentInputContracts';
import { describeComposerFileDropOutcome } from '@/components/sessions/composer/composerFileDropOutcome';
import type { AgentInputSendIntentOptions, AgentInputSendOptions } from './agentInputSendOptions';
import type { MessageSendMode } from '@/sync/domains/session/control/submitMode';
import type { AgentInputChipPickerOption } from './components/AgentInputChipPickerTypes';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { insertTextAtSelection } from './insertTextAtSelection';
import { AgentInputDictationButton } from './components/AgentInputDictationButton';
import { AgentInputDictationRecovery, useDictationRecoveryFailure } from './components/AgentInputDictationRecovery';
import { HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import { subscribeToIosHardwareShiftEnter } from './subscribeToIosHardwareShiftEnter';
import {
    COMPOSER_ABORT_CONFIRMATION_WINDOW_MS,
    resolveComposerEnterAction,
    resolveComposerEscapeAction,
    resolveComposerSendShortcutAction,
    buildComposerSendShortcutLabels,
    shouldRunComposerModeCycleShortcut,
} from '@/keyboard/composer';
import { useKeyboardShortcutHandlers, type KeyboardShortcutHandlers } from '@/keyboard';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import type { PromptInvocationSuggestionMetadata } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import { getAutocompleteSuggestionIdentity, type AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type {
    PluginContributedActionDescriptor,
    PluginContributedActionOpenOutcome,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    buildStructuredInputMetaOverrides,
    createStructuredInputMentionFromSuggestion,
    reconcileStructuredInputMentionsWithText,
    reconcileStructuredInputMentionsWithTextChange,
    structuredInputMentionSurvivesText,
    type ComposerStructuredInputMention,
} from './structuredInputMentions';
import {
    INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT,
    normalizeAgentInputExpansionCollapsedMaxHeight,
    resolveAgentInputExpansionToggleVisible,
    shouldReserveAgentInputExpansionToggleSpace,
} from './inputExpansionToggleVisibility';
import { AgentInputCommandMenu } from './commandMenu/AgentInputCommandMenu';
import { AgentInputDocumentPanelContext, AgentInputPopoverClearanceContext, AgentInputPopoverColumnContext } from './selection/useAgentInputPopoverLayout';
import { AgentInputFieldAccessories, resolveAgentInputFieldAccessoryGeometry } from './components/AgentInputFieldAccessories';
import { buildAgentInputPlacementDescriptors, resolveAgentInputPlacementContext } from './controls/buildAgentInputPlacementDescriptors';
import type { AgentInputPlacementContext } from './controls/agentInputControlTypes';
import { getAgentInputFieldAccessoryPlacement } from './controls/agentInputControlRegistry';
import { getAgentInputResetStartPlacement } from './definitions/agentInputActionChipPlacements';
import { resolveAgentInputControlLines, selectComposerPlacementPreferences } from './controls/resolveAgentInputControlLines';
import { isPhoneHardware } from '@/utils/platform/isPhoneHardware';
import { AgentInputPromptPicker } from './commandMenu/AgentInputPromptPicker';
import { usePromptPickerController } from './commandMenu/usePromptPickerController';
import { useAgentInputCommandMenu } from './commandMenu/useAgentInputCommandMenu';
import { SelectionListFooter } from '@/components/ui/selectionList/SelectionListFooter';
import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { resolveAgentInputCommandMenuAnchor } from './commandMenu/resolveAgentInputCommandMenuAnchor';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { StyleProp } from 'react-native';
import {
    areActiveWordsEqual,
    areLiveInputTextStatusesEqual,
    resolveLiveInputTextStatus,
} from './liveInputState';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useSessionViewerComposerReserve } from '@/components/sessions/viewer/SessionViewerController';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

/** Lab P1: the reference picker's one frame (list and footer), kept as results narrow. */
const REFERENCE_PICKER_HEIGHT_PX = 320;
const LazyResetStartPicker = retryableLazy(() => import('./components/AgentInputResetStartPicker'));

/**
 * The action bar's row rhythm on native, where wrapped rows state it as a
 * margin rather than a `gap`. Exported so the trailing cluster's own rhythm can
 * be checked against the column's without re-declaring the number.
 */
export const NATIVE_ACTION_BAR_SECTION_GAP_Y = 6;
const WEB_ACTION_BAR_ROW_GAP_Y = 2;
const WEB_ACTION_BAR_ROW_GAP_MOBILE_Y = 1;
const ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT = 30;
const STATUS_ROW_ITEM_GAP = 8;
const STATUS_ROW_WRAP_GAP = 4;
const AGENT_INPUT_CONTAINER_VERTICAL_PADDING = 4;
const AGENT_INPUT_CONTAINER_VERTICAL_CHROME_HEIGHT = AGENT_INPUT_CONTAINER_VERTICAL_PADDING * 2;
// Panel padding and corner radius come from the composer chrome owner; the radius is shared by the
// panel surface, its cast-shadow wrapper and the auxiliary banners stacked above the panel.
const AGENT_INPUT_PANEL_VERTICAL_CHROME_HEIGHT = AGENT_INPUT_PANEL_PADDING_TOP + AGENT_INPUT_PANEL_PADDING_BOTTOM;
const AGENT_INPUT_VARIABLE_SECTION_CONTENT_PADDING_BOTTOM = 4;
const AGENT_INPUT_COMMAND_MENU_TEST_ID = 'agent-input-command-menu';
const AGENT_INPUT_COMBOBOX_EXPANDED_STATE = { expanded: true } as const;
const AGENT_INPUT_COMBOBOX_COLLAPSED_STATE = { expanded: false } as const;

const AGENT_INPUT_TEST_IDS = {
    sessionInput: 'session-composer-input',
    sessionSend: 'session-composer-send',
    newSessionInput: 'new-session-composer-input',
    newSessionSend: 'new-session-composer-send',
    connectionStatusText: 'agent-input-connection-status-text',
} as const;

type ProgrammaticHistoryInputState = Readonly<{
    state: TextInputState;
}>;

function resolveHistoryKeyInputState(event: KeyPressEvent, fallback: TextInputState): TextInputState {
    return event.inputState ?? fallback;
}

function areTextInputSelectionsEqual(a: TextInputState['selection'], b: TextInputState['selection']): boolean {
    return a.start === b.start && a.end === b.end;
}

function areStructuredInputMentionListsEqual(
    left: readonly ComposerStructuredInputMention[],
    right: readonly ComposerStructuredInputMention[],
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeLayoutHeightPx(height: number): number {
    return Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
}

function updateNullableLayoutHeight(
    setHeight: React.Dispatch<React.SetStateAction<number | null>>,
    height: number,
): void {
    const nextHeight = normalizeLayoutHeightPx(height);
    setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
}

function updateLayoutHeight(
    setHeight: React.Dispatch<React.SetStateAction<number>>,
    height: number,
): void {
    const nextHeight = normalizeLayoutHeightPx(height);
    setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
}

function updateViewportMeasurement(
    setMeasurement: React.Dispatch<React.SetStateAction<number>>,
    measurement: number,
): void {
    const nextMeasurement = Number.isFinite(measurement) ? Math.max(0, measurement) : 0;
    setMeasurement((currentMeasurement) => (
        currentMeasurement === nextMeasurement ? currentMeasurement : nextMeasurement
    ));
}

interface AgentInputProps {
    value: string;
    placeholder: string;
    /** Accessible name for the text input itself, when the host names each composer. */
    inputAccessibilityLabel?: string;
    /** A field-specific repair, supplied by the host's input validation owner. */
    inputAccessibilityHint?: string;
    /** Absent: full selectable document, with no editing, voice or submission. */
    onChangeText?: (text: string) => void;
    /** Scope-local observer for the incumbent input's real focus transitions. */
    onComposerFocusChange?: (focused: boolean) => void;
    /** Scope-local access to this mounted input's existing imperative focus method. */
    onComposerFocusRequestChange?: (request: (() => void) | null) => void;
    /** Forwards a control press that activated this input from its document picture. */
    onComposerControlRequestChange?: (request: ((intent: AgentInputControlIntent) => void) | null) => void;
    onPromptPickerOpenRequestChange?: (request: (() => boolean) | null) => void;
    onComposerInputFlushRequestChange?: (request: (() => void) | null) => void;
    /** Scope-local observer for this mounted input's resolved action-bar layout. */
    onComposerActionBarLayoutChange?: (layout: AgentInputActionBarLayout) => void;
    /** The host's request when the setting is auto (a narrow card asks for wrap); an explicit setting wins. */
    hostActionBarLayout?: AgentInputActionBarLayout;
    sessionId?: string;
    /** Exact immutable Voice target for an existing Session; `null` fails that Session start closed. */
    sessionAddress?: SessionAddress | null;
    /** Exact Composer identity for origin-neutral authoring surfaces without a Session. */
    composerRef?: ComposerRefV1;
    /** Borrows the current suggestion/provider owner; drops retain identity only. */
    composerReferenceHost?: ComposerReferenceSearchHost | null;
    /** Machine-addressed composers use their existing file-search scope. */
    composerFileScope?: FileSuggestionScope | null;
    /** The Session host supplies its normalized access capability and exact Home. */
    sessionTypingPresence?: Readonly<{ serverId: string; canSubmitAgentInput: boolean }>;
    /** The retaining Session surface's existing presented fact; absent hosts are mounted/presented. */
    surfacePresented?: boolean;
    /**
     * Submits the composer. Absent means authoring only (a workflow step's
     * prompt): no send or stop affordance, Enter always inserts a newline
     * whatever the Session Enter-to-send preference says, send shortcuts are
     * left to the page (its Mod+Enter Run, Mod+S Save), and nothing touches
     * focus, message history or the submit lock on the way.
     */
    onSend?: (options?: AgentInputSendOptions) => void;
    sendMenuModes?: readonly MessageSendMode[];
    alternateSendMode?: MessageSendMode;
    canSendNextQueued?: boolean;
    /** The Session submit owner admits reset-bound text for its current recipient. */
    resetStartEnabled?: boolean;
    submitAccessibilityLabel?: string;
    sendIcon?: React.ReactNode;
    permissionMode?: PermissionMode;
    /** An embed's allowed permission modes; the mode picker offers only these. */
    allowedPermissionModes?: readonly PermissionMode[] | null;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onPermissionClick?: () => void;
    onAcpSessionModeChange?: (modeId: string) => void;
    retainKeyboardLift?: () => () => void;
    /**
     * Optional override for ACP "session mode" picker options (e.g. OpenCode plan/build).
     *
     * Used by new-session flows to surface ACP modes before a session exists.
     */
    acpSessionModeOptionsOverride?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    /**
     * Optional selected ACP mode when using `acpSessionModeOptionsOverride`.
     *
     * When null/empty, the UI should behave like "Default" (no override).
     */
    acpSessionModeSelectedIdOverride?: string | null;
    /**
     * Optional: show a probe/loading state + refresh control in the ACP mode picker.
     */
    acpSessionModeOptionsOverrideProbe?: OptionPickerProbeState;
    acpConfigOptionsOverride?: ReadonlyArray<AcpConfigOption>;
    acpConfigOptionsOverrideProbe?: OptionPickerProbeState;
    acpConfigOptionOverridesOverride?: AcpConfigOptionOverridesV1 | null;
    onAcpConfigOptionChange?: (configId: string, valueId: AcpConfigOptionValueId) => void;
    modelMode?: ModelMode;
    /** Whether the session runtime is active; omitted when this composer has no runtime. */
    sessionActive?: boolean;
    /** Exact backend target for active-runtime provenance (including configured-target identity). */
    agentTargetKey?: string | null;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
    onModelModeChange?: (mode: ModelMode) => void;
    /**
     * Optional override for model picker options.
     *
     * Used by new-session flows to display preflight/probed model lists before a session exists.
     */
    modelOptionsOverride?: readonly ModelOption[];
    /**
     * Optional: show a probe/loading state + refresh control in the model picker.
     * Intended for preflight (no-session) flows that dynamically probe models.
     */
    modelOptionsOverrideProbe?: OptionPickerProbeState & ModelCatalogNames;
    /** Optional domain-owned model list UI; AgentInput still owns the surrounding engine detail. */
    modelContentOverride?: React.ReactNode;
    /**
     * `none` hides the agent/engine picker entirely, including sections the agent's own settings
     * would contribute. Used by an embedded presentation that offers no configuration. Default `auto`.
     */
    engineControls?: 'auto' | 'none';
    /**
     * `controlsOnly` keeps the composer's controls (the engine and model picker, approvals) and draws no
     * text field, send or dictation: a host that grants a Session control without text submission (an
     * embed's "Change model" without Send). Default `full`.
     */
    inputPresentation?: 'full' | 'controlsOnly';
    /** Embedded presentations narrow the host's device-local customization entry. */
    allowPlacementCustomization?: boolean;
    /** Explicit context for a host without a portable Composer identity (for example a workflow launch form). */
    placementContext?: AgentInputPlacementContext;
    /**
     * `none` mounts no voice affordance or dictation, whatever the account enables (the embedded
     * presentation). `dictation` retains the microphone without mounting conversational Voice (a
     * Workflow step authors a document, not a live conversation). Default `auto`.
     */
    voiceAffordance?: 'auto' | 'dictation' | 'none';
    /**
     * `none`: ArrowUp/ArrowDown never recall the person's agent prompts into this field (a human
     * discussion's composer, where those prompts are not what is being written). Default `auto`.
     */
    messageHistory?: 'auto' | 'none';
    /** Controls prompt-library contents independently of recalled message history. Default `auto`. */
    promptLibrary?: 'auto' | 'none';
    /**
     * `none`: a bare `@` offers only `autocompleteSuggestions`, with no Recent group drawn from the whole
     * Account (a Discussion, whose roster is the complete set of who can be addressed). Default `auto`.
     */
    referenceRecents?: 'auto' | 'none';
    /** Changes to a non-empty key open the model/agent picker for an explicit external action. */
    openModelPickerRequestKey?: string | null;
    /**
     * A new `key` opens that action chip's popover for an explicit request from another surface (the
     * Work tab opening the Goal control). Collapsed chips open from the action menu's anchor.
     */
    openActionChipRequest?: Readonly<{ chipKey: string; key: string }> | null;
    metadata?: Metadata | null;
    composerOptionsInput?: ComposerOptionsInputV1 | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
        /** An unavailable launch target is repaired through the existing machine picker. */
        recovery?: 'machine';
        /** The one trailing action the line offers (the guard's Keep running). */
        action?: SessionInstrumentStripLineAction;
        /** A second, quieter way forward after the action (Sign in beside a connected account's switch). */
        secondaryAction?: SessionInstrumentStripLineAction;
        /** The longer explanation behind the short line (a Provider binding's body), shown as its tooltip. */
        detail?: string;
        /** A coming stop: the line ends with a countdown to it, ticking in its own leaf. */
        countdownTo?: number;
        /** Which guard moment the line shows; a change cross-fades the line. */
        transitionKey?: string;
    };
    /**
     * `compact`: an ask box on a page about one thing (the machine page's "Ask an agent", lab `ra`
     * A1). The composer contains only where it runs and which model answers, on one rail; every
     * other choice keeps the new session's default. Default `full`.
     */
    controlPreset?: 'full' | 'compact';
    /**
     * `document`: the composer is one card in a document (a workflow step), not the floating
     * composer of a conversation. It draws the plain hairline card the read-only presentation
     * draws — no glass rim or cast shadow, whatever the composer style setting — with no outer
     * vertical padding and no reserved empty status row, so the document's own rhythm places it.
     * Default `composer`.
     */
    panelPresentation?: 'composer' | 'document';
    /**
     * Plan/quota usage bundle rendered by the instrument strip. Data path stays
     * System-B-owned (SessionView); the strip only restyles the trigger.
     */
    instrumentQuota?: SessionInstrumentStripQuota | null;
    statusBadges?: ReadonlyArray<AgentInputStatusBadgeDescriptor>;
    /** Admitted statusStrip regions from the shared Composer presentation owner. */
    statusRegions?: React.ComponentProps<typeof SessionInstrumentStrip>['statusRegions'];
    statusTrailingActions?: React.ReactNode;
    /** Hosts with an editable permission chip may omit the repeated instrument-strip label. */
    showStatusPermissionMode?: boolean;
    activeStatusBadgeKey?: string | null;
    onActiveStatusBadgeKeyChange?: (key: string | null) => void;
    /** Eligible suggestion kinds for this composer host. Trigger characters follow from the kinds (INV-1). */
    autocompleteKinds: readonly ComposerSuggestionKindId[];
    /** Receives an abort signal for the query it is resolving; a superseded query is never applied (D-15). */
    autocompleteSuggestions: ActiveSuggestionsSource;
    /** Session composer host opens controller-admitted external slash Actions through the canonical Action path. */
    onContributedActionSuggestionSelect?: (
        action: PluginContributedActionDescriptor,
    ) => Promise<PluginContributedActionOpenOutcome> | PluginContributedActionOpenOutcome;
    onFileViewerPress?: () => void;
    agentType?: string;
    agentLabel?: string | null;
    /**
     * A controlled authoring engine/Role label; live Sessions retain their own projection. With
     * `engineControls="none"` it is a fixed chip naming who answers (a walkthrough's model), with no picker.
     */
    engineLabel?: string;
    /** The Agent a fixed `engineLabel` belongs to, for the chip's mark. */
    engineAgentId?: string;
    /** Already-demanded picker facts; the closed chip shares the picker's label owner without discovery. */
    modelPickerPresentation?: Parameters<typeof buildSessionModelSelectedTriggerPresentation>[0];
    /** Current machine-qualified catalog identity for the running/preflight Agent. */
    agentCatalogIdentity?: Readonly<{
        entry: ResolvedAgentCatalogEntry;
        machineId: string | null;
        serverId: string | null;
        current: boolean;
    }>;
    onAgentClick?: () => void;
    agentPickerTitle?: string;
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    /**
     * Extends the composer's own current-Agent rows with more of the Agent catalog,
     * for surfaces that offer other Agents alongside the running one. It receives
     * the rows this composer built and returns the complete list. `agentPickerOptions`
     * still replaces the list outright when a caller owns the whole projection.
     */
    composeAgentPickerOptions?: (
        currentAgentOptions: ReadonlyArray<AgentInputChipPickerOption>,
    ) => ReadonlyArray<AgentInputChipPickerOption>;
    /**
     * The Agent picker opened or closed. Lets a caller defer work that is only
     * worth doing once the user is actually choosing an Agent — a live capability
     * probe, for instance — instead of on every composer mount.
     */
    onAgentPickerVisibilityChange?: (visible: boolean) => void;
    agentPickerSelectedOptionId?: string | null;
    onAgentPickerSelect?: (id: string) => void;
    agentPickerApplyLabel?: string;
    agentPickerProbe?: OptionPickerProbeState;
    machineName?: string | null;
    onMachineClick?: () => void;
    machinePopover?: AgentInputContentPopoverConfig;
    /** The folder shown by the folder chip; shorthand for `folderChipState: {kind:'folder'}`. */
    currentPath?: string | null;
    /** The folder chip's state when it is not simply a folder (no folder, loading, machine unavailable). */
    folderChipState?: AgentInputFolderChipState;
    /** Present when the folder can be removed from the composer (×, Delete, the a11y action, the menu). */
    onRemoveFolder?: () => void;
    onPathClick?: () => void;
    pathPopover?: AgentInputContentPopoverConfig;
    resumeSessionId?: string | null;
    onResumeClick?: () => void;
    resumePopover?: AgentInputContentPopoverConfig;
    resumeIsChecking?: boolean;
    isSendDisabled?: boolean;
    /**
     * The Agent the in-session picker has armed for the next message, or null.
     *
     * The composer does not act on it — the session's send owner does — but the
     * send control names it, because pressing send with a target armed continues
     * this Session with that Agent rather than the one running now.
     */
    armedContinuationTarget?: Readonly<{
        agentId: string;
        /** Exact catalog target key the selected picker row came from. */
        backendTargetKey?: string;
        label: string;
        /**
         * The label of the model chosen for the target Agent, or null while it is
         * still on that Agent's own defaults. It is the picker's OWN label — the
         * exact words the reader just selected — rather than a second lookup that
         * could name the same model differently.
         */
        modelLabel?: string | null;
    }> | null;
    /**
     * A route or model change for the running Agent, armed for the next message
     * (D15). The send control names it; the session's send owner applies it.
     */
    armedRouteContinuation?: ArmedRouteContinuation | null;
    /** Cancels the armed route change (D15); see `AgentInputSubmitButton`. */
    onUnarmRoute?: (() => void) | null;
    unarmRoutePending?: boolean;
    isSending?: boolean;
    disabled?: boolean;
    /** Ephemeral target-owned feedback; it never changes the input document. */
    composerDecorations?: readonly AgentInputComposerDecoration[];
    /** Aggregated target-owned lock state, already bounded by the protocol owner. */
    composerInputLock?: AgentInputComposerInputLock | null;
    minHeight?: number;
    inputMaxHeight?: number;
    inputExpansion?: Readonly<{
        expanded: boolean;
        collapsedMaxHeight?: number;
        onToggle: () => void;
    }>;
    inputPersistence?: Readonly<{
        initialScrollY?: number;
        initialSelection?: TextInputState['selection'];
        restoreToken: string;
        /** Omitted by a host that restores the caret but owns no scroll position. */
        onScrollYChange?: (scrollY: number) => void;
        onSelectionChangePersist: (selection: TextInputState['selection'], textLength: number) => void;
    }>;
    structuredInputMentions?: readonly ComposerStructuredInputMention[];
    onStructuredInputMentionsChange?: (mentions: readonly ComposerStructuredInputMention[]) => void;
    maxPanelHeight?: number;
    /**
     * Defaults to native-floating so existing-session web composers stay flex-bounded
     * without a late measured cap. New-session/modal hosts should use host-constrained
     * when maxPanelHeight is the authoritative all-platform composer budget.
     */
    panelMaxHeightMode?: AgentInputPanelMaxHeightMode;
    profileId?: string | null;
    onProfileClick?: () => void;
    profilePopover?: AgentInputContentPopoverConfig;
    envVarsCount?: number;
    onEnvVarsClick?: () => void;
    envVarsPopover?: AgentInputContentPopoverConfig;
    contentPaddingHorizontal?: number;
    panelStyle?: ViewStyle;
    /** Placement supplied by the host; the transcript remains on the content plane. */
    surfaceGroup?: GlassSurfaceGroup;
    maxWidthCap?: number | null;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    /** UI-only Browser/Review presentation rendered before file/image attachments. */
    attachmentRowItems?: ReadonlyArray<AgentInputAttachmentsRowItem>;
    /**
     * A control rendered immediately before the submit button, at the trailing
     * edge of the action row.
     *
     * `extraActionChips` places contributions in the LEADING chip row, which in
     * a live session already carries model, mode, target, permission, account,
     * attach, mention, branch and diff. A *mode* that must stay operable while
     * the trailing slot is a Stop button — Voice being the case this exists for —
     * has nowhere to go there.
     *
     * Purely additive: when omitted the action row is byte-identical to before.
     */
    trailingAccessory?: React.ReactNode;
    /**
     * Whether the submit button may become the dictation mic when the composer
     * is empty. Defaults to `true` (today's behaviour).
     *
     * Hosts that surface speech through their own control set this `false` so
     * the submit button means exactly one thing — send, or stop. That also
     * un-shadows `showStopWhenEmpty` in `AgentInputSubmitButton`, which is
     * currently unreachable whenever the `voice` feature is on, because
     * `showDictation` always wins for an empty composer.
     */
    submitDictation?: boolean;
    /**
     * A control pinned to the top-right of the text field itself.
     *
     * This is where an affordance belongs when it **acts on the field's text**
     * rather than on the session — dictation being the case it exists for, since
     * dictation appends words to the input and nothing else.
     *
     * The composer owns the stacking: the accessory takes the expand toggle's
     * slot while that toggle is hidden, and drops one row beneath it when the
     * toggle appears, so the two never collide.
     */
    fieldAccessory?: React.ReactNode;
    onAttachmentsAdded?: (files: readonly File[], options?: AddWebAttachmentsOptions) => readonly AttachmentDraft[] | void;
    /** The attachment owner describes constraints before an OS drop is released. */
    attachmentDropHint?: string;
    hasSendableAttachments?: boolean;
    permissionRequests?: ReadonlyArray<PendingPermissionRequest>;
    approvalRequests?: ReadonlyArray<OpenApprovalAttentionArtifactForSession>;
    canApprovePermissions?: boolean;
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
}

type AgentInputPermissionRequestsProps = React.ComponentProps<typeof AgentInputPermissionRequests>;

const EMPTY_PERMISSION_LOCATIONS_BY_ID: ReadonlyMap<string, PermissionToolCallMessageLocation | null> = new Map();
const NO_APPROVAL_REQUESTS: ReadonlyArray<OpenApprovalAttentionArtifactForSession> = [];
const EMPTY_APPROVAL_LOCATIONS_BY_ARTIFACT_ID: ReadonlyMap<string, PermissionToolCallMessageLocation | null> = new Map();

const AgentInputAttentionRequestsWithLocations = React.memo(function AgentInputAttentionRequestsWithLocations(
    props: Omit<AgentInputPermissionRequestsProps, 'permissionLocationsById' | 'approvalLocationsByArtifactId'>,
) {
    const source = useSessionTranscriptSource();
    const committedMessageIdsOldestFirst = source.useMessageIdsOldestFirst();
    const committedMessagesById = source.useMessagesById();
    const committedMessagesReducerState = source.useReducerState();

    const permissionLocationsById = React.useMemo(() => {
        const ids = props.permissionRequests.map((request) => request.id);
        if (ids.length === 0) return EMPTY_PERMISSION_LOCATIONS_BY_ID;
        return new Map(
            resolvePermissionToolCallLocations({
                permissionIds: ids,
                messageIdsOldestFirst: committedMessageIdsOldestFirst,
                messagesById: committedMessagesById,
                resolveRouteMessageId: (messageId, _message) =>
                    buildSessionMessageRouteId({
                        messageId,
                        messagesById: committedMessagesById,
                        reducerState: committedMessagesReducerState,
                    }),
            }),
        );
    }, [
        committedMessageIdsOldestFirst,
        committedMessagesById,
        committedMessagesReducerState,
        props.permissionRequests,
    ]);

    const approvalLocationsByArtifactId = React.useMemo(() => {
        const approvals = (props.approvalRequests ?? []).filter(isBuiltInOpenApprovalArtifactForSession).map((request) => ({
            artifactId: request.artifact.id,
            approval: request.approval,
        }));
        if (approvals.length === 0) return EMPTY_APPROVAL_LOCATIONS_BY_ARTIFACT_ID;
        return resolveApprovalToolCallLocations({
            approvals,
            sessionId: props.sessionId,
            messageIdsOldestFirst: committedMessageIdsOldestFirst,
            messagesById: committedMessagesById,
            resolveRouteMessageId: (messageId, _message) =>
                buildSessionMessageRouteId({
                    messageId,
                    messagesById: committedMessagesById,
                    reducerState: committedMessagesReducerState,
                }),
        });
    }, [
        committedMessageIdsOldestFirst,
        committedMessagesById,
        committedMessagesReducerState,
        props.approvalRequests,
        props.sessionId,
    ]);

    return (
        <AgentInputPermissionRequests
            {...props}
            permissionLocationsById={permissionLocationsById}
            approvalLocationsByArtifactId={approvalLocationsByArtifactId}
        />
    );
});

const stylesheet = StyleSheet.create((theme, runtime) => ({
    /** The reference picker's kind tabs: the footer's inset and divider, mirrored at the top. */
    referencePickerTabs: {
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    container: {
        alignItems: 'center',
        width: '100%',
        paddingBottom: theme.space.s8,
        paddingTop: theme.space.s8,
    },
    /** A document card: the document's own rhythm places it (`panelPresentation="document"`). */
    containerDocument: {
        paddingTop: 0,
        paddingBottom: 0,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    // Default (non-glass) composer surface — the original styling: standard input
    // background + hairline surface border, no drop shadow.
    unifiedPanel: resolveAgentInputPanelLayoutStyle(theme),
    // The composer style changes its shadow; the Elements material owns its fill. The edge stays
    // the standard single even hairline: the composer has no lip (DESIGN.md, owner 2026-10-15).
    // The cast shadow lives on the `panelShadow` wrapper (glass mode only).
    unifiedPanelGlass: {
        // Composer-only fainter inner shadow (the other glass surfaces keep `glass.innerShadow`).
        boxShadow: theme.colors.glass.composerInnerShadow,
    },
    // Cast-shadow wrapper (un-clipped) for the glass composer — the two-layer pattern
    // the tab bar uses so the soft drop shadow renders around the clipped surface.
    // `buildGlassCastShadowStyle` uses native shadow* on iOS and the cross-platform
    // boxShadow on Android/web (never Android `elevation`), damped further on web.
    panelShadow: {
        borderRadius: theme.parts.composer.radius,
    },
    // Match the cockpit tab bar that sits beside the composer: same level, softened.
    panelShadowGlass: {
        ...buildGlassCastShadowStyle(theme.colors.shadowLevels[4], theme.colors.glass.castShadow, true),
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s8,
        paddingVertical: AGENT_INPUT_CONTAINER_VERTICAL_PADDING,
        minHeight: 40,
    },
    readOnlyInputContent: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    /** A reading card hugs its text: the field's reserved line is for typing into. */
    readOnlyDocumentContent: {
        minHeight: 0,
    },
        readOnlyText: {
            color: theme.colors.text.primary,
            textAlign: 'left',
        },
        /** The same composer edge in a document, editable or read-only (C1: read-only is interaction, not an edge). */
        documentPanel: resolveAgentInputPanelLayoutStyle(theme),
        readOnlyPanel: {
            ...resolveAgentInputPanelLayoutStyle(theme),
            width: '100%',
            alignSelf: 'stretch',
        },
    nativeKeyboardPanelContent: {
        minHeight: 0,
    },
    nativeKeyboardVariableSection: {
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
    },
    nativeKeyboardVariableSectionContent: {
        paddingBottom: AGENT_INPUT_VARIABLE_SECTION_CONTENT_PADDING_BOTTOM,
    },
    webVariableSectionEdgeToEdge: {
        marginHorizontal: -8,
    },
    webVariableSectionContentInset: {
        paddingHorizontal: theme.space.s8,
    },
    composerPresentationEffects: {
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s4,
    },
    composerInputLockFeedback: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.state.warning.border,
        backgroundColor: theme.colors.state.warning.background,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
    },
    composerInputLockFeedbackText: {
        color: theme.colors.state.warning.foreground,
        ...Typography.variant('meta', 'semiBold'),
    },
    readOnlyReferenceText: {
        ...Typography.variant('meta'),
    },
    nativeKeyboardFooterSection: {
        flexShrink: 0,
    },

    // Overlay styles
    settingsOverlay: {
        // positioning is handled by `Popover`
    },
    overlaySection: {
        paddingVertical: theme.space.s16,
    },
    overlaySectionTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s4,
    },
    overlayInlineRefreshButton: {
        minWidth: 30,
        height: 30,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: 'transparent',
    },
    overlayInlineRefreshButtonPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    overlayInlineRefreshButtonDisabled: {
        opacity: 0.6,
    },
    overlayEffectivePolicy: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s2,
        paddingBottom: theme.space.s8,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
        backgroundColor: 'transparent',
    },
    selectionItemPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    radioButton: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: theme.space.s12,
    },
    radioButtonActive: {
        borderColor: theme.colors.radio.active,
    },
    radioButtonInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioButtonDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    selectionLabel: {
        fontSize: 14,
        ...Typography.default(),
    },
    selectionLabelActive: {
        color: theme.colors.radio.active,
    },
    selectionLabelInactive: {
        color: theme.colors.text.primary,
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: STATUS_ROW_ITEM_GAP,
        rowGap: STATUS_ROW_WRAP_GAP,
    },
    connectionStatusGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
    },
    statusText: {
        ...Typography.variant('micro'),
    },
    statusDot: {
        marginRight: theme.space.s6,
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        ...Typography.variant('micro'),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        columnGap: theme.space.s8,
        paddingHorizontal: 0,
    },
    actionButtonsColumn: {
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_Y } : {}),
    },
    actionButtonsColumnMobile: {
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_MOBILE_Y } : {}),
    },
    actionButtonsColumnNarrow: {
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_Y } : {}),
    },
    actionButtonsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    /**
     * The trailing cluster: an optional accessory plus submit.
     *
     * It is the chip column's **sibling**, not a passenger inside chip row 1 —
     * see `actionButtonsContainer`, which aligns the two on their shared bottom
     * edge. Nested in the row it was centred against 32pt chips, so every point
     * it stood taller was charged twice, above and below, as a dead band under
     * the input.
     *
     * One row — the accessory sits *before* the submit, reading left-to-right
     * as "mode, then send" (VE-02), also when the chips wrap to a second rail:
     * the container aligns the cluster to the column's bottom edge, so it rides
     * the last rail's line instead of stacking Voice under Send.
     */
    trailingAccessoryInline: {
        flexDirection: 'row',
        // An armed continuation names its destination in words ("Continue with
        // GPT-6-Sol") and is wider than any other occupant of the cluster, which are
        // all fixed-width and never reach the cap. On a phone that sentence, the
        // cancel beside it and the Voice accessory need most of the card: the rail
        // yields to them, because the sentence is what the reader is about to press
        // and must read whole. The cap still leaves the rail a share of the row and
        // its scroll, and an unusually long name ellipsizes inside the label rather
        // than covering the rail.
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '85%',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    actionButtonsRowWithBelow: {
        // Match the vertical rhythm of wrapped chip rows on native.
        marginBottom: Platform.OS === 'web' ? 0 : NATIVE_ACTION_BAR_SECTION_GAP_Y,
    },
    pathRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        ...(Platform.OS === 'web' ? { columnGap: theme.space.s6, rowGap: 1 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
        flex: 1,
        minWidth: 0,
        flexWrap: 'wrap',
        overflow: 'visible',
    },
    actionButtonsLeftScroll: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
    },
    actionButtonsScrollViewportContent: {
        paddingRight: ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT,
    },
    actionButtonsLeftScrollInline: {
        flexDirection: 'row',
        alignItems: 'center',
        ...(Platform.OS === 'web' ? { columnGap: theme.space.s6 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionButtonsLeftScrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        ...(Platform.OS === 'web' ? { columnGap: theme.space.s6 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
        paddingRight: ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT,
    },
    actionButtonsFadeLeft: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 24,
        zIndex: 2,
    },
    actionButtonsFadeRight: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 24,
        zIndex: 2,
    },
    actionButtonsLeftNarrow: {
        columnGap: theme.space.s4,
    },
    actionButtonsLeftNoFlex: {
        flex: 0,
    },
    actionItemWrapper: {
        // Non-chip action items (e.g. SCM status) should align with chips on native.
        ...(Platform.OS === 'web' ? {} : { marginRight: theme.space.s6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionChip: AGENT_INPUT_ACTION_CHIP_STYLE,
    /** A chip whose menu is open holds the ink selection fill. */
    actionChipOpen: { backgroundColor: theme.colors.surface.selected },
    actionChipText: resolveAgentInputActionChipTextStyle(theme),
    actionChipCountText: {
        color: theme.colors.composer.chipTint,
    },
    overlayOptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
    },
    overlayOptionRowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    overlayOptionLabel: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    overlayOptionLabelSelected: {
        color: theme.colors.radio.active,
    },
    overlayOptionLabelUnselected: {
        color: theme.colors.text.primary,
    },
    overlayOptionDescription: {
        ...Typography.variant('micro'),
        color: theme.colors.text.secondary,
    },
    overlayEmptyText: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
        justifyContent: 'center',
        height: 32,
        // Keep vertical alignment consistent with `actionChip` on native.
        ...(Platform.OS === 'web' ? {} : { marginRight: theme.space.s6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionButtonPressed: {
        opacity: motionTokens.press.opacity,
    },
    actionButtonIcon: {
        color: theme.colors.composer.chipTint,
    },
    sessionInputText: {
        fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
    },
    newSessionInputText: {
        fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
    },
}));

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const transcriptSource = useOptionalSessionTranscriptSource();
    // Interactive local samples have conversation presentation without live Session runtime authority.
    const localSampleSource = transcriptSource?.kind === 'readOnly' && transcriptSource.actions !== null ? transcriptSource : null;
    const isConversation = Boolean(props.sessionId || localSampleSource);
    const compactControls = props.controlPreset === 'compact';
    const column = resolveAgentInputColumn({
        screenWidth,
        ...(props.contentPaddingHorizontal === undefined ? {} : { contentPaddingHorizontal: props.contentPaddingHorizontal }),
        ...(props.maxWidthCap === undefined ? {} : { maxWidthCap: props.maxWidthCap }),
        compact: compactControls,
    });
    const attentionRequestSessionId = props.sessionId ?? localSampleSource?.sessionId;
    const submitAccessibilityLabel = props.submitAccessibilityLabel ?? (isConversation ? t('common.send') : undefined);
    const readOnly = props.onChangeText === undefined;
    const voiceFeatureEnabled = useFeatureEnabled('voice');
    const voiceEnabled = !readOnly && voiceFeatureEnabled && props.voiceAffordance !== 'none';
    const documentPanel = props.panelPresentation === 'document';
    const chipTint = theme.colors.composer.chipTint;
    const composerSurfaceStyleSetting = useSetting('composerSurfaceStyle');
    const isGlassComposer = !documentPanel && isGlassComposerSurface({ setting: composerSurfaceStyleSetting });
    const surfaceGroup = props.surfaceGroup ?? 'card';
    const composerSurfaceColor = isGlassComposer ? theme.colors.glass.composerSurface : theme.colors.input.background;
    const panelMaterialProps = { surfaceGroup, nested: surfaceGroup === 'card', solidColor: composerSurfaceColor, finishRole: 'composer' as const };
    const keyboardShortcutsV2Enabled = useSetting('keyboardShortcutsV2Enabled') === true;
    const keyboardSingleKeyShortcutsEnabled = useSetting('keyboardSingleKeyShortcutsEnabled') === true;
    const keyboardShortcutOverridesV1 = useSetting('keyboardShortcutOverridesV1') ?? {};
    const keyboardShortcutDisabledCommandIdsV1 = useSetting('keyboardShortcutDisabledCommandIdsV1') ?? [];
    const renderIoniconNode = React.useCallback(
        (
            name: IconName,
            size: number,
            color: string,
            style?: StyleProp<ViewStyle>,
        ) => normalizeNodeForView(<Icon name={name} size={size} color={color} style={style} />),
        [],
    );
    const renderOcticonNode = React.useCallback(
        (
            name: IconName,
            size: number,
            color: string,
            style?: StyleProp<ViewStyle>,
        ) => normalizeNodeForView(<Icon name={name} size={size} color={color} style={style} />),
        [],
    );

    const defaultInputMaxHeight = useAgentInputDefaultMaxHeight();
    // Existing-session web/Tauri composers are flex-bounded, so their late measured
    // maxPanelHeight must not re-constrain the panel during session switches. Hosts that
    // own an explicit composer budget (for example /new modals) opt into applying it on web.
    const hostPanelMaxHeight = resolveAgentInputHostPanelMaxHeight({
        platform: Platform.OS,
        maxPanelHeight: props.maxPanelHeight,
        mode: props.panelMaxHeightMode,
    });
    const [panelHeightPx, setPanelHeightPx] = React.useState<number | null>(null);
    const [inputContainerHeightPx, setInputContainerHeightPx] = React.useState<number | null>(null);
    const [inputContentHeightPx, setInputContentHeightPx] = React.useState<number | null>(null);
    const [inputExpansionToggleVisible, setInputExpansionToggleVisible] = React.useState(false);
    const [actionFooterHeightPx, setActionFooterHeightPx] = React.useState(0);
    const [composerAttentionHeightPx, setComposerAttentionHeightPx] = React.useState(0);
    const [variableContentBeforeInputHeightPx, setVariableContentBeforeInputHeightPx] = React.useState(0);
    const [nativeAttachmentViewportOffsetPx, setNativeAttachmentViewportOffsetPx] = React.useState(0);
    const [nativeAttachmentViewportHeightPx, setNativeAttachmentViewportHeightPx] = React.useState(0);
    const [nativeAttachmentRowTopPx, setNativeAttachmentRowTopPx] = React.useState<number | null>(null);
    // ScrollView reports content coordinates, while attachment body layouts
    // are relative to the row itself. This existing native viewport owner
    // translates between those spaces; the row retains the sole mount decision.
    const nativeAttachmentViewport = React.useMemo(() => (
        nativeAttachmentRowTopPx === null
            ? { offset: 0, height: 0 }
            : {
                offset: nativeAttachmentViewportOffsetPx - nativeAttachmentRowTopPx,
                height: nativeAttachmentViewportHeightPx,
            }
    ), [
        nativeAttachmentRowTopPx,
        nativeAttachmentViewportHeightPx,
        nativeAttachmentViewportOffsetPx,
    ]);
    const handleNativeAttachmentViewportLayout = React.useCallback((event: LayoutChangeEvent) => {
        updateViewportMeasurement(setNativeAttachmentViewportHeightPx, event.nativeEvent.layout.height);
    }, []);
    const handleNativeAttachmentViewportScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        updateViewportMeasurement(setNativeAttachmentViewportOffsetPx, event.nativeEvent.contentOffset.y);
    }, []);
    const handleNativeAttachmentRowLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextTop = Number.isFinite(event.nativeEvent.layout.y)
            ? Math.max(0, event.nativeEvent.layout.y)
            : 0;
        setNativeAttachmentRowTopPx((currentTop) => currentTop === nextTop ? currentTop : nextTop);
    }, []);
    const panelVariableSectionMaxHeight = React.useMemo(() => {
        if (typeof hostPanelMaxHeight !== 'number') return undefined;
        return computeAgentInputKeyboardOpenVariableSectionMaxHeight({
            panelMaxHeight: hostPanelMaxHeight,
            footerHeight: actionFooterHeightPx + composerAttentionHeightPx,
        });
    }, [actionFooterHeightPx, composerAttentionHeightPx, hostPanelMaxHeight]);
    const fallbackInputMaxHeight = props.inputMaxHeight ?? defaultInputMaxHeight;
    const minimumMeasuredPanelFixedChromeHeight = Platform.OS === 'web'
        ? actionFooterHeightPx
            + composerAttentionHeightPx
            + variableContentBeforeInputHeightPx
            + AGENT_INPUT_PANEL_VERTICAL_CHROME_HEIGHT
            + AGENT_INPUT_VARIABLE_SECTION_CONTENT_PADDING_BOTTOM
        : undefined;
    const resolvedInputMaxHeight = React.useMemo(() => {
        return computeMeasuredPanelInputMaxHeight({
            panelMaxHeight: hostPanelMaxHeight,
            panelHeight: panelHeightPx,
            inputContainerHeight: inputContainerHeightPx,
            inputContainerChromeHeight: AGENT_INPUT_CONTAINER_VERTICAL_CHROME_HEIGHT,
            minimumFixedChromeHeight: minimumMeasuredPanelFixedChromeHeight,
            fallbackMaxHeight: fallbackInputMaxHeight,
            fallbackMaxHeightMode: isConversation ? 'cap' : 'seed',
        });
    }, [
        fallbackInputMaxHeight,
        hostPanelMaxHeight,
        inputContainerHeightPx,
        minimumMeasuredPanelFixedChromeHeight,
        panelHeightPx,
        isConversation,
    ]);
    const inputExpansionCollapsedMaxHeight = normalizeAgentInputExpansionCollapsedMaxHeight(
        props.inputExpansion?.collapsedMaxHeight,
    );
    const handleInputContentHeightChange = React.useCallback((height: number) => {
        updateNullableLayoutHeight(setInputContentHeightPx, height);
    }, []);
    const hasInputExpansion = Boolean(props.inputExpansion);
    React.useEffect(() => {
        setInputExpansionToggleVisible((currentVisible) => resolveAgentInputExpansionToggleVisible({
            currentVisible,
            hasInputExpansion,
            inputContentHeightPx,
            collapsedMaxHeight: inputExpansionCollapsedMaxHeight,
        }));
    }, [hasInputExpansion, inputContentHeightPx, inputExpansionCollapsedMaxHeight]);
    const shouldShowInputExpansionToggle = hasInputExpansion && inputExpansionToggleVisible;
    const shouldReserveInputExpansionToggleSpace = shouldReserveAgentInputExpansionToggleSpace({
        hasInputExpansion,
        collapsedMaxHeight: inputExpansionCollapsedMaxHeight,
    });

    const [liveTextStatus, setLiveTextStatus] = React.useState(() => resolveLiveInputTextStatus(props.value));
    const liveTextStatusRef = React.useRef(liveTextStatus);
    const hasText = liveTextStatus.hasText;
    const hasSendableContent = hasText || props.hasSendableAttachments === true;
    const sendMenuShortcuts = React.useMemo(() => buildComposerSendShortcutLabels({
        alternateMode: props.alternateSendMode ?? 'agent_queue', keyboardShortcutsV2Enabled,
        keyboardSingleKeyShortcutsEnabled, keyboardShortcutOverridesV1, keyboardShortcutDisabledCommandIdsV1,
        platformOS: Platform.OS,
    }), [props.alternateSendMode, keyboardShortcutsV2Enabled, keyboardSingleKeyShortcutsEnabled, keyboardShortcutOverridesV1, keyboardShortcutDisabledCommandIdsV1]);
    // Dictation edits this exact composer, so it consumes the same edit authority as
    // the text input. A submit-only lock deliberately remains editable; read-only and
    // edit+submit locks do not. Retained Session editors keep their draft tree mounted
    // while hidden. Dictation is live
    // capture, not draft state: feed the existing presentation fact into its one controller so
    // hiding this retained composer cancels and releases the canonical capture admission.
    const composerInputEditLocked = props.composerInputLock?.mode === 'editAndSubmit';
    const dictationEditable = !readOnly && !props.disabled && !composerInputEditLocked;
    const typingAddress = React.useMemo(
        () => normalizeSessionAddress(props.sessionTypingPresence?.serverId, props.sessionId),
        [props.sessionTypingPresence?.serverId, props.sessionId],
    );
    const typingEditable = dictationEditable
        && props.surfacePresented !== false
        && props.sessionTypingPresence?.canSubmitAgentInput === true;
    // Only this input's activity is ours to clear. An idle retained composer for
    // the same Session must not stop another mounted input's typing intent.
    const reportedTypingAddressRef = React.useRef<SessionAddress | null>(null);
    const stopTyping = React.useCallback(() => {
        const address = reportedTypingAddressRef.current;
        reportedTypingAddressRef.current = null;
        if (address) stopSessionTyping(address);
    }, []);
    React.useEffect(() => stopTyping, [typingAddress, stopTyping]);
    React.useEffect(() => {
        if (!typingEditable || !hasText) stopTyping();
    }, [typingEditable, hasText, stopTyping]);
    const [fileDragActive, setFileDragActive] = React.useState(false);

    const pendingPermissionRequests = props.permissionRequests ?? [];
    const pendingApprovalRequests = useComposerApprovalRequests(props.approvalRequests ?? NO_APPROVAL_REQUESTS);
    const canApprovePermissions = props.canApprovePermissions === true;
    const permissionPromptSurface = useSetting('permissionPromptSurface');
    const resolvedPermissionPromptSurface = resolvePermissionPromptSurface(permissionPromptSurface);
    const showComposerPermissionCards = resolvedPermissionPromptSurface === 'composer';
    const composerApprovalRequests = React.useMemo(
        () => selectComposerApprovalRequestsForSurface(pendingApprovalRequests, resolvedPermissionPromptSurface),
        [pendingApprovalRequests, resolvedPermissionPromptSurface],
    );
    const composerPermissionRequests = React.useMemo(
        () => pendingPermissionRequests.filter((req) => shouldShowGenericPermissionPromptForRequest({ toolName: req.tool, requestKind: req.kind })),
        [pendingPermissionRequests],
    );
    const hasComposerAttentionRequests =
        (showComposerPermissionCards && composerPermissionRequests.length > 0)
        || composerApprovalRequests.length > 0;
    React.useEffect(() => {
        if (!hasComposerAttentionRequests) {
            updateLayoutHeight(setComposerAttentionHeightPx, 0);
        }
    }, [hasComposerAttentionRequests]);

    const resolvedSessionAgentId = resolveAgentIdFromSessionMetadata(props.metadata);
    // Static composer policy remains owned by the closed built-in catalog. An
    // external Agent identity is preserved by the surrounding dynamic catalog
    // and explicit option projections; it must never be coerced to AgentId.
    const agentId: AgentId = resolvedSessionAgentId && isBundledAgentId(resolvedSessionAgentId)
        ? resolvedSessionAgentId
        : DEFAULT_AGENT_ID;
    const sessionAgentId = resolvedSessionAgentId ?? agentId;
    const armedComposerTarget = resolveArmedComposerContinuation({
        armedContinuationTarget: props.armedContinuationTarget,
    });
    // Who answers is fixed (engine controls off, a named engine): the chip names it and opens nothing.
    const fixedEngine = props.engineControls === 'none' && props.engineLabel !== undefined;
    const fixedEngineAgentId = fixedEngine ? props.engineAgentId : undefined;
    const engineChipAgentId = fixedEngineAgentId ?? armedComposerTarget?.agentId ?? props.agentType ?? resolvedSessionAgentId ?? agentId;
    // Explicit authoring selection may be public even when owner metadata is unavailable.
    // A runtime policy default supplies no identity evidence for an existing Session.
    const engineChipMarkAgentId = fixedEngineAgentId ?? armedComposerTarget?.agentId ?? props.agentType ?? resolvedSessionAgentId
        ?? (props.sessionId ? null : engineChipAgentId);

    /**
     * Effective Session-authoring policy, resolved by the shared owner.
     *
     * The composer keeps its own handlers and presentation; what is *selected*
     * and what that selection actually resolves to is answered once, in
     * `components/sessions/authoring/controls`, so the standalone authoring row
     * and this composer cannot drift apart.
     */
    const {
        modelOptions,
        permissionModeOptions,
        permissionModeOrder,
        effectivePermissionPolicy,
        effectivePermissionLabel,
        permissionChipLabel,
        effectiveModelPolicy,
        selectedModelLabel,
        appliedModelPresentation,
        modelApplyTiming,
        modelNotes,
        canEnterCustomModel,
        shouldShowModelOptionDescriptions,
        selectedModelForControls,
        selectedModelOptionControls,
        acpConfigOptionControls,
        sessionModeChipControl,
        sessionModePickerOptions,
        shouldRenderSessionModeChip,
        sessionModeChipPresentation,
        sessionModeChipInteraction,
    } = useSessionAuthoringControls({
        agentId: sessionAgentId,
        permissionTargetAgentId: armedComposerTarget?.agentId,
        metadata: props.metadata ?? null,
        composerOptionsInput: props.composerOptionsInput,
        sessionId: props.sessionId,
        sessionActive: props.sessionActive,
        currentRunnerProcessIdentity: props.currentRunnerProcessIdentity,
        permissionMode: props.permissionMode ?? null,
        allowedPermissionModes: props.allowedPermissionModes ?? null,
        modelMode: props.modelMode ?? null,
        modelOptionsOverride: props.modelOptionsOverride ?? null,
        canChangeModel: !armedComposerTarget && Boolean(props.onModelModeChange),
        canChangeSessionMode: !armedComposerTarget && Boolean(props.onAcpSessionModeChange),
        canChangeConfigOption: !armedComposerTarget && Boolean(props.onAcpConfigOptionChange),
        acpSessionModeOptionsOverride: props.acpSessionModeOptionsOverride ?? null,
        acpSessionModeSelectedIdOverride: props.acpSessionModeSelectedIdOverride ?? null,
        acpConfigOptionsOverride: props.acpConfigOptionsOverride ?? null,
        acpConfigOptionOverridesOverride: props.acpConfigOptionOverridesOverride ?? null,
        modelCatalogNames: props.modelOptionsOverrideProbe ?? null,
    });

    // Profile data
    const profiles = useAiLaunchProfilesForLegacyUi();
    const currentProfile = React.useMemo(() => {
        if (props.profileId === undefined || props.profileId === null || props.profileId.trim() === '') {
            return null;
        }
        return resolveProfileById(props.profileId, profiles);
    }, [profiles, props.profileId]);

        const profileLabel = React.useMemo(() => {
            if (props.profileId === undefined) {
                return null;
            }
            if (props.profileId === null || props.profileId.trim() === '') {
                return t('profiles.noProfile');
            }
        if (currentProfile) {
            return getProfileDisplayName(currentProfile);
        }
        const shortId = props.profileId.length > 8 ? `${props.profileId.slice(0, 8)}…` : props.profileId;
        return `${t('status.unknown')} (${shortId})`;
        }, [props.profileId, currentProfile]);

            const profileIcon = React.useMemo<IconName>(() => {
                // Always show a stable "profile" icon so the chip reads as Profile selection (not "current provider").
                return 'user-circle';
            }, []);

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');
    const agentInputEnterToSendNative = useSetting('agentInputEnterToSendNative');
    const agentInputHistoryScope = useSetting('agentInputHistoryScope');
    const agentInputActionBarLayout = useSetting('agentInputActionBarLayout');
    const agentInputChipDensity = useSetting('agentInputChipDensity');
    const composerPlacementPreferences = useLocalSetting('navigationSurfacePlacementsV1', selectComposerPlacementPreferences);

    const historyScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const messageHistory = useUserMessageHistory({
        scope: historyScope,
        sessionId: props.sessionId ?? null,
        serverId: props.sessionTypingPresence?.serverId,
    });

    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const mainColumn = usePaneMainColumn();
    const focusAdmissionRef = React.useRef({ mainColumn, presented: props.surfacePresented !== false });
    focusAdmissionRef.current = { mainColumn, presented: props.surfacePresented !== false };
    const pendingComposerFocusRef = React.useRef(false);
    // A host's explicit focus request puts the caret where the composer's document has it: after a host
    // writes the text (the Discussion composer's `@`), the field opens at the end, not where it last was.
    const focusComposerInput = React.useCallback(() => {
        if (!inputRef.current) {
            actionMenuAnchorRef.current?.focus?.();
            return;
        }
        inputRef.current?.focus();
        inputRef.current?.setSelection(inputStateRef.current.selection);
    }, []);
    const requestComposerFocus = React.useCallback(() => {
        const { mainColumn, presented } = focusAdmissionRef.current;
        if (!presented) return;
        if (mainColumn?.hidden) {
            pendingComposerFocusRef.current = true;
            mainColumn.setHidden(false);
            return;
        }
        pendingComposerFocusRef.current = false;
        focusComposerInput();
    }, [focusComposerInput]);
    React.useLayoutEffect(() => {
        if (!pendingComposerFocusRef.current) return;
        if (props.surfacePresented === false) {
            pendingComposerFocusRef.current = false;
            return;
        }
        if (mainColumn?.hidden) return;
        // The retained field can receive focus only after the reveal has committed.
        pendingComposerFocusRef.current = false;
        focusComposerInput();
    }, [focusComposerInput, mainColumn?.hidden, props.surfacePresented]);
    const flushComposerInput = React.useCallback(() => {
        inputRef.current?.flushPendingTextChange?.();
    }, []);
    const lastControlledValueRef = React.useRef(props.value);
    const composerInputSubmitLocked = props.composerInputLock !== null && props.composerInputLock !== undefined;
    const sendActionDisabled = Boolean(
        readOnly || props.disabled || props.isSendDisabled || props.isSending || composerInputSubmitLocked,
    );
    const onSendProp = props.onSend;
    const controlsOnly = props.inputPresentation === 'controlsOnly';
    const submitEnabled = !readOnly && onSendProp !== undefined && !controlsOnly;
    // An authoring-only composer never turns Enter into a send.
    const enterToSendEnabled = submitEnabled && (Platform.OS === 'web'
        ? agentInputEnterToSend === true
        : agentInputEnterToSendNative === true);

    React.useEffect(() => {
        props.onComposerFocusRequestChange?.(requestComposerFocus);
        return () => {
            props.onComposerFocusRequestChange?.(null);
        };
    }, [props.onComposerFocusRequestChange, requestComposerFocus]);

    React.useEffect(() => {
        props.onComposerInputFlushRequestChange?.(flushComposerInput);
        return () => props.onComposerInputFlushRequestChange?.(null);
    }, [props.onComposerInputFlushRequestChange, flushComposerInput]);

    const handleSend = React.useCallback((options?: AgentInputSendIntentOptions) => {
        // Guarded before any side effect: no flush, blur or history reset without a submit owner.
        if (onSendProp === undefined || sendActionDisabled) {
            return;
        }
        const liveInputText = inputRef.current?.flushPendingTextChange?.()
            ?? inputRef.current?.getText?.()
            ?? inputStateRef.current.text;
        recordLargeTextInputDiagnostic({
            phase: 'send-flush',
            platform: Platform.OS,
            surface: 'agentInput',
            textLength: liveInputText.length,
            selection: inputStateRef.current.selection,
            valueLength: props.value.length,
            liveTextLength: liveInputText.length,
        });
        if (inputStateRef.current.text !== liveInputText) {
            const nextState = {
                text: liveInputText,
                selection: { start: liveInputText.length, end: liveInputText.length },
            };
            inputStateRef.current = nextState;
            const nextStatus = resolveLiveInputTextStatus(liveInputText);
            liveTextStatusRef.current = nextStatus;
            setLiveTextStatus(nextStatus);
            setInputSelection((currentSelection) => (
                areTextInputSelectionsEqual(currentSelection, nextState.selection) ? currentSelection : nextState.selection
            ));
        }
        if (props.sessionId) {
            stopTyping();
            inputRef.current?.blur();
        }
        messageHistory.reset();
        const structuredInputMetaOverrides = buildStructuredInputMetaOverrides({
            mentions: structuredInputMentionsRef.current,
            text: liveInputText,
        });
        const hasStructuredInputMeta = Object.keys(structuredInputMetaOverrides).length > 0;
        const shouldCarryLiveInputText = !props.sessionId || liveInputText !== props.value;
        onSendProp(
            options?.forceImmediate === true || options?.deliveryIntent != null || options?.resetStart != null || hasStructuredInputMeta
                ? {
                    ...(options?.forceImmediate === true ? { forceImmediate: true } : {}),
                    ...(options?.deliveryIntent != null ? { deliveryIntent: options.deliveryIntent } : {}),
                    ...(options?.resetStart != null ? { resetStart: options.resetStart } : {}),
                    ...(hasStructuredInputMeta ? { structuredInputMetaOverrides } : {}),
                    ...(shouldCarryLiveInputText ? { inputTextOverride: liveInputText } : {}),
                }
                : (shouldCarryLiveInputText ? { inputTextOverride: liveInputText } : undefined),
        );
    }, [
        messageHistory,
        onSendProp,
        props.sessionId,
        props.value,
        sendActionDisabled,
        stopTyping,
    ]);

    const effectiveChipDensity = React.useMemo<'auto' | 'labels' | 'icons'>(() => {
        if (agentInputChipDensity === 'icons') {
            return 'icons';
        }
        if (agentInputChipDensity === 'labels') {
            return 'labels';
        }
        // auto: selectively hide labels for self-explanatory chips.
        return 'auto';
    }, [agentInputChipDensity]);

    const effectiveActionBarLayout = resolveAgentInputActionBarLayout({
        configuredLayout: agentInputActionBarLayout,
        ...(props.hostActionBarLayout === undefined ? {} : { hostLayout: props.hostActionBarLayout }),
        platform: Platform.OS,
        isMobileLayout: isMobileLayoutWidth(screenWidth),
    });

    React.useEffect(() => {
        props.onComposerActionBarLayoutChange?.(effectiveActionBarLayout);
    }, [effectiveActionBarLayout, props.onComposerActionBarLayoutChange]);

    // In labels mode: always show; in icons mode: never show; in auto: show for 'always' policy chips.
    const showChipLabels = effectiveChipDensity === 'labels' || effectiveChipDensity === 'auto';
    const showAutoHideChipLabels = effectiveChipDensity === 'labels';


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const abortConfirmationExpiresAtRef = React.useRef(0);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const [isInputFocused, setIsInputFocused] = React.useState(false);
    const composerKeyboardLayoutForFocus = useComposerKeyboardLayoutContext();

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Autocomplete state - track text and selection together
    const initialInputState = React.useMemo<TextInputState>(() => ({
        text: props.value,
        selection: { start: props.value.length, end: props.value.length },
    }), []);
    const inputStateRef = React.useRef<TextInputState>(initialInputState);
    const [inputSelection, setInputSelection] = React.useState<TextInputState['selection']>(initialInputState.selection);
    const [activeWordState, setActiveWordState] = React.useState<ActiveWord | undefined>(() => (
        findActiveWord(initialInputState.text, initialInputState.selection, props.autocompleteKinds, props.structuredInputMentions)
    ));
    const [hasAutocompleteTextInteraction, setHasAutocompleteTextInteraction] = React.useState(false);
    const inputScopeKeyRef = React.useRef<string | null>(props.sessionId ?? null);
    // Selection restore is an OPEN-time resumption: applied at most once per generation,
    // and voided as soon as the user edits (see composerSelectionRestore).
    const consumedSelectionRestoreTokenRef = React.useRef<string | null>(null);
    const composerEditedSinceOpenRef = React.useRef(false);
    const [uncontrolledStructuredInputMentions, setUncontrolledStructuredInputMentions] = React.useState<ComposerStructuredInputMention[]>([]);
    const structuredInputMentions = props.structuredInputMentions ?? uncontrolledStructuredInputMentions;
    const structuredInputMentionsRef = React.useRef<readonly ComposerStructuredInputMention[]>(structuredInputMentions);
    const historyAppliedInputStateRef = React.useRef<ProgrammaticHistoryInputState | null>(null);

    React.useEffect(() => {
        structuredInputMentionsRef.current = structuredInputMentions;
    }, [structuredInputMentions]);

    const updateStructuredInputMentions = React.useCallback((
        nextOrUpdater: readonly ComposerStructuredInputMention[]
            | ((current: readonly ComposerStructuredInputMention[]) => readonly ComposerStructuredInputMention[]),
    ) => {
        const current = structuredInputMentionsRef.current;
        const next = typeof nextOrUpdater === 'function'
            ? nextOrUpdater(current)
            : nextOrUpdater;
        if (areStructuredInputMentionListsEqual(current, next)) return;
        structuredInputMentionsRef.current = next;
        if (!props.structuredInputMentions) {
            setUncontrolledStructuredInputMentions([...next]);
        }
        props.onStructuredInputMentionsChange?.(next);
    }, [props.onStructuredInputMentionsChange, props.structuredInputMentions]);

    const handleEditorReferencesChange = React.useCallback((references: readonly ComposerEditorReference[]) => {
        const text = inputRef.current?.getText?.() ?? inputStateRef.current.text;
        const bindings = references.flatMap((reference) => (
            reference.binding !== null && typeof reference.binding === 'object'
                ? [{ ...reference.binding, tokenText: reference.token, start: reference.start, end: reference.end }]
                : []
        ));
        updateStructuredInputMentions(parseComposerStructuredInputMentionsForText(bindings, text).mentions);
    }, [updateStructuredInputMentions]);

    const isHistoryBrowsing = React.useCallback(() => (
        messageHistory.isBrowsing()
    ), [messageHistory]);

    const hasRetainedHistorySession = React.useCallback(() => (
        messageHistory.hasRetainedSession()
    ), [messageHistory]);

    const updateActiveWordState = React.useCallback((state: TextInputState) => {
        const nextActiveWord = findActiveWord(state.text, state.selection, props.autocompleteKinds, structuredInputMentionsRef.current);
        setActiveWordState((currentActiveWord) => (
            areActiveWordsEqual(currentActiveWord, nextActiveWord) ? currentActiveWord : nextActiveWord
        ));
    }, [props.autocompleteKinds]);

    const updateInputSelectionState = React.useCallback((selection: TextInputState['selection']) => {
        setInputSelection((currentSelection) => (
            areTextInputSelectionsEqual(currentSelection, selection) ? currentSelection : selection
        ));
    }, []);

    // Handle combined text and selection state changes
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        const previousState = inputStateRef.current;
        const previousText = previousState.text;
        const historyAppliedInputState = historyAppliedInputStateRef.current;
        const isProgrammaticHistoryApply =
            historyAppliedInputState !== null
            && historyAppliedInputState.state.text === newState.text
            && areTextInputSelectionsEqual(historyAppliedInputState.state.selection, newState.selection);
        if (!isProgrammaticHistoryApply && hasRetainedHistorySession()) {
            historyAppliedInputStateRef.current = null;
            messageHistory.pause(newState.text);
        }
        // Live edits know the exact replaced selection, which disambiguates equal token text.
        // Programmatic swaps below use the bounded diff-based sibling.
        updateStructuredInputMentions((current) => reconcileStructuredInputMentionsWithTextChange({
            previousText,
            nextText: newState.text,
            previousSelection: previousState.selection,
            mentions: current,
        }));
        if (newState.text !== previousText && !isProgrammaticHistoryApply) {
            setHasAutocompleteTextInteraction(true);
        }
        inputStateRef.current = newState;
        updateActiveWordState(newState);
        const nextStatus = resolveLiveInputTextStatus(newState.text);
        if (newState.text !== previousText && !isProgrammaticHistoryApply) {
            if (!nextStatus.hasText) {
                stopTyping();
            } else if (isInputFocused && typingEditable && typingAddress) {
                reportedTypingAddressRef.current = typingAddress;
                reportSessionTypingEdit(typingAddress, true);
            }
        }
        if (!areLiveInputTextStatusesEqual(liveTextStatusRef.current, nextStatus)) {
            liveTextStatusRef.current = nextStatus;
            setLiveTextStatus(nextStatus);
        }
        updateInputSelectionState(newState.selection);
        props.inputPersistence?.onSelectionChangePersist(newState.selection, newState.text.length);
    }, [hasRetainedHistorySession, isInputFocused, messageHistory, props.inputPersistence, stopTyping, typingAddress, typingEditable, updateActiveWordState, updateInputSelectionState, updateStructuredInputMentions]);

    const composerRef = React.useMemo<ComposerRefV1 | null>(() => (
        props.composerRef
        ?? (props.sessionId ? { kind: 'session', sessionId: props.sessionId } : null)
    ), [props.composerRef, props.sessionId]);
    const composerDropScope = useActiveServerAccountScope();
    const composerDropTargetId = React.useId();
    const composerDropRuntime = useEntityDragDropRuntime();
    const entityDropDomRef = useEntityDropDomBinding(composerDropRuntime, { beforeRelease: flushComposerInput });
    const composerDropHost = React.useRef<View | null>(null);
    const composerDropNativeBounds = React.useRef<WindowBounds | null>(null);
    const composerDropMeasurable = React.useCallback((): TreeDropMeasurableRef | null => {
        const node = composerDropHost.current;
        if (!node) return null;
        const element = node as unknown as { getBoundingClientRect?: () => DOMRect };
        return element.getBoundingClientRect ? { getBoundingClientRectFn: () => element.getBoundingClientRect!() } : node;
    }, []);
    const composerEntityDropRef = React.useCallback((node: View | null) => {
        composerDropHost.current = node;
        entityDropDomRef(node);
    }, [entityDropDomRef]);
    const composerDropBounds = React.useCallback(() => readWindowBounds(composerDropMeasurable()) ?? composerDropNativeBounds.current, [composerDropMeasurable]);
    // The composer's whole block (status row, attachments and panel): a carried card keeps clear of it.
    const composerBlockBounds = React.useCallback((): WindowBounds | null => {
        const element = stageSpotlightRef.current as unknown as { getBoundingClientRect?: () => DOMRect } | null;
        return element?.getBoundingClientRect ? readWindowBounds({ getBoundingClientRectFn: () => element.getBoundingClientRect!() }) : null;
    }, []);
    const measureComposerDrop = React.useCallback(() => {
        const node = composerDropHost.current;
        void measureWindowBounds(composerDropMeasurable()).then(bounds => {
            if (composerDropHost.current !== node) return;
            composerDropNativeBounds.current = bounds;
            composerDropRuntime.refresh();
        });
    }, [composerDropMeasurable, composerDropRuntime]);
    const mountedComposerId = React.useId();
    const promptLibraryAvailable = props.promptLibrary !== 'none';
    const promptPickerSessionAddress = props.sessionAddress ?? typingAddress;
    const promptPicker = usePromptPickerController({
        composerKey: JSON.stringify([
            promptPickerSessionAddress ? sessionAddressKey(promptPickerSessionAddress) : null,
            composerRef ? composerRefV1Key(composerRef) : mountedComposerId,
        ]),
        editable: promptLibraryAvailable && dictationEditable && !controlsOnly && props.surfacePresented !== false,
        canSend: submitEnabled && !sendActionDisabled,
        inputRef,
        stateRef: inputStateRef,
        send: handleSend,
    });
    const openPromptPicker = React.useCallback(() => {
        flushComposerInput();
        return promptPicker.open();
    }, [flushComposerInput, promptPicker.open]);
    React.useEffect(() => {
        props.onPromptPickerOpenRequestChange?.(openPromptPicker);
        return () => props.onPromptPickerOpenRequestChange?.(null);
    }, [props.onPromptPickerOpenRequestChange, openPromptPicker]);
    const openPromptPickerFromSlash = React.useCallback(() => {
        flushComposerInput();
        promptPicker.open(activeWordState
            ? { start: activeWordState.offset, end: activeWordState.endOffset }
            : undefined);
    }, [activeWordState, flushComposerInput, promptPicker.open]);
    const dictation = useSessionAuthoringComposerDictation({
        composerRef,
        enabled: voiceEnabled && props.submitDictation !== false,
        presented: props.surfacePresented !== false,
        editable: dictationEditable,
        transcriptionSessionId: props.sessionId ?? null,
        inputRef,
        stateRef: inputStateRef,
    });
    const handleDictationPress = dictation.onPress;

    /*
     * §2.3 — dictation and conversational Voice stop competing by **placement**.
     *
     * A composer that owns a session mounts both halves itself: the planet in the
     * trailing slot, a peer of Send, and the dictation microphone in the field's
     * top-right corner. Moving dictation to the field is exactly what takes it off
     * the submit button, so the two decisions are one — they are derived here
     * together rather than left to each host to get half right.
     *
     * The three props stay the seam. A host that supplies its own accessory keeps
     * it, and keeps the submit-button microphone with it; this is the default, not
     * a takeover.
     */
    /*
     * The two halves are gated on different facts, and conflating them is what left the New
     * Session composer with no Voice affordance at all (§2.5).
     *
     * Dictation transcribes into *this* exact Composer through the shared authoring seam. A live
     * Session keeps its released Session address; origin-neutral authoring callers provide their
     * own Composer reference and never fabricate a Session. Conversational Voice remains separately
     * Session-targeted by `VoiceComposerPlanetMount` below.
     */
    const mountsVoiceComposerPlanet = voiceEnabled && props.voiceAffordance !== 'dictation';
    const ownsFieldDictation = Boolean(voiceEnabled && composerRef)
        && props.fieldAccessory == null
        && props.submitDictation !== false;
    const dictationPressHandler = voiceEnabled && composerRef && props.submitDictation !== false && !ownsFieldDictation
        ? handleDictationPress
        : undefined;
    const dictationStatus = voiceEnabled ? dictation.status : 'idle';
    const dictationActive = dictationStatus !== 'idle';
    // Only the button that *owns* dictation may have its enablement driven by it.
    const submitDictationActive = dictationActive && Boolean(dictationPressHandler);
    const voiceComposerTarget = React.useMemo<VoiceAttemptIdleTarget>(() => (
        props.sessionId === undefined
            ? VOICE_ATTEMPT_IDLE_TARGET_GLOBAL
            : { kind: 'session', sessionAddress: props.sessionAddress ?? null }
    ), [props.sessionAddress, props.sessionId]);
    const voiceComposerPlanet = React.useMemo(
        () => <VoiceComposerPlanetMount
            target={voiceComposerTarget}
            isPresented={props.surfacePresented}
        />,
        [props.surfacePresented, voiceComposerTarget],
    );
    const availableFieldAccessory = props.fieldAccessory
        ?? (ownsFieldDictation
            ? <AgentInputDictationButton
                disabled={!dictationEditable || !dictation.available}
                status={dictationStatus}
                onPress={handleDictationPress}
                onFocus={() => { void dictation.onFocus(); }}
            />
            : null);

    React.useEffect(() => {
        historyAppliedInputStateRef.current = null;
        // A different session/scope is a fresh open, so its persisted selection is
        // eligible again.
        composerEditedSinceOpenRef.current = false;
    }, [props.sessionId, historyScope]);

    React.useEffect(() => {
        if (props.value === lastControlledValueRef.current) return;
        lastControlledValueRef.current = props.value;

        const current = inputStateRef.current;
        if (current.text === props.value) return;

        const wasSelectionAtCurrentEnd = current.selection.start === current.text.length
            && current.selection.end === current.text.length;
        const nextSelection = wasSelectionAtCurrentEnd
            ? { start: props.value.length, end: props.value.length }
            : {
                start: Math.min(current.selection.start, props.value.length),
                end: Math.min(current.selection.end, props.value.length),
            };
        const nextState = {
            text: props.value,
            selection: nextSelection,
        };
        // An authored controlled snapshot already has ranges for the new text.
        // Otherwise retain the existing reconciliation for stale controlled
        // ranges, including external text-only changes.
        if (props.structuredInputMentions === undefined
            || !props.structuredInputMentions.every((mention) => structuredInputMentionSurvivesText(props.value, mention))) {
            updateStructuredInputMentions((currentMentions) => reconcileStructuredInputMentionsWithText({
                previousText: current.text,
                nextText: props.value,
                mentions: currentMentions,
            }));
        }
        setHasAutocompleteTextInteraction(false);
        inputStateRef.current = nextState;
        updateActiveWordState(nextState);
        const nextStatus = resolveLiveInputTextStatus(props.value);
        if (!areLiveInputTextStatusesEqual(liveTextStatusRef.current, nextStatus)) {
            liveTextStatusRef.current = nextStatus;
            setLiveTextStatus(nextStatus);
        }
        updateInputSelectionState(nextSelection);
    }, [props.value, props.structuredInputMentions, updateActiveWordState, updateInputSelectionState, updateStructuredInputMentions]);

    React.useEffect(() => {
        updateActiveWordState(inputStateRef.current);
    }, [updateActiveWordState]);

    React.useEffect(() => {
        const nextScopeKey = props.sessionId ?? null;
        if (inputScopeKeyRef.current === nextScopeKey) return;
        inputScopeKeyRef.current = nextScopeKey;

        const liveInputText = inputRef.current?.getText?.();
        if (liveInputText === undefined || liveInputText === props.value) return;

        const nextSelection = { start: props.value.length, end: props.value.length };
        const nextState = { text: props.value, selection: nextSelection };
        historyAppliedInputStateRef.current = { state: nextState };
        if (props.structuredInputMentions === undefined
            || !props.structuredInputMentions.every((mention) => structuredInputMentionSurvivesText(props.value, mention))) {
            updateStructuredInputMentions((currentMentions) => reconcileStructuredInputMentionsWithText({
                previousText: liveInputText,
                nextText: props.value,
                mentions: currentMentions,
            }));
        }
        inputStateRef.current = nextState;
        updateActiveWordState(nextState);
        const nextStatus = resolveLiveInputTextStatus(props.value);
        if (!areLiveInputTextStatusesEqual(liveTextStatusRef.current, nextStatus)) {
            liveTextStatusRef.current = nextStatus;
            setLiveTextStatus(nextStatus);
        }
        updateInputSelectionState(nextSelection);
        inputRef.current?.setTextAndSelection(props.value, nextSelection);
        historyAppliedInputStateRef.current = null;
    }, [props.sessionId, props.value, props.structuredInputMentions, updateActiveWordState, updateInputSelectionState, updateStructuredInputMentions]);

    React.useEffect(() => {
        setHasAutocompleteTextInteraction(false);
    }, [props.sessionId]);

    const handleComposerTextChange = React.useCallback((text: string) => {
        // A persisted selection describes the text as it was at OPEN. The moment the user
        // edits, those offsets describe text that no longer exists — and the stored value
        // can be a RANGE, so re-applying it would select a word and let the next keystroke
        // replace it. Void the restore for this composer from here on.
        composerEditedSinceOpenRef.current = true;
        setHasAutocompleteTextInteraction(true);
        props.onChangeText?.(text);
    }, [props.onChangeText]);

    React.useEffect(() => {
        const selection = props.inputPersistence?.initialSelection;
        const decision = resolveComposerSelectionRestore({
            token: props.inputPersistence?.restoreToken,
            lastConsumedToken: consumedSelectionRestoreTokenRef.current,
            hasEditedSinceOpen: composerEditedSinceOpenRef.current,
            hasSelection: Boolean(selection),
        });
        consumedSelectionRestoreTokenRef.current = decision.consumedToken;
        if (!decision.apply || !selection) return;
        const liveTextLength = inputRef.current?.getText?.().length ?? props.value.length;
        recordLargeTextInputDiagnostic({
            phase: 'selection-restore',
            platform: Platform.OS,
            surface: 'agentInput',
            textLength: liveTextLength,
            selection,
            valueLength: props.value.length,
        });
        inputRef.current?.setSelection(selection);
    }, [props.inputPersistence?.restoreToken]);

    React.useEffect(() => {
        if (props.value.length === 0) {
            updateStructuredInputMentions([]);
        }
    }, [props.value, updateStructuredInputMentions]);

    const handleComposerFocus = React.useCallback(() => {
        void dictation.onFocus();
        composerKeyboardLayoutForFocus?.setComposerInputFocused?.(true);
        setIsInputFocused(true);
        const focusedActiveWord = findActiveWord(
            inputStateRef.current.text,
            inputStateRef.current.selection,
            props.autocompleteKinds,
            structuredInputMentionsRef.current,
        );
        if (focusedActiveWord) {
            setActiveWordState((currentActiveWord) => (
                areActiveWordsEqual(currentActiveWord, focusedActiveWord) ? currentActiveWord : focusedActiveWord
            ));
            setHasAutocompleteTextInteraction(true);
        }
        messageHistory.warmup();
        props.onComposerFocusChange?.(true);
    }, [composerKeyboardLayoutForFocus, dictation.onFocus, messageHistory, props.autocompleteKinds, props.onComposerFocusChange]);

    const handleComposerBlur = React.useCallback(() => {
        inputRef.current?.flushPendingTextChange?.();
        stopTyping();
        composerKeyboardLayoutForFocus?.setComposerInputFocused?.(false);
        setIsInputFocused(false);
        props.onComposerFocusChange?.(false);
    }, [composerKeyboardLayoutForFocus, props.onComposerFocusChange, stopTyping]);

    const applyHistoryInputText = React.useCallback((next: string) => {
        const nextState = { text: next, selection: { start: next.length, end: next.length } };
        const setTextAndSelection = inputRef.current?.setTextAndSelection;
        if (setTextAndSelection) {
            const pendingHistoryApply: ProgrammaticHistoryInputState = {
                state: nextState,
            };
            historyAppliedInputStateRef.current = pendingHistoryApply;
            setTextAndSelection(next, nextState.selection);
        } else {
            props.onChangeText?.(next);
        }
    }, [props.onChangeText]);

    React.useEffect(() => {
        if (Platform.OS !== 'ios' || !enterToSendEnabled || !isInputFocused || props.disabled) {
            return;
        }

        const subscription = subscribeToIosHardwareShiftEnter(() => {
            const nextState = insertTextAtSelection({
                text: inputStateRef.current.text,
                selection: inputStateRef.current.selection,
                insertedText: '\n',
            });

            inputRef.current?.setTextAndSelection(nextState.text, nextState.selection);
        });

        return () => {
            subscription?.remove();
        };
    }, [enterToSendEnabled, isInputFocused, props.disabled]);

    const activeWord = activeWordState?.activeWord ?? null;
    const activeSuggestionQuery = isInputFocused && hasAutocompleteTextInteraction && !props.disabled ? activeWord : null;
    const autocompleteSuggestions = resolveActiveSuggestionsHandler(props.autocompleteSuggestions, activeSuggestionQuery);
    // Selection follows candidate identity, not an index (INV-6) — the hook owns that.
    const resolveSuggestions = React.useCallback<ActiveSuggestionsHandler>(async (query, signal, publish) => {
        if (query !== '@' || !composerDropScope || props.referenceRecents === 'none') return autocompleteSuggestions(query, signal, publish);
        const rows = readRegisteredStorageState()?.sessionListRowsByServerId?.[composerDropScope.serverId];
        const sessions = props.autocompleteKinds.includes('session')
            ? readComposerSessionSuggestionItems({ serverId: composerDropScope.serverId, currentSessionId: props.sessionId ?? null })
                .slice().sort((left, right) => readSessionListMeaningfulActivityAt(rows?.[right.id]) - readSessionListMeaningfulActivityAt(rows?.[left.id]))
            : [];
        const recent = buildComposerRecentReferenceSuggestions({
            inserted: readRecentComposerReferenceInsertions(composerDropScope, props.composerFileScope),
            files: props.autocompleteKinds.includes('file') ? readQuickOpenRecentFiles(props.composerFileScope ?? null).map(file => file.fullPath) : [],
            sessions, kinds: props.autocompleteKinds, group: t('newSession.machinePicker.recentTitle'), sessionKindLabel: t('composerReferences.kindSession'),
            attachmentIds: props.attachmentRowItems?.flatMap(item => item.attachmentId && item.status !== 'error'
                && item.availability !== 'unavailable' && item.availability !== 'invalid' ? [item.attachmentId] : []),
            skillSelectionEffect: reference => async () => {
                const query = `$${reference.label}`;
                const current = await resolveActiveSuggestionsHandler(props.autocompleteSuggestions, query)(query, new AbortController().signal, () => {});
                const candidate = current.find(item => {
                    const mention = createStructuredInputMentionFromSuggestion({ suggestion: item, start: 0 });
                    return mention && composerReferencesFromStructuredMentions({ text: item.text, mentions: [mention] })[0]?.ref === reference.ref;
                });
                return applyRecentComposerSkillSelection(candidate, t('capabilities.control.changeFailed'));
            },
        });
        if (recent.length === 0) return autocompleteSuggestions(query, signal, publish);
        // Lab P1: Recent leads, and every kind keeps its own section below it (so a kind tab is never
        // empty on a bare trigger). A row already in Recent is not repeated.
        const recentIdentities = new Set(recent.map(getAutocompleteSuggestionIdentity));
        const withRecent = (rows: readonly AutocompleteSuggestion[]) => [...recent, ...rows.filter(row => !recentIdentities.has(getAutocompleteSuggestionIdentity(row)))];
        publish(recent);
        return withRecent(await autocompleteSuggestions(query, signal, (rows, status) => publish(withRecent(rows), status)));
    }, [composerDropScope, props.autocompleteKinds, props.autocompleteSuggestions, autocompleteSuggestions, props.composerFileScope, props.sessionId, props.attachmentRowItems, props.referenceRecents]);
    // Folder/attachment refreshes only affect bare-@ recents, not an in-flight native catalog query.
    const activeSuggestionsHandler = activeSuggestionQuery === '@' ? resolveSuggestions : autocompleteSuggestions;
    const [suggestions, selected, moveUp, moveDown, selectionPending, suggestionsSettledEmpty, selectionForKind] = useActiveSuggestions(activeSuggestionQuery, activeSuggestionsHandler, { wrapAround: true });
    // Lab P1–P3: a reference trigger (@, $) gets the reference picker — kind tabs, a held frame and its
    // own empty state. Commands keep the plain list.
    const activeTrigger = activeWord?.charAt(0) ?? null;
    const referencePickerTrigger = activeTrigger === '@' || activeTrigger === '$' ? activeTrigger : null;
    const referencePickerKinds = React.useMemo(
        () => referencePickerTrigger === null ? undefined : resolveComposerSuggestionKindIdsForTrigger(props.autocompleteKinds, referencePickerTrigger),
        [props.autocompleteKinds, referencePickerTrigger],
    );
    // A contributed Action can remain externally effectful while its selection
    // awaits canonical dispatch or form preparation. This stays local to the
    // incumbent picker selection owner and follows the same input snapshot currentness.
    const pendingContributedActionSelectionInputRef = React.useRef<TextInputState | null>(null);

    // Several references inserted together (two pictures pasted, three files dropped) are planned one
    // after another on one local snapshot and written to the editor once. Writing each in turn let the
    // editor report its references before the first new chip reached it, which dropped that chip's
    // binding and left its token as raw text.
    const insertReferencesInInput = React.useCallback((insertions: ReadonlyArray<Readonly<{ reference: ComposerReferenceInsertion;
        template?: ComposerStructuredInputMention; suggestion?: AutocompleteSuggestion }>>,
        firstAt: Parameters<typeof planComposerReferenceInsertion>[0]['at']): number | null => {
        let text = inputStateRef.current.text;
        let selection = inputStateRef.current.selection;
        let mentions = structuredInputMentionsRef.current;
        const insertedRefs: string[] = [];
        let at = firstAt;
        let cursor: number | null = null;
        for (const { reference, template } of insertions) {
            const operations = planComposerReferenceInsertion({ snapshot: { text, selection,
                references: composerReferencesFromStructuredMentions({ text, mentions }) }, reference, at });
            const edit = operations[0];
            const added = operations[1];
            if (!edit || !added || added.kind !== 'reference.insert' || (edit.kind !== 'text.insert' && edit.kind !== 'text.replaceRange')) continue;
            const range = edit.kind === 'text.insert' ? { start: edit.position.offset, end: edit.position.offset } : edit.range;
            const mention = template ? { ...template, tokenText: added.reference.token, start: added.reference.start, end: added.reference.end }
                : composerStructuredMentionsFromReferences({ references: [added.reference], existing: [] })[0];
            if (!mention) continue;
            const shift = edit.text.length - (range.end - range.start);
            text = text.slice(0, range.start) + edit.text + text.slice(range.end);
            mentions = [
                ...mentions.filter(item => item.end <= range.start || item.start >= range.end)
                    .map(item => item.start >= range.end ? { ...item, start: item.start + shift, end: item.end + shift } : item),
                mention,
            ].sort((left, right) => left.start - right.start);
            cursor = range.start + edit.text.length;
            selection = { start: cursor, end: cursor };
            at = { kind: 'offset', offset: cursor };
            insertedRefs.push(reference.ref);
        }
        if (cursor === null) return null;
        inputRef.current?.setTextAndSelection(text, { start: cursor, end: cursor });
        // After the editor's own report, which cannot know the chips it has not been given yet.
        updateStructuredInputMentions(mentions);
        if (composerDropScope) recordComposerReferencePublication({ scope: composerDropScope, insertedRefs,
            next: { text, references: composerReferencesFromStructuredMentions({ text, mentions }) }, workspace: props.composerFileScope,
            suggestions: new Map(insertions.flatMap(item => item.suggestion ? [[item.reference.ref, item.suggestion] as const] : [])) });
        return cursor;
    }, [composerDropScope, props.composerFileScope, updateStructuredInputMentions]);
    const insertReferenceInInput = React.useCallback((reference: ComposerReferenceInsertion,
        at: Parameters<typeof planComposerReferenceInsertion>[0]['at'],
        template?: ComposerStructuredInputMention, suggestion?: AutocompleteSuggestion): number | null => (
        insertReferencesInInput([{ reference, ...(template ? { template } : {}), ...(suggestion ? { suggestion } : {}) }], at)
    ), [insertReferencesInInput]);

    const mentionAddedUploads = React.useCallback((drafts: readonly AttachmentDraft[] | void,
        at: Parameters<typeof planComposerReferenceInsertion>[0]['at']) => {
        if (!drafts || drafts.length === 0) return;
        insertReferencesInInput(drafts.map(draft => ({ reference: {
            label: draft.source.kind === 'web' ? draft.source.file.name : draft.source.name,
            kind: INLINE_REFERENCE_ATTACHMENT_SCHEME_V1,
            ref: buildMentionRefV1(INLINE_REFERENCE_ATTACHMENT_SCHEME_V1, draft.id),
        } })), at);
    }, [insertReferencesInInput]);
    const handleFilesPastedToComposer = React.useCallback((files: readonly File[]) => {
        mentionAddedUploads(props.onAttachmentsAdded?.(files), { kind: 'caret' });
    }, [mentionAddedUploads, props.onAttachmentsAdded]);
    const attachmentIntakeScope = JSON.stringify([composerDropScope, composerRef ? composerRefV1Key(composerRef) : mountedComposerId]);
    const currentAttachmentIntakeScope = React.useRef(attachmentIntakeScope);
    currentAttachmentIntakeScope.current = attachmentIntakeScope;
    const handleNativeAttachmentsDropped = React.useCallback((drop: import('@/components/ui/forms/nativeComposerInput').NativeComposerAttachmentDrop) => {
        if (currentAttachmentIntakeScope.current !== attachmentIntakeScope || !dictationEditable || props.surfacePresented === false) return;
        if (drop.error) {
            Modal.alert(t('files.transfers.uploadFailed'));
            return;
        }
        mentionAddedUploads(props.onAttachmentsAdded?.([], { sources: drop.sources }), { kind: 'offset', offset: drop.offset });
    }, [attachmentIntakeScope, dictationEditable, mentionAddedUploads, props.onAttachmentsAdded, props.surfacePresented]);
    const handleFilesDroppedToComposer = React.useCallback(async (event: WebFileDragEvent, mention = true) => {
        const onAttachmentsAdded = props.onAttachmentsAdded;
        const input = inputRef.current;
        if (!onAttachmentsAdded || !event.dataTransfer) return;
        // Claim browser handles before awaiting directory traversal or point measurement.
        const files = extractWebAttachmentFilesFromDataTransfer(event.dataTransfer);
        const directories: string[] = [];
        const entries = readWebDroppedEntries(event.dataTransfer as DataTransfer, { onDirectory: path => directories.push(path) });
        const x = event.clientX ?? event.nativeEvent?.clientX;
        const y = event.clientY ?? event.nativeEvent?.clientY;
        const offset = mention && typeof x === 'number' && typeof y === 'number'
            ? input?.offsetAtPoint({ x, y }) : null;
        const [dropped, point] = await Promise.all([entries, offset]);
        if (inputRef.current !== input || currentAttachmentIntakeScope.current !== attachmentIntakeScope) return;
        const sources = groupWebDroppedEntries(dropped, directories);
        const added = sources.some(source => source.kind === 'folder')
            ? onAttachmentsAdded([], { sources })
            : files.length > 0 ? onAttachmentsAdded(files)
                : dropped.length > 0 ? onAttachmentsAdded(dropped.map(entry => entry.file)) : undefined;
        if (mention) mentionAddedUploads(added, typeof point === 'number' ? { kind: 'offset', offset: point } : { kind: 'caret' });
    }, [attachmentIntakeScope, mentionAddedUploads, props.onAttachmentsAdded]);
    const composerDropZoneHandlers = useWebFileDropZone({
        enabled: Platform.OS === 'web' && dictationEditable && !controlsOnly && props.surfacePresented !== false && typeof props.onAttachmentsAdded === 'function',
        onFilesDropped: handleFilesDroppedToComposer,
        onFileDragActiveChange: typeof props.onAttachmentsAdded === 'function' ? setFileDragActive : undefined,
    });
    const trayDropZoneHandlers = useWebFileDropZone({
        enabled: Platform.OS === 'web' && dictationEditable && !controlsOnly && props.surfacePresented !== false && typeof props.onAttachmentsAdded === 'function',
        present: typeof props.onAttachmentsAdded === 'function',
        onFilesDropped: event => handleFilesDroppedToComposer(event, false),
    });

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];
        const currentInputState = inputStateRef.current;
        const isSelectionCurrent = () => inputStateRef.current === currentInputState;
        const isContributedActionSelection =
            suggestion.pluginContributedAction !== undefined
            && props.onContributedActionSuggestionSelect !== undefined;
        if (
            isContributedActionSelection
            && pendingContributedActionSelectionInputRef.current === currentInputState
        ) return;
        if (isContributedActionSelection) {
            pendingContributedActionSelectionInputRef.current = currentInputState;
        }
        const activeWordForSelection = findActiveWord(currentInputState.text, currentInputState.selection, props.autocompleteKinds, structuredInputMentionsRef.current);
        const applyResolvedSelection = (result: Readonly<{ text: string; cursorPosition: number }>) => {
            inputRef.current?.setTextAndSelection(result.text, {
                start: result.cursorPosition,
                end: result.cursorPosition,
            });
        };

        const applyDefaultSelection = () => {
            const candidateMention = createStructuredInputMentionFromSuggestion({ suggestion, start: 0 });
            const reference = candidateMention ? composerReferencesFromStructuredMentions({ text: suggestion.text, mentions: [candidateMention] })[0] : undefined;
            if (reference && candidateMention) {
                const insertionReference = { kind: reference.kind, ref: reference.ref, label: reference.label ?? suggestion.label ?? suggestion.text, payload: reference };
                insertReferenceInInput(insertionReference, activeWordForSelection
                    ? { kind: 'activeWord', range: { start: activeWordForSelection.offset, end: activeWordForSelection.endOffset } }
                    : { kind: 'caret' }, candidateMention, suggestion);
                return;
            }
            const result = applySuggestion(
                currentInputState.text,
                currentInputState.selection,
                suggestion.text,
                props.autocompleteKinds,
                true,
            );
            applyResolvedSelection(result);

            const insertionStart = activeWordForSelection?.offset ?? currentInputState.selection.start;
            const mention = createStructuredInputMentionFromSuggestion({ suggestion, start: insertionStart });
            if (mention) {
                updateStructuredInputMentions((current) => [
                    ...current.filter((existing) => existing.start !== mention.start || existing.end !== mention.end),
                    mention,
                ]);
            }
        };

        // A kind whose selection is not "replace the token with a string" owns that
        // rewrite itself (D-20). This used to be a host prop implemented identically
        // in SessionView and useNewSessionScreenModel.
        const applySelection = resolveComposerSuggestionKind(suggestion.kind).applySelection;
        if (applySelection) {
            void applySelection({
                suggestion,
                inputText: currentInputState.text,
                selection: currentInputState.selection,
                activeWord: activeWordForSelection ?? null,
                onContributedActionSuggestionSelect: props.onContributedActionSuggestionSelect,
            }).then((result) => {
                if (!inputRef.current || !isSelectionCurrent()) return;
                if (result.handled) {
                    applyResolvedSelection(result);
                } else if (!result.preserveInput) {
                    applyDefaultSelection();
                }
            }).catch((error: unknown) => {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
            }).finally(() => {
                if (
                    isContributedActionSelection
                    && pendingContributedActionSelectionInputRef.current === currentInputState
                ) {
                    pendingContributedActionSelectionInputRef.current = null;
                }
                hapticsLight();
            });
            return;
        }

        applyDefaultSelection();
        hapticsLight();
    }, [
        props.autocompleteKinds,
        composerDropScope,
        props.composerFileScope,
        props.onContributedActionSuggestionSelect,
        suggestions,
        insertReferenceInInput,
        updateStructuredInputMentions,
    ]);

    // Action menu popover state
    const composerAnchorRef = React.useRef<View>(null);
    const composerCardRef = React.useRef<View>(null);
    const stageSpotlightRef = React.useRef<View>(null);
    const stageSpotlightProps = useSpotlightTarget(
        stageSpotlightRef,
        props.sessionId ? STAGE_SPOTLIGHT_TARGET_IDS.composerQueue : null,
    );

    const {
        commandMenuOpen,
        items: commandMenuItems,
        selectedIndex: commandMenuSelectedIndex,
        query: commandMenuQuery,
        onSelectFromMenu: commandMenuOnSelect,
        onSelectIndexFromMenu: commandMenuOnSelectIndex,
        onCloseMenu: commandMenuOnClose,
        moveUp: commandMenuMoveUp,
        moveDown: commandMenuMoveDown,
        kindTab: referencePickerKindTab,
        setKindTab: setReferencePickerKindTab,
        cycleKindTab: cycleReferencePickerKindTab,
        showsEmptyState: referencePickerShowsEmptyState,
        selectable: commandMenuSelectable,
    } = useAgentInputCommandMenu({
        suggestions,
        selected,
        selectionPending,
        selectionForKind,
        activeWord,
        activeWordRange: activeWordState
            ? { start: activeWordState.offset, end: activeWordState.endOffset }
            : null,
        inputTextLength: liveTextStatus.length,
        moveUp,
        moveDown,
        handleSuggestionSelect,
        onOpenPromptPicker: promptLibraryAvailable && dictationEditable && !controlsOnly ? openPromptPickerFromSlash : undefined,
        settledEmpty: suggestionsSettledEmpty,
        // Only a focused composer that is querying holds the picker frame; a blurred draft shows no empty picker.
        emptyStateWhenResolved: referencePickerTrigger !== null && activeSuggestionQuery !== null,
        kindTabs: referencePickerKinds,
    });
    // Lab P1: the reference picker keeps one height as results narrow and says how it is driven, on a
    // hardware keyboard, in its footer.
    const hardwareKeyboard = useHardwareKeyboard();
    const referencePickerHasTabs = cycleReferencePickerKindTab !== undefined;
    const referencePickerFooter = React.useMemo(() => (
        referencePickerTrigger !== null ? (
            <SelectionListFooter hardwareKeyboardAvailable={hardwareKeyboard} hints={[
                { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
                { id: 'mention', label: '↵', description: t('composerReferences.hintMention') },
                ...(referencePickerHasTabs ? [{ id: 'kind', label: '⇥', description: t('composerReferences.hintNextKind') }] : []),
                { id: 'close', label: 'esc', description: t('commandPalette.hints.close') },
            ]} />
        ) : null
    ), [referencePickerTrigger, referencePickerHasTabs, hardwareKeyboard]);
    // The kinds a trigger can mention, as tabs over the list (lab P1/P2); ⇥ cycles them.
    const referencePickerHeader = React.useMemo(() => (
        referencePickerHasTabs && referencePickerKinds ? (
            <View style={styles.referencePickerTabs}>
                <SegmentedTabBar
                    presentation="plain"
                    compact
                    segmentSizing="content"
                    overflow={{ label: t('common.more') }}
                    accessibilityLabel={t('agentInput.suggestionGroups.references')}
                    testIDPrefix="agent-input-reference-kind"
                    tabs={[
                        { id: 'all', label: t('composerReferences.tabAll') },
                        ...referencePickerKinds.map((kind) => ({ id: kind, label: t(resolveComposerSuggestionKind(kind).sectionTitleKey) })),
                    ]}
                    activeTabId={referencePickerKindTab ?? 'all'}
                    onSelectTab={(id) => setReferencePickerKindTab(id === 'all' ? null : id as ComposerSuggestionKindId)}
                />
            </View>
        ) : null
    ), [referencePickerHasTabs, referencePickerKinds, referencePickerKindTab, setReferencePickerKindTab]);
    // Lab P3: the frame stays and says what was searched; Enter is left to the composer meanwhile.
    const referencePickerSearchText = commandMenuQuery.slice(1).replace(/^"|"$/g, '');
    const referencePickerEmptyState = referencePickerShowsEmptyState ? (
        <EmptyState
            layout="centered"
            size="pane"
            iconName="magnifying-glass"
            title={referencePickerSearchText.length > 0
                ? t('composerReferences.noMatches', { query: referencePickerSearchText })
                : t('composerReferences.nothingToMention')}
            subtitle={t('composerReferences.noMatchesDetail')}
            testID={`${AGENT_INPUT_COMMAND_MENU_TEST_ID}:empty`}
        />
    ) : referencePickerTrigger !== null ? <View /> : null;
    const commandMenuComboboxAccessibility = React.useMemo(
        () => resolveCommandMenuComboboxAccessibility({
            testID: AGENT_INPUT_COMMAND_MENU_TEST_ID,
            items: commandMenuItems,
            selectedIndex: commandMenuSelectedIndex,
        }),
        [commandMenuItems, commandMenuSelectedIndex],
    );
    const composerInputComboboxProps = props.autocompleteKinds.length === 0
        ? {}
        : {
            accessibilityRole: 'combobox' as const,
            accessibilityState: commandMenuOpen
                ? AGENT_INPUT_COMBOBOX_EXPANDED_STATE
                : AGENT_INPUT_COMBOBOX_COLLAPSED_STATE,
            'aria-haspopup': 'listbox' as const,
            'aria-autocomplete': 'list' as const,
            'aria-controls': commandMenuComboboxAccessibility.listboxId,
            ...(commandMenuOpen && commandMenuComboboxAccessibility.activeDescendantId !== undefined
                ? { 'aria-activedescendant': commandMenuComboboxAccessibility.activeDescendantId }
                : {}),
        };

    const { handleKey: handleCommandMenuKey } = useCommandMenuKeyboard({
        open: commandMenuOpen,
        onMoveUp: commandMenuMoveUp,
        onMoveDown: commandMenuMoveDown,
        onSelect: commandMenuOnSelect,
        onClose: commandMenuOnClose,
        onTab: cycleReferencePickerKindTab,
        selectable: commandMenuSelectable,
    });

    const caretRect = useTextInputCaretRect({
        inputRef,
        selection: inputSelection,
        enabled: isInputFocused && !props.disabled && activeWord !== null,
    });
    // On a compact layout the menu takes the composer card's width and left edge instead of the caret's.
    const compactCommandMenu = isMobileLayoutWidth(screenWidth);
    const commandMenuAnchor: CommandMenuAnchor = React.useMemo(
        () => resolveAgentInputCommandMenuAnchor(caretRect, composerAnchorRef, compactCommandMenu ? composerCardRef : null),
        [caretRect, composerAnchorRef, compactCommandMenu],
    );

    const permissionRequestsFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });
    // A phone viewer docked or expanded in Chat holds its frame above the composer: the attention band
    // takes its share of what is left, so it never covers the dock nor squeezes Expanded below it.
    const viewerComposerReserve = useSessionViewerComposerReserve();
    const permissionRequestsMaxHeightPx = React.useMemo(() => {
        const available = Math.max(1, (props.maxPanelHeight ?? screenHeight) - viewerComposerReserve);
        const desired = Math.round(available * 0.34);
        return clampNumber(desired, 160, Math.min(320, available));
    }, [props.maxPanelHeight, screenHeight, viewerComposerReserve]);
    const composerAttentionRequestsNode = React.useMemo(() => {
        if (!attentionRequestSessionId || !hasComposerAttentionRequests) return null;
        const sharedProps: Omit<AgentInputPermissionRequestsProps, 'permissionLocationsById'> = {
            sessionId: attentionRequestSessionId,
            permissionRequests: composerPermissionRequests,
            approvalRequests: composerApprovalRequests,
            metadata: props.metadata || null,
            canApprovePermissions,
            disabledReason: props.permissionDisabledReason,
            maxHeightPx: permissionRequestsMaxHeightPx,
            onContentSizeChange: (_w, h) => {
                permissionRequestsFades.onContentSizeChange?.(_w, h);
            },
            onLayout: (e) => {
                permissionRequestsFades.onViewportLayout?.(e);
            },
            onScroll: (e) => {
                permissionRequestsFades.onScroll?.(e);
            },
            fadeVisibility: permissionRequestsFades.visibility,
        };
        if (composerPermissionRequests.length > 0 || composerApprovalRequests.length > 0) {
            return <AgentInputAttentionRequestsWithLocations {...sharedProps} />;
        }
        return (
            <AgentInputPermissionRequests
                {...sharedProps}
                permissionLocationsById={EMPTY_PERMISSION_LOCATIONS_BY_ID}
                approvalLocationsByArtifactId={EMPTY_APPROVAL_LOCATIONS_BY_ARTIFACT_ID}
            />
        );
    }, [
        canApprovePermissions,
        composerApprovalRequests,
        composerPermissionRequests,
        hasComposerAttentionRequests,
        permissionRequestsFades,
        permissionRequestsMaxHeightPx,
        props.metadata,
        props.permissionDisabledReason,
        attentionRequestSessionId,
    ]);
    const fixedComposerAttentionRequestsNode = composerAttentionRequestsNode ? (
        <View
            testID="agentInput.permissionRequests.fixed"
            onLayout={(event) => {
                updateLayoutHeight(setComposerAttentionHeightPx, event.nativeEvent.layout.height);
            }}
        >
            {composerAttentionRequestsNode}
        </View>
    ) : null;

    const submitCustomModel = React.useCallback((value: string) => {
        const normalized = value.trim();
        if (!normalized) return;
        props.onModelModeChange?.(normalized);
    }, [props.onModelModeChange]);

    const sessionModeOptionsOverrideProbe = props.acpSessionModeOptionsOverrideProbe ?? null;
    const acpConfigOptionsOverrideProbe = props.acpConfigOptionsOverrideProbe ?? null;

    const handleSelectModelOptionValue = React.useCallback((configId: string, valueId: string) => {
        if (configId === EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID) {
            const modelId = resolveExtendedContextModelIdForToggle({
                model: selectedModelForControls,
                enabled: valueId === 'true',
            });
            if (!modelId) return;
            hapticsLight();
            props.onModelModeChange?.(modelId);
            return;
        }
        hapticsLight();
        props.onAcpConfigOptionChange?.(configId, valueId);
    }, [props.onAcpConfigOptionChange, props.onModelModeChange, selectedModelForControls]);
    const hasSettingsAcpConfigSection = Boolean(acpConfigOptionControls);

    const unifiedEnginePickerProbe = React.useMemo<OptionPickerProbeState | undefined>(() => {
        return mergeOptionPickerProbes([
            props.modelOptionsOverrideProbe ?? null,
            props.agentPickerProbe ?? null,
            sessionModeOptionsOverrideProbe ?? null,
            acpConfigOptionsOverrideProbe ?? null,
        ]);
    }, [
        acpConfigOptionsOverrideProbe,
        props.agentPickerProbe,
        props.modelOptionsOverrideProbe,
        sessionModeOptionsOverrideProbe,
    ]);

    const renderResolvedEngineDetail = React.useCallback((
        surfaceVariant: 'carded' | 'plain' = 'carded',
        onRequestClose?: () => void,
    ) => (
        <AgentInputEngineDetail
            fillAvailableSpace
            modelOptions={modelOptions.map((option) => ({
                value: option.value,
                label: option.label,
                ...(appliedModelPresentation?.optionValue === option.value ? {
                    trailingStatusIcon: (
                        <ReportedModelStatusIcon
                            status={appliedModelPresentation.status}
                        />
                    ),
                    accessibilityLabel: `${option.label}. ${appliedModelPresentation.summary}`,
                } : {}),
                description:
                    option.value === 'default'
                    && shouldShowModelOptionDescriptions
                    && (typeof option.description !== 'string' || option.description.trim().length === 0)
                        ? t('agentInput.model.configureInCli')
                        : option.description,
                ...(option.modelOptions ? { modelOptions: option.modelOptions } : {}),
            }))}
            selectedModelId={effectiveModelPolicy.selectedModelId}
            modelSummary={appliedModelPresentation?.summary
                ? `${appliedModelPresentation.summary} · ${modelApplyTiming}`
                : modelApplyTiming}
            modelNotes={modelNotes}
            modelApplyTiming={modelApplyTiming}
            modelEmptyText={t('agentInput.model.configureInCli')}
            canEnterCustomModel={canEnterCustomModel}
            // Keep a single refresh affordance in the model section, but wire it to refresh all
            // probe surfaces that feed the engine popover (CLI detection, models, modes/config).
            modelProbe={unifiedEnginePickerProbe}
            modelContentOverride={props.modelContentOverride}
            modelRoutingHint={props.agentCatalogIdentity ? (
                <SessionModelRoutingHint entry={props.agentCatalogIdentity.entry} machineId={props.agentCatalogIdentity.machineId} />
            ) : undefined}
            onSelectModel={(value) => {
                hapticsLight();
                props.onModelModeChange?.(value);
                if (onRequestClose) deferAgentInputPopoverClose(onRequestClose);
            }}
            onSubmitCustomValue={canEnterCustomModel ? submitCustomModel : undefined}
            selectedModelOptionControls={selectedModelOptionControls}
            onSelectModelOptionValue={
                props.onAcpConfigOptionChange || props.onModelModeChange
                    ? handleSelectModelOptionValue
                    : undefined
            }
            configControls={acpConfigOptionControls}
            onSelectConfigValue={
                props.onAcpConfigOptionChange
                    ? (configId, valueId) => {
                        hapticsLight();
                        props.onAcpConfigOptionChange?.(configId, valueId);
                    }
                    : undefined
            }
            surfaceVariant={surfaceVariant}
        />
    ), [
        acpConfigOptionControls,
        canEnterCustomModel,
        effectiveModelPolicy.selectedModelId,
        modelOptions,
        modelNotes,
        modelApplyTiming,
        appliedModelPresentation,
        unifiedEnginePickerProbe,
        shouldShowModelOptionDescriptions,
        props.onAcpConfigOptionChange,
        props.modelContentOverride,
        props.agentCatalogIdentity,
        props.onModelModeChange,
        handleSelectModelOptionValue,
        submitCustomModel,
        selectedModelOptionControls,
    ]);

    const hasInternalAgentPickerOptions = Boolean(
        !armedComposerTarget
        && props.engineControls !== 'none'
        && props.agentType
        && (props.onModelModeChange || hasSettingsAcpConfigSection),
    );

    const effectiveAgentLabel = React.useMemo(() => {
        if (engineChipMarkAgentId === null) return t('status.unknown');
        if (typeof props.agentLabel === 'string' && props.agentLabel.length > 0) {
            return props.agentLabel;
        }
        return props.agentType && isBundledAgentId(props.agentType)
            ? resolveAgentCatalogTitle(props.agentType)
            : '';
    }, [engineChipMarkAgentId, props.agentLabel, props.agentType]);

    const currentAgentPickerRow = React.useMemo<AgentInputChipPickerOption | null>(() => (
        props.agentType
            ? {
                id: `engine:${props.agentType}`,
                label: effectiveAgentLabel,
                icon: (
                    props.agentCatalogIdentity
                    && (
                        props.agentType === props.agentCatalogIdentity.entry.agentId
                        || props.agentType === props.agentCatalogIdentity.entry.qualifiedId
                    )
                        ? <AgentCatalogIdentityIcon {...props.agentCatalogIdentity} size={12} />
                        : <AgentIcon
                            agentId={props.agentType}
                            size={12}
                            style={{ transform: [{ scale: getAgentPickerIconScale(props.agentType) }] }}
                        />
                ),
            }
            : null
    ), [effectiveAgentLabel, props.agentCatalogIdentity, props.agentType]);

    const internalAgentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!hasInternalAgentPickerOptions || !props.agentType || !currentAgentPickerRow) return [];
        return [{
            ...currentAgentPickerRow,
            deferRenderDetailContent: true,
            deferredDetailContentCacheKey: `session-engine:${props.agentType}`,
            renderDetailContent: ({ onRequestClose }) => renderResolvedEngineDetail('carded', onRequestClose),
        }];
    }, [
        currentAgentPickerRow,
        hasInternalAgentPickerOptions,
        props.agentType,
        renderResolvedEngineDetail,
    ]);

    const agentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (props.engineControls === 'none') return [];
        if ((props.agentPickerOptions?.length ?? 0) > 0) {
            return props.agentPickerOptions ?? [];
        }
        const composeAgentPickerOptions = props.composeAgentPickerOptions;
        if (!composeAgentPickerOptions) {
            return internalAgentPickerOptions;
        }
        // With nothing of its own to configure, the running Agent is still worth naming —
        // but only once a caller has actually contributed another Agent to choose between.
        // Otherwise a lone, inert row would open a picker that offers no decision.
        const ownsCurrentAgentDetail = internalAgentPickerOptions.length > 0;
        const currentAgentOptions = ownsCurrentAgentDetail
            ? internalAgentPickerOptions
            : (currentAgentPickerRow ? [currentAgentPickerRow] : []);
        const composed = composeAgentPickerOptions(currentAgentOptions);
        if (!ownsCurrentAgentDetail && composed.length <= currentAgentOptions.length) {
            return [];
        }
        return composed;
    }, [
        currentAgentPickerRow,
        internalAgentPickerOptions,
        props.agentPickerOptions,
        props.composeAgentPickerOptions,
        props.engineControls,
    ]);

    const effectiveAgentPickerSelectedOptionId = React.useMemo(() => resolveAgentInputEngineOptionId({
        options: agentPickerOptions,
        selectedOptionId: props.agentPickerSelectedOptionId,
        agentType: props.agentType,
    }), [agentPickerOptions, props.agentPickerSelectedOptionId, props.agentType]);

    const hasAgentPickerOptions = agentPickerOptions.length > 0;

    const {
        overlayAnchorRef,
        actionMenuAnchorRef,
        agentChipAnchorRef,
        permissionChipAnchorRef,
        machineChipAnchorRef,
        sessionModeChipAnchorRef,
        pathChipAnchorRef,
        resumeChipAnchorRef,
        profileChipAnchorRef,
        envVarsChipAnchorRef,
    } = useAgentInputSelectionAnchors();
    const [showActionMenu, setShowActionMenu] = React.useState(false);
    const closeActionMenu = React.useCallback(() => {
        setShowActionMenu(false);
    }, []);
    const onSelectionOverlayDismiss = React.useCallback((id: AgentInputSelectionOverlayId) => {
        if (id === 'machine') props.machinePopover?.onRequestClose?.();
    }, [props.machinePopover]);
    const resetStartAvailable = props.resetStartEnabled === true && submitEnabled
        && props.sessionId !== undefined && props.sessionAddress !== undefined
        && !props.armedContinuationTarget;
    // `handleSend` follows the live text; the chip only sends on press, so typing must not rebuild
    // the chip array (and with it every control row and the action menu).
    const sendFromResetStartChip = useEventCallback(handleSend);
    const extraActionChips = React.useMemo<readonly AgentInputExtraActionChip[]>(() => {
        if (!resetStartAvailable || !props.sessionId || !props.sessionAddress) return props.extraActionChips ?? [];
        const key = 'resetStart';
        const disabled = sendActionDisabled;
        return [...(props.extraActionChips ?? []), {
            key, controlId: 'delivery',
            placement: getAgentInputResetStartPlacement(),
            render: context => <Pressable ref={context.chipAnchorRef} testID="agent-input-reset-start"
                accessibilityRole="button" accessibilityLabel={t('usage.board.plans.sendAtReset')}
                accessibilityState={{ disabled }} disabled={disabled} style={({ pressed }) => context.chipStyle(pressed)}
                onPress={() => context.toggleCollapsedPopover?.(key)}>
                <Icon name="clock" size={16} color={context.iconColor} />
                {context.showLabel ? <Text style={context.textStyle}>{t('usage.board.plans.sendAtReset')}</Text> : null}
            </Pressable>,
            collapsedContentPopover: {
                title: t('usage.board.plans.sendAtReset'), disabled,
                icon: tint => <Icon name="clock" size={16} color={tint} />,
                renderContent: ({ requestClose }) => <React.Suspense fallback={
                    <ActivitySpinner size="small" accessibilityLabel={t('usage.board.page.loading')} />
                }>
                    <LazyResetStartPicker sessionId={props.sessionId!} serverId={props.sessionAddress!.serverId}
                        onSelect={reset => { requestClose(); sendFromResetStartChip({ resetStart: reset }); }} />
                </React.Suspense>,
            },
        }];
    }, [resetStartAvailable, props.extraActionChips, props.sessionId, props.sessionAddress, sendActionDisabled, sendFromResetStartChip]);
    const {
        activeSelectionOverlay,
        activeExtraCollapsedPopoverChip,
        openSelectionOverlay,
        toggleSelectionOverlay,
        closeSelectionOverlay,
        resetSelectionOverlays,
    } = useAgentInputSelectionOverlayController({
        extraActionChips,
        shouldRenderSessionModeChip,
        canChangePermission: Boolean(props.onPermissionModeChange),
        hasMachinePopover: Boolean(props.machinePopover),
        hasPathPopover: Boolean(props.pathPopover),
        hasResumePopover: Boolean(props.resumePopover),
        hasProfilePopover: Boolean(props.profilePopover),
        hasEnvVarsPopover: Boolean(props.envVarsPopover),
        hasAgentPickerOptions,
        retainKeyboardLift: props.retainKeyboardLift,
        onSelectionOverlayDismiss,
    });
    useAgentInputExternalPickerRequest({
        requestKey: props.openModelPickerRequestKey,
        open: React.useCallback(() => {
            if (!hasAgentPickerOptions) return;
            openSelectionOverlay('agent', 'chip');
        }, [hasAgentPickerOptions, openSelectionOverlay]),
    });
    const openActionChipRequest = props.openActionChipRequest ?? null;
    useAgentInputExternalPickerRequest({
        requestKey: openActionChipRequest?.key,
        open: React.useCallback(() => {
            if (!openActionChipRequest) return;
            openSelectionOverlay('collapsedExtra', 'chip', openActionChipRequest.chipKey);
        }, [openActionChipRequest, openSelectionOverlay]),
    });
    const {
        showAgentPicker,
        agentPickerAnchor,
        closeAgentPicker,
        showSessionModePicker,
        sessionModePickerAnchor,
        closeSessionModePicker,
        showPermissionPopover,
        closePermissionPopover,
        showMachinePopover,
        machinePopoverAnchor,
        closeMachinePopover,
        showPathPopover,
        pathPopoverAnchor,
        closePathPopover,
        showResumePopover,
        resumePopoverAnchor,
        closeResumePopover,
        showProfilePopover,
        profilePopoverAnchor,
        closeProfilePopover,
        showEnvVarsPopover,
        envVarsPopoverAnchor,
        closeEnvVarsPopover,
        activeExtraCollapsedPopoverAnchor,
        closeActiveExtraCollapsedPopoverChip,
    } = buildAgentInputSelectionOverlayViewModel({
        activeSelectionOverlay,
        activeExtraCollapsedPopoverChip,
        closeSelectionOverlay,
    });

    const onAgentPickerVisibilityChange = props.onAgentPickerVisibilityChange;
    React.useEffect(() => {
        onAgentPickerVisibilityChange?.(showAgentPicker);
    }, [onAgentPickerVisibilityChange, showAgentPicker]);

    // "Runs through" opens the engine pane on one source through the same overlay owner as every
    // other picker; the request is dropped when the pane closes, so reopening shows every source.
    const [modelSourceBrowseRequest, setModelSourceBrowseRequest] = React.useState<SessionModelSourceBrowseHandoff['request']>(null);
    React.useEffect(() => {
        if (!showAgentPicker) setModelSourceBrowseRequest(null);
    }, [showAgentPicker]);
    const modelSourceBrowseHandoff = React.useMemo<SessionModelSourceBrowseHandoff | null>(() => hasAgentPickerOptions ? {
        request: modelSourceBrowseRequest,
        browse: (agentTargetKey, scope) => {
            setModelSourceBrowseRequest((current) => ({ agentTargetKey, scope, key: (current?.key ?? 0) + 1 }));
            openSelectionOverlay('agent', 'chip');
        },
    } : null, [hasAgentPickerOptions, modelSourceBrowseRequest, openSelectionOverlay]);

    const instrumentStripPermission = React.useMemo<SessionInstrumentStripPermission | null>(() => {
        if (!shouldRenderPermissionChip(permissionChipLabel)) return null;
        const mode = effectivePermissionPolicy.effectiveMode;
        const color = mode === 'acceptEdits' ? theme.colors.permission.acceptEdits
            : mode === 'bypassPermissions' ? theme.colors.permission.bypass
                : mode === 'plan' ? theme.colors.permission.plan
                    : mode === 'read-only' ? theme.colors.permission.readOnly
                        : mode === 'safe-yolo' ? theme.colors.permission.safeYolo
                            : mode === 'yolo' ? theme.colors.permission.yolo
                                : theme.colors.text.secondary;
        return { label: permissionChipLabel, color };
    }, [permissionChipLabel, effectivePermissionPolicy.effectiveMode, theme]);

    const showPermissionChip = Boolean(props.onPermissionModeChange || props.onPermissionClick);
    const hasProfile = Boolean(props.onProfileClick || props.profilePopover);
    const hasEnvVars = Boolean(props.onEnvVarsClick || props.envVarsPopover);
    const {
        hasAgentSelection: hasAgent,
        resolvedAgentLabel,
        handlePermissionPress,
        handleModePress,
        handleProfilePress,
        handleEnvVarsPress,
        handleAgentPress,
        handleMachinePress,
        handlePathPress,
        handleResumePress,
    } = useAgentInputCoreControlHandlers({
        agentLabel: effectiveAgentLabel,
        hasAgentPickerOptions,
        onAgentClick: props.onAgentClick,
        onPermissionModeChange: props.onPermissionModeChange,
        onPermissionClick: props.onPermissionClick,
        sessionModeChipInteraction,
        onSessionModeChange: props.onAcpSessionModeChange,
        profilePopover: props.profilePopover,
        onProfileClick: props.onProfileClick,
        envVarsPopover: props.envVarsPopover,
        onEnvVarsClick: props.onEnvVarsClick,
        machinePopover: props.machinePopover,
        onMachineClick: props.onMachineClick,
        pathPopover: props.pathPopover,
        onPathClick: props.onPathClick,
        resumePopover: props.resumePopover,
        onResumeClick: props.onResumeClick,
        setShowActionMenu,
        closeSelectionOverlay,
        toggleSelectionOverlay,
    });
    /**
     * The armed Agent switch, as the composer is presenting it right now.
     *
     * One owner, shared with the send control, so the chip and the button cannot
     * name different Agents: the picker showing a checkmark on Sonnet 4.6 while
     * the chip still read GPT 5.6 Sol is the defect this removes. The chip reads
     * the arm itself — selection is the arming, so it changes with the rail rather
     * than waiting for a keystroke — while the button additionally requires that
     * pressing it would take the switch.
     */
    const engineChipLabel = React.useMemo(() => {
        if (props.engineLabel !== undefined) return props.engineLabel;
        if (engineChipMarkAgentId === null) return t('status.unknown');
        const picker = props.modelPickerPresentation;
        if (picker?.selected?.providerConnectionId && (
            !armedComposerTarget || armedComposerTarget.backendTargetKey === picker.agentTargetKey
        )) {
            const name = buildSessionModelSelectedTriggerPresentation(picker).subtitle;
            // An id is not a name: until the projection answers, the chip stays on the Agent.
            return !picker.providerProjectionAuthoritative && !picker.providerProjectionFailed && name === picker.selected.modelId
                ? resolvedAgentLabel
                : name;
        }
        // Selection IS the selection. An armed target with a model chosen names
        // that model; an armed target still on the Agent's own defaults names the
        // Agent, because no model has been chosen to name.
        if (armedComposerTarget) {
            return armedComposerTarget.modelLabel ?? armedComposerTarget.label;
        }
        return hasAgentPickerOptions ? selectedModelLabel ?? resolvedAgentLabel : resolvedAgentLabel;
    }, [props.engineLabel, props.modelPickerPresentation, armedComposerTarget, engineChipMarkAgentId, hasAgentPickerOptions, resolvedAgentLabel, selectedModelLabel]);
    /**
     * The mark on the engine chip: the armed Agent while one is armed, otherwise
     * the Agent running this Session.
     *
     * Scoped to the chip on purpose. `agentId` still resolves the RUNNING Agent,
     * because permission modes, model options and session modes are facts about
     * what is running — only this one control is about what runs next.
     */
    const engineChipIdentityIcon = React.useMemo(() => {
        if (engineChipMarkAgentId === null) {
            return <AgentIcon agentId={null} size={16} color={theme.colors.composer.chipTint} testID="agent-input-agent-chip-logo" />;
        }
        const identity = props.agentCatalogIdentity;
        if (identity) {
            const entryMatches = engineChipAgentId === identity.entry.agentId
                || engineChipAgentId === identity.entry.qualifiedId;
            if (entryMatches) {
                return (
                    <AgentCatalogIdentityIcon
                        {...identity}
                        size={16}
                        color={theme.colors.composer.chipTint}
                        testID="agent-input-agent-chip-logo"
                    />
                );
            }
        }
        const selectedOption = agentPickerOptions.find(
            (option) => option.id === effectiveAgentPickerSelectedOptionId,
        );
        if (armedComposerTarget && (
            !armedComposerTarget.backendTargetKey
            || selectedOption?.id !== armedComposerTarget.backendTargetKey
        )) return undefined;
        return React.isValidElement<Record<string, unknown>>(selectedOption?.icon)
            ? React.cloneElement(selectedOption.icon, {
                size: 16,
                testID: 'agent-input-agent-chip-logo',
            })
            : undefined;
    }, [
        agentPickerOptions,
        effectiveAgentPickerSelectedOptionId,
        engineChipAgentId,
        engineChipMarkAgentId,
        props.agentCatalogIdentity,
        theme.colors.composer.chipTint,
    ]);
    const armedContinuationIdentityMark = React.useMemo(() => {
        if (!armedComposerTarget) return undefined;
        const selectedOption = agentPickerOptions.find(
            (option) => option.id === effectiveAgentPickerSelectedOptionId,
        );
        return selectedOption !== undefined && selectedOption.id === armedComposerTarget.backendTargetKey
            ? selectedOption.icon
            : undefined;
    }, [agentPickerOptions, armedComposerTarget, effectiveAgentPickerSelectedOptionId]);
    const attachmentRowItems = React.useMemo<readonly AgentInputAttachmentsRowItem[]>(() => (
        projectAgentInputAttachmentRowItems({ items: props.attachmentRowItems }).map((item) => {
            const remove = item.onRemove;
            return remove ? { ...item, onRemove: () => { flushComposerInput(); remove(); } } : item;
        })
    ), [flushComposerInput, props.attachmentRowItems]);
    const editorAttachmentIds = React.useMemo(() => attachmentRowItems.flatMap((item) => (
        item.attachmentId === undefined ? [] : [item.attachmentId]
    )), [attachmentRowItems]);
    const referenceRouter = useDestinationRouter();
    const { open: openReferenceFile, canOpen: canOpenReferenceFile } = useWorkspaceFileOpener();
    const editorReferences = React.useMemo(() => {
        const currentLifetime = captureActiveServerAccountScopeLifetime();
        const sourceServerId = props.sessionAddress?.serverId ?? props.composerReferenceHost?.serverId ?? props.composerFileScope?.serverId;
        const lifetime = currentLifetime && (!sourceServerId || areServerProfileIdentifiersEquivalent(sourceServerId, currentLifetime.scope.serverId))
            ? currentLifetime : null;
        const bindings = new Map(structuredInputMentions.map((mention) => [mention.start, mention]));
        const attachments = new Map(attachmentRowItems.flatMap((item) => item.attachmentId === undefined ? [] : [[item.attachmentId, item] as const]));
        const imageNumbers = readAgentInputImageNumbers(attachmentRowItems);
        return composerReferencesFromStructuredMentions({ text: props.value, mentions: structuredInputMentions }).map((reference): ComposerEditorReference<ComposerStructuredInputMention> => {
            const parsed = parseMentionRefV1(reference.ref);
            const binding = bindings.get(reference.start);
            const label = resolveComposerReferenceChipLabel(reference);
            if (parsed?.scheme !== INLINE_REFERENCE_ATTACHMENT_SCHEME_V1) {
                const readableMarker = formatSessionInputMentionMarkerV1({ ...reference, label });
                const sessionId = reference.kind === MENTION_KIND_V1.session
                    ? readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, reference.ref) : null;
                const file = reference.kind === MENTION_KIND_V1.file
                    ? readMentionRefOpaqueForKindV1(MENTION_KIND_V1.file, reference.ref) : null;
                const path = file === null ? null : isAbsoluteLocalPath(file.replace(/\\/g, '/'))
                    ? props.composerFileScope ? resolvePathRelativeToRoot({ path: file, root: props.composerFileScope.rootPath, preservePathSpelling: true }) : null
                    : normalizeRelativeLocalPath(file);
                const onOpen = sessionId && lifetime ? () => {
                    const auth = getCurrentAuth();
                    if (!lifetime.isCurrent() || !auth || props.composerReferenceHost?.isCurrent() === false) return;
                    fireAndForget(navigateToSession(sessionId, { serverId: lifetime.scope.serverId }, {
                        router: referenceRouter, refreshFromActiveServer: auth.refreshFromActiveServer,
                    }), { tag: 'AgentInput.openSessionReference' });
                } : lifetime && canOpenReferenceFile && path && !path.endsWith('/') && isSafeWorkspaceRelativePath(path)
                    && (props.sessionAddress || props.composerFileScope) ? () => {
                    if (!lifetime.isCurrent() || props.composerReferenceHost?.isCurrent() === false) return;
                    if (props.sessionAddress) {
                        if (!areServerProfileIdentifiersEquivalent(props.sessionAddress.serverId, lifetime.scope.serverId)) return;
                        fireAndForget(openReferenceFile({ kind: 'session', ...props.sessionAddress, path }, { intent: 'preview', view: 'view' }),
                            { tag: 'AgentInput.openFileReference' });
                        return;
                    }
                    const state = readRegisteredStorageState();
                    const scope = props.composerFileScope;
                    if (!state || !scope || !areServerProfileIdentifiersEquivalent(scope.serverId, lifetime.scope.serverId)) return;
                    const target = resolveWorkspaceRefByScope(readProjectWorkspaceRefs(state), scope);
                    if (target.kind !== 'resolved') return;
                    fireAndForget(openReferenceFile({ kind: 'project', workspaceRefId: target.ref.id, serverId: target.ref.serverId,
                        machineId: target.ref.machineId, rootPath: target.ref.rootPath, path }, { intent: 'preview', view: 'view' }),
                        { tag: 'AgentInput.openFileReference' });
                } : undefined;
                return { ...reference, binding, label, accessibilityLabel: readableMarker,
                    ...(parsed ? {} : { state: 'unavailable' }),
                    ...(onOpen ? { onOpen } : {}),
                    readableMarker };
            }
            const attachment = attachments.get(parsed.opaque);
            if (!attachment || attachment.status === 'error') {
                return { ...reference, binding, state: 'removed', label: t('composerReferences.attachmentRemoved'),
                    accessibilityLabel: t('composerReferences.attachmentRemoved'), readableMarker: label };
            }
            const number = imageNumbers.get(parsed.opaque);
            const state = attachment.status === 'uploading' || (attachment.attachmentType === 'folder' && attachment.status === 'pending')
                ? 'pending' : attachment.availability && attachment.availability !== 'ready' ? 'unavailable' : 'ready';
            const thumbnail = attachment.kind === 'media' && attachment.media === 'image'
                ? attachment.renderedPreview ?? (attachment.preview?.kind === 'image'
                    ? <Image source={{ uri: attachment.preview.uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                    : undefined)
                : undefined;
            return { ...reference, binding, state,
                label: number === undefined ? attachment.label : t('composerReferences.imageNumber', { number }),
                accessibilityLabel: number === undefined ? attachment.accessibilityLabel ?? attachment.label
                    : t('composerReferences.imageAccessibility', { number, name: attachment.label }),
                readableMarker: number === undefined ? `[${attachment.attachmentType === 'folder' ? 'Folder' : 'File'}: ${attachment.label}]` : `[Image #${number}]`,
                ...(thumbnail === undefined ? {} : { thumbnail }),
                ...(attachment.onPress ? { onOpen: () => attachment.onPress?.({ focusReturnRef: inputRef }) } : {}),
            };
        });
    }, [attachmentRowItems, props.value, props.sessionAddress, props.composerFileScope, props.composerReferenceHost, structuredInputMentions,
        composerDropScope, referenceRouter, openReferenceFile, canOpenReferenceFile]);
    React.useEffect(() => {
        if (attachmentRowItems.length === 0) {
            setNativeAttachmentRowTopPx(null);
        }
    }, [attachmentRowItems.length]);
    const editorDecorations = React.useMemo<readonly ComposerEditorDecoration[]>(() => (
        (props.composerDecorations ?? []).flatMap((decoration) => decoration.decorations.ranges.map((entry) => ({
            ...entry.range, treatment: entry.treatment, ...(entry.label ? { label: entry.label } : {}),
        })))
    ), [props.composerDecorations]);
    // A failed dictation that kept its recording stays beside the field until Retry succeeds or the
    // person discards it; the field's text is never touched by either.
    const recoveryFailure = useDictationRecoveryFailure(dictation.failure, dictation.status);
    const retainedDictationFailure = voiceEnabled ? recoveryFailure : null;
    const dictationRecovery = React.useMemo(() => retainedDictationFailure ? (
        // The line's glyph stands on the field's text edge, inside the same inset as the input-lock note.
        <View testID="agent-input-dictation-recovery-slot" style={styles.composerPresentationEffects}>
            <HappierBodyEdgeContext.Provider value>
                <AgentInputDictationRecovery failure={retainedDictationFailure} status={dictation.status}
                    onRetry={dictation.onRetry} onDiscard={dictation.onDiscard} />
            </HappierBodyEdgeContext.Provider>
        </View>
    ) : null, [retainedDictationFailure, dictation.status, dictation.onRetry, dictation.onDiscard, styles.composerPresentationEffects]);
    const composerPresentationFeedback = React.useMemo(() => {
        const inputLock = props.composerInputLock ?? null;
        if (inputLock === null && dictationRecovery === null) return null;

        return (
            <>
                {inputLock === null ? null : (
                    <View testID="agent-input-composer-presentation-effects" style={styles.composerPresentationEffects}>
                        <View testID="agent-input-composer-lock" style={styles.composerInputLockFeedback}>
                            <Text style={styles.composerInputLockFeedbackText}>{inputLock.reasons.join(' · ')}</Text>
                        </View>
                    </View>
                )}
                {dictationRecovery}
            </>
        );
    }, [
        dictationRecovery,
        props.composerInputLock,
        styles.composerInputLockFeedback,
        styles.composerInputLockFeedbackText,
        styles.composerPresentationEffects,
    ]);
    const hasVariableContentBeforeInput = attachmentRowItems.length > 0 || composerPresentationFeedback !== null;
    React.useEffect(() => {
        if (!hasVariableContentBeforeInput) {
            updateLayoutHeight(setVariableContentBeforeInputHeightPx, 0);
        }
    }, [hasVariableContentBeforeInput]);
    const hasMachine = Boolean(props.onMachineClick || props.machinePopover);
    const instrumentStripConnectionStatus = React.useMemo(() => {
        if (!props.connectionStatus) return null;
        if (props.connectionStatus.recovery !== 'machine' || !handleMachinePress) return props.connectionStatus;
        return {
            ...props.connectionStatus,
            action: { label: t('newSession.selectMachineTitle'), onPress: handleMachinePress },
        };
    }, [props.connectionStatus, handleMachinePress]);
    const hasPath = Boolean(props.onPathClick || props.pathPopover);
    const folderChipState = React.useMemo(
        () => resolveAgentInputFolderChipState(props.currentPath, props.folderChipState),
        [props.currentPath, props.folderChipState],
    );
    const hasResume = Boolean(props.onResumeClick || props.resumePopover);
    const hasFiles = Boolean(props.sessionId && props.onFileViewerPress);
    const canStopFromComposer = Boolean(props.onAbort && props.showAbortButton);

    const phoneHardware = isPhoneHardware();
    const promptLibraryControlAvailable = promptLibraryAvailable && dictationEditable && !controlsOnly;
    const accessoryPlacements = React.useMemo(() => ({
        promptLibrary: promptLibraryControlAvailable ? getAgentInputFieldAccessoryPlacement('promptLibrary') : null,
        dictate: ownsFieldDictation ? getAgentInputFieldAccessoryPlacement('dictate', dictationActive) : null,
    }), [promptLibraryControlAvailable, ownsFieldDictation, dictationActive]);
    const placementDescriptors = React.useMemo(() => buildAgentInputPlacementDescriptors({
        coreControls: [
            ...(hasAgent || ((readOnly || fixedEngine) && Boolean(props.agentType || props.engineLabel)) ? [{ id: 'engine' as const }] : []),
            ...(showPermissionChip ? [{ id: 'permission' as const }] : []),
            ...(shouldRenderSessionModeChip ? [{ id: 'mode' as const }] : []),
            ...(hasProfile ? [{ id: 'profile' as const }] : []),
            ...(hasEnvVars ? [{ id: 'env' as const }] : []),
            ...(hasMachine ? [{ id: 'machine' as const, pending: !isConversation && !props.machineName }] : []),
            ...(hasPath ? [{ id: 'path' as const, pending: !isConversation && folderChipState.kind === 'resolving' }] : []),
            ...(hasResume ? [{ id: 'resume' as const }] : []),
            ...(hasFiles ? [{ id: 'files' as const }] : []),
        ],
        chips: extraActionChips,
        accessories: [
            ...(accessoryPlacements.promptLibrary ? [accessoryPlacements.promptLibrary] : []),
            ...(accessoryPlacements.dictate ? [accessoryPlacements.dictate] : []),
        ],
        phone: phoneHardware,
        newSession: !isConversation,
        ...(compactControls ? { containedControlIds: AGENT_INPUT_COMPACT_CONTROL_IDS } : {}),
    }), [hasAgent, showPermissionChip, shouldRenderSessionModeChip, hasProfile, hasEnvVars, hasMachine, hasPath, hasResume, hasFiles,
        isConversation, props.machineName, folderChipState.kind, extraActionChips, accessoryPlacements, phoneHardware, compactControls,
        readOnly, fixedEngine, props.agentType, props.engineLabel]);
    const resolvedControls = React.useMemo(() => resolveAgentInputControlLines({
        controls: placementDescriptors,
        preferences: composerPlacementPreferences,
        singleRow: isConversation || compactControls,
    }), [placementDescriptors, composerPlacementPreferences, isConversation, compactControls]);
    React.useEffect(() => {
        if (!activeSelectionOverlay) return;
        const id = activeSelectionOverlay.id === 'collapsedExtra'
            ? extraActionChips.find(chip => chip.key === activeSelectionOverlay.chipKey)?.placement?.id
            : activeSelectionOverlay.id === 'agent' ? 'engine'
                : activeSelectionOverlay.id === 'sessionMode' ? 'mode'
                    : activeSelectionOverlay.id === 'envVars' ? 'env' : activeSelectionOverlay.id;
        const placement = id ? resolvedControls.effectivePlacements[id] : undefined;
        const rowAnchorExists = id !== undefined && (
            resolvedControls.primary.includes(id) || resolvedControls.secondary.includes(id)
        );
        if (placement && placement !== 'hidden' && (activeSelectionOverlay.anchor !== 'chip' || rowAnchorExists)) return;
        closeSelectionOverlay(activeSelectionOverlay.id);
        requestComposerFocus();
    }, [activeSelectionOverlay, extraActionChips, resolvedControls, closeSelectionOverlay, requestComposerFocus]);
    const showPromptLibraryButton = resolvedControls.accessories.includes('promptLibrary');
    const fieldAccessory = !ownsFieldDictation || resolvedControls.accessories.includes('dictate') ? availableFieldAccessory : null;
    const fieldAccessoryGeometry = resolveAgentInputFieldAccessoryGeometry({
        library: showPromptLibraryButton,
        accessory: fieldAccessory != null,
        belowToggle: shouldShowInputExpansionToggle,
    });
    const trailingAccessory = props.trailingAccessory ?? (mountsVoiceComposerPlanet ? voiceComposerPlanet : null);
    const fieldInputPaddingRight = Math.max(fieldAccessoryGeometry.paddingRight ?? 0,
        shouldReserveInputExpansionToggleSpace ? INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT : 0) || undefined;
    const accessoryMenuChips = React.useMemo<readonly AgentInputExtraActionChip[]>(() => {
        const { promptLibrary, dictate } = accessoryPlacements;
        return [
        ...(promptLibrary ? [{ key: 'promptLibrary', controlId: 'shortcuts' as const,
            placement: promptLibrary,
            render: () => null,
            collapsedAction: ({ dismiss, tint }: Parameters<NonNullable<AgentInputExtraActionChip['collapsedAction']>>[0]) => ({
                id: 'promptLibrary', label: promptLibrary.title, icon: <Icon name={promptLibrary.icon} size={16} color={tint} />,
                onPress: () => { dismiss(); openPromptPicker(); },
            }),
        }] : []),
        ...(dictate ? [{ key: 'dictate', controlId: 'shortcuts' as const,
            placement: dictate,
            render: () => null,
            collapsedAction: ({ dismiss, tint }: Parameters<NonNullable<AgentInputExtraActionChip['collapsedAction']>>[0]) => ({
                id: 'dictate', label: dictate.title, icon: <Icon name={dictate.icon} size={16} color={tint} />,
                onPress: () => { dismiss(); void handleDictationPress(); },
            }),
        }] : []),
        ];
    }, [accessoryPlacements, openPromptPicker, handleDictationPress]);
    const menuActionChips = React.useMemo(() => [...extraActionChips, ...accessoryMenuChips], [extraActionChips, accessoryMenuChips]);
    const actionBarShouldScroll = effectiveActionBarLayout === 'scroll';
    const actionChipTransientStyles = React.useMemo(() => ({
        iconOnly: AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
        pressed: AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE,
    }), []);
    const chipStyle = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        !showChipLabels ? actionChipTransientStyles.iconOnly : null,
        pressed ? actionChipTransientStyles.pressed : null,
    ]), [
        actionChipTransientStyles.iconOnly,
        actionChipTransientStyles.pressed,
        showChipLabels,
        styles.actionChip,
    ]);
    const chipStyleAutoHide = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        !showAutoHideChipLabels ? actionChipTransientStyles.iconOnly : null,
        pressed ? actionChipTransientStyles.pressed : null,
    ]), [
        actionChipTransientStyles.iconOnly,
        actionChipTransientStyles.pressed,
        showAutoHideChipLabels,
        styles.actionChip,
    ]);

    const actionBarFadeColor = useGlassSurfaceColor(panelMaterialProps.solidColor, panelMaterialProps.surfaceGroup, panelMaterialProps.nested);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    const runAbortShortcutAction = React.useCallback((action: 'armAbort' | 'confirmAbort') => {
        if (action === 'confirmAbort') {
            void handleAbortPress();
            return;
        }
        abortConfirmationExpiresAtRef.current = Date.now() + COMPOSER_ABORT_CONFIRMATION_WINDOW_MS;
        hapticsError();
        shakerRef.current?.shake();
    }, [handleAbortPress]);

    const handleComposerFocusShortcut = React.useCallback(() => {
        if (props.disabled || props.surfacePresented === false) return false;
        requestComposerFocus();
    }, [props.disabled, props.surfacePresented, requestComposerFocus]);

    const handleComposerAbortShortcut = React.useCallback(() => {
        const escapeAction = resolveComposerEscapeAction({ key: 'Escape', shiftKey: true }, {
            canAbort: canStopFromComposer,
            isAborting,
            abortConfirmationExpiresAt: abortConfirmationExpiresAtRef.current,
            nowMs: Date.now(),
        });
        if (escapeAction) {
            runAbortShortcutAction(escapeAction);
        }
    }, [canStopFromComposer, isAborting, runAbortShortcutAction]);

    const keyboardShortcutHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        const handlers: KeyboardShortcutHandlers = {
            'composer.focus': handleComposerFocusShortcut,
        };
        if (canStopFromComposer) {
            handlers['composer.abortConfirm'] = handleComposerAbortShortcut;
        }
        if (promptLibraryAvailable && isInputFocused && dictationEditable && !controlsOnly && props.surfacePresented !== false) {
            handlers['composer.prompts.open'] = openPromptPicker;
        }
        return handlers;
    }, [canStopFromComposer, handleComposerAbortShortcut, handleComposerFocusShortcut, isInputFocused, dictationEditable, controlsOnly, props.surfacePresented, openPromptPicker, promptLibraryAvailable]);
    useKeyboardShortcutHandlers(keyboardShortcutHandlers);

    // Identity-stable handlers: these feed the action-menu and control-row memos, which an inline
    // arrow would invalidate on every keystroke render.
    const handleActionMenuPermissionClick = React.useCallback(() => {
        if (props.onPermissionModeChange) openSelectionOverlay('permission', 'actionMenu');
        else props.onPermissionClick?.();
    }, [props.onPermissionModeChange, props.onPermissionClick, openSelectionOverlay]);
    const openCollapsedExtraChipOptionsPopover = React.useCallback((chipKey: string | null) => {
        if (!chipKey) {
            closeSelectionOverlay('collapsedExtra');
            return;
        }
        openSelectionOverlay('collapsedExtra', 'actionMenu', chipKey);
    }, [closeSelectionOverlay, openSelectionOverlay]);
    const handleToggleExtraChipCollapsedPopover = React.useCallback((chipKey: string) => {
        toggleSelectionOverlay('collapsedExtra', 'chip', chipKey);
    }, [toggleSelectionOverlay]);
    const blurComposerInput = React.useCallback(() => {
        inputRef.current?.blur();
    }, []);
    // "Customize composer…" belongs to a composer the person can edit here: never read-only, controls-only,
    // locked or disabled, and never where the embedding host narrowed placement away.
    const canCustomizeComposer = props.allowPlacementCustomization !== false && !readOnly && !controlsOnly
        && props.disabled !== true && !composerInputEditLocked;
    const customizeDescriptors = resolvedControls.controls;
    const placementContext = props.placementContext ?? resolveAgentInputPlacementContext(props.composerRef?.kind, isConversation);
    const handleCustomizeComposer = React.useCallback(() => {
        setShowActionMenu(false);
        openComposerPlacementCustomizer({ descriptors: customizeDescriptors, context: placementContext,
            placeholder: props.placeholder,
            singleRow: isConversation || compactControls,
            previewValues: {
                // A contributed chip's current value is the one its own overflow row states.
                ...Object.fromEntries(extraActionChips.flatMap((chip) => {
                    const label = chip.collapsedContentPopover?.label ?? chip.collapsedOptionsPopover?.label;
                    return chip.placement && label ? [[chip.placement.id, { label, ...chip.composerPreview?.(theme.colors.composer.chipTint) }]] : [];
                })),
                engine: { label: engineChipLabel, mark: engineChipIdentityIcon },
                mode: { label: sessionModeChipControl?.label ?? null },
                machine: { label: props.machineName ?? null },
                path: { label: props.currentPath ?? null },
            } });
    }, [customizeDescriptors, placementContext, props.placeholder, isConversation, compactControls, theme.colors.composer.chipTint, extraActionChips, engineChipLabel, engineChipIdentityIcon, sessionModeChipControl?.label, props.machineName, props.currentPath]);
    const {
        handleActionMenuPress,
        actionMenuActions,
        hasActionMenuPopoverSections,
    } = useAgentInputActionMenuControls({
        resolvedControls,
        canCustomizeComposer,
        permissionLabel: permissionChipLabel,
        onPermissionClick: showPermissionChip ? handleActionMenuPermissionClick : undefined,
        actionMenuAnchorRef,
        showActionMenu,
        setShowActionMenu,
        closeSelectionOverlay,
        openSelectionOverlay,
        resetSelectionOverlays,
        inputRef,
        profilePopover: props.profilePopover,
        onProfileClick: props.onProfileClick,
        envVarsPopover: props.envVarsPopover,
        onEnvVarsClick: props.onEnvVarsClick,
        machinePopover: props.machinePopover,
        pathPopover: props.pathPopover,
        resumePopover: props.resumePopover,
        hasAgentPickerOptions,
        onAgentClick: props.onAgentClick,
        tint: theme.colors.composer.chipTint,
        agentId: engineChipAgentId,
        agentIdentityIcon: engineChipIdentityIcon,
        profileLabel,
        profileIcon,
        envVarsCount: props.envVarsCount,
        agentLabel: resolvedAgentLabel,
        engineLabel: engineChipLabel,
        machineName: props.machineName,
        currentPath: props.currentPath,
        folderChipState,
        onRemoveFolder: props.onRemoveFolder,
        resumeSessionId: props.resumeSessionId,
        sessionId: props.sessionId,
        extraActionChips: menuActionChips,
        openCollapsedOptionsPopover: openCollapsedExtraChipOptionsPopover,
        sessionModeLabel: sessionModeChipControl?.label ?? null,
        sessionModeChipInteraction,
        onSessionModeChange: props.onAcpSessionModeChange,
        onMachineClick: handleMachinePress,
        onPathClick: handlePathPress,
        onResumeClick: handleResumePress,
        onFileViewerPress: props.onFileViewerPress,
        hasProfile,
        hasEnvVars,
        hasAgent: !readOnly && hasAgent,
    });
    const requestComposerControl = useEventCallback((intent: AgentInputControlIntent) => {
        switch (intent) {
            case 'engine': handleAgentPress(); break;
            case 'actionMenu': handleActionMenuPress(); break;
            case 'promptLibrary': openPromptPicker(); break;
            case 'dictate': void handleDictationPress(); break;
            default: handleToggleExtraChipCollapsedPopover(intent.chipPopover); break;
        }
    });
    React.useEffect(() => {
        props.onComposerControlRequestChange?.(requestComposerControl);
        return () => props.onComposerControlRequestChange?.(null);
    }, [props.onComposerControlRequestChange, requestComposerControl]);

    const {
        controlNodes: renderedActionControlNodes,
        hasPermissionControl,
        secondaryLeadingControls: secondaryLeadingControlsForWrap,
        secondaryTrailingControls: secondaryTrailingControlsForWrap,
        extraChipAnchorRefsByKey,
    } = useRenderedAgentInputControlRows({
        resolvedControls,
        readOnly: readOnly || fixedEngine,
        chips: extraActionChips,
        overlayAnchorRef,
        onToggleExtraChipCollapsedPopover: handleToggleExtraChipCollapsedPopover,
        themeTint: chipTint,
        showChipLabels: readOnly || showChipLabels,
        showAutoHideChipLabels: readOnly || showAutoHideChipLabels,
        chipStyle,
        chipStyleAutoHide,
        textStyle: styles.actionChipText,
        countTextStyle: styles.actionChipCountText,
        actionButtonStyle: styles.actionButton,
        actionButtonPressedStyle: styles.actionButtonPressed,
        showPermissionChip,
        permissionChipAnchorRef,
        permissionChipLabel,
        onPermissionPress: handlePermissionPress,
        hasActionMenuPopoverSections,
        actionMenuAnchorRef,
        onActionMenuPress: handleActionMenuPress,
        actionMenuOpen: showActionMenu,
        actionChipOpenStyle: styles.actionChipOpen,
        sessionModeChipControl,
        shouldRenderSessionModeChip,
        sessionModeChipAnchorRef,
        sessionModeChipPresentation,
        onModePress: handleModePress,
        hasProfile,
        profileChipAnchorRef,
        profileIcon,
        profileLabel,
        onProfilePress: handleProfilePress,
        hasEnvVars,
        envVarsChipAnchorRef,
        envVarsCount: props.envVarsCount,
        onEnvVarsPress: handleEnvVarsPress,
        hasAgentSelection: hasAgent || ((readOnly || fixedEngine) && Boolean(props.agentType || props.engineLabel)),
        agentChipAnchorRef,
        agentId: engineChipAgentId,
        agentIdentityIcon: engineChipIdentityIcon,
        agentLabel: resolvedAgentLabel,
        engineLabel: engineChipLabel,
        onAgentPress: handleAgentPress,
        machineChipAnchorRef,
        onMachinePress: handleMachinePress,
        machineName: props.machineName,
        pathChipAnchorRef,
        onPathPress: handlePathPress,
        folderChipState,
        onRemoveFolder: props.onRemoveFolder,
        resumeChipAnchorRef,
        onResumePress: handleResumePress,
        blurInput: blurComposerInput,
        resumeSessionId: props.resumeSessionId,
        resumeIsChecking: props.resumeIsChecking,
        onAbort: props.onAbort,
        showAbortButton: props.showAbortButton,
        isAborting,
        shakerRef,
        onAbortPress: handleAbortPress,
        sessionId: props.sessionId,
        onFileViewerPress: props.onFileViewerPress,
        sourceControlCompact: actionBarShouldScroll || !showChipLabels,
        sourceControlWrapperStyle: styles.actionItemWrapper,
    });

    // One rail in an existing session; a new session adds the machine · folder · resume rail
    // beneath its setup rail at every width (0.2's rails).
    const showSecondaryControlsRow = !isConversation && !compactControls && shouldShowSecondaryControlRow(
        effectiveActionBarLayout,
        secondaryLeadingControlsForWrap.length > 0 || secondaryTrailingControlsForWrap.length > 0,
    );

    // The setup chips sit above the machine · folder · resume chips: each row's hit areas take half the gap.
    const upperChipRowReach = showSecondaryControlsRow ? AGENT_INPUT_CHIP_ROW_HIT_REACH.upper : undefined;

    const handlePermissionSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        closePermissionPopover();
    }, [closePermissionPopover, props.onPermissionModeChange]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        const eventInputText = event.inputState?.text ?? inputRef.current?.getText?.() ?? inputStateRef.current.text;
        const hasSendableInput = resolveLiveInputTextStatus(eventInputText).hasText || props.hasSendableAttachments === true;
        const sendShortcutAction = !submitEnabled ? null : resolveComposerSendShortcutAction(event, {
            keyboardShortcutsV2Enabled,
            keyboardSingleKeyShortcutsEnabled,
            keyboardShortcutOverridesV1,
            keyboardShortcutDisabledCommandIdsV1,
            hasSendableInput,
            canSendNextQueued: props.canSendNextQueued,
            sendActionDisabled,
            platformOS: Platform.OS,
        });
        if (sendShortcutAction) {
            const deliveryIntent = sendShortcutAction === 'sendInterrupt' ? 'interrupt'
                : sendShortcutAction === 'sendPending' ? 'server_pending'
                    : hasSendableInput ? (props.alternateSendMode ?? 'agent_queue') : 'agent_queue';
            if (!hasSendableInput) {
                if (deliveryIntent === 'server_pending') return false;
                onSendProp?.({ deliveryIntent, sendNextQueued: true });
            } else {
                handleSend({ deliveryIntent });
            }
            return true;
        }

        const enterAction = resolveComposerEnterAction(event, {
            enterToSendEnabled,
            hasSendableInput,
            sendActionDisabled,
            platformOS: Platform.OS,
        });

        const escapeAction = resolveComposerEscapeAction(event, {
            canAbort: canStopFromComposer,
            isAborting,
            abortConfirmationExpiresAt: abortConfirmationExpiresAtRef.current,
            nowMs: Date.now(),
        });
        if (escapeAction) {
            runAbortShortcutAction(escapeAction);
            return true;
        }

        // D21: command-menu navigation stays after explicit send/abort and before enter-to-send/history.
        if (handleCommandMenuKey(event)) return true;

        if (enterAction === 'send') {
            handleSend();
            return true;
        }

        // Original key handling. Message history is a Session composer's; an
        // authoring-only field keeps plain caret movement.
        if (Platform.OS === 'web' && submitEnabled) {
            // Shell-like history: only when suggestions are not visible and cursor is at the boundary.
            const historyInputState = resolveHistoryKeyInputState(event, inputStateRef.current);
            const isCollapsedSelection = historyInputState.selection.start === historyInputState.selection.end;
            if (props.messageHistory !== 'none' && isCollapsedSelection && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                const historyBrowsing = isHistoryBrowsing();
                if (event.key === 'ArrowUp' && (historyBrowsing || historyInputState.selection.start === 0)) {
                    const next = messageHistory.moveUp(historyInputState.text);
                    if (next !== null) {
                        applyHistoryInputText(next);
                        return true;
                    }
                }

                const canResumeRetainedSessionDown =
                    hasRetainedHistorySession()
                    && historyInputState.selection.end === historyInputState.text.length;
                if (event.key === 'ArrowDown' && (historyBrowsing || canResumeRetainedSessionDown)) {
                    const next = messageHistory.moveDown(historyInputState.text);
                    if (next !== null) {
                        applyHistoryInputText(next);
                        return true;
                    }
                }
            }

            // Handle Shift+Tab for permission mode switching
            if (
                event.key === 'Tab'
                && event.shiftKey
                && props.onPermissionModeChange
                && shouldRunComposerModeCycleShortcut(event, {
                    keyboardShortcutsV2Enabled,
                    keyboardSingleKeyShortcutsEnabled,
                    keyboardShortcutOverridesV1,
                    keyboardShortcutDisabledCommandIdsV1,
                    platformOS: Platform.OS,
                })
            ) {
                const modeOrder = permissionModeOrder;
                if (!modeOrder || modeOrder.length === 0) return false;
                const current = effectivePermissionPolicy.effectiveMode;
                const currentIndex = modeOrder.indexOf(current);
                const nextIndex = (currentIndex + 1) % modeOrder.length;
                props.onPermissionModeChange(modeOrder[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }
        }
        return false; // Key was not handled
    }, [handleCommandMenuKey, props.hasSendableAttachments, props.canSendNextQueued, props.alternateSendMode, onSendProp, handleSend, props.onPermissionModeChange, keyboardShortcutsV2Enabled, keyboardSingleKeyShortcutsEnabled, keyboardShortcutOverridesV1, keyboardShortcutDisabledCommandIdsV1, permissionModeOrder, effectivePermissionPolicy.effectiveMode, messageHistory, props.messageHistory, applyHistoryInputText, sendActionDisabled, isHistoryBrowsing, hasRetainedHistorySession, enterToSendEnabled, submitEnabled, canStopFromComposer, isAborting, runAbortShortcutAction]);

    const handleSubmitEditing = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        if (!enterToSendEnabled) return;
        if (sendActionDisabled) return;
        const hasSendableInput = resolveLiveInputTextStatus(inputRef.current?.getText?.() ?? inputStateRef.current.text).hasText || props.hasSendableAttachments === true;
        if (!hasSendableInput) return;
        handleSend();
    }, [enterToSendEnabled, handleSend, props.hasSendableAttachments, sendActionDisabled]);

    const submitBehavior = React.useMemo<MultiTextInputSubmitBehavior | undefined>(() => {
        if (Platform.OS === 'web') return undefined;
        return enterToSendEnabled ? 'submit' : 'newline';
    }, [enterToSendEnabled]);

    const renderVariableContentBeforeInput = () => {
        if (!hasVariableContentBeforeInput) return null;

        const attachmentsRow = (
            <AgentInputAttachmentsRow
                items={attachmentRowItems}
                onRequestComposerFocus={requestComposerFocus}
            />
        );

        if (Platform.OS !== 'web') {
            return (
                <ScrollView
                    testID="agent-input-native-attachment-viewport"
                    style={[
                        styles.nativeKeyboardVariableSection,
                        typeof panelVariableSectionMaxHeight === 'number'
                            ? { maxHeight: panelVariableSectionMaxHeight }
                            : null,
                    ]}
                    contentContainerStyle={styles.nativeKeyboardVariableSectionContent}
                    keyboardShouldPersistTaps="handled"
                    alwaysBounceVertical={false}
                    onLayout={handleNativeAttachmentViewportLayout}
                    onScroll={handleNativeAttachmentViewportScroll}
                    scrollEventThrottle={16}
                >
                    {composerPresentationFeedback}
                    <AgentInputAttachmentsRow
                        items={attachmentRowItems}
                        verticalViewport={nativeAttachmentViewport}
                        onLayout={handleNativeAttachmentRowLayout}
                        onRequestComposerFocus={requestComposerFocus}
                    />
                </ScrollView>
            );
        }

        return (
            <View
                testID="agent-input-variable-content-before-input"
                onLayout={(event) => {
                    updateLayoutHeight(setVariableContentBeforeInputHeightPx, event.nativeEvent.layout.height);
                }}
            >
                {composerPresentationFeedback}
                <WebDropTargetView {...trayDropZoneHandlers} testID="agent-input-attachment-drop-target">{attachmentsRow}</WebDropTargetView>
            </View>
        );
    };

    const overlayLayer = (
        <AgentInputOverlayLayer
            overlayAnchorRef={overlayAnchorRef}
            screenWidth={screenWidth}
            showPermissionPopover={showPermissionPopover && Boolean(props.onPermissionModeChange)}
            permissionChipAnchorRef={permissionChipAnchorRef}
            onPermissionPopoverRequestClose={closePermissionPopover}
            onPermissionSelect={handlePermissionSelect}
            agentId={armedComposerTarget?.agentId ?? sessionAgentId}
            permissionModeOptions={permissionModeOptions}
            effectivePermissionMode={effectivePermissionPolicy.effectiveMode}
            effectivePermissionLabel={effectivePermissionLabel}
            effectivePermissionPolicy={effectivePermissionPolicy}
            styles={styles}
            showActionMenu={showActionMenu}
            hasActionMenuPopoverSections={hasActionMenuPopoverSections}
            actionMenuAnchorRef={actionMenuAnchorRef}
            onActionMenuRequestClose={closeActionMenu}
            onCustomizeComposer={canCustomizeComposer ? handleCustomizeComposer : undefined}
            actionMenuActions={actionMenuActions}
            maxWidthCap={layout.maxWidth}
            showAgentPicker={showAgentPicker}
            hasAgentPickerOptions={hasAgentPickerOptions}
            agentPickerAnchor={agentPickerAnchor}
            agentChipAnchorRef={agentChipAnchorRef}
            agentPickerTitle={props.agentPickerTitle ?? ''}
            agentPickerOptions={agentPickerOptions}
            effectiveAgentPickerSelectedOptionId={effectiveAgentPickerSelectedOptionId}
            onAgentPickerSelect={props.onAgentPickerSelect}
            onAgentPickerRequestClose={closeAgentPicker}
            agentPickerApplyLabel={props.agentPickerApplyLabel}
            showSessionModePicker={showSessionModePicker}
            shouldRenderSessionModeChip={shouldRenderSessionModeChip}
            sessionModePickerAnchor={sessionModePickerAnchor}
            sessionModeChipAnchorRef={sessionModeChipAnchorRef}
            sessionModePickerOptions={sessionModePickerOptions}
            sessionModeSelectedOptionId={sessionModeChipControl?.selectedId ?? null}
            onSessionModeSelect={(selectedId) => {
                props.onAcpSessionModeChange?.(selectedId);
                closeSessionModePicker();
            }}
            onSessionModeRequestClose={closeSessionModePicker}
            activeExtraCollapsedPopoverChip={activeExtraCollapsedPopoverChip}
            activeExtraCollapsedPopoverAnchor={activeExtraCollapsedPopoverAnchor}
            extraChipAnchorRefsByKey={extraChipAnchorRefsByKey}
            onActiveExtraCollapsedPopoverChipClose={closeActiveExtraCollapsedPopoverChip}
            showMachinePopover={showMachinePopover}
            machinePopoverAnchor={machinePopoverAnchor}
            machineChipAnchorRef={machineChipAnchorRef}
            machinePopover={props.machinePopover}
            onMachinePopoverRequestClose={closeMachinePopover}
            showProfilePopover={showProfilePopover}
            profilePopoverAnchor={profilePopoverAnchor}
            profileChipAnchorRef={profileChipAnchorRef}
            profilePopover={props.profilePopover}
            onProfilePopoverRequestClose={closeProfilePopover}
            showPathPopover={showPathPopover}
            pathPopoverAnchor={pathPopoverAnchor}
            pathChipAnchorRef={pathChipAnchorRef}
            pathPopover={props.pathPopover}
            onPathPopoverRequestClose={closePathPopover}
            showResumePopover={showResumePopover}
            resumePopoverAnchor={resumePopoverAnchor}
            resumeChipAnchorRef={resumeChipAnchorRef}
            resumePopover={props.resumePopover}
            onResumePopoverRequestClose={closeResumePopover}
            showEnvVarsPopover={showEnvVarsPopover}
            envVarsPopoverAnchor={envVarsPopoverAnchor}
            envVarsChipAnchorRef={envVarsChipAnchorRef}
            envVarsPopover={props.envVarsPopover}
            onEnvVarsPopoverRequestClose={closeEnvVarsPopover}
        />
    );

    if (readOnly) {
        // The document owner has already placed and admitted these exact ranges.
        // Reading never searches the live catalog or rebinds a frozen reference.
        const references = composerReferencesFromStructuredMentions({
            text: props.value,
            mentions: structuredInputMentions,
        });
        return (
            <SessionModelSourceBrowseHandoffContext.Provider value={modelSourceBrowseHandoff}>
            <AgentInputPopoverClearanceContext.Provider value={documentPanel ? undefined : stageSpotlightRef}>
            <AgentInputPopoverColumnContext.Provider value={overlayAnchorRef}>
            <AgentInputDocumentPanelContext.Provider value={documentPanel}>
            <TextSelectabilityScope selectable>
                <View ref={overlayAnchorRef} testID="agent-input-composer" style={[styles.container, documentPanel ? styles.containerDocument : null, { paddingHorizontal: props.contentPaddingHorizontal ?? 0 }]}>
                    <GlassSurface testID="agent-input-material-surface" {...panelMaterialProps} style={[styles.unifiedPanel, props.panelStyle, styles.readOnlyPanel]}>
                        {composerPresentationFeedback}
                        <AgentInputAttachmentsRow items={attachmentRowItems} />
                        <View style={[styles.inputContainer, styles.readOnlyInputContent, documentPanel ? styles.readOnlyDocumentContent : null]}>
                            {/* A reading document's card is calm: about three lines, then More (DESIGN-4 M4). */}
                            <AgentInputReadOnlyText value={props.value} accessibilityLabel={props.inputAccessibilityLabel} clamp={documentPanel}
                                style={[isConversation ? styles.sessionInputText : styles.newSessionInputText, styles.readOnlyText]} />
                            {references.map((reference) => (
                                <Text key={`${reference.start}:${reference.ref}`} selectable style={styles.readOnlyReferenceText}>{reference.label ?? reference.token}</Text>
                            ))}
                        </View>
                        {renderedActionControlNodes.length > 0 || secondaryLeadingControlsForWrap.length > 0 || secondaryTrailingControlsForWrap.length > 0 ? (
                            <AgentInputReadOnlyChipRow testID="agent-input-read-only-chips"
                                engine={renderedActionControlNodes}
                                chips={[...secondaryLeadingControlsForWrap, ...secondaryTrailingControlsForWrap]} />
                        ) : null}
                    </GlassSurface>
                </View>
            </TextSelectabilityScope>
            {overlayLayer}
            </AgentInputDocumentPanelContext.Provider>
            </AgentInputPopoverColumnContext.Provider>
            </AgentInputPopoverClearanceContext.Provider>
            </SessionModelSourceBrowseHandoffContext.Provider>
        );
    }

    return (
        <SessionModelSourceBrowseHandoffContext.Provider value={modelSourceBrowseHandoff}>
        <AgentInputPopoverClearanceContext.Provider value={documentPanel ? undefined : stageSpotlightRef}>
        <AgentInputPopoverColumnContext.Provider value={overlayAnchorRef}>
        <AgentInputDocumentPanelContext.Provider value={documentPanel}>
        <SyncPerformanceReactProfiler id="sessions.agentInput">
            <View
                testID="agent-input-composer"
                ref={stageSpotlightRef}
                // Measured by the composer's pickers (their clearance) and by the stage spotlight.
                collapsable={false}
                onLayout={stageSpotlightProps.onLayout}
                pointerEvents={Platform.OS === 'web' ? 'auto' : undefined}
                style={[
                    styles.container,
                    documentPanel ? styles.containerDocument : null,
                    stageSpotlightProps.style,
                    { paddingHorizontal: column.paddingHorizontal },
                ]}
            >
            <View style={[
                styles.innerContainer,
                ...(column.maxWidth === undefined ? [] : [{ maxWidth: column.maxWidth }]),
            ]} ref={overlayAnchorRef}>
                {overlayLayer}
                <AgentInputCommandMenu
                    open={commandMenuOpen && !promptPicker.isOpen}
                    anchor={commandMenuAnchor}
                    query={commandMenuQuery}
                    items={commandMenuItems}
                    selectedIndex={commandMenuSelectedIndex}
                    onMoveUp={commandMenuMoveUp}
                    onMoveDown={commandMenuMoveDown}
                    onSelect={(_item, index) => commandMenuOnSelectIndex(index)}
                    onRequestClose={commandMenuOnClose}
                    maxHeight={referencePickerFooter ? REFERENCE_PICKER_HEIGHT_PX : 240}
                    {...(compactCommandMenu ? { matchAnchorWidth: true, maxWidth: screenWidth } : {})}
                    {...(referencePickerFooter ? { footer: referencePickerFooter, fillHeight: true } : {})}
                    {...(referencePickerHeader ? { header: referencePickerHeader } : {})}
                    emptyState={referencePickerEmptyState}
                    testID={AGENT_INPUT_COMMAND_MENU_TEST_ID}
                />
                {promptPicker.isOpen ? (
                    <AgentInputPromptPicker
                        // The picker spans the composer card edge to edge (Prompts lab R1), as the compact menu does.
                        anchor={{ kind: 'view', ref: composerCardRef }}
                        serverId={props.sessionAddress?.serverId ?? props.sessionTypingPresence?.serverId ?? getAppliedActiveServerSnapshot().serverId}
                        sessionId={props.sessionId ?? null}
                        canSend={submitEnabled && !sendActionDisabled}
                        onRequestClose={promptPicker.close}
                        onApply={promptPicker.apply}
                    />
                ) : null}

                {/* Session instrument strip: connection status + context gauge, quota ring,
                    git ±, extension badges, permission chip. Subscribes to the store itself
                    (F-UI-11) so token ticks never re-render this memoized composer. */}
                <SessionInstrumentStrip
                    serverId={props.sessionTypingPresence?.serverId}
                    sessionId={props.sessionId}
                    agentId={sessionAgentId}
                    agentTargetKey={props.agentTargetKey}
                    metadata={props.metadata ?? null}
                    sessionActive={props.sessionActive}
                    currentRunnerProcessIdentity={props.currentRunnerProcessIdentity}
                    connectionStatus={instrumentStripConnectionStatus}
                    permission={props.showStatusPermissionMode === false || hasPermissionControl ? null : instrumentStripPermission}
                    quota={props.instrumentQuota ?? null}
                    statusBadges={props.statusBadges}
                    statusRegions={props.statusRegions}
                    statusTrailingActions={props.statusTrailingActions}
                    activeStatusBadgeKey={props.activeStatusBadgeKey}
                    onActiveStatusBadgeKeyChange={props.onActiveStatusBadgeKeyChange}
                    onGitPress={props.onFileViewerPress}
                    // A compact composer has no Session to report on: an empty strip reserves no row above it.
                    collapseWhenEmpty={documentPanel || compactControls}
                />

                {/* Box 2: Action Area (Input + Send) */}
                <WebDropTargetView
                    ref={composerEntityDropRef}
                    style={[styles.panelShadow, isGlassComposer ? styles.panelShadowGlass : null]}
                    onLayout={(event) => {
                        updateNullableLayoutHeight(setPanelHeightPx, event.nativeEvent.layout.height);
                        measureComposerDrop();
                    }}
                    onDragEnter={composerDropZoneHandlers.onDragEnter}
                    onDragLeave={composerDropZoneHandlers.onDragLeave}
                    onDragOver={composerDropZoneHandlers.onDragOver}
                    onDrop={composerDropZoneHandlers.onDrop}
                >
                <GlassSurface
                    ref={composerCardRef}
                    testID="agent-input-material-surface"
                    {...panelMaterialProps}
                    style={[
                        styles.unifiedPanel,
                        isGlassComposer ? styles.unifiedPanelGlass : null,
                        documentPanel ? styles.documentPanel : null,
                        props.panelStyle,
                        typeof hostPanelMaxHeight === 'number' ? { maxHeight: hostPanelMaxHeight } : null,
                    ]}
                >
                    {fileDragActive && typeof props.onAttachmentsAdded === 'function' ? (
                        <ExternalFileDropOutcomePill testID="agent-input-drop-overlay"
                            outcome={{ glyph: 'attach', tone: 'allowed', ...describeComposerFileDropOutcome({
                                carried: readExternalFileDragItems(),
                                nextImageNumber: readAgentInputImageNumbers(attachmentRowItems).size + 1,
                                ...(props.attachmentDropHint ? { hint: props.attachmentDropHint } : {}),
                            }) }} />
                    ) : null}
                    {Platform.OS === 'web' ? (
                        <>
                            {fixedComposerAttentionRequestsNode}
                            {controlsOnly ? null : (
                            <ScrollView
                                style={[
                                    styles.nativeKeyboardVariableSection,
                                    styles.webVariableSectionEdgeToEdge,
                                    typeof panelVariableSectionMaxHeight === 'number'
                                        ? { maxHeight: panelVariableSectionMaxHeight }
                                        : null,
                                ]}
                                contentContainerStyle={[
                                    styles.nativeKeyboardVariableSectionContent,
                                    styles.webVariableSectionContentInset,
                                ]}
                                keyboardShouldPersistTaps="handled"
                                alwaysBounceVertical={false}
                            >
                                {renderVariableContentBeforeInput()}
                                <View
                                    ref={composerAnchorRef}
                                    collapsable={false}
                                    style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}
                                    onLayout={(event) => {
                                        updateNullableLayoutHeight(setInputContainerHeightPx, event.nativeEvent.layout.height);
                                    }}
                                >
                                    <SessionAuthoringComposer
                                        {...composerInputComboboxProps}
                                        ref={inputRef}
                                        composerRef={composerRef}
                                        testID={isConversation ? AGENT_INPUT_TEST_IDS.sessionInput : AGENT_INPUT_TEST_IDS.newSessionInput}
                                        textStyle={isConversation ? styles.sessionInputText : styles.newSessionInputText}
                                        value={props.value}
                                        paddingTop={Platform.OS === 'web' ? 10 : 8}
                                        references={editorReferences}
                                        attachmentIds={editorAttachmentIds}
                                        decorations={editorDecorations}
                                        onReferencesChange={handleEditorReferencesChange}
                                        paddingBottom={Platform.OS === 'web' ? 10 : 8}
                                        paddingRight={fieldInputPaddingRight}
                                        onChangeText={handleComposerTextChange}
                                        placeholder={props.placeholder}
                                        placeholderTextColor={theme.colors.composer.chipTint}
                                        accessibilityLabel={props.inputAccessibilityLabel}
                                        accessibilityHint={props.inputAccessibilityHint}
                                        onKeyPress={handleKeyPress}
                                        onStateChange={handleInputStateChange}
                                        initialScrollY={props.inputPersistence?.initialScrollY}
                                        scrollRestoreToken={props.inputPersistence?.restoreToken}
                                        onScrollYChange={props.inputPersistence?.onScrollYChange}
                                        onFocus={handleComposerFocus}
                                        onBlur={handleComposerBlur}
                                        submitBehavior={submitBehavior}
                                        onSubmitEditing={handleSubmitEditing}
                                        maxHeight={resolvedInputMaxHeight}
                                        editable={!props.disabled && !composerInputEditLocked}
                                        onFilesPasted={props.onAttachmentsAdded ? handleFilesPastedToComposer : undefined}
                                        onAttachmentsDropped={props.onAttachmentsAdded && dictationEditable && props.surfacePresented !== false ? handleNativeAttachmentsDropped : undefined}
                                        attachmentDropScope={attachmentIntakeScope}
                                        onContentHeightChange={handleInputContentHeightChange}
                                    />
                                    {props.inputExpansion && shouldShowInputExpansionToggle ? (
                                        <AgentInputExpansionToggle
                                            expanded={props.inputExpansion.expanded}
                                            onToggle={props.inputExpansion.onToggle}
                                        />
                                    ) : null}
                                    <AgentInputFieldAccessories showLibrary={showPromptLibraryButton} onOpenLibrary={openPromptPicker} libraryOpen={promptPicker.isOpen}
                                        accessory={fieldAccessory} orderedIds={resolvedControls.accessories} belowToggle={shouldShowInputExpansionToggle} />
                                </View>
                            </ScrollView>
                            )}
                            <View
                                style={styles.nativeKeyboardFooterSection}
                                onLayout={(event) => {
                                    updateLayoutHeight(setActionFooterHeightPx, event.nativeEvent.layout.height);
                                }}
                            >
                                <View style={styles.actionButtonsContainer}>
                                <View
                                    style={[
                                        screenWidth < 420 ? styles.actionButtonsColumnNarrow : styles.actionButtonsColumn,
                                        isMobileLayoutWidth(screenWidth) ? styles.actionButtonsColumnMobile : null,
                                    ]}
                                >{[
                                    <View
                                        key="row1"
                                        style={[styles.actionButtonsRow, showSecondaryControlsRow ? styles.actionButtonsRowWithBelow : null]}
                                    >
                                        {actionBarShouldScroll ? (
                                            <AgentInputScrollableChipRow
                                                containerStyle={styles.actionButtonsLeftScroll}
                                                contentStyle={styles.actionButtonsLeftScrollContent}
                                                fadeColor={actionBarFadeColor}
                            indicatorColor={theme.colors.composer.chipTint}
                                                fadeLeftStyle={styles.actionButtonsFadeLeft}
                                                fadeRightStyle={styles.actionButtonsFadeRight}
                                            >
                                                <AgentInputChipRowReach reach={upperChipRowReach}>{renderedActionControlNodes as any}</AgentInputChipRowReach>
                                            </AgentInputScrollableChipRow>
                                        ) : (
                                            <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                                                <AgentInputChipRowReach reach={upperChipRowReach}>{renderedActionControlNodes as any}</AgentInputChipRowReach>
                                            </View>
                                        )}
                                    </View>,
                                    (showSecondaryControlsRow) ? (
                                        actionBarShouldScroll ? (
                                            <AgentInputScrollableChipRow
                                                key="row2"
                                                containerStyle={styles.actionButtonsLeftScroll}
                                                contentStyle={styles.actionButtonsScrollViewportContent}
                                                fadeColor={actionBarFadeColor}
                            indicatorColor={theme.colors.composer.chipTint}
                                                fadeLeftStyle={styles.actionButtonsFadeLeft}
                                                fadeRightStyle={styles.actionButtonsFadeRight}
                                            >
<PathAndResumeRow
                                                    styles={{
                                                        pathRow: styles.pathRow,
                                                        actionButtonsLeft: styles.actionButtonsLeftScrollInline,
                                                    }}
                                                    fillAvailableWidth={false}
                                                    leadingControls={secondaryLeadingControlsForWrap}
                                                    trailingControls={secondaryTrailingControlsForWrap}
                                                />
                                            </AgentInputScrollableChipRow>
                                        ) : (
<PathAndResumeRow
                                                key="row2"
                                                styles={{
                                                    pathRow: styles.pathRow,
                                                    actionButtonsLeft: styles.actionButtonsLeft,
                                                }}
                                                leadingControls={secondaryLeadingControlsForWrap}
                                                trailingControls={secondaryTrailingControlsForWrap}
                                            />
                                        )
                                    ) : null,
                                ]}</View>
                                <View
                                    style={[
                                        styles.trailingAccessoryInline,
                                    ]}
                                >
                                    {trailingAccessory}
                                    {/* Authoring-only composers keep dictation but offer no send or stop; controls-only has neither. */}
                                    {!controlsOnly && (submitEnabled || dictationPressHandler) ? (
                                        <AgentInputSubmitButton
                                            testID={isConversation ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                                            sessionId={props.sessionId}
                                            submitAccessibilityLabel={submitAccessibilityLabel}
                                            disabled={submitDictationActive
                                                ? dictationStatus === 'transcribing'
                                                : Boolean(props.disabled || props.isSendDisabled || props.isSending || composerInputSubmitLocked || (!(submitEnabled && hasSendableContent) && !dictationPressHandler && !(submitEnabled && canStopFromComposer)))}
                                            isSending={props.isSending}
                                            isStopping={isAborting}
                                            hasSendableContent={submitEnabled && hasSendableContent}
                                            canStop={submitEnabled && canStopFromComposer}
                                            hasDedicatedStopControl={Boolean(props.onAbort) && Boolean(props.showAbortButton)}
                                            dictationPressHandler={dictationPressHandler}
            dictationAvailable={dictation.available}
                                            dictationStatus={dictationStatus}
                                            armedContinuationTarget={props.armedContinuationTarget ?? null}
                                            armedRouteContinuation={props.armedRouteContinuation ?? null}
                                            onUnarmRoute={props.onUnarmRoute ?? null}
                                            unarmRoutePending={props.unarmRoutePending === true}
                                            armedContinuationIdentityMark={armedContinuationIdentityMark}
                                            onSend={handleSend}
                                            sendMenuModes={props.sendMenuModes}
                                            sendMenuShortcuts={sendMenuShortcuts}
                                            onStop={handleAbortPress}
                                        />
                                    ) : null}
                                </View>
                                </View>
                            </View>
                        </>
                    ) : (
                        <View style={styles.nativeKeyboardPanelContent}>
                            {fixedComposerAttentionRequestsNode}
                            {controlsOnly ? null : (
                            <View
                                style={[
                                    styles.nativeKeyboardVariableSection,
                                    styles.nativeKeyboardVariableSectionContent,
                                    typeof panelVariableSectionMaxHeight === 'number'
                                        ? { maxHeight: panelVariableSectionMaxHeight }
                                        : null,
                                ]}
                            >
                                {renderVariableContentBeforeInput()}
                                <View
                                    ref={composerAnchorRef}
                                    collapsable={false}
                                    style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}
                                    onLayout={(event) => {
                                        updateNullableLayoutHeight(setInputContainerHeightPx, event.nativeEvent.layout.height);
                                    }}
                                >
                                    <SessionAuthoringComposer
                                        {...composerInputComboboxProps}
                                        ref={inputRef}
                                        composerRef={composerRef}
                                        testID={isConversation ? AGENT_INPUT_TEST_IDS.sessionInput : AGENT_INPUT_TEST_IDS.newSessionInput}
                                        textStyle={isConversation ? styles.sessionInputText : styles.newSessionInputText}
                                        value={props.value}
                                        paddingTop={8}
                                        references={editorReferences}
                                        attachmentIds={editorAttachmentIds}
                                        decorations={editorDecorations}
                                        onReferencesChange={handleEditorReferencesChange}
                                        paddingBottom={8}
                                        paddingRight={fieldInputPaddingRight}
                                        onChangeText={handleComposerTextChange}
                                        placeholder={props.placeholder}
                                        placeholderTextColor={theme.colors.composer.chipTint}
                                        accessibilityLabel={props.inputAccessibilityLabel}
                                        accessibilityHint={props.inputAccessibilityHint}
                                        onKeyPress={handleKeyPress}
                                        onStateChange={handleInputStateChange}
                                        initialScrollY={props.inputPersistence?.initialScrollY}
                                        scrollRestoreToken={props.inputPersistence?.restoreToken}
                                        onScrollYChange={props.inputPersistence?.onScrollYChange}
                                        onFocus={handleComposerFocus}
                                        onBlur={handleComposerBlur}
                                        submitBehavior={submitBehavior}
                                        onSubmitEditing={handleSubmitEditing}
                                        maxHeight={resolvedInputMaxHeight}
                                        editable={!props.disabled && !composerInputEditLocked}
                                        onFilesPasted={props.onAttachmentsAdded ? handleFilesPastedToComposer : undefined}
                                        onAttachmentsDropped={props.onAttachmentsAdded && dictationEditable && props.surfacePresented !== false ? handleNativeAttachmentsDropped : undefined}
                                        attachmentDropScope={attachmentIntakeScope}
                                        onContentHeightChange={handleInputContentHeightChange}
                                    />
                                    {props.inputExpansion && shouldShowInputExpansionToggle ? (
                                        <AgentInputExpansionToggle
                                            expanded={props.inputExpansion.expanded}
                                            onToggle={props.inputExpansion.onToggle}
                                        />
                                    ) : null}
                                    <AgentInputFieldAccessories showLibrary={showPromptLibraryButton} onOpenLibrary={openPromptPicker} libraryOpen={promptPicker.isOpen}
                                        accessory={fieldAccessory} orderedIds={resolvedControls.accessories} belowToggle={shouldShowInputExpansionToggle} />
                                </View>
                            </View>
                            )}
                            <View
                                style={styles.nativeKeyboardFooterSection}
                                onLayout={(event) => {
                                    updateLayoutHeight(setActionFooterHeightPx, event.nativeEvent.layout.height);
                                }}
                            >
                                <View style={styles.actionButtonsContainer}>
                                    <View
                                        style={[
                                            screenWidth < 420 ? styles.actionButtonsColumnNarrow : styles.actionButtonsColumn,
                                            isMobileLayoutWidth(screenWidth) ? styles.actionButtonsColumnMobile : null,
                                        ]}
                                    >{[
                                        <View
                                            key="row1"
                                            style={[styles.actionButtonsRow, showSecondaryControlsRow ? styles.actionButtonsRowWithBelow : null]}
                                        >
                                            {actionBarShouldScroll ? (
                                                <AgentInputScrollableChipRow
                                                    containerStyle={styles.actionButtonsLeftScroll}
                                                    contentStyle={styles.actionButtonsLeftScrollContent}
                                                    fadeColor={actionBarFadeColor}
                                                    indicatorColor={theme.colors.button.secondary.tint}
                                                    fadeLeftStyle={styles.actionButtonsFadeLeft}
                                                    fadeRightStyle={styles.actionButtonsFadeRight}
                                                >
                                                    <AgentInputChipRowReach reach={upperChipRowReach}>{renderedActionControlNodes as any}</AgentInputChipRowReach>
                                                </AgentInputScrollableChipRow>
                                            ) : (
                                                <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                                                    <AgentInputChipRowReach reach={upperChipRowReach}>{renderedActionControlNodes as any}</AgentInputChipRowReach>
                                                </View>
                                            )}
                                        </View>,
                                        (showSecondaryControlsRow) ? (
                                            actionBarShouldScroll ? (
                                                <AgentInputScrollableChipRow
                                                    key="row2"
                                                    containerStyle={styles.actionButtonsLeftScroll}
                                                    contentStyle={styles.actionButtonsScrollViewportContent}
                                                    fadeColor={actionBarFadeColor}
                                                    indicatorColor={theme.colors.button.secondary.tint}
                                                    fadeLeftStyle={styles.actionButtonsFadeLeft}
                                                    fadeRightStyle={styles.actionButtonsFadeRight}
                                                >
<PathAndResumeRow
                                                        styles={{
                                                            pathRow: styles.pathRow,
                                                            actionButtonsLeft: styles.actionButtonsLeftScrollInline,
                                                        }}
                                                        fillAvailableWidth={false}
                                                        leadingControls={secondaryLeadingControlsForWrap}
                                                        trailingControls={secondaryTrailingControlsForWrap}
                                                    />
                                                </AgentInputScrollableChipRow>
                                            ) : (
<PathAndResumeRow
                                                    key="row2"
                                                    styles={{
                                                        pathRow: styles.pathRow,
                                                        actionButtonsLeft: styles.actionButtonsLeft,
                                                    }}
                                                    leadingControls={secondaryLeadingControlsForWrap}
                                                    trailingControls={secondaryTrailingControlsForWrap}
                                                />
                                            )
                                        ) : null,
                                    ]}</View>
                                    <View
                                        style={[
                                            styles.trailingAccessoryInline,
                                        ]}
                                    >
                                        {trailingAccessory}
                                        {/* Authoring-only composers keep dictation but offer no send or stop; controls-only has neither. */}
                                        {!controlsOnly && (submitEnabled || dictationPressHandler) ? (
                                            <AgentInputSubmitButton
                                                testID={isConversation ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                                                sessionId={props.sessionId}
                                                submitAccessibilityLabel={submitAccessibilityLabel}
                                                disabled={submitDictationActive
                                                    ? dictationStatus === 'transcribing'
                                                    : Boolean(props.disabled || props.isSendDisabled || props.isSending || composerInputSubmitLocked || (!(submitEnabled && hasSendableContent) && !dictationPressHandler && !(submitEnabled && canStopFromComposer)))}
                                                isSending={props.isSending}
                                                isStopping={isAborting}
                                                hasSendableContent={submitEnabled && hasSendableContent}
                                                canStop={submitEnabled && canStopFromComposer}
                                                hasDedicatedStopControl={Boolean(props.onAbort) && Boolean(props.showAbortButton)}
                                                dictationPressHandler={dictationPressHandler}
            dictationAvailable={dictation.available}
                                                dictationStatus={dictationStatus}
                                                armedContinuationTarget={props.armedContinuationTarget ?? null}
                                                armedRouteContinuation={props.armedRouteContinuation ?? null}
                                            onUnarmRoute={props.onUnarmRoute ?? null}
                                            unarmRoutePending={props.unarmRoutePending === true}
                                                armedContinuationIdentityMark={armedContinuationIdentityMark}
                                                onSend={handleSend}
                                            sendMenuModes={props.sendMenuModes}
                                            sendMenuShortcuts={sendMenuShortcuts}
                                                onStop={handleAbortPress}
                                            />
                                        ) : null}
                                    </View>
                                </View>
                            </View>
                        </View>
                    )}
                </GlassSurface>
                {/* After the panel, so its drop outline paints over the panel's own fill (it is the target's one visible mark). */}
                {composerRef && composerDropScope ? <ComposerEntityDropTarget
                    id={composerDropTargetId} scope={composerDropScope} refValue={composerRef}
                    bounds={composerDropBounds} clearBounds={composerBlockBounds} presented={props.surfacePresented !== false}
                    editable={dictationEditable && !controlsOnly} kinds={props.autocompleteKinds}
                    inputRef={inputRef} externalFilesActive={fileDragActive}
                    referenceHost={props.composerReferenceHost} fileScope={props.composerFileScope}
                    /> : null}
                </WebDropTargetView>
            </View>
            </View>
        </SyncPerformanceReactProfiler>
        </AgentInputDocumentPanelContext.Provider>
        </AgentInputPopoverColumnContext.Provider>
        </AgentInputPopoverClearanceContext.Provider>
        </SessionModelSourceBrowseHandoffContext.Provider>
    );
}));
