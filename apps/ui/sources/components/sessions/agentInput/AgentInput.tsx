import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { reportSessionTypingEdit, stopSessionTyping } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import * as React from 'react';
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
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { STAGE_SPOTLIGHT_TARGET_IDS } from '@/components/onboarding/tour/stage/stageSpotlightTargetIds';
import {
    useSpotlightTarget,
} from '@/components/onboarding/tour/stage/useSpotlightTarget';
import { useComposerKeyboardLayoutContext } from '@/components/sessions/keyboardAvoidance';
import {
    KeyPressEvent,
    type MultiTextInputSubmitBehavior,
} from '@/components/ui/forms/MultiTextInput';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';
import { composerReferencesFromStructuredMentions } from '@/components/sessions/composer/composerScopeAdapters';
import { Typography } from '@/constants/Typography';
import type {
    PermissionMode,
    ModelMode,
} from '@/sync/domains/permissions/permissionTypes';
import type { ModelOption } from '@/sync/domains/models/modelOptions';
import {
    EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID,
    resolveExtendedContextModelIdForToggle,
} from '@/sync/domains/models/extendedContextModelControl';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { ReportedModelStatusIcon } from '@/components/sessions/modelPicker/reportedModelPresentation';
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
    type ActiveSuggestionsHandler,
} from '@/components/autocomplete/useActiveSuggestions';
import { resolveComposerSuggestionKind } from '@/components/autocomplete/composerSuggestionKinds';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionGrammar';
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
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
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
import { resolveAgentInputFolderChipState, type AgentInputFolderChipState } from './definitions/AgentInputFolderChip';
import {
    getHasAnyAgentInputActions,
    shouldShowSecondaryControlRow,
    type AgentInputActionBarLayout,
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
    computeAgentInputDefaultMaxHeight,
    computeAgentInputKeyboardOpenVariableSectionMaxHeight,
    computeMeasuredPanelInputMaxHeight,
    resolveAgentInputHostPanelMaxHeight,
    type AgentInputPanelMaxHeightMode,
} from './inputMaxHeight';
import { shouldRenderPermissionChip } from './permissionChipVisibility';
import { type AgentInputContentPopoverConfig } from './components/AgentInputContentPopover';
import { AgentInputEngineDetail } from './components/AgentInputEngineDetail';
import { SessionModelRoutingHint } from '@/components/sessions/modelPicker/SessionModelRoutingHint';
import { SessionModelSourceBrowseHandoffContext, type SessionModelSourceBrowseHandoff } from '@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff';
import {
    SessionInstrumentStrip,
    type SessionInstrumentStripPermission,
    type SessionInstrumentStripQuota,
} from './instrumentStrip';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { AgentInputAttachmentsRow } from './components/AgentInputAttachmentsRow';
import { AgentInputReadOnlyText } from './components/AgentInputReadOnlyText';
import { AgentInputOverlayLayer } from './components/AgentInputOverlayLayer';
import { AgentInputExpansionToggle } from './components/AgentInputExpansionToggle';
import { AgentInputPermissionRequests } from './components/AgentInputPermissionRequests';
import { useOptionalSessionTranscriptSource, useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { resolveArmedComposerContinuation } from './components/agentContinuationSubmitPresentation';
import { AgentInputSubmitButton } from './components/AgentInputSubmitButton';
import { useAgentInputActionMenuControls } from './controls/useAgentInputActionMenuControls';
import { useAgentInputCoreControlHandlers } from './controls/useAgentInputCoreControlHandlers';
import { useRenderedAgentInputControlRows } from './controls/useRenderedAgentInputControlRows';
import type { AgentInputControlId } from './controls/agentInputControlTypes';
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
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
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
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import type { WebFileDragEvent } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { useEntityDragDropRuntime, useEntityDropDomBinding, readWindowBounds, measureWindowBounds,
    type TreeDropMeasurableRef, type WindowBounds } from '@/components/ui/treeDragDrop';
import { ExternalFileDropOutcomePill } from '@/components/ui/treeDragDrop/ui/ExternalFileDropOutcomePill';
import { ComposerEntityDropTarget } from '@/components/sessions/composer/ComposerEntityDropTarget';
import type { ComposerReferenceSearchHost } from '@/components/autocomplete/composerSuggestionKinds';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import type {
    AgentInputAttachmentsRowItem,
    AgentInputComposerDecoration,
    AgentInputComposerInputLock,
    AgentInputExtraActionChip,
    AgentInputStatusBadge as AgentInputStatusBadgeDescriptor,
} from './agentInputContracts';
import { projectAgentInputAttachmentRowItems } from './agentInputContracts';
import type { AgentInputSendIntentOptions, AgentInputSendOptions } from './agentInputSendOptions';
import type { AgentInputChipPickerOption } from './components/AgentInputChipPickerTypes';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { insertTextAtSelection } from './insertTextAtSelection';
import { AgentInputDictationButton } from './components/AgentInputDictationButton';
import { subscribeToIosHardwareShiftEnter } from './subscribeToIosHardwareShiftEnter';
import {
    COMPOSER_ABORT_CONFIRMATION_WINDOW_MS,
    resolveComposerEnterAction,
    resolveComposerEscapeAction,
    resolveComposerSendShortcutAction,
    shouldRunComposerModeCycleShortcut,
} from '@/keyboard/composer';
import { useKeyboardShortcutHandlers, type KeyboardShortcutHandlers } from '@/keyboard';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import type { PromptInvocationSuggestionMetadata } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type {
    PluginContributedActionDescriptor,
    PluginContributedActionOpenOutcome,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    buildStructuredInputMetaOverrides,
    createStructuredInputMentionFromSuggestion,
    reconcileStructuredInputMentionsWithText,
    reconcileStructuredInputMentionsWithTextChange,
    type ComposerStructuredInputMention,
} from './structuredInputMentions';
import {
    INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT,
    normalizeAgentInputExpansionCollapsedMaxHeight,
    resolveAgentInputExpansionToggleVisible,
    shouldReserveAgentInputExpansionToggleSpace,
} from './inputExpansionToggleVisibility';
import { AgentInputCommandMenu } from './commandMenu/AgentInputCommandMenu';
import { AgentInputFieldAccessories, resolveAgentInputFieldAccessoryGeometry } from './components/AgentInputFieldAccessories';
import { AgentInputPromptPicker } from './commandMenu/AgentInputPromptPicker';
import { usePromptPickerController } from './commandMenu/usePromptPickerController';
import { useAgentInputCommandMenu } from './commandMenu/useAgentInputCommandMenu';
import { resolveAgentInputCommandMenuAnchor } from './commandMenu/resolveAgentInputCommandMenuAnchor';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { StyleProp } from 'react-native';
import {
    areActiveWordsEqual,
    areLiveInputTextStatusesEqual,
    resolveLiveInputTextStatus,
} from './liveInputState';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

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
    onPromptPickerOpenRequestChange?: (request: (() => boolean) | null) => void;
    onComposerInputFlushRequestChange?: (request: (() => void) | null) => void;
    /** Scope-local observer for this mounted input's resolved action-bar layout. */
    onComposerActionBarLayoutChange?: (layout: AgentInputActionBarLayout) => void;
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
    modelOptionsOverrideProbe?: OptionPickerProbeState;
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
    /**
     * `none` mounts no voice affordance or dictation, whatever the account enables (the embedded
     * presentation). `dictation` retains the microphone without mounting conversational Voice (a
     * Workflow step authors a document, not a live conversation), and places the prompt library and
     * microphone at the end of the chip row, where a document card keeps its tools (lab `editor-E1`),
     * rather than in the field's corner. Default `auto`.
     */
    voiceAffordance?: 'auto' | 'dictation' | 'none';
    /**
     * `none`: ArrowUp/ArrowDown never recall the person's agent prompts into this field (a human
     * discussion's composer, where those prompts are not what is being written). Default `auto`.
     */
    messageHistory?: 'auto' | 'none';
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
        /** The target is ready: a host that keeps healthy state quiet (Home) may omit the line. */
        healthy?: boolean;
        /** An unavailable launch target is repaired through the existing machine picker. */
        recovery?: 'machine';
    };
    /**
     * The action bar layout this host prefers while the person's setting is "auto" (their own
     * choice always wins). Home's column composer uses `collapsed`: one row of core chips with the
     * rest behind the actions menu.
     */
    autoActionBarLayout?: 'wrap' | 'scroll' | 'collapsed';
    /**
     * Collapsed layout: the controls this host keeps on the bar, in bar order; every other
     * control is reached from the actions menu. Home passes machine · folder · agent · permission ·
     * actions, the lab's one row.
     */
    barControlIds?: readonly AgentInputControlId[];
    /** The status row above the card takes no height while it has nothing to show (Home). */
    collapseEmptyStatusRow?: boolean;
    /**
     * `document`: the composer is one card in a document (a workflow step), not the floating
     * composer of a conversation. It draws the plain hairline card the read-only presentation
     * draws — no glass rim or cast shadow, whatever the composer style setting — with no outer
     * vertical padding and no reserved empty status row, so the document's own rhythm places it.
     * Default `composer`.
     */
    panelPresentation?: 'composer' | 'document';
    /** Run-review decisions use the same chip controls with a flat ink border. */
    chipPresentation?: 'quiet' | 'bordered';
    /**
     * Plan/quota usage bundle rendered by the instrument strip. Data path stays
     * System-B-owned (SessionView); the strip only restyles the trigger.
     */
    instrumentQuota?: SessionInstrumentStripQuota | null;
    statusBadges?: ReadonlyArray<AgentInputStatusBadgeDescriptor>;
    statusTrailingActions?: React.ReactNode;
    /** Hosts with an editable permission chip may omit the repeated instrument-strip label. */
    showStatusPermissionMode?: boolean;
    activeStatusBadgeKey?: string | null;
    onActiveStatusBadgeKeyChange?: (key: string | null) => void;
    /** Eligible suggestion kinds for this composer host. Trigger characters follow from the kinds (INV-1). */
    autocompleteKinds: readonly ComposerSuggestionKindId[];
    /** Receives an abort signal for the query it is resolving; a superseded query is never applied (D-15). */
    autocompleteSuggestions: ActiveSuggestionsHandler;
    /** Session composer host opens controller-admitted external slash Actions through the canonical Action path. */
    onContributedActionSuggestionSelect?: (
        action: PluginContributedActionDescriptor,
    ) => Promise<PluginContributedActionOpenOutcome> | PluginContributedActionOpenOutcome;
    onFileViewerPress?: () => void;
    agentType?: string;
    agentLabel?: string | null;
    /** A controlled authoring engine/Role label; live Sessions retain their own projection. */
    engineLabel?: string;
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
    onAttachmentsAdded?: (files: readonly File[]) => void;
    hasSendableAttachments?: boolean;
    permissionRequests?: ReadonlyArray<PendingPermissionRequest>;
    approvalRequests?: ReadonlyArray<OpenApprovalArtifactForSession>;
    canApprovePermissions?: boolean;
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
}

