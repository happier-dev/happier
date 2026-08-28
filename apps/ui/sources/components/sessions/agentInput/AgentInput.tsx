import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
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
    createBackdropNativeStyle,
    createBackdropWebStyle,
} from '@/components/ui/overlays/createBackdropLayerStyle';
import {
    MultiTextInput,
    KeyPressEvent,
    type MultiTextInputSubmitBehavior,
} from '@/components/ui/forms/MultiTextInput';
import {
    TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
    isLargeTextInputValueLength,
} from '@/components/ui/forms/largeTextInputPolicy';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';
import { Typography } from '@/constants/Typography';
import type {
    PermissionMode,
    ModelMode,
} from '@/sync/domains/permissions/permissionTypes';
import {
    findModelOptionForEffectiveModelId,
    getModelOptionsForSession,
    supportsFreeformModelSelectionForSession,
    type ModelOption,
} from '@/sync/domains/models/modelOptions';
import {
    buildExtendedContextModelControl,
    EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID,
    resolveExtendedContextModelIdForToggle,
} from '@/sync/domains/models/extendedContextModelControl';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import {
    ReportedModelStatusIcon,
    reportedModelSummary,
    resolveReportedModelStatus,
    type ReportedModelStatus,
} from '@/components/sessions/modelPicker/reportedModelPresentation';
import { Modal } from '@/modal';
import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeLabelForAgentType,
    getPermissionModeOptionsForSession,
} from '@/sync/domains/permissions/permissionModeOptions';
import { describeEffectivePermissionMode } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
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
    useSessionMessagesById,
    useSessionMessagesReducerState,
    useSessionMessagesVersion,
    useSessionTranscriptIds,
    useSetting,
} from '@/sync/domains/state/storage';
import { useUserMessageHistory } from '@/hooks/session/useUserMessageHistory';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/domains/state/storageTypes';
import {
    getProfileEnvironmentVariables,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';
import {
    DEFAULT_AGENT_ID,
    getAgentCore,
    type AgentId,
} from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
// From the registry rather than the catalog facade: this narrows an id the picker
// supplied, which is the same check the send control's presentation resolver makes.
import { isBundledAgentId } from '@/agents/registry/registryCore';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { readUiAiLaunchProfilesForLegacyUi } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputScrollableChipRow } from './layout/AgentInputScrollableChipRow';
import { PathAndResumeRow } from './layout/PathAndResumeRow';
import {
    getHasAnyAgentInputActions,
    shouldShowSecondaryControlRow,
    type AgentInputActionBarLayout,
} from './layout/actionBarLogic';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useVoiceDictation } from '@/voice/dictation/useVoiceDictation';
import {
    resolveVoiceDictationFailureTranslationKey,
    resolveVoiceDictationStartErrorTranslationKey,
} from '@/voice/dictation/voiceDictationErrorCopy';
import { VoiceComposerPlanetMount } from '@/components/voice/composer/VoiceComposerPlanetMount';
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
import {
    SessionInstrumentStrip,
    type SessionInstrumentStripPermission,
    type SessionInstrumentStripQuota,
} from './instrumentStrip';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { AgentInputAttachmentsRow } from './components/AgentInputAttachmentsRow';
import { AgentInputOverlayLayer } from './components/AgentInputOverlayLayer';
import { AgentInputExpansionToggle } from './components/AgentInputExpansionToggle';
import { AgentInputPermissionRequests } from './components/AgentInputPermissionRequests';
import { resolveArmedComposerContinuation } from './components/agentContinuationSubmitPresentation';
import { AgentInputSubmitButton } from './components/AgentInputSubmitButton';
import {
    DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
    resolveChipOptionInteraction,
    shouldRenderChipForOptions,
} from './chipOptionInteraction';
import { resolveSessionModeChipPresentation } from './controls/resolveSessionModeChipPresentation';
import { useAgentInputActionMenuControls } from './controls/useAgentInputActionMenuControls';
import { useAgentInputCoreControlHandlers } from './controls/useAgentInputCoreControlHandlers';
import { useRenderedAgentInputControlRows } from './controls/useRenderedAgentInputControlRows';
import { recordLargeTextInputDiagnostic } from '@/utils/system/userInteractionDiagnostics';
import { buildAgentInputSelectionOverlayViewModel } from './selection/buildAgentInputSelectionOverlayViewModel';
import { useAgentInputSelectionAnchors } from './selection/useAgentInputSelectionAnchors';
import { useAgentInputSelectionOverlayController } from './selection/useAgentInputSelectionOverlayController';
import { deferAgentInputPopoverClose } from './selection/deferAgentInputPopoverClose';
import { useAgentInputExternalPickerRequest } from './selection/useAgentInputExternalPickerRequest';
import { computeSessionModePickerControl } from '@/sync/domains/sessionControl/sessionModeControl';
import {
    computeAcpConfigOptionControls,
    computeAcpConfigOptionControlsFromOverride,
    type AcpConfigOption,
    type AcpConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { Text } from '@/components/ui/text/Text';
import { buildGlassCastShadowStyle } from '@/shadowElevation';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { isGlassComposerSurface } from './composerSurfaceStyle';
import { resolveComposerSelectionRestore } from './composerSelectionRestore';
import { COMPOSER_SURFACE_RADIUS } from './composerContentInset';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import { resolveApprovalToolCallLocations } from '@/utils/sessions/approvals/resolveApprovalToolCallLocations';
import {
    resolvePermissionPromptSurface,
    shouldShowGenericPermissionPromptForRequest,
} from '@/utils/sessions/permissions/permissionPromptPolicy';
import { buildSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { useLocalSetting } from '@/sync/store/hooks';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
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
import { applyDictationToComposer } from './applyDictationToComposer';
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
import { useAgentInputCommandMenu } from './commandMenu/useAgentInputCommandMenu';
import { resolveAgentInputCommandMenuAnchor } from './commandMenu/resolveAgentInputCommandMenuAnchor';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { StyleProp } from 'react-native';
import {
    areActiveWordsEqual,
    areLiveInputTextStatusesEqual,
    resolveLiveInputTextStatus,
} from './liveInputState';

const NATIVE_ACTION_CHIP_GAP_Y = 1;
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
const AGENT_INPUT_PANEL_PADDING_TOP = 2;
const AGENT_INPUT_PANEL_PADDING_BOTTOM = 8;
// Composer panel corner radius. Shared by the panel surface, its cast-shadow wrapper so the drop
// shadow follows the same rounded shape, and the auxiliary banners stacked above the panel.
const AGENT_INPUT_PANEL_RADIUS = COMPOSER_SURFACE_RADIUS;
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

type AgentInputPendingParentTextSync = {
    text: string;
    hasFlushed: boolean;
};

function shouldDeferAgentInputParentTextSync(
    parentText: string,
    nextText: string,
): boolean {
    if (!isLargeTextInputValueLength(nextText.length)) {
        return false;
    }
    const parentStatus = resolveLiveInputTextStatus(parentText);
    const nextStatus = resolveLiveInputTextStatus(nextText);
    return parentStatus.hasText === nextStatus.hasText;
}

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
    onChangeText: (text: string) => void;
    /** Scope-local observer for the incumbent input's real focus transitions. */
    onComposerFocusChange?: (focused: boolean) => void;
    /** Scope-local access to this mounted input's existing imperative focus method. */
    onComposerFocusRequestChange?: (request: (() => void) | null) => void;
    /** Scope-local observer for this mounted input's resolved action-bar layout. */
    onComposerActionBarLayoutChange?: (layout: AgentInputActionBarLayout) => void;
    sessionId?: string;
    /** The retaining Session surface's existing presented fact; absent hosts are mounted/presented. */
    surfacePresented?: boolean;
    onSend: (options?: AgentInputSendOptions) => void;
    submitAccessibilityLabel?: string;
    sendIcon?: React.ReactNode;
    permissionMode?: PermissionMode;
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
    /** Changes to a non-empty key open the model/agent picker for an explicit external action. */
    openModelPickerRequestKey?: string | null;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
    };
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
    /**
     * The reader is reaching for the Agent chip — hover, focus, or press-in.
     *
     * Fired before the picker opens so the Session's machine can be asked about
     * continuation support while the pointer is still travelling, rather than on
     * every Session view.
     */
    onAgentPickerIntent?: () => void;
    onAgentPickerVisibilityChange?: (visible: boolean) => void;
    agentPickerSelectedOptionId?: string | null;
    onAgentPickerSelect?: (id: string) => void;
    agentPickerApplyLabel?: string;
    agentPickerProbe?: OptionPickerProbeState;
    machineName?: string | null;
    onMachineClick?: () => void;
    machinePopover?: AgentInputContentPopoverConfig;
    currentPath?: string | null;
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
        onScrollYChange: (scrollY: number) => void;
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
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
}