type AgentInputPermissionRequestsProps = React.ComponentProps<typeof AgentInputPermissionRequests>;

const EMPTY_PERMISSION_LOCATIONS_BY_ID: ReadonlyMap<string, PermissionToolCallMessageLocation | null> = new Map();
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
        const approvals = (props.approvalRequests ?? []).map((request) => ({
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
    container: {
        alignItems: 'center',
        width: '100%',
        paddingBottom: 8,
        paddingTop: 8,
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
    // The composer style changes its rim/shadow; the content material owns its fill.
    // Fully redefines the border so the
    // standard hairline + highlight don't leak through. The cast shadow lives on the
    // `panelShadow` wrapper (glass mode only).
    unifiedPanelGlass: {
        // Light: a touch thicker rim so the edge reads against the white surface.
        borderWidth: theme.dark ? 1.5 : 2,
        borderColor: theme.colors.glass.border,
        borderTopWidth: theme.dark ? 1.5 : 2,
        borderTopColor: theme.colors.glass.border,
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
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: AGENT_INPUT_CONTAINER_VERTICAL_PADDING,
        minHeight: 40,
    },
    readOnlyInputContent: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
        readOnlyText: {
            color: theme.colors.text.primary,
            textAlign: 'left',
        },
        /** The same hairline card in a document, editable or read-only. */
        documentPanel: resolveAgentInputPanelLayoutStyle(theme, true),
        readOnlyPanel: {
            ...resolveAgentInputPanelLayoutStyle(theme, true),
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
        paddingHorizontal: 8,
    },
    composerPresentationEffects: {
        gap: 4,
        paddingHorizontal: 8,
        paddingTop: 4,
    },
    composerInputLockFeedback: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.state.warning.border,
        backgroundColor: theme.colors.state.warning.background,
        paddingHorizontal: 8,
        paddingVertical: 5,
    },
    composerInputLockFeedbackText: {
        color: theme.colors.state.warning.foreground,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    composerDecorationFeedback: {
        alignSelf: 'flex-start',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 7,
        paddingVertical: 3,
    },
    composerDecorationFeedbackInteractive: {
        // An interactive decoration keeps the compact chip padding and reaches
        // the platform touch minimum through layout. A hit-slop floor would
        // expand each chip past the row gap and into its stacked neighbour.
        minWidth: resolveMinimumInteractiveTargetSize(Platform.OS),
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
        alignItems: 'center',
        justifyContent: 'center',
    },
    composerDecorationFeedbackText: {
        fontSize: 12,
        ...Typography.default(),
    },
    nativeKeyboardFooterSection: {
        flexShrink: 0,
    },

    // Overlay styles
    settingsOverlay: {
        // positioning is handled by `Popover`
    },
    overlaySection: {
        paddingVertical: 16,
    },
    overlaySectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
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
        paddingHorizontal: 16,
        paddingTop: 2,
        paddingBottom: 8,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
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
        marginRight: 12,
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
        paddingHorizontal: 16,
        paddingBottom: 4,
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
        fontSize: 11,
        ...Typography.default(),
    },
    statusDot: {
        marginRight: 6,
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: 11,
        ...Typography.default(),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        columnGap: 8,
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
     * Single row — the accessory sits *before* the submit, reading left-to-right
     * as "mode, then send". When the chips wrap to a second row the horizontal
     * budget is already spent, so the cluster stacks instead: submit on top,
     * accessory beneath it, against the taller column.
     *
     * `column-reverse` is what produces that stack from the same JSX order: the
     * first child lands at the bottom, so the accessory ends up under the submit
     * without reordering the tree. Reading order stays "accessory, then submit"
     * in both layouts, which is also the order a screen reader announces.
     */
    trailingAccessoryInline: {
        flexDirection: 'row',
        flexShrink: 0,
        alignItems: 'center',
        gap: 8,
    },
    trailingAccessoryStack: {
        flexDirection: 'column-reverse',
        flexShrink: 0,
        alignItems: 'center',
        // The visual rhythm remains 32pt. The Voice accessory's outer target can
        // be larger, so keep the column centered instead of assuming equal
        // control frames.
        gap: Platform.OS === 'web' ? WEB_ACTION_BAR_ROW_GAP_Y : NATIVE_ACTION_BAR_SECTION_GAP_Y,
    },
    trailingAccessoryStackMobile: {
        // Mirrors `actionButtonsColumnMobile`, which tightens that same rhythm.
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_MOBILE_Y } : {}),
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
        ...(Platform.OS === 'web' ? { columnGap: 6, rowGap: 1 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
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
        ...(Platform.OS === 'web' ? { columnGap: 6 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionButtonsLeftScrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        ...(Platform.OS === 'web' ? { columnGap: 6 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
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
        columnGap: 4,
    },
    actionButtonsLeftNoFlex: {
        flex: 0,
    },
    actionItemWrapper: {
        // Non-chip action items (e.g. SCM status) should align with chips on native.
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionChip: AGENT_INPUT_ACTION_CHIP_STYLE,
    actionChipBordered: {
        ...resolveThemeSurfaceBorderStyle({ borderColor: theme.colors.border.default }),
        borderRadius: theme.borderRadius.md,
    },
    actionChipText: resolveAgentInputActionChipTextStyle(theme),
    actionChipBorderedText: { ...resolveAgentInputActionChipTextStyle(theme), color: theme.colors.text.primary },
    actionChipCountText: {
        color: theme.colors.composer.chipTint,
    },
    overlayOptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    overlayOptionRowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    overlayRadioOuter: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    overlayRadioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    overlayRadioOuterUnselected: {
        borderColor: theme.colors.radio.inactive,
    },
    overlayRadioInner: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
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
        fontSize: 11,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    overlayEmptyText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
        ...Typography.default(),
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
        // Keep vertical alignment consistent with `actionChip` on native.
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
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
    const attentionRequestSessionId = props.sessionId ?? localSampleSource?.sessionId;
    const submitAccessibilityLabel = props.submitAccessibilityLabel ?? (isConversation ? t('common.send') : undefined);
    const readOnly = props.onChangeText === undefined;
    const voiceFeatureEnabled = useFeatureEnabled('voice');
    const voiceEnabled = !readOnly && voiceFeatureEnabled && props.voiceAffordance !== 'none';
    const documentPanel = props.panelPresentation === 'document';
    const borderedDocument = documentPanel && props.chipPresentation === 'bordered';
    const chipTint = borderedDocument ? theme.colors.text.primary : theme.colors.composer.chipTint;
    const composerSurfaceStyleSetting = useSetting('composerSurfaceStyle');
    const isGlassComposer = !documentPanel && isGlassComposerSurface({ setting: composerSurfaceStyleSetting });
    const surfaceGroup = props.surfaceGroup ?? 'content';
    const composerSurfaceColor = borderedDocument ? theme.colors.edge.floatingFill
        : isGlassComposer ? theme.colors.glass.composerSurface : theme.colors.input.background;
    const panelMaterialProps = { surfaceGroup, nested: surfaceGroup === 'content', solidColor: composerSurfaceColor, finishRole: 'composer' as const };
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

    const defaultInputMaxHeight = React.useMemo(() => {
        return computeAgentInputDefaultMaxHeight({
            platform: Platform.OS,
            screenHeight,
            keyboardHeight: 0,
        });
    }, [screenHeight]);
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
    const handleFilesDroppedToComposer = React.useCallback((event: WebFileDragEvent) => {
        const onAttachmentsAdded = props.onAttachmentsAdded;
        if (typeof onAttachmentsAdded !== 'function') return;
        const files = extractWebAttachmentFilesFromDataTransfer(event?.dataTransfer);
        if (files.length === 0) return;
        onAttachmentsAdded(files);
    }, [props.onAttachmentsAdded]);
    const composerDropZoneHandlers = useWebFileDropZone({
        enabled: Platform.OS === 'web' && dictationEditable && props.surfacePresented !== false && typeof props.onAttachmentsAdded === 'function',
        onFilesDropped: handleFilesDroppedToComposer,
        onFileDragActiveChange: typeof props.onAttachmentsAdded === 'function' ? setFileDragActive : undefined,
    });

    const pendingPermissionRequests = props.permissionRequests ?? [];
    const pendingApprovalRequests = props.approvalRequests ?? [];
    const canApprovePermissions = props.canApprovePermissions === true;
    const permissionPromptSurface = useSetting('permissionPromptSurface');
    const resolvedPermissionPromptSurface = resolvePermissionPromptSurface(permissionPromptSurface);
    const showComposerPermissionCards = resolvedPermissionPromptSurface === 'composer';
    const composerPermissionRequests = React.useMemo(
        () => pendingPermissionRequests.filter((req) => shouldShowGenericPermissionPromptForRequest({ toolName: req.tool, requestKind: req.kind })),
        [pendingPermissionRequests],
    );
    const hasComposerAttentionRequests =
        showComposerPermissionCards &&
        (composerPermissionRequests.length > 0 || pendingApprovalRequests.length > 0);
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
    const composerPromptLibraryButtonEnabled = useSetting('composerPromptLibraryButtonEnabled');

    const historyScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const messageHistory = useUserMessageHistory({
        scope: historyScope,
        sessionId: props.sessionId ?? null,
        serverId: props.sessionTypingPresence?.serverId,
    });

    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const requestComposerFocus = React.useCallback(() => {
        inputRef.current?.focus();
    }, []);
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
            options?.forceImmediate === true || options?.deliveryIntent != null || hasStructuredInputMeta
                ? {
                    ...(options?.forceImmediate === true ? { forceImmediate: true } : {}),
                    ...(options?.deliveryIntent != null ? { deliveryIntent: options.deliveryIntent } : {}),
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

    const effectiveActionBarLayout = React.useMemo<'wrap' | 'scroll' | 'collapsed'>(() => {
        if (agentInputActionBarLayout === 'wrap' || agentInputActionBarLayout === 'scroll' || agentInputActionBarLayout === 'collapsed') {
            return agentInputActionBarLayout;
        }
        // auto
        if (props.autoActionBarLayout) return props.autoActionBarLayout;
        if (isMobileLayoutWidth(screenWidth)) return 'scroll';
        // Flex layout measures the actual remaining column after Voice/Send,
        // so desktop controls wrap rather than being clipped.
        return 'wrap';
    }, [agentInputActionBarLayout, props.autoActionBarLayout, screenWidth]);

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
        findActiveWord(initialInputState.text, initialInputState.selection, props.autocompleteKinds)
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

    const isHistoryBrowsing = React.useCallback(() => (
        messageHistory.isBrowsing()
    ), [messageHistory]);

    const hasRetainedHistorySession = React.useCallback(() => (
        messageHistory.hasRetainedSession()
    ), [messageHistory]);

    const updateActiveWordState = React.useCallback((state: TextInputState) => {
        const nextActiveWord = findActiveWord(state.text, state.selection, props.autocompleteKinds);
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
    const measureComposerDrop = React.useCallback(() => {
        const node = composerDropHost.current;
        void measureWindowBounds(composerDropMeasurable()).then(bounds => {
            if (composerDropHost.current !== node) return;
            composerDropNativeBounds.current = bounds;
            composerDropRuntime.refresh();
        });
    }, [composerDropMeasurable, composerDropRuntime]);
    const mountedComposerId = React.useId();
    const promptPickerSessionAddress = props.sessionAddress ?? typingAddress;
    const promptPicker = usePromptPickerController({
        composerKey: JSON.stringify([
            promptPickerSessionAddress ? sessionAddressKey(promptPickerSessionAddress) : null,
            composerRef ? composerRefV1Key(composerRef) : mountedComposerId,
        ]),
        editable: dictationEditable && !controlsOnly && props.surfacePresented !== false,
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
    // A document-authoring composer keeps its library and mic in the chip row's trailing slot (S-o).
    const accessoriesInActionRow = props.voiceAffordance === 'dictation';
    const fieldAccessory = props.fieldAccessory
        ?? (ownsFieldDictation
            ? <AgentInputDictationButton
                disabled={!dictationEditable}
                status={dictationStatus}
                onPress={handleDictationPress}
            />
            : null);
    const showPromptLibraryButton = composerPromptLibraryButtonEnabled !== false
        && dictationEditable && !controlsOnly;
    const fieldAccessoryGeometry = resolveAgentInputFieldAccessoryGeometry({
        library: showPromptLibraryButton && !accessoriesInActionRow,
        accessory: fieldAccessory != null && !accessoriesInActionRow,
        belowToggle: shouldShowInputExpansionToggle,
    });
    const trailingAccessory = props.trailingAccessory
        ?? (mountsVoiceComposerPlanet ? voiceComposerPlanet
            : accessoriesInActionRow ? (
                <AgentInputFieldAccessories showLibrary={showPromptLibraryButton} onOpenLibrary={openPromptPicker}
                    accessory={fieldAccessory} belowToggle={false} placement="actionRow" />
            ) : null);
    const fieldInputPaddingRight = Math.max(
        fieldAccessoryGeometry.paddingRight ?? 0,
        shouldReserveInputExpansionToggleSpace ? INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT : 0,
    ) || undefined;

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
        updateStructuredInputMentions((currentMentions) => reconcileStructuredInputMentionsWithText({
            previousText: current.text,
            nextText: props.value,
            mentions: currentMentions,
        }));
        setHasAutocompleteTextInteraction(false);
        inputStateRef.current = nextState;
        updateActiveWordState(nextState);
        const nextStatus = resolveLiveInputTextStatus(props.value);
        if (!areLiveInputTextStatusesEqual(liveTextStatusRef.current, nextStatus)) {
            liveTextStatusRef.current = nextStatus;
            setLiveTextStatus(nextStatus);
        }
        updateInputSelectionState(nextSelection);
    }, [props.value, updateActiveWordState, updateInputSelectionState, updateStructuredInputMentions]);

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
        updateStructuredInputMentions((currentMentions) => reconcileStructuredInputMentionsWithText({
            previousText: liveInputText,
            nextText: props.value,
            mentions: currentMentions,
        }));
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
    }, [props.sessionId, props.value, updateActiveWordState, updateInputSelectionState, updateStructuredInputMentions]);

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
        composerKeyboardLayoutForFocus?.setComposerInputFocused?.(true);
        setIsInputFocused(true);
        const focusedActiveWord = findActiveWord(
            inputStateRef.current.text,
            inputStateRef.current.selection,
            props.autocompleteKinds,
        );
        if (focusedActiveWord) {
            setActiveWordState((currentActiveWord) => (
                areActiveWordsEqual(currentActiveWord, focusedActiveWord) ? currentActiveWord : focusedActiveWord
            ));
            setHasAutocompleteTextInteraction(true);
        }
        messageHistory.warmup();
        props.onComposerFocusChange?.(true);
    }, [composerKeyboardLayoutForFocus, messageHistory, props.autocompleteKinds, props.onComposerFocusChange]);

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
    // Selection follows candidate identity, not an index (INV-6) — the hook owns that.
    const [suggestions, selected, moveUp, moveDown, selectionPending] = useActiveSuggestions(activeSuggestionQuery, props.autocompleteSuggestions, { wrapAround: true });
    // A contributed Action can remain externally effectful while its selection
    // awaits canonical dispatch or form preparation. This stays local to the
    // incumbent picker selection owner and follows the same input snapshot currentness.
    const pendingContributedActionSelectionInputRef = React.useRef<TextInputState | null>(null);

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
        const activeWordForSelection = findActiveWord(currentInputState.text, currentInputState.selection, props.autocompleteKinds);
        const applyResolvedSelection = (result: Readonly<{ text: string; cursorPosition: number }>) => {
            inputRef.current?.setTextAndSelection(result.text, {
                start: result.cursorPosition,
                end: result.cursorPosition,
            });
        };

        const applyDefaultSelection = () => {
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
        props.onContributedActionSuggestionSelect,
        suggestions,
        updateStructuredInputMentions,
    ]);

    // Action menu popover state
    const composerAnchorRef = React.useRef<View>(null);
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
    } = useAgentInputCommandMenu({
        suggestions,
        selected,
        selectionPending,
        activeWord,
        activeWordRange: activeWordState
            ? { start: activeWordState.offset, end: activeWordState.endOffset }
            : null,
        inputTextLength: liveTextStatus.length,
        moveUp,
        moveDown,
        handleSuggestionSelect,
        onOpenPromptPicker: dictationEditable && !controlsOnly ? openPromptPickerFromSlash : undefined,
    });
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
    });

    const caretRect = useTextInputCaretRect({
        inputRef,
        selection: inputSelection,
        enabled: isInputFocused && !props.disabled && activeWord !== null,
    });
    const commandMenuAnchor: CommandMenuAnchor = React.useMemo(
        () => resolveAgentInputCommandMenuAnchor(caretRect, composerAnchorRef),
        [caretRect, composerAnchorRef],
    );

    const permissionRequestsFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });
    const permissionRequestsMaxHeightPx = React.useMemo(() => {
        const available = Math.max(1, props.maxPanelHeight ?? screenHeight);
        const desired = Math.round(available * 0.34);
        return clampNumber(desired, 160, Math.min(320, available));
    }, [props.maxPanelHeight, screenHeight]);
    const composerAttentionRequestsNode = React.useMemo(() => {
        if (!attentionRequestSessionId || !hasComposerAttentionRequests) return null;
        const sharedProps: Omit<AgentInputPermissionRequestsProps, 'permissionLocationsById'> = {
            sessionId: attentionRequestSessionId,
            permissionRequests: composerPermissionRequests,
            approvalRequests: pendingApprovalRequests,
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
        if (composerPermissionRequests.length > 0 || pendingApprovalRequests.length > 0) {
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
        composerPermissionRequests,
        hasComposerAttentionRequests,
        pendingApprovalRequests,
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
            sectionOrder={['model', 'config']}
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
        if (typeof props.agentLabel === 'string' && props.agentLabel.length > 0) {
            return props.agentLabel;
        }
        return props.agentType && isBundledAgentId(props.agentType)
            ? resolveAgentCatalogTitle(props.agentType)
            : '';
    }, [props.agentLabel, props.agentType]);

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

    const effectiveAgentPickerSelectedOptionId = React.useMemo(() => {
        if (typeof props.agentPickerSelectedOptionId === 'string' && props.agentPickerSelectedOptionId.length > 0) {
            return props.agentPickerSelectedOptionId;
        }
        return agentPickerOptions[0]?.id ?? null;
    }, [agentPickerOptions, props.agentPickerSelectedOptionId]);

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
    const {
        activeSelectionOverlay,
        activeExtraCollapsedPopoverChip,
        openSelectionOverlay,
        toggleSelectionOverlay,
        closeSelectionOverlay,
        resetSelectionOverlays,
    } = useAgentInputSelectionOverlayController({
        extraActionChips: props.extraActionChips,
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
        // Selection IS the selection. An armed target with a model chosen names
        // that model; an armed target still on the Agent's own defaults names the
        // Agent, because no model has been chosen to name.
        if (armedComposerTarget) {
            return armedComposerTarget.modelLabel ?? armedComposerTarget.label;
        }
        return hasAgentPickerOptions ? selectedModelLabel : resolvedAgentLabel;
    }, [props.engineLabel, armedComposerTarget, hasAgentPickerOptions, resolvedAgentLabel, selectedModelLabel]);
    /**
     * The mark on the engine chip: the armed Agent while one is armed, otherwise
     * the Agent running this Session.
     *
     * Scoped to the chip on purpose. `agentId` still resolves the RUNNING Agent,
     * because permission modes, model options and session modes are facts about
     * what is running — only this one control is about what runs next.
     */
    const engineChipAgentId = (
        armedComposerTarget
            ? armedComposerTarget.agentId
            : (props.agentType ?? agentId)
    );
    const engineChipIdentityIcon = React.useMemo(() => {
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
    const hasRecipient = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'recipient');
    }, [props.extraActionChips]);
    const hasDelivery = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'delivery');
    }, [props.extraActionChips]);
    const hasExtraActionChips = (props.extraActionChips?.length ?? 0) > 0;
    const attachmentRowItems = React.useMemo<readonly AgentInputAttachmentsRowItem[]>(() => (
        projectAgentInputAttachmentRowItems({ items: props.attachmentRowItems })
    ), [props.attachmentRowItems]);
    React.useEffect(() => {
        if (attachmentRowItems.length === 0) {
            setNativeAttachmentRowTopPx(null);
        }
    }, [attachmentRowItems.length]);
    const composerPresentationFeedback = React.useMemo(() => {
        const decorations = props.composerDecorations ?? [];
        const inputLock = props.composerInputLock ?? null;
        if (decorations.length === 0 && inputLock === null) return null;

        return (
            <View testID="agent-input-composer-presentation-effects" style={styles.composerPresentationEffects}>
                {inputLock ? (
                    <View testID="agent-input-composer-lock" style={styles.composerInputLockFeedback}>
                        <Text style={styles.composerInputLockFeedbackText}>{inputLock.reasons.join(' · ')}</Text>
                    </View>
                ) : null}
                {decorations.flatMap((decoration) => decoration.decorations.ranges.map((entry, index) => {
                    const selectedText = props.value.slice(entry.range.start, entry.range.end).trim();
                    const label = entry.label ?? (selectedText || decoration.key);
                    const treatment = entry.treatment;
                    const color = treatment === 'warning'
                        ? theme.colors.state.warning.foreground
                        : treatment === 'success'
                            ? theme.colors.state.success.foreground
                            : treatment === 'muted'
                                ? theme.colors.text.secondary
                                : theme.colors.accent.blue;
                    const textStyle = [
                        styles.composerDecorationFeedbackText,
                        { color },
                        treatment === 'code' ? Typography.mono() : null,
                    ];
                    const text = <Text style={textStyle}>{label}</Text>;
                    const testID = `agent-input-composer-decoration:${decoration.id}:${index}`;
                    if (typeof treatment === 'object' && treatment.kind === 'link') {
                        return (
                            <Pressable
                                key={testID}
                                testID={testID}
                                accessibilityRole="link"
                                accessibilityLabel={label}
                                style={[
                                    styles.composerDecorationFeedback,
                                    styles.composerDecorationFeedbackInteractive,
                                ]}
                                onPress={() => {
                                    void openExternalUrl(treatment.url, { platformOS: Platform.OS });
                                }}
                            >
                                {text}
                            </Pressable>
                        );
                    }
                    return (
                        <View key={testID} testID={testID} style={styles.composerDecorationFeedback}>
                            {text}
                        </View>
                    );
                }))}
            </View>
        );
    }, [
        props.composerDecorations,
        props.composerInputLock,
        props.value,
        styles.composerDecorationFeedback,
        styles.composerDecorationFeedbackInteractive,
        styles.composerDecorationFeedbackText,
        styles.composerInputLockFeedback,
        styles.composerInputLockFeedbackText,
        styles.composerPresentationEffects,
        theme.colors.accent.blue,
        theme.colors.state.success.foreground,
        theme.colors.state.warning.foreground,
        theme.colors.text.secondary,
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
    const hasStop = canStopFromComposer;
    const hasAnyActions = getHasAnyAgentInputActions({
        showPermissionChip,
        hasProfile,
        hasEnvVars,
        hasAgent,
        hasRecipient,
        hasDelivery,
        hasExtraActionChips,
        hasMachine,
        hasPath,
        hasResume,
        hasFiles,
        hasStop,
    });

    // Collapsed folds secondary controls into the menu, not onto more lines.
    // Retain access to the remaining chips through the existing overflow track.
    const actionBarShouldScroll = effectiveActionBarLayout !== 'wrap';
    const actionBarIsCollapsed = effectiveActionBarLayout === 'collapsed';
    const actionChipTransientStyles = React.useMemo(() => ({
        iconOnly: AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
        pressed: AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE,
    }), []);
    const chipStyle = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        props.chipPresentation === 'bordered' ? styles.actionChipBordered : null,
        !showChipLabels ? actionChipTransientStyles.iconOnly : null,
        pressed ? actionChipTransientStyles.pressed : null,
    ]), [
        actionChipTransientStyles.iconOnly,
        actionChipTransientStyles.pressed,
        showChipLabels,
        styles.actionChip,
        props.chipPresentation,
        styles.actionChipBordered,
    ]);
    const chipStyleAutoHide = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        props.chipPresentation === 'bordered' ? styles.actionChipBordered : null,
        !showAutoHideChipLabels ? actionChipTransientStyles.iconOnly : null,
        pressed ? actionChipTransientStyles.pressed : null,
    ]), [
        actionChipTransientStyles.iconOnly,
        actionChipTransientStyles.pressed,
        showAutoHideChipLabels,
        styles.actionChip,
        props.chipPresentation,
        styles.actionChipBordered,
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
        if (props.disabled) return;
        inputRef.current?.focus();
    }, [props.disabled]);

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
        if (isInputFocused && dictationEditable && !controlsOnly && props.surfacePresented !== false) {
            handlers['composer.prompts.open'] = openPromptPicker;
        }
        return handlers;
    }, [canStopFromComposer, handleComposerAbortShortcut, handleComposerFocusShortcut, isInputFocused, dictationEditable, controlsOnly, props.surfacePresented, openPromptPicker]);
    useKeyboardShortcutHandlers(keyboardShortcutHandlers);

    const {
        handleActionMenuPress,
        actionMenuActions,
        hasActionMenuPopoverSections,
    } = useAgentInputActionMenuControls({
        ...(props.barControlIds ? { barControlIds: props.barControlIds } : {}),
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
        actionBarIsCollapsed,
        hasAnyActions,
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
        extraActionChips: props.extraActionChips,
        openCollapsedOptionsPopover: (chipKey) => {
            if (!chipKey) {
                closeSelectionOverlay('collapsedExtra');
                return;
            }
            openSelectionOverlay('collapsedExtra', 'actionMenu', chipKey);
        },
        sessionModeLabel: sessionModeChipControl?.label ?? null,
        sessionModeChipInteraction,
        onSessionModeChange: props.onAcpSessionModeChange,
        shouldExposeSessionModeAction: actionBarIsCollapsed && shouldRenderSessionModeChip,
        onMachineClick: handleMachinePress,
        onPathClick: handlePathPress,
        onResumeClick: handleResumePress,
        onFileViewerPress: props.onFileViewerPress,
        canStop: canStopFromComposer,
        onStop: () => {
            void handleAbortPress();
        },
        hasProfile,
        hasEnvVars,
        hasAgent,
    });
    const singleRowControls = borderedDocument || (
        agentInputActionBarLayout === 'auto'
        && effectiveActionBarLayout === 'scroll'
        && isMobileLayoutWidth(screenWidth)
    );
    const {
        controlNodes: renderedActionControlNodes,
        hasPermissionControl,
        readOnlyEngineNodes,
        extraChipNodes: renderedExtraChipNodes,
        secondaryLeadingControls: secondaryLeadingControlsForWrap,
        extraChipAnchorRefsByKey,
    } = useRenderedAgentInputControlRows({
        readOnly,
        layout: effectiveActionBarLayout,
        singleRow: singleRowControls,
        ...(props.barControlIds ? { barControlIds: props.barControlIds } : {}),
        chips: props.extraActionChips,
        overlayAnchorRef,
        onToggleExtraChipCollapsedPopover: (chipKey) => {
            toggleSelectionOverlay('collapsedExtra', 'chip', chipKey);
        },
        themeTint: chipTint,
        showChipLabels: readOnly || showChipLabels,
        showAutoHideChipLabels: readOnly || showAutoHideChipLabels,
        chipStyle,
        chipStyleAutoHide,
        textStyle: borderedDocument ? styles.actionChipBorderedText : styles.actionChipText,
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
        actionBarIsCollapsed,
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
        hasAgentSelection: hasAgent || (readOnly && Boolean(props.agentType || props.engineLabel)),
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
        blurInput: () => inputRef.current?.blur(),
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

    const showSecondaryControlsRow = !singleRowControls && shouldShowSecondaryControlRow(
        effectiveActionBarLayout,
        secondaryLeadingControlsForWrap.length > 0 || hasPath || hasResume,
    );

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
            sendActionDisabled,
            platformOS: Platform.OS,
        });
        if (sendShortcutAction === 'sendImmediate') {
            // Explicit immediate-send bypasses autocomplete.
            handleSend({ forceImmediate: true });
            return true;
        }
        if (sendShortcutAction === 'sendPending') {
            // Explicit pending-send bypasses steering so the message can be reviewed/reordered.
            handleSend({ deliveryIntent: 'server_pending' });
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
    }, [handleCommandMenuKey, props.hasSendableAttachments, handleSend, props.onPermissionModeChange, keyboardShortcutsV2Enabled, keyboardSingleKeyShortcutsEnabled, keyboardShortcutOverridesV1, keyboardShortcutDisabledCommandIdsV1, permissionModeOrder, effectivePermissionPolicy.effectiveMode, messageHistory, props.messageHistory, applyHistoryInputText, sendActionDisabled, isHistoryBrowsing, hasRetainedHistorySession, enterToSendEnabled, submitEnabled, canStopFromComposer, isAborting, runAbortShortcutAction]);

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
                {attachmentsRow}
            </View>
        );
    };

    if (readOnly) {
        // The document owner has already placed and admitted these exact ranges.
        // Reading never searches the live catalog or rebinds a frozen reference.
        const references = composerReferencesFromStructuredMentions({
            text: props.value,
            mentions: structuredInputMentions,
        });
        return (
            <TextSelectabilityScope selectable>
                <View testID="agent-input-composer" style={[styles.container, documentPanel ? styles.containerDocument : null, { paddingHorizontal: props.contentPaddingHorizontal ?? 0 }]}>
                    <GlassSurface testID="agent-input-material-surface" {...panelMaterialProps} style={[styles.unifiedPanel, props.panelStyle, styles.readOnlyPanel]}>
                        {composerPresentationFeedback}
                        <AgentInputAttachmentsRow items={attachmentRowItems} />
                        <View style={[styles.inputContainer, styles.readOnlyInputContent]}>
                            {/* A reading document's card is calm: about three lines, then More (DESIGN-4 M4). */}
                            <AgentInputReadOnlyText value={props.value} accessibilityLabel={props.inputAccessibilityLabel} clamp={documentPanel}
                                style={[isConversation ? styles.sessionInputText : styles.newSessionInputText, styles.readOnlyText]} />
                            {references.map((reference) => (
                                <Text key={`${reference.start}:${reference.ref}`} selectable style={styles.composerDecorationFeedbackText}>{reference.label ?? reference.token}</Text>
                            ))}
                        </View>
                        {readOnlyEngineNodes.length > 0 || renderedExtraChipNodes.length > 0 ? (
                            <AgentInputReadOnlyChipRow testID="agent-input-read-only-chips" engine={readOnlyEngineNodes} chips={renderedExtraChipNodes} />
                        ) : null}
                    </GlassSurface>
                </View>
            </TextSelectabilityScope>
        );
    }

    return (
        <SessionModelSourceBrowseHandoffContext.Provider value={modelSourceBrowseHandoff}>
        <SyncPerformanceReactProfiler id="sessions.agentInput">
            <View
                testID="agent-input-composer"
                ref={stageSpotlightRef}
                collapsable={stageSpotlightProps.active ? false : undefined}
                onLayout={stageSpotlightProps.onLayout}
                pointerEvents={Platform.OS === 'web' ? 'auto' : undefined}
                style={[
                    styles.container,
                    documentPanel ? styles.containerDocument : null,
                    stageSpotlightProps.style,
                    { paddingHorizontal: props.contentPaddingHorizontal ?? (screenWidth > 700 ? 16 : 8) },
                ]}
            >
            <View style={[
                styles.innerContainer,
                ...(typeof props.maxWidthCap === 'number'
                    ? [{ maxWidth: props.maxWidthCap }]
                    : props.maxWidthCap === null
                        ? []
                        : [{ maxWidth: layout.maxWidth }])
            ]} ref={overlayAnchorRef}>
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
                    maxHeight={240}
                    testID={AGENT_INPUT_COMMAND_MENU_TEST_ID}
                />
                {promptPicker.isOpen ? (
                    <AgentInputPromptPicker
                        anchor={{ kind: 'view', ref: composerAnchorRef }}
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
                    statusTrailingActions={props.statusTrailingActions}
                    activeStatusBadgeKey={props.activeStatusBadgeKey}
                    onActiveStatusBadgeKeyChange={props.onActiveStatusBadgeKeyChange}
                    onGitPress={props.onFileViewerPress}
                    collapseWhenEmpty={props.collapseEmptyStatusRow === true || documentPanel}
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
                {composerRef && composerDropScope ? <ComposerEntityDropTarget
                    id={composerDropTargetId} scope={composerDropScope} refValue={composerRef}
                    bounds={composerDropBounds} presented={props.surfacePresented !== false}
                    editable={dictationEditable && !controlsOnly} kinds={props.autocompleteKinds}
                    referenceHost={props.composerReferenceHost} fileScope={props.composerFileScope}
                    /> : null}
                <GlassSurface
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
                            outcome={{ glyph: 'attach', tone: 'allowed', title: t('entityDragDrop.files.attach'), detail: t('entityDragDrop.composer.consequence') }} />
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
                                        paddingBottom={Platform.OS === 'web' ? 10 : 8}
                                        paddingRight={fieldInputPaddingRight}
                                        onChangeText={handleComposerTextChange}
                                        placeholder={props.placeholder}
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
                                        onFilesPasted={props.onAttachmentsAdded}
                                        onContentHeightChange={handleInputContentHeightChange}
                                    />
                                    {props.inputExpansion && shouldShowInputExpansionToggle ? (
                                        <AgentInputExpansionToggle
                                            expanded={props.inputExpansion.expanded}
                                            onToggle={props.inputExpansion.onToggle}
                                        />
                                    ) : null}
                                    {accessoriesInActionRow ? null : <AgentInputFieldAccessories showLibrary={showPromptLibraryButton} onOpenLibrary={openPromptPicker}
                                        accessory={fieldAccessory} belowToggle={shouldShowInputExpansionToggle} />}
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
                                                {renderedActionControlNodes as any}
                                            </AgentInputScrollableChipRow>
                                        ) : (
                                            <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                                                {renderedActionControlNodes as any}
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
                                                        actionChip: styles.actionChip,
                                                        actionChipIconOnly: actionChipTransientStyles.iconOnly,
                                                        actionChipPressed: actionChipTransientStyles.pressed,
                                                        actionChipText: styles.actionChipText,
                                                    }}
                                                    fillAvailableWidth={false}
                                                    leadingControls={secondaryLeadingControlsForWrap}
                                                    showChipLabels={showChipLabels}
                                iconColor={theme.colors.composer.chipTint}
                                                    folderChipState={folderChipState}
                                                    pathChipAnchorRef={pathChipAnchorRef}
                                                    onPathClick={handlePathPress}
                                                    onRemoveFolder={props.onRemoveFolder}
                                                    resumeSessionId={props.resumeSessionId}
                                                    resumeChipAnchorRef={resumeChipAnchorRef}
                                                    onResumeClick={handleResumePress}
                                                    resumeLabelTitle={t('newSession.resume.chipOptional', {
                                                        agent: resolvedAgentLabel,
                                                    })}
                                                    resumeLabelOptional={t('newSession.resume.chipOptional', {
                                                        agent: resolvedAgentLabel,
                                                    })}
                                                />
                                            </AgentInputScrollableChipRow>
                                        ) : (
                                            <PathAndResumeRow
                                                key="row2"
                                                styles={{
                                                    pathRow: styles.pathRow,
                                                    actionButtonsLeft: styles.actionButtonsLeft,
                                                    actionChip: styles.actionChip,
                                                    actionChipIconOnly: actionChipTransientStyles.iconOnly,
                                                    actionChipPressed: actionChipTransientStyles.pressed,
                                                    actionChipText: styles.actionChipText,
                                                }}
                                                leadingControls={secondaryLeadingControlsForWrap}
                                                showChipLabels={showChipLabels}
                            iconColor={theme.colors.composer.chipTint}
                                                folderChipState={folderChipState}
                                                pathChipAnchorRef={pathChipAnchorRef}
                                                onPathClick={handlePathPress}
                                                onRemoveFolder={props.onRemoveFolder}
                                                resumeSessionId={props.resumeSessionId}
                                                resumeChipAnchorRef={resumeChipAnchorRef}
                                                onResumeClick={handleResumePress}
                                                resumeLabelTitle={t('newSession.resume.chipOptional', {
                                                    agent: resolvedAgentLabel,
                                                })}
                                                resumeLabelOptional={t('newSession.resume.chipOptional', {
                                                    agent: resolvedAgentLabel,
                                                })}
                                            />
                                        )
                                    ) : null,
                                ]}</View>
                                <View
                                    style={[
                                        showSecondaryControlsRow
                                            ? styles.trailingAccessoryStack
                                            : styles.trailingAccessoryInline,
                                        showSecondaryControlsRow && isMobileLayoutWidth(screenWidth)
                                            ? styles.trailingAccessoryStackMobile
                                            : null,
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
                                            hasDedicatedStopControl={Boolean(props.onAbort) && Boolean(props.showAbortButton) && !actionBarIsCollapsed}
                                            dictationPressHandler={dictationPressHandler}
                                            dictationStatus={dictationStatus}
                                            armedContinuationTarget={props.armedContinuationTarget ?? null}
                                            armedContinuationIdentityMark={armedContinuationIdentityMark}
                                            onSend={handleSend}
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
                                        paddingBottom={8}
                                        paddingRight={fieldInputPaddingRight}
                                        onChangeText={handleComposerTextChange}
                                        placeholder={props.placeholder}
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
                                        onFilesPasted={props.onAttachmentsAdded}
                                        onContentHeightChange={handleInputContentHeightChange}
                                    />
                                    {props.inputExpansion && shouldShowInputExpansionToggle ? (
                                        <AgentInputExpansionToggle
                                            expanded={props.inputExpansion.expanded}
                                            onToggle={props.inputExpansion.onToggle}
                                        />
                                    ) : null}
                                    {accessoriesInActionRow ? null : <AgentInputFieldAccessories showLibrary={showPromptLibraryButton} onOpenLibrary={openPromptPicker}
                                        accessory={fieldAccessory} belowToggle={shouldShowInputExpansionToggle} />}
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
                                                    {renderedActionControlNodes as any}
                                                </AgentInputScrollableChipRow>
                                            ) : (
                                                <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                                                    {renderedActionControlNodes as any}
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
                                                            actionChip: styles.actionChip,
                                                            actionChipIconOnly: actionChipTransientStyles.iconOnly,
                                                            actionChipPressed: actionChipTransientStyles.pressed,
                                                            actionChipText: styles.actionChipText,
                                                        }}
                                                        fillAvailableWidth={false}
                                                        leadingControls={secondaryLeadingControlsForWrap}
                                                        showChipLabels={showChipLabels}
                                                        iconColor={theme.colors.button.secondary.tint}
                                                        folderChipState={folderChipState}
                                                        pathChipAnchorRef={pathChipAnchorRef}
                                                        onPathClick={handlePathPress}
                                                        onRemoveFolder={props.onRemoveFolder}
                                                        resumeSessionId={props.resumeSessionId}
                                                        resumeChipAnchorRef={resumeChipAnchorRef}
                                                        onResumeClick={handleResumePress}
                                                        resumeLabelTitle={t('newSession.resume.chipOptional', {
                                                            agent: resolvedAgentLabel,
                                                        })}
                                                        resumeLabelOptional={t('newSession.resume.chipOptional', {
                                                            agent: resolvedAgentLabel,
                                                        })}
                                                    />
                                                </AgentInputScrollableChipRow>
                                            ) : (
                                                <PathAndResumeRow
                                                    key="row2"
                                                    styles={{
                                                        pathRow: styles.pathRow,
                                                        actionButtonsLeft: styles.actionButtonsLeft,
                                                        actionChip: styles.actionChip,
                                                        actionChipIconOnly: actionChipTransientStyles.iconOnly,
                                                        actionChipPressed: actionChipTransientStyles.pressed,
                                                        actionChipText: styles.actionChipText,
                                                    }}
                                                    leadingControls={secondaryLeadingControlsForWrap}
                                                    showChipLabels={showChipLabels}
                                                    iconColor={theme.colors.button.secondary.tint}
                                                    folderChipState={folderChipState}
                                                    pathChipAnchorRef={pathChipAnchorRef}
                                                    onPathClick={handlePathPress}
                                                    onRemoveFolder={props.onRemoveFolder}
                                                    resumeSessionId={props.resumeSessionId}
                                                    resumeChipAnchorRef={resumeChipAnchorRef}
                                                    onResumeClick={handleResumePress}
                                                    resumeLabelTitle={t('newSession.resume.chipOptional', {
                                                        agent: resolvedAgentLabel,
                                                    })}
                                                    resumeLabelOptional={t('newSession.resume.chipOptional', {
                                                        agent: resolvedAgentLabel,
                                                    })}
                                                />
                                            )
                                        ) : null,
                                    ]}</View>
                                    <View
                                        style={[
                                            showSecondaryControlsRow
                                                ? styles.trailingAccessoryStack
                                                : styles.trailingAccessoryInline,
                                            showSecondaryControlsRow && isMobileLayoutWidth(screenWidth)
                                                ? styles.trailingAccessoryStackMobile
                                                : null,
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
                                                hasDedicatedStopControl={Boolean(props.onAbort) && Boolean(props.showAbortButton) && !actionBarIsCollapsed}
                                                dictationPressHandler={dictationPressHandler}
                                                dictationStatus={dictationStatus}
                                                armedContinuationTarget={props.armedContinuationTarget ?? null}
                                                armedContinuationIdentityMark={armedContinuationIdentityMark}
                                                onSend={handleSend}
                                                onStop={handleAbortPress}
                                            />
                                        ) : null}
                                    </View>
                                </View>
                            </View>
                        </View>
                    )}
                </GlassSurface>
                </WebDropTargetView>
            </View>
            </View>
        </SyncPerformanceReactProfiler>
        </SessionModelSourceBrowseHandoffContext.Provider>
    );
}));