type AgentInputPermissionRequestsProps = React.ComponentProps<typeof AgentInputPermissionRequests>;

const EMPTY_PERMISSION_LOCATIONS_BY_ID: ReadonlyMap<string, PermissionToolCallMessageLocation | null> = new Map();
const EMPTY_APPROVAL_LOCATIONS_BY_ARTIFACT_ID: ReadonlyMap<string, PermissionToolCallMessageLocation | null> = new Map();

const AgentInputAttentionRequestsWithLocations = React.memo(function AgentInputAttentionRequestsWithLocations(
    props: Omit<AgentInputPermissionRequestsProps, 'permissionLocationsById' | 'approvalLocationsByArtifactId'>,
) {
    const { ids: committedMessageIdsOldestFirst } = useSessionTranscriptIds(props.sessionId);
    const committedMessagesById = useSessionMessagesById(props.sessionId);
    const committedMessagesReducerState = useSessionMessagesReducerState(props.sessionId);
    const permissionLocationVersion = useSessionMessagesVersion(
        props.sessionId,
        props.permissionRequests.length > 0 || (props.approvalRequests?.length ?? 0) > 0,
    );

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
        permissionLocationVersion,
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
        permissionLocationVersion,
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

const FIELD_ACCESSORY_VISUAL_SIZE = 24;
const FIELD_ACCESSORY_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const FIELD_ACCESSORY_HORIZONTAL_INSET = (FIELD_ACCESSORY_TARGET_SIZE - FIELD_ACCESSORY_VISUAL_SIZE) / 2;

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        width: '100%',
        paddingBottom: 8,
        paddingTop: 8,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    // The visual remains in AgentInputExpansionToggle's 24pt slot. The parent
    // instead bounds the full target so native hit testing does not clip the
    // child's hitSlop; the two stacked targets meet at y=30 without overlap.
    fieldAccessory: {
        position: 'absolute',
        top: 2,
        right: 6 - FIELD_ACCESSORY_HORIZONTAL_INSET,
        zIndex: 2,
        width: FIELD_ACCESSORY_TARGET_SIZE,
        height: FIELD_ACCESSORY_TARGET_SIZE,
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: 4,
    },
    fieldAccessoryBelowToggle: {
        top: 30,
    },
    // Default (non-glass) composer surface — the original styling: standard input
    // background + hairline surface border, no drop shadow.
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: AGENT_INPUT_PANEL_RADIUS,
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.surface,
            highlightColor: theme.colors.effect.surfaceHighlight,
        }),
        overflow: 'hidden',
        paddingTop: AGENT_INPUT_PANEL_PADDING_TOP,
        paddingBottom: AGENT_INPUT_PANEL_PADDING_BOTTOM,
        paddingHorizontal: 8,
    },
    // Opt-in "glass" composer: the Liquid Glass tab bar's solid look — `surface.base`
    // fill, the glass rim, and a top inset shadow. Fully redefines the border so the
    // standard hairline + highlight don't leak through. The cast shadow lives on the
    // `panelShadow` wrapper (glass mode only).
    unifiedPanelGlass: {
        backgroundColor: theme.colors.glass.composerSurface,
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
        borderRadius: AGENT_INPUT_PANEL_RADIUS,
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
        minWidth: FIELD_ACCESSORY_TARGET_SIZE,
        minHeight: FIELD_ACCESSORY_TARGET_SIZE,
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
        paddingHorizontal: 0,
    },
    actionButtonsColumn: {
        flexDirection: 'column',
        flex: 1,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_Y } : {}),
    },
    actionButtonsColumnMobile: {
        flexDirection: 'column',
        flex: 1,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_MOBILE_Y } : {}),
    },
    actionButtonsColumnNarrow: {
        flexDirection: 'column',
        flex: 1,
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
        alignItems: 'center',
        gap: 8,
    },
    trailingAccessoryStack: {
        flexDirection: 'column-reverse',
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
        flexWrap: 'wrap',
        overflow: 'visible',
    },
    actionButtonsLeftScroll: {
        flex: 1,
        overflow: 'visible',
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
    actionChip: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 10,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
        gap: 6,
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionChipText: {
        fontSize: 13,
        color: theme.colors.composer.chipTint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
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
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.composer.chipTint,
    },
    fileDropOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.overlay.scrim,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: Platform.select({ default: 16, android: 20 }),
    },
    fileDropOverlayContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    fileDropOverlayText: {
        color: theme.colors.text.primary,
        fontSize: 13,
        ...Typography.default('semiBold'),
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
    const voiceEnabled = useFeatureEnabled('voice');
    const uiBackdropBlurEnabled = useLocalSetting('uiBackdropBlurEnabled') !== false;
    const fileDropOverlayBackdropStyle = React.useMemo<ViewStyle>(() => {
        const backgroundColor = theme.colors.overlay.scrimWizard ?? theme.colors.overlay.scrim;
        if (Platform.OS === 'web') {
            return createBackdropWebStyle({
                backgroundColor,
                blurPx: 2,
                enableBlur: uiBackdropBlurEnabled,
                fallbackBackgroundColorWhenBlurDisabled: theme.colors.overlay.scrimStrong ?? theme.colors.overlay.scrim,
            }) as unknown as ViewStyle;
        }
        return createBackdropNativeStyle({ backgroundColor });
    }, [
        theme.colors.overlay.scrim,
        theme.colors.overlay.scrimStrong,
        theme.colors.overlay.scrimWizard,
        uiBackdropBlurEnabled,
    ]);
    const isGlassComposer = isGlassComposerSurface({ setting: useSetting('composerSurfaceStyle') });
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
            fallbackMaxHeightMode: props.sessionId ? 'cap' : 'seed',
        });
    }, [
        fallbackInputMaxHeight,
        hostPanelMaxHeight,
        inputContainerHeightPx,
        minimumMeasuredPanelFixedChromeHeight,
        panelHeightPx,
        props.sessionId,
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
    const dictationEditable = !props.disabled && !composerInputEditLocked;
    const dictation = useVoiceDictation(
        props.sessionId,
        props.surfacePresented !== false,
        dictationEditable,
    );
    const dictationComposerAuthorityRef = React.useRef({
        editable: dictationEditable,
        sessionId: props.sessionId ?? null,
    });
    dictationComposerAuthorityRef.current = {
        editable: dictationEditable,
        sessionId: props.sessionId ?? null,
    };
    const [fileDragActive, setFileDragActive] = React.useState(false);
    const handleFilesDroppedToComposer = React.useCallback((event: any) => {
        const onAttachmentsAdded = props.onAttachmentsAdded;
        if (typeof onAttachmentsAdded !== 'function') return;
        const files = extractWebAttachmentFilesFromDataTransfer(event?.dataTransfer);
        if (files.length === 0) return;
        onAttachmentsAdded(files);
    }, [props.onAttachmentsAdded]);
    const composerDropZoneHandlers = useWebFileDropZone({
        enabled: Platform.OS === 'web' && typeof props.onAttachmentsAdded === 'function',
        onFilesDropped: handleFilesDroppedToComposer,
        onFileDragActiveChange: typeof props.onAttachmentsAdded === 'function' ? setFileDragActive : undefined,
    });

    const pendingPermissionRequests = props.permissionRequests ?? [];
    const pendingApprovalRequests = props.approvalRequests ?? [];
    const canApprovePermissions = props.canApprovePermissions ?? true;
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
    const lastNonEmptySessionModelOptionsRef = React.useRef<readonly ModelOption[] | null>(null);
    React.useEffect(() => {
        lastNonEmptySessionModelOptionsRef.current = null;
    }, [props.sessionId, sessionAgentId]);

    const sessionModelsState = React.useMemo(() => {
        if (props.modelOptionsOverride) return { hasSessionModelsState: false, availableCount: 0 };
        const raw = readSessionModelsState(props.metadata ?? null);
        const stateAgentId = typeof raw?.agentId === 'string' ? raw.agentId.trim() : '';
        if (!stateAgentId || stateAgentId !== (resolvedSessionAgentId ?? agentId)) {
            return { hasSessionModelsState: false, availableCount: 0 };
        }
        const available = Array.isArray(raw?.availableModels) ? raw.availableModels : [];
        return { hasSessionModelsState: true, availableCount: available.length };
    }, [agentId, props.metadata, props.modelOptionsOverride, resolvedSessionAgentId]);

    const baseModelOptions = React.useMemo(() => {
        if (props.modelOptionsOverride) return props.modelOptionsOverride;
        return getModelOptionsForSession(sessionAgentId, props.metadata ?? null);
    }, [props.metadata, props.modelOptionsOverride, sessionAgentId]);

    const modelOptions = React.useMemo(() => {
        if (props.modelOptionsOverride) return baseModelOptions;
        if (sessionModelsState.hasSessionModelsState && sessionModelsState.availableCount === 0) {
            const sticky = lastNonEmptySessionModelOptionsRef.current;
            if (sticky && sticky.length > 0) return sticky;
        }
        return baseModelOptions;
    }, [baseModelOptions, props.modelOptionsOverride, sessionModelsState.availableCount, sessionModelsState.hasSessionModelsState]);

    const sessionModelOptionsProbe = React.useMemo<OptionPickerProbeState | null>(() => {
        if (props.modelOptionsOverride) return null;
        if (!sessionModelsState.hasSessionModelsState) return null;
        if (sessionModelsState.availableCount > 0) return null;
        const phase: OptionPickerProbeState['phase'] = lastNonEmptySessionModelOptionsRef.current ? 'refreshing' : 'loading';
        return { phase };
    }, [props.modelOptionsOverride, sessionModelsState.availableCount, sessionModelsState.hasSessionModelsState]);

    React.useEffect(() => {
        if (props.modelOptionsOverride) return;
        if (!sessionModelsState.hasSessionModelsState) {
            lastNonEmptySessionModelOptionsRef.current = null;
            return;
        }
        if (sessionModelsState.availableCount > 0 && modelOptions.length > 0) {
            lastNonEmptySessionModelOptionsRef.current = modelOptions;
        }
    }, [modelOptions, props.modelOptionsOverride, sessionModelsState.availableCount, sessionModelsState.hasSessionModelsState]);

    // Profile data
    const rawProfiles = useSetting('profiles');
    const profiles = React.useMemo(
        () => readUiAiLaunchProfilesForLegacyUi(rawProfiles),
        [rawProfiles],
    );
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
    const sessionPermissionModeApplyTiming = useSetting('sessionPermissionModeApplyTiming');

    const historyScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const messageHistory = useUserMessageHistory({
        scope: historyScope,
        sessionId: props.sessionId ?? null,
    });

    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const requestComposerFocus = React.useCallback(() => {
        inputRef.current?.focus();
    }, []);
    const lastControlledValueRef = React.useRef(props.value);
    const onChangeTextRef = React.useRef(props.onChangeText);
    const deferredParentTextSyncRef = React.useRef<AgentInputPendingParentTextSync | null>(null);
    const deferredParentTextSyncTimerRef = React.useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
    const composerInputSubmitLocked = props.composerInputLock !== null && props.composerInputLock !== undefined;
    const sendActionDisabled = Boolean(
        props.disabled || props.isSendDisabled || props.isSending || composerInputSubmitLocked,
    );
    const enterToSendEnabled = Platform.OS === 'web'
        ? agentInputEnterToSend === true
        : agentInputEnterToSendNative === true;

    React.useEffect(() => {
        onChangeTextRef.current = props.onChangeText;
    }, [props.onChangeText]);

    React.useEffect(() => {
        props.onComposerFocusRequestChange?.(requestComposerFocus);
        return () => {
            props.onComposerFocusRequestChange?.(null);
        };
    }, [props.onComposerFocusRequestChange, requestComposerFocus]);

    const clearDeferredParentTextSync = React.useCallback(() => {
        if (deferredParentTextSyncTimerRef.current !== null) {
            globalThis.clearTimeout(deferredParentTextSyncTimerRef.current);
            deferredParentTextSyncTimerRef.current = null;
        }
        deferredParentTextSyncRef.current = null;
    }, []);

    const flushDeferredParentTextSync = React.useCallback(() => {
        const pending = deferredParentTextSyncRef.current;
        if (!pending) return null;
        if (deferredParentTextSyncTimerRef.current !== null) {
            globalThis.clearTimeout(deferredParentTextSyncTimerRef.current);
            deferredParentTextSyncTimerRef.current = null;
        }
        if (!pending.hasFlushed) {
            pending.hasFlushed = true;
            onChangeTextRef.current(pending.text);
        }
        return pending.text;
    }, []);

    const scheduleDeferredParentTextSync = React.useCallback((text: string) => {
        deferredParentTextSyncRef.current = {
            text,
            hasFlushed: false,
        };
        if (deferredParentTextSyncTimerRef.current !== null) {
            globalThis.clearTimeout(deferredParentTextSyncTimerRef.current);
        }
        deferredParentTextSyncTimerRef.current = globalThis.setTimeout(() => {
            deferredParentTextSyncTimerRef.current = null;
            const pending = deferredParentTextSyncRef.current;
            if (!pending || pending.hasFlushed) return;
            pending.hasFlushed = true;
            onChangeTextRef.current(pending.text);
        }, TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS);
    }, []);

    React.useEffect(() => () => {
        if (deferredParentTextSyncTimerRef.current !== null) {
            globalThis.clearTimeout(deferredParentTextSyncTimerRef.current);
            deferredParentTextSyncTimerRef.current = null;
        }
    }, []);

    const handleSend = React.useCallback((options?: AgentInputSendIntentOptions) => {
        if (sendActionDisabled) {
            return;
        }
        const liveInputText = flushDeferredParentTextSync()
            ?? inputRef.current?.flushPendingTextChange?.()
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
            inputRef.current?.blur();
        }
        messageHistory.reset();
        const structuredInputMetaOverrides = buildStructuredInputMetaOverrides({
            mentions: structuredInputMentionsRef.current,
            text: liveInputText,
        });
        const hasStructuredInputMeta = Object.keys(structuredInputMetaOverrides).length > 0;
        const shouldCarryLiveInputText = !props.sessionId || liveInputText !== props.value;
        props.onSend(
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
        flushDeferredParentTextSync,
        props.onSend,
        props.sessionId,
        props.value,
        sendActionDisabled,
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
        // Treat sub-tablet widths as "mobile": prefer a horizontally scrollable action bar.
        return isMobileLayoutWidth(screenWidth) ? 'scroll' : 'wrap';
    }, [agentInputActionBarLayout, screenWidth]);

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
        if (!areLiveInputTextStatusesEqual(liveTextStatusRef.current, nextStatus)) {
            liveTextStatusRef.current = nextStatus;
            setLiveTextStatus(nextStatus);
        }
        updateInputSelectionState(newState.selection);
        props.inputPersistence?.onSelectionChangePersist(newState.selection, newState.text.length);
    }, [hasRetainedHistorySession, messageHistory, props.inputPersistence, updateActiveWordState, updateInputSelectionState, updateStructuredInputMentions]);

    const handleDictationPress = React.useCallback(async () => {
        const admittedSessionId = props.sessionId ?? null;
        if (!admittedSessionId || !dictationComposerAuthorityRef.current.editable) return;
        try {
            const result = await dictation.toggle();
            if (result.kind !== 'completed') return;
            const currentAuthority = dictationComposerAuthorityRef.current;
            if (
                !currentAuthority.editable
                || currentAuthority.sessionId !== admittedSessionId
            ) {
                return;
            }
            if (!result.text) {
                Modal.alert(t('voiceAssistant.dictationNoSpeech'));
                return;
            }
            applyDictationToComposer({
                input: inputRef.current,
                state: inputStateRef.current,
                text: result.text,
            });
        } catch (error) {
            if (
                error instanceof Error
                && error.message === 'mic_permission_denied'
            ) {
                return;
            }
            const busyTranslationKey =
                resolveVoiceDictationStartErrorTranslationKey(error);
            if (busyTranslationKey) {
                Modal.alert(t('common.error'), t(busyTranslationKey));
                return;
            }
            Modal.alert(t('common.error'), t('errors.dictationFailed'));
        }
    }, [dictation.toggle, props.sessionId]);

    React.useEffect(() => {
        if (!dictation.failure) return;
        if (dictation.failure.kind !== 'mic_permission_denied') {
            Modal.alert(
                t('common.error'),
                t(resolveVoiceDictationFailureTranslationKey(dictation.failure.reason)),
            );
        }
        dictation.dismissFailure(dictation.failure.id);
    }, [dictation.dismissFailure, dictation.failure]);

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
     * Dictation transcribes into *this* composer through a session-bound transcriber, so it stays
     * session-scoped. A Voice conversation does not need a session to exist: New Session starts
     * **Global**, and `VoiceComposerPlanetMount` states that target from the session id below.
     */
    const mountsVoiceComposerPlanet = Boolean(voiceEnabled);
    const ownsFieldDictation = Boolean(voiceEnabled && props.sessionId)
        && props.fieldAccessory == null
        && props.submitDictation !== false;
    const dictationPressHandler = voiceEnabled && props.sessionId && props.submitDictation !== false && !ownsFieldDictation
        ? handleDictationPress
        : undefined;
    const dictationStatus = voiceEnabled ? dictation.status : 'idle';
    const dictationActive = dictationStatus !== 'idle';
    // Only the button that *owns* dictation may have its enablement driven by it.
    const submitDictationActive = dictationActive && Boolean(dictationPressHandler);
    const voiceComposerSessionId = props.sessionId ?? null;
    const voiceComposerPlanet = React.useMemo(
        () => <VoiceComposerPlanetMount
            sessionId={voiceComposerSessionId}
            isPresented={props.surfacePresented}
        />,
        [props.surfacePresented, voiceComposerSessionId],
    );
    const trailingAccessory = props.trailingAccessory
        ?? (mountsVoiceComposerPlanet ? voiceComposerPlanet : null);
    const fieldAccessory = props.fieldAccessory
        ?? (ownsFieldDictation
            ? <AgentInputDictationButton
                disabled={!dictationEditable}
                status={dictationStatus}
                onPress={handleDictationPress}
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
        clearDeferredParentTextSync();
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
    }, [clearDeferredParentTextSync, props.value, updateActiveWordState, updateInputSelectionState, updateStructuredInputMentions]);

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
        const isProgrammaticHistoryApply = historyAppliedInputStateRef.current?.state.text === text;
        if (isProgrammaticHistoryApply || !shouldDeferAgentInputParentTextSync(lastControlledValueRef.current, text)) {
            clearDeferredParentTextSync();
            props.onChangeText(text);
            return;
        }
        scheduleDeferredParentTextSync(text);
    }, [clearDeferredParentTextSync, props.onChangeText, scheduleDeferredParentTextSync]);

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
        flushDeferredParentTextSync();
        composerKeyboardLayoutForFocus?.setComposerInputFocused?.(false);
        setIsInputFocused(false);
        props.onComposerFocusChange?.(false);
    }, [composerKeyboardLayoutForFocus, flushDeferredParentTextSync, props.onComposerFocusChange]);

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
            props.onChangeText(next);
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
        if (!props.sessionId || !hasComposerAttentionRequests) return null;
        const sharedProps: Omit<AgentInputPermissionRequestsProps, 'permissionLocationsById'> = {
            sessionId: props.sessionId,
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
        props.sessionId,
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

            const permissionModeOptions = React.useMemo(() => {
                return getPermissionModeOptionsForSession(sessionAgentId, props.metadata ?? null);
            }, [props.metadata, sessionAgentId]);

        const permissionModeOrder = React.useMemo(() => {
            return permissionModeOptions.map((o) => o.value);
        }, [permissionModeOptions]);

    const effectivePermissionPolicy = React.useMemo(() => {
                return describeEffectivePermissionMode({
                    agentType: sessionAgentId,
                    selectedMode: props.permissionMode ?? 'default',
                metadata: props.metadata ?? null,
                applyTiming: sessionPermissionModeApplyTiming ?? 'immediate',
            });
    }, [props.metadata, props.permissionMode, sessionAgentId, sessionPermissionModeApplyTiming]);

    const effectiveModelPolicy = React.useMemo(() => {
        return describeEffectiveModelMode({
            agentType: sessionAgentId,
            selectedModelId: props.modelMode ?? 'default',
            metadata: props.metadata ?? null,
        });
    }, [props.metadata, props.modelMode, sessionAgentId]);

    const selectedModelLabel = React.useMemo(() => {
        const found = findModelOptionForEffectiveModelId(modelOptions, effectiveModelPolicy.selectedModelId);
        if (found) return found.label;
        return effectiveModelPolicy.selectedModelId === 'default'
            ? t('agentInput.model.useCliSettings')
            : effectiveModelPolicy.selectedModelId;
    }, [effectiveModelPolicy.selectedModelId, modelOptions]);

    const appliedModelPresentation = React.useMemo(() => {
        const appliedModelId = effectiveModelPolicy.appliedModelId;
        if (!appliedModelId) return null;
        const found = findModelOptionForEffectiveModelId(modelOptions, appliedModelId);
        const label = found?.label ?? appliedModelId;
        const status: ReportedModelStatus = resolveReportedModelStatus(props.sessionActive);
        return {
            optionValue: found?.value ?? appliedModelId,
            status,
            summary: reportedModelSummary(status, label),
        };
    }, [effectiveModelPolicy.appliedModelId, modelOptions, props.sessionActive]);

    // One line under the section label: what is running, and when a change to it
    // takes effect. Anything a provider adds beyond that stays a note, so the
    // ordinary case is a label, a line and the models — never a paragraph.
    const modelApplyTiming = React.useMemo(() => (
        effectiveModelPolicy.applyScope === 'spawn_only'
            ? t('agentInput.model.applyTimingNewSession')
            : t('agentInput.model.applyTimingNextMessage')
    ), [effectiveModelPolicy.applyScope]);

    const modelNotes = React.useMemo(() => {
        if (props.sessionActive === false) {
            return [t('agentInput.model.selectedForResume')];
        }
        return effectiveModelPolicy.notes;
    }, [effectiveModelPolicy.notes, props.sessionActive]);

    const canEnterCustomModel = React.useMemo(() => {
        return supportsFreeformModelSelectionForSession(sessionAgentId, props.metadata ?? null);
    }, [props.metadata, sessionAgentId]);

    const submitCustomModel = React.useCallback((value: string) => {
        const normalized = value.trim();
        if (!normalized) return;
        props.onModelModeChange?.(normalized);
    }, [props.onModelModeChange]);

    const preflightAcpSessionModeOptions = React.useMemo(() => {
        const raw = props.acpSessionModeOptionsOverride;
        if (!Array.isArray(raw) || raw.length === 0) return null;
        const cleaned = raw
            .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m) => ({
                id: String(m.id),
                name: String(m.name),
                ...(typeof m.description === 'string' ? { description: m.description } : {}),
            }))
            .filter((m) => m.id.trim().length > 0 && m.name.trim().length > 0);
        return cleaned.length > 0 ? cleaned : null;
    }, [props.acpSessionModeOptionsOverride]);

    const sessionModePickerControl = React.useMemo(() => {
        if (!props.onAcpSessionModeChange) return null;
        // When preflight options are provided (e.g. New Session), prefer the override surface so
        // selections can be reflected immediately without relying on session metadata updates.
        if (preflightAcpSessionModeOptions) return null;
        return computeSessionModePickerControl({ agentId: sessionAgentId, metadata: props.metadata ?? null });
    }, [props.metadata, preflightAcpSessionModeOptions, props.onAcpSessionModeChange, sessionAgentId]);

    const preflightAcpSessionModeEffective = React.useMemo(() => {
        const selected = typeof props.acpSessionModeSelectedIdOverride === 'string'
            ? props.acpSessionModeSelectedIdOverride.trim()
            : '';
        const effectiveId = selected || 'default';
        const opt = preflightAcpSessionModeOptions?.find((o) => o.id === effectiveId) ?? null;
        return { id: effectiveId, name: opt?.name ?? (effectiveId === 'default' ? t('common.default') : effectiveId) };
    }, [preflightAcpSessionModeOptions, props.acpSessionModeSelectedIdOverride]);
    const sessionModeOptionsOverrideProbe = props.acpSessionModeOptionsOverrideProbe ?? null;
    const acpConfigOptionsOverrideProbe = props.acpConfigOptionsOverrideProbe ?? null;

    const sessionModeChipControl = React.useMemo(() => {
        if (!props.onAcpSessionModeChange) return null;
        if (sessionModePickerControl) {
            return {
                options: sessionModePickerControl.options,
                selectedId: (
                    sessionModePickerControl.requestedModeId
                    ?? sessionModePickerControl.effectiveModeId
                    ?? 'default'
                ),
                label: sessionModePickerControl.effectiveModeName,
                isPending: sessionModePickerControl.isPending,
            };
        }
        if (preflightAcpSessionModeOptions) {
            return {
                options: preflightAcpSessionModeOptions,
                selectedId: preflightAcpSessionModeEffective.id,
                label: preflightAcpSessionModeEffective.name,
                isPending: false,
            };
        }
        return null;
    }, [
        preflightAcpSessionModeEffective.id,
        preflightAcpSessionModeEffective.name,
        preflightAcpSessionModeOptions,
        props.onAcpSessionModeChange,
        sessionModePickerControl,
    ]);

    const sessionModePickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!sessionModeChipControl) return [];
        const optionsById = new Map(sessionModeChipControl.options.map((option) => [option.id, option]));
        const uniqueIds = Array.from(
            new Set([
                'default',
                ...sessionModeChipControl.options.map((option) => option.id).filter((id) => id && id !== 'default'),
            ]),
        );
        return uniqueIds.map((id) => ({
            id,
            label: optionsById.get(id)?.name ?? (id === 'default' ? t('common.default') : id),
            subtitle: optionsById.get(id)?.description,
        }));
    }, [sessionModeChipControl]);

    const shouldRenderSessionModeChip = React.useMemo(() => {
        return shouldRenderChipForOptions({
            optionCount: sessionModePickerOptions.length,
            showWhenNoOptions: false,
            showWhenSingleOption: false,
        });
    }, [sessionModePickerOptions.length]);

    const sessionModeChipPresentation = React.useMemo(() => {
        return sessionModeChipControl ? resolveSessionModeChipPresentation(sessionModeChipControl) : null;
    }, [sessionModeChipControl]);

    const sessionModeChipInteraction = React.useMemo(() => {
        if (!sessionModeChipControl) return null;
        const selectableOptionIds = Array.from(new Set(
            sessionModeChipControl.options
                .map((option) => option.id?.trim?.() ?? option.id)
                .filter((id): id is string => typeof id === 'string' && id.length > 0),
        ));
        return resolveChipOptionInteraction({
            currentOptionId: sessionModeChipControl.selectedId,
            selectableOptionIds,
            cycleMaxOptions: DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
        });
    }, [sessionModeChipControl]);

    const acpConfigOptionControls = React.useMemo(() => {
        if (!props.onAcpConfigOptionChange) return null;
        if (props.acpConfigOptionsOverride) {
            return computeAcpConfigOptionControlsFromOverride({
                agentId: sessionAgentId,
                configOptions: props.acpConfigOptionsOverride,
                overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
            });
        }
        return computeAcpConfigOptionControls({ agentId: sessionAgentId, metadata: props.metadata ?? null });
    }, [
        sessionAgentId,
        props.acpConfigOptionsOverride,
        props.acpConfigOptionOverridesOverride,
        props.metadata,
        props.onAcpConfigOptionChange,
    ]);

    const selectedModelForControls = React.useMemo(() => (
        findModelOptionForEffectiveModelId(modelOptions, effectiveModelPolicy.selectedModelId)
    ), [effectiveModelPolicy.selectedModelId, modelOptions]);

    const selectedModelOptionControls = React.useMemo(() => {
        const baseControls = props.onAcpConfigOptionChange && selectedModelForControls?.modelOptions?.length
            ? [...(computeAcpConfigOptionControlsFromOverride({
                agentId: sessionAgentId,
                configOptions: selectedModelForControls.modelOptions,
                overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
            }) ?? [])]
            : [];
        const extendedContextControl = props.onModelModeChange
            ? buildExtendedContextModelControl({
                model: selectedModelForControls,
                effectiveModelId: effectiveModelPolicy.selectedModelId,
            })
            : null;
        if (extendedContextControl) baseControls.push(extendedContextControl);
        return baseControls.length > 0 ? baseControls : null;
    }, [
        sessionAgentId,
        effectiveModelPolicy.selectedModelId,
        props.acpConfigOptionOverridesOverride,
        props.onAcpConfigOptionChange,
        props.onModelModeChange,
        selectedModelForControls,
    ]);
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

    const shouldShowModelOptionDescriptions = React.useMemo(() => {
        return modelOptions.some((option) => {
            if (option.value === 'default') return false;
            return typeof option.description === 'string' && option.description.trim().length > 0;
        });
    }, [modelOptions]);

    const unifiedEnginePickerProbe = React.useMemo<OptionPickerProbeState | undefined>(() => {
        return mergeOptionPickerProbes([
            props.modelOptionsOverrideProbe ?? null,
            sessionModelOptionsProbe ?? null,
            props.agentPickerProbe ?? null,
            sessionModeOptionsOverrideProbe ?? null,
            acpConfigOptionsOverrideProbe ?? null,
        ]);
    }, [
        acpConfigOptionsOverrideProbe,
        props.agentPickerProbe,
        props.modelOptionsOverrideProbe,
        sessionModeOptionsOverrideProbe,
        sessionModelOptionsProbe,
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
        props.onModelModeChange,
        handleSelectModelOptionValue,
        submitCustomModel,
        selectedModelOptionControls,
    ]);

    const hasInternalAgentPickerOptions = Boolean(
        props.agentType
        && (props.onModelModeChange || hasSettingsAcpConfigSection),
    );

    const effectiveAgentLabel = React.useMemo(() => {
        if (typeof props.agentLabel === 'string' && props.agentLabel.length > 0) {
            return props.agentLabel;
        }
        return props.agentType && isBundledAgentId(props.agentType)
            ? t(getAgentCore(props.agentType).displayNameKey)
            : '';
    }, [props.agentLabel, props.agentType]);

    const currentAgentPickerRow = React.useMemo<AgentInputChipPickerOption | null>(() => (
        props.agentType
            ? {
                id: `engine:${props.agentType}`,
                label: effectiveAgentLabel,
                icon: (
                    <AgentIcon
                        agentId={props.agentType}
                        size={12}
                        style={{ transform: [{ scale: getAgentPickerIconScale(props.agentType) }] }}
                    />
                ),
            }
            : null
    ), [effectiveAgentLabel, props.agentType]);

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
    });
    useAgentInputExternalPickerRequest({
        requestKey: props.openModelPickerRequestKey,
        open: React.useCallback(() => {
            if (!hasAgentPickerOptions) return;
            openSelectionOverlay('agent', 'chip');
        }, [hasAgentPickerOptions, openSelectionOverlay]),
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

    const effectivePermissionLabel = React.useMemo(() => {
        return getPermissionModeLabelForAgentType(sessionAgentId, effectivePermissionPolicy.effectiveMode);
    }, [effectivePermissionPolicy.effectiveMode, sessionAgentId]);

    const permissionChipLabel = React.useMemo(() => {
        return getPermissionModeBadgeLabelForAgentType(sessionAgentId, effectivePermissionPolicy.effectiveMode);
    }, [effectivePermissionPolicy.effectiveMode, sessionAgentId]);

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
    const armedComposerTarget = resolveArmedComposerContinuation({
        armedContinuationTarget: props.armedContinuationTarget,
    });
    const engineChipLabel = React.useMemo(() => {
        // Selection IS the selection. An armed target with a model chosen names
        // that model; an armed target still on the Agent's own defaults names the
        // Agent, because no model has been chosen to name.
        if (armedComposerTarget) {
            return armedComposerTarget.modelLabel ?? armedComposerTarget.label;
        }
        return hasAgentPickerOptions ? selectedModelLabel : resolvedAgentLabel;
    }, [armedComposerTarget, hasAgentPickerOptions, resolvedAgentLabel, selectedModelLabel]);
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
    const hasPath = Boolean(props.onPathClick || props.pathPopover);
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

    const actionBarShouldScroll = effectiveActionBarLayout === 'scroll';
    const actionBarIsCollapsed = effectiveActionBarLayout === 'collapsed';
    const showSecondaryControlsRow = shouldShowSecondaryControlRow(
        effectiveActionBarLayout,
        hasMachine || hasPath || hasResume,
    );
    const actionChipTransientStyles = React.useMemo(() => ({
        iconOnly: {
            paddingHorizontal: 8,
            gap: 0,
        },
        pressed: {
            opacity: 0.7,
        },
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

    const actionBarFadeColor = React.useMemo(() => {
        return isGlassComposer ? theme.colors.surface.base : theme.colors.input.background;
    }, [isGlassComposer, theme.colors.surface.base, theme.colors.input.background]);

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
        return handlers;
    }, [canStopFromComposer, handleComposerAbortShortcut, handleComposerFocusShortcut]);
    useKeyboardShortcutHandlers(keyboardShortcutHandlers);

    const {
        handleActionMenuPress,
        actionMenuActions,
        hasActionMenuPopoverSections,
    } = useAgentInputActionMenuControls({
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
        profileLabel,
        profileIcon,
        envVarsCount: props.envVarsCount,
        agentLabel: resolvedAgentLabel,
        engineLabel: engineChipLabel,
        machineName: props.machineName,
        currentPath: props.currentPath,
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
    const {
        controlNodes: renderedActionControlNodes,
        secondaryLeadingControls: secondaryLeadingControlsForWrap,
        extraChipAnchorRefsByKey,
    } = useRenderedAgentInputControlRows({
        layout: effectiveActionBarLayout,
        chips: props.extraActionChips,
        overlayAnchorRef,
        onToggleExtraChipCollapsedPopover: (chipKey) => {
            toggleSelectionOverlay('collapsedExtra', 'chip', chipKey);
        },
        themeTint: theme.colors.composer.chipTint,
        showChipLabels,
        showAutoHideChipLabels,
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
        hasAgentSelection: hasAgent,
        agentChipAnchorRef,
        agentId: engineChipAgentId,
        agentLabel: resolvedAgentLabel,
        engineLabel: engineChipLabel,
        onAgentPress: handleAgentPress,
        onAgentIntent: props.onAgentPickerIntent,
        machineChipAnchorRef,
        onMachinePress: handleMachinePress,
        machineName: props.machineName,
        pathChipAnchorRef,
        onPathPress: handlePathPress,
        currentPath: props.currentPath,
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

    const handlePermissionSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        closePermissionPopover();
    }, [closePermissionPopover, props.onPermissionModeChange]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        const eventInputText = event.inputState?.text ?? inputRef.current?.getText?.() ?? inputStateRef.current.text;
        const hasSendableInput = resolveLiveInputTextStatus(eventInputText).hasText || props.hasSendableAttachments === true;
        const sendShortcutAction = resolveComposerSendShortcutAction(event, {
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

        // Original key handling
        if (Platform.OS === 'web') {
            // Shell-like history: only when suggestions are not visible and cursor is at the boundary.
            const historyInputState = resolveHistoryKeyInputState(event, inputStateRef.current);
            const isCollapsedSelection = historyInputState.selection.start === historyInputState.selection.end;
            if (isCollapsedSelection && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
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
    }, [handleCommandMenuKey, props.hasSendableAttachments, handleSend, props.onPermissionModeChange, keyboardShortcutsV2Enabled, keyboardSingleKeyShortcutsEnabled, keyboardShortcutOverridesV1, keyboardShortcutDisabledCommandIdsV1, permissionModeOrder, effectivePermissionPolicy.effectiveMode, messageHistory, applyHistoryInputText, sendActionDisabled, isHistoryBrowsing, hasRetainedHistorySession, enterToSendEnabled, canStopFromComposer, isAborting, runAbortShortcutAction]);

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

    const deferredParentTextSync = deferredParentTextSyncRef.current;
    const renderedComposerInputValue = deferredParentTextSync && props.value === lastControlledValueRef.current
        ? deferredParentTextSync.text
        : props.value;

    return (
        <SyncPerformanceReactProfiler id="sessions.agentInput">
            <View
                ref={stageSpotlightRef}
                collapsable={stageSpotlightProps.active ? false : undefined}
                onLayout={stageSpotlightProps.onLayout}
                pointerEvents={Platform.OS === 'web' ? 'auto' : undefined}
                style={[
                    styles.container,
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
                    agentId={sessionAgentId}
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
                    open={commandMenuOpen}
                    anchor={commandMenuAnchor}
                    query={commandMenuQuery}
                    items={commandMenuItems}
                    selectedIndex={commandMenuSelectedIndex}
                    onMoveUp={commandMenuMoveUp}
                    onMoveDown={commandMenuMoveDown}
                    onSelect={(_item, index) => {
                        handleSuggestionSelect(index);
                    }}
                    onRequestClose={commandMenuOnClose}
                    maxHeight={240}
                    testID={AGENT_INPUT_COMMAND_MENU_TEST_ID}
                />

                {/* Session instrument strip: connection status + context gauge, quota ring,
                    git ±, extension badges, permission chip. Subscribes to the store itself
                    (F-UI-11) so token ticks never re-render this memoized composer. */}
                <SessionInstrumentStrip
                    sessionId={props.sessionId}
                    agentId={sessionAgentId}
                    agentTargetKey={props.agentTargetKey}
                    metadata={props.metadata ?? null}
                    sessionActive={props.sessionActive}
                    currentRunnerProcessIdentity={props.currentRunnerProcessIdentity}
                    connectionStatus={props.connectionStatus ?? null}
                    permission={props.showStatusPermissionMode === false ? null : instrumentStripPermission}
                    quota={props.instrumentQuota ?? null}
                    statusBadges={props.statusBadges}
                    statusTrailingActions={props.statusTrailingActions}
                    activeStatusBadgeKey={props.activeStatusBadgeKey}
                    onActiveStatusBadgeKeyChange={props.onActiveStatusBadgeKeyChange}
                    onGitPress={props.onFileViewerPress}
                />

                {/* Box 2: Action Area (Input + Send) */}
                <View style={[styles.panelShadow, isGlassComposer ? styles.panelShadowGlass : null]}>
                <WebDropTargetView
                    style={[
                        styles.unifiedPanel,
                        isGlassComposer ? styles.unifiedPanelGlass : null,
                        props.panelStyle,
                        typeof hostPanelMaxHeight === 'number' ? { maxHeight: hostPanelMaxHeight } : null,
                    ]}
                    onLayout={(event) => {
                        updateNullableLayoutHeight(setPanelHeightPx, event.nativeEvent.layout.height);
                    }}
                    onDragEnter={composerDropZoneHandlers.onDragEnter}
                    onDragLeave={composerDropZoneHandlers.onDragLeave}
                    onDragOver={composerDropZoneHandlers.onDragOver}
                    onDrop={composerDropZoneHandlers.onDrop}
                >
                    {fileDragActive && typeof props.onAttachmentsAdded === 'function' ? (
                        <View
                            testID="agent-input-drop-overlay"
                            pointerEvents="none"
                            style={[
                                styles.fileDropOverlay,
                                fileDropOverlayBackdropStyle,
                            ]}
                        >
                            <View style={styles.fileDropOverlayContent}>
                                {renderIoniconNode('paperclip', 18, theme.colors.text.primary)}
                                <Text style={styles.fileDropOverlayText}>{t('agentInput.dropToAttach')}</Text>
                            </View>
                        </View>
                    ) : null}
                    {Platform.OS === 'web' ? (
                        <>
                            {fixedComposerAttentionRequestsNode}
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
                                    <MultiTextInput
                                        {...composerInputComboboxProps}
                                        ref={inputRef}
                                        testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionInput : AGENT_INPUT_TEST_IDS.newSessionInput}
                                        textStyle={props.sessionId ? styles.sessionInputText : styles.newSessionInputText}
                                        value={renderedComposerInputValue}
                                        paddingTop={Platform.OS === 'web' ? 10 : 8}
                                        paddingBottom={Platform.OS === 'web' ? 10 : 8}
                                        paddingRight={shouldReserveInputExpansionToggleSpace ? INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT : undefined}
                                        onChangeText={handleComposerTextChange}
                                        placeholder={props.placeholder}
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
                                    {fieldAccessory ? (
                                        <View
                                            style={[
                                                styles.fieldAccessory,
                                                // Takes the toggle's slot while it is hidden; drops
                                                // one row beneath it when the toggle appears.
                                                shouldShowInputExpansionToggle ? styles.fieldAccessoryBelowToggle : null,
                                            ]}
                                        >
                                            {fieldAccessory}
                                        </View>
                                    ) : null}
                                </View>
                            </ScrollView>
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
                                                    currentPath={props.currentPath}
                                                    pathChipAnchorRef={pathChipAnchorRef}
                                                    emptyPathLabel={t('newSession.selectPathTitle')}
                                                    onPathClick={handlePathPress}
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
                                                currentPath={props.currentPath}
                                                pathChipAnchorRef={pathChipAnchorRef}
                                                emptyPathLabel={t('newSession.selectPathTitle')}
                                                onPathClick={handlePathPress}
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
                                    <AgentInputSubmitButton
                                        testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                                        sessionId={props.sessionId}
                                        submitAccessibilityLabel={props.submitAccessibilityLabel}
                                        disabled={submitDictationActive
                                            ? dictationStatus === 'transcribing'
                                            : Boolean(props.disabled || props.isSendDisabled || props.isSending || composerInputSubmitLocked || (!hasSendableContent && !dictationPressHandler && !canStopFromComposer))}
                                        isSending={props.isSending}
                                        isStopping={isAborting}
                                        hasSendableContent={hasSendableContent}
                                        canStop={canStopFromComposer}
                                        hasDedicatedStopControl={Boolean(props.onAbort) && Boolean(props.showAbortButton) && !actionBarIsCollapsed}
                                        dictationPressHandler={dictationPressHandler}
                                        dictationStatus={dictationStatus}
                                        armedContinuationTarget={props.armedContinuationTarget ?? null}
                                        onSend={handleSend}
                                        onStop={handleAbortPress}
                                    />
                                </View>
                                </View>
                            </View>
                        </>
                    ) : (
                        <View style={styles.nativeKeyboardPanelContent}>
                            {fixedComposerAttentionRequestsNode}
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
                                    <MultiTextInput
                                        {...composerInputComboboxProps}
                                        ref={inputRef}
                                        testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionInput : AGENT_INPUT_TEST_IDS.newSessionInput}
                                        textStyle={props.sessionId ? styles.sessionInputText : styles.newSessionInputText}
                                        value={renderedComposerInputValue}
                                        paddingTop={8}
                                        paddingBottom={8}
                                        paddingRight={shouldReserveInputExpansionToggleSpace ? INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT : undefined}
                                        onChangeText={handleComposerTextChange}
                                        placeholder={props.placeholder}
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
                                    {fieldAccessory ? (
                                        <View
                                            style={[
                                                styles.fieldAccessory,
                                                // Takes the toggle's slot while it is hidden; drops
                                                // one row beneath it when the toggle appears.
                                                shouldShowInputExpansionToggle ? styles.fieldAccessoryBelowToggle : null,
                                            ]}
                                        >
                                            {fieldAccessory}
                                        </View>
                                    ) : null}
                                </View>
                            </View>
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
                                                        currentPath={props.currentPath}
                                                        pathChipAnchorRef={pathChipAnchorRef}
                                                        emptyPathLabel={t('newSession.selectPathTitle')}
                                                        onPathClick={handlePathPress}
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
                                                    currentPath={props.currentPath}
                                                    pathChipAnchorRef={pathChipAnchorRef}
                                                    emptyPathLabel={t('newSession.selectPathTitle')}
                                                    onPathClick={handlePathPress}
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
                                        <AgentInputSubmitButton
                                            testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                                            sessionId={props.sessionId}
                                            submitAccessibilityLabel={props.submitAccessibilityLabel}
                                            disabled={submitDictationActive
                                                ? dictationStatus === 'transcribing'
                                                : Boolean(props.disabled || props.isSendDisabled || props.isSending || composerInputSubmitLocked || (!hasSendableContent && !dictationPressHandler && !canStopFromComposer))}
                                            isSending={props.isSending}
                                            isStopping={isAborting}
                                            hasSendableContent={hasSendableContent}
                                            canStop={canStopFromComposer}
                                            hasDedicatedStopControl={Boolean(props.onAbort) && Boolean(props.showAbortButton) && !actionBarIsCollapsed}
                                            dictationPressHandler={dictationPressHandler}
                                            dictationStatus={dictationStatus}
                                            armedContinuationTarget={props.armedContinuationTarget ?? null}
                                            onSend={handleSend}
                                            onStop={handleAbortPress}
                                        />
                                    </View>
                                </View>
                            </View>
                        </View>
                    )}
                </WebDropTargetView>
                </View>
            </View>
            </View>
        </SyncPerformanceReactProfiler>
    );
}));
