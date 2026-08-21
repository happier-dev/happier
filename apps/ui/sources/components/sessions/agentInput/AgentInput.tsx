import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Pressable, ScrollView } from 'react-native';
import { layout } from '@/components/ui/layout/layout';
import { MultiTextInput, KeyPressEvent, type MultiTextInputSubmitBehavior } from '@/components/ui/forms/MultiTextInput';
import {
    TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
    isLargeTextInputValueLength,
} from '@/components/ui/forms/largeTextInputPolicy';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';
import {
    areActiveWordsEqual,
    areLiveInputTextStatusesEqual,
    resolveLiveInputTextStatus,
} from './liveInputState';
import { isGlassComposerSurface } from './composerSurfaceStyle';
import { resolveComposerSelectionRestore } from './composerSelectionRestore';
import { COMPOSER_SURFACE_RADIUS } from './composerContentInset';
import { Typography } from '@/constants/Typography';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { findModelOptionForEffectiveModelId, getModelOptionsForSession, supportsFreeformModelSelectionForSession, type ModelOption } from '@/sync/domains/models/modelOptions';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { Modal } from '@/modal';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeLabelForAgentType,
    getPermissionModeOptionsForSession,
} from '@/sync/domains/permissions/permissionModeOptions';
import { describeEffectivePermissionMode } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { hapticsLight, hapticsError } from '@/components/ui/theme/haptics';
import { type ShakeInstance } from '@/components/ui/feedback/Shaker';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useActiveSuggestions, type ActiveSuggestionsHandler } from '@/components/autocomplete/useActiveSuggestions';
import { TextInputState, MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import { findActiveWord, type ActiveWord } from '@/components/autocomplete/findActiveWord';
import { resolveComposerSuggestionKind } from '@/components/autocomplete/composerSuggestionKinds';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionGrammar';
import { type ModelPickerProbeState } from '@/components/model/ModelPickerOverlay';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
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
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { DEFAULT_AGENT_ID, getAgentBehavior, getAgentCore, resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
// From the registry rather than the catalog facade: this narrows an id the picker
// supplied, which is the same check the send control's presentation resolver makes.
import { isAgentId } from '@/agents/registry/registryCore';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputScrollableChipRow } from './layout/AgentInputScrollableChipRow';
import { PathAndResumeRow } from './layout/PathAndResumeRow';
import {
    getHasAnyAgentInputActions,
    resolveAgentInputActionBarLayout,
    shouldShowSecondaryControlRow,
} from './layout/actionBarLogic';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    clampNumber,
    computeAgentInputDefaultMaxHeight,
    computeAgentInputKeyboardOpenVariableSectionMaxHeight,
    computeMeasuredPanelInputMaxHeight,
    resolveAgentInputHostPanelMaxHeight,
    type AgentInputPanelMaxHeightMode,
} from './inputMaxHeight';
import {
    formatContextTokenCount,
    formatContextUsagePercent,
    getContextUsageState,
    type ContextUsageState,
} from './contextWarning';
import { resolveContextWindowTokens } from './resolveContextWarningWindowTokens';
import { shouldRenderPermissionChip } from './permissionChipVisibility';
import { AgentInputContentPopover, type AgentInputContentPopoverConfig } from './components/AgentInputContentPopover';
import { AgentInputEngineDetail } from './components/AgentInputEngineDetail';
import { AgentInputContextUsageBadge } from './components/AgentInputContextUsageBadge';
import { AgentInputProviderUsageBadge } from './components/AgentInputProviderUsageBadge';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { AgentInputAttachmentsRow } from './components/AgentInputAttachmentsRow';
import { AgentInputOverlayLayer } from './components/AgentInputOverlayLayer';
import { useCommandMenuKeyboard, type CommandMenuAnchor } from '@/components/ui/commandMenu';
import { AgentInputCommandMenu } from './commandMenu/AgentInputCommandMenu';
import { useAgentInputCommandMenu } from './commandMenu/useAgentInputCommandMenu';
import { recordLargeTextInputDiagnostic } from '@/utils/system/userInteractionDiagnostics';
import { resolveAgentInputCommandMenuAnchor } from './commandMenu/resolveAgentInputCommandMenuAnchor';
import { useTextInputCaretRect } from '@/hooks/ui/textInputCaretRect';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import type { PermissionModePickerStyles } from './components/permissionModePickerStyles';
import { AgentInputAttentionRequests } from './components/AgentInputPermissionRequests';
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
import { buildAgentInputSelectionOverlayViewModel } from './selection/buildAgentInputSelectionOverlayViewModel';
import { useAgentInputSelectionAnchors } from './selection/useAgentInputSelectionAnchors';
import { useAgentInputSelectionOverlayController } from './selection/useAgentInputSelectionOverlayController';
import { computeSessionModePickerControl } from '@/sync/domains/sessionControl/sessionModeControl';
import {
    computeSessionConfigOptionControls,
    computeSessionConfigOptionControlsForProvider,
    computeSessionConfigOptionControlsFromOverride,
    type SessionConfigOption,
    type SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { Text } from '@/components/ui/text/Text';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import { resolveApprovalToolCallLocations } from '@/utils/sessions/approvals/resolveApprovalToolCallLocations';
import {
    resolvePermissionPromptSurface,
    shouldShowGenericPermissionPromptForRequest,
} from '@/utils/sessions/permissions/permissionPromptPolicy';
import { buildSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { WebDropTargetView } from '@/components/sessions/files/repositoryTree/WebDropTargetView';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { useLocalSetting } from '@/sync/store/hooks';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import type {
    AgentInputAttachment,
    AgentInputComposerAttachmentBadge,
    AgentInputExtraActionChip,
    AgentInputStatusBadge as AgentInputStatusBadgeDescriptor,
} from './agentInputContracts';
import type { AgentInputSendIntentOptions, AgentInputSendOptions } from './agentInputSendOptions';
import { APPLIED_RUNTIME_MARKER_ICON, resolveAppliedRuntimeStatus } from './appliedRuntimeMarker';
import { resolveArmedComposerContinuation } from './components/agentContinuationSubmitPresentation';
import { AgentInputStatusBadge } from './status/AgentInputStatusBadge';
import type { AgentInputChipPickerOption } from './components/AgentInputChipPickerTypes';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { useComposerKeyboardLayoutContext } from '@/components/sessions/keyboardAvoidance';
import { insertTextAtSelection } from './insertTextAtSelection';
import { subscribeToIosHardwareShiftEnter } from './subscribeToIosHardwareShiftEnter';
import {
    buildStructuredInputMetaOverrides,
    createStructuredInputMentionFromSuggestion,
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from './structuredInputMentions';
import { buildGlassCastShadowStyle } from '@/shadowElevation';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import {
    COMPOSER_ABORT_CONFIRMATION_WINDOW_MS,
    resolveComposerEnterAction,
    resolveComposerEscapeAction,
    resolveComposerSendShortcutAction,
    shouldRunComposerModeCycleShortcut,
} from '@/keyboard/composer';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { StyleProp } from 'react-native';

/**
 * Synthesized model-card toggle id for catalog-declared extended-context model variants
 * (e.g. Claude `[1m]`). NOT a real provider config option: selections route through the
 * model-override pipeline (`onModelModeChange`) with the variant/base model id.
 */
export const EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID = 'extended_context_model';

const NATIVE_ACTION_CHIP_GAP_Y = 1;
const NATIVE_ACTION_BAR_SECTION_GAP_Y = 0;
const WEB_ACTION_BAR_ROW_GAP_Y = 0;
const WEB_ACTION_BAR_ROW_GAP_MOBILE_Y = 0;
const ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT = 30;
const STATUS_ROW_ITEM_GAP = 8;
const STATUS_ROW_WRAP_GAP = 4;
const INPUT_EXPANSION_TOGGLE_SHOW_OFFSET_PX = 1;
const INPUT_EXPANSION_TOGGLE_HIDE_OFFSET_PX = 12;
const INPUT_EXPANSION_TOGGLE_INPUT_PADDING_RIGHT = 32;
const AGENT_INPUT_CONTAINER_VERTICAL_PADDING = 4;
const AGENT_INPUT_CONTAINER_VERTICAL_CHROME_HEIGHT = AGENT_INPUT_CONTAINER_VERTICAL_PADDING * 2;
const AGENT_INPUT_PANEL_PADDING_TOP = 2;
const AGENT_INPUT_PANEL_PADDING_BOTTOM = 8;
// Composer panel corner radius. Shared by the panel surface, its cast-shadow wrapper so the drop
// shadow follows the same rounded shape, and the auxiliary banners stacked above the panel.
const AGENT_INPUT_PANEL_RADIUS = COMPOSER_SURFACE_RADIUS;
const AGENT_INPUT_PANEL_VERTICAL_CHROME_HEIGHT = AGENT_INPUT_PANEL_PADDING_TOP + AGENT_INPUT_PANEL_PADDING_BOTTOM;
const AGENT_INPUT_VARIABLE_SECTION_CONTENT_PADDING_BOTTOM = 4;
const EMPTY_PERMISSION_LOCATIONS_BY_ID = new Map<string, PermissionToolCallMessageLocation | null>();
const AGENT_INPUT_TEST_IDS = {
    sessionInput: 'session-composer-input',
    sessionSend: 'session-composer-send',
    newSessionInput: 'new-session-composer-input',
    newSessionSend: 'new-session-composer-send',
    connectionStatusText: 'agent-input-connection-status-text',
} as const;

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

interface AgentInputProps {
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    sessionId?: string;
    onSend: (options?: AgentInputSendOptions) => void;
    submitAccessibilityLabel?: string;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onPermissionClick?: () => void;
    onAcpSessionModeChange?: (modeId: string) => void;
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
    acpSessionModeOptionsOverrideProbe?: ModelPickerProbeState;
    acpConfigOptionsOverride?: ReadonlyArray<SessionConfigOption>;
    acpConfigOptionsOverrideProbe?: ModelPickerProbeState;
    acpConfigOptionOverridesOverride?: AcpConfigOptionOverridesV1 | null;
    onSessionConfigOptionChange?: (configId: string, valueId: SessionConfigOptionValueId) => void;
    modelMode?: ModelMode;
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
    modelOptionsOverrideProbe?: ModelPickerProbeState;
    metadata?: Metadata | null;
    /** Whether the existing session runtime is active. Omit for pre-session composers. */
    sessionActive?: boolean;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
    };
    statusBadges?: ReadonlyArray<AgentInputStatusBadgeDescriptor>;
    activeStatusBadgeKey?: string | null;
    onActiveStatusBadgeKeyChange?: (key: string | null) => void;
    /** Eligible suggestion kinds for this composer host. Trigger characters follow from the kinds (INV-1). */
    autocompleteKinds: readonly ComposerSuggestionKindId[];
    /** Receives an abort signal for the query it is resolving; a superseded query is never applied (D-15). */
    autocompleteSuggestions: ActiveSuggestionsHandler;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindowTokens?: number;
    };
    providerUsageGauge?: ConnectedServiceQuotaGaugeViewModel | null;
    onProviderUsageRecoveryCreditPress?: () => void;
    providerUsageRecoveryCreditPending?: boolean;
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: AgentId;
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
    attachments?: ReadonlyArray<AgentInputAttachment>;
    onAttachmentsAdded?: (files: readonly File[]) => void;
    hasSendableAttachments?: boolean;
    permissionRequests?: ReadonlyArray<PendingPermissionRequest>;
    approvalRequests?: ReadonlyArray<OpenApprovalArtifactForSession>;
    canApprovePermissions?: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
}

function AgentInputAttentionRequestsWithLocations(
    props: Omit<React.ComponentProps<typeof AgentInputAttentionRequests>, 'permissionLocationsById' | 'approvalLocationsByArtifactId'>
) {
    const { ids: committedMessageIdsOldestFirst } = useSessionTranscriptIds(props.sessionId);
    const committedMessagesById = useSessionMessagesById(props.sessionId);
    const committedMessagesReducerState = useSessionMessagesReducerState(props.sessionId);
    const permissionLocationVersion = useSessionMessagesVersion(props.sessionId, props.permissionRequests.length > 0);
    const approvalLocationVersion = useSessionMessagesVersion(props.sessionId, (props.approvalRequests?.length ?? 0) > 0);

    const permissionLocationsById = React.useMemo(() => {
        if (props.permissionRequests.length === 0) {
            return EMPTY_PERMISSION_LOCATIONS_BY_ID;
        }

        const ids = props.permissionRequests.map((request) => request.id);
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
        const approvalRequests = props.approvalRequests ?? [];
        if (approvalRequests.length === 0) {
            return EMPTY_PERMISSION_LOCATIONS_BY_ID;
        }

        return new Map(
            resolveApprovalToolCallLocations({
                approvals: approvalRequests.map((entry) => ({
                    artifactId: entry.artifact.id,
                    approval: entry.approval,
                })),
                sessionId: props.sessionId,
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
        approvalLocationVersion,
        committedMessageIdsOldestFirst,
        committedMessagesById,
        committedMessagesReducerState,
        props.approvalRequests,
        props.sessionId,
    ]);

    return (
        <AgentInputAttentionRequests
            {...props}
            permissionLocationsById={permissionLocationsById}
            approvalLocationsByArtifactId={approvalLocationsByArtifactId}
        />
    );
}

type AgentInputHiddenUsageOverflowProps = Readonly<{
    contextUsageState?: ContextUsageState | null;
    providerUsageGauge?: ConnectedServiceQuotaGaugeViewModel | null;
    onProviderUsageRecoveryCreditPress?: () => void;
    providerUsageRecoveryCreditPending?: boolean;
    marginLeft?: number;
}>;

function AgentInputHiddenUsageOverflow(props: AgentInputHiddenUsageOverflowProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<any>(null);
    const [open, setOpen] = React.useState(false);
    const contextUsageState = props.contextUsageState ?? null;
    const usedPercentageLabel = contextUsageState
        ? formatContextUsagePercent(contextUsageState.usedPercentage)
        : null;
    const usedTokensLabel = contextUsageState
        ? formatContextTokenCount(contextUsageState.usedTokens)
        : null;
    const contextWindowTokensLabel = contextUsageState
        ? formatContextTokenCount(contextUsageState.contextWindowTokens)
        : null;
    const contextDetail = contextUsageState && usedPercentageLabel && usedTokensLabel && contextWindowTokensLabel
        ? t('agentInput.context.usedDetail', {
            percent: usedPercentageLabel,
            used: usedTokensLabel,
            total: contextWindowTokensLabel,
        })
        : null;
    const providerUsageGauge = props.providerUsageGauge ?? null;
    const providerRecoveryCreditSummary = providerUsageGauge?.recoveryCreditSummary ?? null;

    if (!contextDetail && !providerUsageGauge) return null;

    return (
        <>
            <Pressable
                ref={anchorRef}
                testID="agent-input-hidden-usage-overflow"
                accessibilityRole="button"
                accessibilityLabel={t('agentInput.usageOverflow.accessibilityLabel')}
                onPress={() => setOpen((value) => !value)}
                style={({ pressed }) => [
                    styles.hiddenUsageOverflow,
                    { marginLeft: props.marginLeft ?? 0 },
                    pressed ? styles.hiddenUsageOverflowPressed : null,
                ]}
            >
                <Icon name="dots-three" size={14} color={theme.colors.text.secondary} />
            </Pressable>
            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => setOpen(false)}
                maxWidthCap={340}
                scrollEnabled={false}
                testID="agent-input-hidden-usage-overflow-popover"
                content={(
                    <View style={styles.hiddenUsageOverflowContent}>
                        {contextDetail ? (
                            <View style={styles.hiddenUsageOverflowSection}>
                                <Text style={styles.hiddenUsageOverflowTitle}>
                                    {t('agentInput.context.windowTitle')}
                                </Text>
                                <Text style={styles.hiddenUsageOverflowDetail}>
                                    {contextDetail}
                                </Text>
                            </View>
                        ) : null}
                        {providerUsageGauge ? (
                            <View style={styles.hiddenUsageOverflowSection}>
                                <Text style={styles.hiddenUsageOverflowTitle}>
                                    {t('agentInput.providerUsage.title')}
                                </Text>
                                <Text style={styles.hiddenUsageOverflowDetail}>
                                    {providerUsageGauge.detailRightLabel}
                                </Text>
                                {providerUsageGauge.usedLimitLabel ? (
                                    <Text style={styles.hiddenUsageOverflowSubdetail}>
                                        {providerUsageGauge.usedLimitLabel}
                                    </Text>
                                ) : null}
                                {providerRecoveryCreditSummary ? (
                                    <>
                                        <Text style={styles.hiddenUsageOverflowSubdetail}>
                                            {t('connectedServices.quota.recoveryCreditTitle', { count: providerRecoveryCreditSummary.availableCount })}
                                        </Text>
                                        <Text style={styles.hiddenUsageOverflowSubdetail}>
                                            {typeof providerRecoveryCreditSummary.nextExpiresAtMs === 'number'
                                                ? t('connectedServices.quota.recoveryCreditExpires', { time: new Date(providerRecoveryCreditSummary.nextExpiresAtMs).toLocaleString() })
                                                : t('connectedServices.quota.recoveryCreditSubtitle')}
                                        </Text>
                                        {props.onProviderUsageRecoveryCreditPress ? (
                                            <Pressable
                                                testID="agent-input-hidden-provider-usage-recovery-credit-action"
                                                accessibilityRole="button"
                                                disabled={props.providerUsageRecoveryCreditPending === true}
                                                onPress={props.onProviderUsageRecoveryCreditPress}
                                                style={({ pressed }) => [
                                                    styles.hiddenUsageOverflowAction,
                                                    pressed ? styles.hiddenUsageOverflowActionPressed : null,
                                                    props.providerUsageRecoveryCreditPending === true ? styles.hiddenUsageOverflowActionDisabled : null,
                                                ]}
                                            >
                                                <Text style={styles.hiddenUsageOverflowActionText}>
                                                    {props.providerUsageRecoveryCreditPending === true
                                                        ? t('connectedServices.quota.recoveryCreditApplying')
                                                        : t('session.usageLimitRecovery.consumeResetCreditAction')}
                                                </Text>
                                            </Pressable>
                                        ) : null}
                                    </>
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                )}
            />
        </>
    );
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        width: '100%',
        paddingBottom: 8,
        paddingTop: 8,
    },
    containerMobileBottomSpacing: {
        paddingBottom: 0,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
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
        position: 'relative',
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
        flex: 1,
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
    statusTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 12,
    },
    inputExpansionToggle: {
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 2,
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputExpansionTogglePressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    hiddenUsageOverflow: {
        width: 20,
        height: 20,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    hiddenUsageOverflowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    hiddenUsageOverflowContent: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
    },
    hiddenUsageOverflowSection: {
        gap: 6,
    },
    hiddenUsageOverflowTitle: {
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
        ...Typography.header(),
    },
    hiddenUsageOverflowDetail: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    hiddenUsageOverflowSubdetail: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    hiddenUsageOverflowAction: {
        alignSelf: 'flex-start',
        minHeight: 28,
        justifyContent: 'center',
        borderRadius: 6,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    hiddenUsageOverflowActionPressed: {
        opacity: 0.82,
    },
    hiddenUsageOverflowActionDisabled: {
        opacity: 0.58,
    },
    hiddenUsageOverflowActionText: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
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
    actionButtonsSecondaryScroll: {
        alignSelf: 'stretch',
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 32,
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
    const [rootHeightPx, setRootHeightPx] = React.useState<number | null>(null);
    const [panelHeightPx, setPanelHeightPx] = React.useState<number | null>(null);
    const [inputContainerHeightPx, setInputContainerHeightPx] = React.useState<number | null>(null);
    const [inputContentHeightPx, setInputContentHeightPx] = React.useState<number | null>(null);
    const [inputExpansionToggleVisible, setInputExpansionToggleVisible] = React.useState(false);
    const [actionFooterHeightPx, setActionFooterHeightPx] = React.useState<number>(0);
    const [composerAttentionHeightPx, setComposerAttentionHeightPx] = React.useState<number>(0);
    const [variableContentBeforeInputHeightPx, setVariableContentBeforeInputHeightPx] = React.useState<number>(0);
    const effectivePanelMaxHeight = React.useMemo(() => {
        if (typeof hostPanelMaxHeight !== 'number') return undefined;
        const nonPanelChromeHeight = rootHeightPx != null && panelHeightPx != null
            ? Math.max(0, rootHeightPx - panelHeightPx)
            : 0;
        return Math.max(0, hostPanelMaxHeight - nonPanelChromeHeight);
    }, [hostPanelMaxHeight, panelHeightPx, rootHeightPx]);
    const panelVariableSectionMaxHeight = React.useMemo(() => {
        if (typeof effectivePanelMaxHeight !== 'number') return undefined;
        return computeAgentInputKeyboardOpenVariableSectionMaxHeight({
            panelMaxHeight: effectivePanelMaxHeight,
            footerHeight: actionFooterHeightPx + composerAttentionHeightPx,
        });
    }, [actionFooterHeightPx, composerAttentionHeightPx, effectivePanelMaxHeight]);
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
            panelMaxHeight: effectivePanelMaxHeight,
            panelHeight: panelHeightPx,
            inputContainerHeight: inputContainerHeightPx,
            inputContainerChromeHeight: AGENT_INPUT_CONTAINER_VERTICAL_CHROME_HEIGHT,
            minimumFixedChromeHeight: minimumMeasuredPanelFixedChromeHeight,
            fallbackMaxHeight: fallbackInputMaxHeight,
            fallbackMaxHeightMode: props.sessionId ? 'cap' : 'seed',
        });
    }, [
        fallbackInputMaxHeight,
        effectivePanelMaxHeight,
        inputContainerHeightPx,
        minimumMeasuredPanelFixedChromeHeight,
        panelHeightPx,
        props.sessionId,
    ]);
    const inputExpansionCollapsedMaxHeight = typeof props.inputExpansion?.collapsedMaxHeight === 'number'
        && Number.isFinite(props.inputExpansion.collapsedMaxHeight)
        && props.inputExpansion.collapsedMaxHeight > 0
        ? props.inputExpansion.collapsedMaxHeight
        : null;
    const handleInputContentHeightChange = React.useCallback((height: number) => {
        updateNullableLayoutHeight(setInputContentHeightPx, height);
    }, []);
    const hasInputExpansion = Boolean(props.inputExpansion);
    React.useEffect(() => {
        setInputExpansionToggleVisible((currentVisible) => {
            if (!hasInputExpansion || inputExpansionCollapsedMaxHeight == null || inputContentHeightPx == null) {
                return false;
            }
            if (currentVisible) {
                return inputContentHeightPx >= inputExpansionCollapsedMaxHeight - INPUT_EXPANSION_TOGGLE_HIDE_OFFSET_PX;
            }
            return inputContentHeightPx > inputExpansionCollapsedMaxHeight + INPUT_EXPANSION_TOGGLE_SHOW_OFFSET_PX;
        });
    }, [hasInputExpansion, inputContentHeightPx, inputExpansionCollapsedMaxHeight]);
    const shouldShowInputExpansionToggle = hasInputExpansion && inputExpansionToggleVisible;
    const shouldReserveInputExpansionToggleSpace = hasInputExpansion && inputExpansionCollapsedMaxHeight != null;
    const composerAnchorRef = React.useRef<View>(null);
    const [liveTextStatus, setLiveTextStatus] = React.useState(() => resolveLiveInputTextStatus(props.value));
    const liveTextStatusRef = React.useRef(liveTextStatus);
    const hasText = liveTextStatus.hasText;
    const hasSendableContent = hasText || props.hasSendableAttachments === true;
    const micPressHandler = voiceEnabled ? props.onMicPress : undefined;
    const micActive = voiceEnabled && props.isMicActive === true;
    const [fileDragActive, setFileDragActive] = React.useState(false);

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
    const hasComposerAttentionRequests = Boolean(
        props.sessionId
        && showComposerPermissionCards
        && (
            composerPermissionRequests.length > 0
            || pendingApprovalRequests.length > 0
        ),
    );

    React.useEffect(() => {
        if (!hasComposerAttentionRequests) {
            updateLayoutHeight(setComposerAttentionHeightPx, 0);
        }
    }, [hasComposerAttentionRequests]);
    const agentId: AgentId = resolveAgentIdFromFlavor(props.metadata?.flavor) ?? props.agentType ?? DEFAULT_AGENT_ID;
    const lastNonEmptySessionModelOptionsRef = React.useRef<readonly ModelOption[] | null>(null);
    React.useEffect(() => {
        lastNonEmptySessionModelOptionsRef.current = null;
    }, [agentId, props.sessionId]);

    const sessionModelsState = React.useMemo(() => {
        if (props.modelOptionsOverride) return { hasSessionModelsState: false, availableCount: 0 };
        const raw = readSessionModelsState(props.metadata ?? null);
        const provider = typeof raw?.provider === 'string' ? raw.provider.trim() : '';
        if (!provider || provider !== agentId) return { hasSessionModelsState: false, availableCount: 0 };
        const available = Array.isArray(raw?.availableModels) ? raw.availableModels : [];
        return { hasSessionModelsState: true, availableCount: available.length };
    }, [agentId, props.metadata, props.modelOptionsOverride]);

    const baseModelOptions = React.useMemo(() => {
        if (props.modelOptionsOverride) return props.modelOptionsOverride;
        return getModelOptionsForSession(agentId, props.metadata ?? null);
    }, [agentId, props.metadata, props.modelOptionsOverride]);

    const modelOptions = React.useMemo(() => {
        if (props.modelOptionsOverride) return baseModelOptions;
        if (sessionModelsState.hasSessionModelsState && sessionModelsState.availableCount === 0) {
            const sticky = lastNonEmptySessionModelOptionsRef.current;
            if (sticky && sticky.length > 0) return sticky;
        }
        return baseModelOptions;
    }, [baseModelOptions, props.modelOptionsOverride, sessionModelsState.availableCount, sessionModelsState.hasSessionModelsState]);

    const sessionModelOptionsProbe = React.useMemo<ModelPickerProbeState | null>(() => {
        if (props.modelOptionsOverride) return null;
        if (!sessionModelsState.hasSessionModelsState) return null;
        if (sessionModelsState.availableCount > 0) return null;
        const phase: ModelPickerProbeState['phase'] = lastNonEmptySessionModelOptionsRef.current ? 'refreshing' : 'loading';
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
    const profiles = useSetting('profiles');
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

            const profileIcon = React.useMemo(() => {
                // Always show a stable "profile" icon so the chip reads as Profile selection (not "current provider").
                return 'user-circle';
            }, []);

    const supportsExactContextUsageBadge = React.useMemo(
        () => getAgentBehavior(agentId).sessionUsage?.supportsExactContextUsageBadge !== false,
        [agentId],
    );

    const contextWindowTokens = React.useMemo(
        () => (
            supportsExactContextUsageBadge
                ? resolveContextWindowTokens({ agentId, metadata: props.metadata ?? null, usageData: props.usageData })
                : null
        ),
        [agentId, props.metadata, props.usageData, supportsExactContextUsageBadge],
    );

    const contextUsageState = supportsExactContextUsageBadge && (
        (props.usageData && typeof props.usageData.contextSize === 'number')
        || props.alwaysShowContextSize === true
    )
        ? getContextUsageState(
            props.usageData?.contextSize ?? 0,
            props.alwaysShowContextSize ?? false,
            contextWindowTokens,
        )
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');
    const agentInputEnterToSendNative = useSetting('agentInputEnterToSendNative');
    const enterToSendEnabled = Platform.OS === 'web'
        ? agentInputEnterToSend === true
        : agentInputEnterToSendNative === true;
    const agentInputHistoryScope = useSetting('agentInputHistoryScope');
    const agentInputActionBarLayout = useSetting('agentInputActionBarLayout');
    const agentInputChipDensity = useSetting('agentInputChipDensity');
    const sessionPermissionModeApplyTiming = useSetting('sessionPermissionModeApplyTiming');
    const isGlassComposer = isGlassComposerSurface({ setting: useSetting('composerSurfaceStyle') });

    const historyScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const messageHistory = useUserMessageHistory({
        scope: historyScope,
        sessionId: props.sessionId ?? null,
    });

    const sendActionDisabled = Boolean(props.disabled || props.isSendDisabled || props.isSending);
    const inputRef = React.useRef<MultiTextInputHandle>(null);
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
    const lastControlledValueRef = React.useRef(props.value);
    const onChangeTextRef = React.useRef(props.onChangeText);
    const deferredParentTextSyncRef = React.useRef<AgentInputPendingParentTextSync | null>(null);
    const deferredParentTextSyncTimerRef = React.useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
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
        onChangeTextRef.current = props.onChangeText;
    }, [props.onChangeText]);

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
        typeof messageHistory.isBrowsing === 'function' && messageHistory.isBrowsing()
    ), [messageHistory]);

    const hasRetainedHistorySession = React.useCallback(() => (
        typeof messageHistory.hasRetainedSession === 'function' && messageHistory.hasRetainedSession()
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
        // SB-7 — one reconciler for every text change, live edit or programmatic swap alike.
        // It used to be two, because maintaining a mention's `[start, end)` needed the selection
        // an edit replaced to resolve the changed span. A mention is now kept by whether the text
        // still contains its token, which needs neither the previous text nor the selection.
        updateStructuredInputMentions((current) => reconcileStructuredInputMentionsWithText({
            text: newState.text,
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
            text: props.value,
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
            text: props.value,
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
            updateInputSelectionState(nextState.selection);
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
        props.onSend(
            options?.forceImmediate === true || options?.deliveryIntent != null || hasStructuredInputMeta
                ? {
                    ...(options?.forceImmediate === true ? { forceImmediate: true } : {}),
                    ...(options?.deliveryIntent != null ? { deliveryIntent: options.deliveryIntent } : {}),
                    ...(hasStructuredInputMeta ? { structuredInputMetaOverrides } : {}),
                    ...(liveInputText !== props.value ? { inputTextOverride: liveInputText } : {}),
                }
                : (liveInputText !== props.value ? { inputTextOverride: liveInputText } : undefined),
        );
    }, [
        messageHistory,
        flushDeferredParentTextSync,
        props.onSend,
        props.sessionId,
        props.value,
        sendActionDisabled,
        updateInputSelectionState,
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
        return resolveAgentInputActionBarLayout({
            configuredLayout: agentInputActionBarLayout,
            platform: Platform.OS,
            isMobileLayout: isMobileLayoutWidth(screenWidth),
        });
    }, [agentInputActionBarLayout, screenWidth]);

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
    }, [composerKeyboardLayoutForFocus, messageHistory, props.autocompleteKinds]);

    const handleComposerBlur = React.useCallback(() => {
        flushDeferredParentTextSync();
        composerKeyboardLayoutForFocus?.setComposerInputFocused?.(false);
        setIsInputFocused(false);
    }, [composerKeyboardLayoutForFocus, flushDeferredParentTextSync]);

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
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeSuggestionQuery, props.autocompleteSuggestions, { wrapAround: true });

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];
        const currentInputState = inputStateRef.current;
        const activeWordForSelection = findActiveWord(currentInputState.text, currentInputState.selection, props.autocompleteKinds);

        const applyResolvedSelection = (result: Readonly<{ text: string; cursorPosition: number }>) => {
            inputRef.current?.setTextAndSelection(result.text, {
                start: result.cursorPosition,
                end: result.cursorPosition
            });
        };

        const applyDefaultSelection = () => {
            const result = applySuggestion(
                currentInputState.text,
                currentInputState.selection,
                suggestion.text,
                props.autocompleteKinds,
                true
            );
            applyResolvedSelection(result);

            const mention = createStructuredInputMentionFromSuggestion({ suggestion });
            if (mention) {
                // Re-picking the same candidate inserts the same token, so it replaces rather
                // than accumulating. A mention whose token the new text no longer carries is
                // dropped by the reconciler on the state change this insertion produces.
                updateStructuredInputMentions((current) => [
                    ...current.filter((existing) => existing.tokenText !== mention.tokenText),
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
            }).then((result) => {
                if (result.handled) {
                    applyResolvedSelection(result);
                } else {
                    applyDefaultSelection();
                }
            }).catch((e: unknown) => {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
            }).finally(() => {
                hapticsLight();
            });
            return;
        }

        applyDefaultSelection();
        hapticsLight();
    }, [suggestions, props.autocompleteKinds, updateStructuredInputMentions]);

    // --- Command Menu adapter ---
    // Bridges existing autocomplete state into the CommandMenu primitive shape.
    // D46: The adapter manages an explicit dismissed-trigger-key so Escape
    // does not rely on selection-collapse to close the menu.
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
        activeWord,
        activeWordRange: activeWordState
            ? { start: activeWordState.offset, end: activeWordState.endOffset }
            : null,
        inputTextLength: liveTextStatus.length,
        moveUp,
        moveDown,
        handleSuggestionSelect,
    });

    // D21: The keyboard hook returns `handleKey` that returns `true` if consumed.
    // Wired into handleKeyPress below, AFTER send/abort, BEFORE enter-to-send/history.
    const { handleKey: handleCommandMenuKey } = useCommandMenuKeyboard({
        open: commandMenuOpen,
        onMoveUp: commandMenuMoveUp,
        onMoveDown: commandMenuMoveDown,
        onSelect: commandMenuOnSelect,
        onClose: commandMenuOnClose,
    });

    // Caret-rect anchor with runtime fallback (D33/D34/D38/D42).
    //
    // - D38: `enabled` tracks composer focus (NOT menu-open) so the native
    //   selection-change subscription is active *before* `/` triggers a menu
    //   open, ensuring the first selection event has already been consumed
    //   by the time we need the rect.
    // - D34: no feature flag. The runtime guard `caretRect ? rect : view`
    //   in `resolveAgentInputCommandMenuAnchor` is the only rollback path.
    // - D42: do not pre-offset the caret rect; `Popover` placement + `gap`
    //   position the popup relative to the caret.
    // - D33: `MultiTextInputHandle` satisfies the `TextInputCaretRectHandle`
    //   shape (`measureInWindow`, `getReactNodeTag`, `getInputElement`), so
    //   `inputRef` is passed directly with no cast.
    const caretRect = useTextInputCaretRect({
        inputRef,
        selection: inputSelection,
        // D38: focus-scoped, NOT menu-scoped. Adding `&& activeWord !== null` here
        // (collateral drift in 795326144) released the keyboard-controller subscription
        // until the trigger character was typed, so the selection event for that very
        // keystroke landed in an empty handler map and the menu's first paint fell back
        // to the composer-view anchor — the "menu appears at the top of the composer,
        // then jumps on the next keystroke" report.
        enabled: isInputFocused && !props.disabled,
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

            const permissionModeOptions = React.useMemo(() => {
                return getPermissionModeOptionsForSession(agentId, props.metadata ?? null);
            }, [agentId, props.metadata]);

        const permissionModeOrder = React.useMemo(() => {
            return permissionModeOptions.map((o) => o.value);
        }, [permissionModeOptions]);

    const effectivePermissionPolicy = React.useMemo(() => {
                return describeEffectivePermissionMode({
                    agentType: agentId,
                    selectedMode: props.permissionMode ?? 'default',
                metadata: props.metadata ?? null,
                applyTiming: sessionPermissionModeApplyTiming ?? 'immediate',
            });
    }, [agentId, props.metadata, props.permissionMode, sessionPermissionModeApplyTiming]);

    const effectiveModelPolicy = React.useMemo(() => {
        return describeEffectiveModelMode({
            agentType: agentId,
            selectedModelId: props.modelMode ?? 'default',
            metadata: props.metadata ?? null,
        });
    }, [agentId, props.metadata, props.modelMode]);

    const selectedModelLabel = React.useMemo(() => {
        const found = findModelOptionForEffectiveModelId(modelOptions, effectiveModelPolicy.selectedModelId);
        if (found) {
            return found.extendedContextModelId === effectiveModelPolicy.selectedModelId
                ? t('agentInput.model.extendedContextLabel', { model: found.label })
                : found.label;
        }
        return effectiveModelPolicy.selectedModelId === 'default'
            ? t('agentInput.model.useCliSettings')
            : effectiveModelPolicy.selectedModelId;
    }, [effectiveModelPolicy.selectedModelId, modelOptions]);

    const appliedModelPresentation = React.useMemo(() => {
        const appliedModelId = effectiveModelPolicy.appliedModelId;
        if (!appliedModelId) return null;
        const found = findModelOptionForEffectiveModelId(modelOptions, appliedModelId);
        const label = found
            ? (found.extendedContextModelId === appliedModelId
                ? t('agentInput.model.extendedContextLabel', { model: found.label })
                : found.label)
            : appliedModelId;
        // Both the status and its glyph come from the shared owner, because the
        // Agent rail in the same popover draws the same mark beside the Session's
        // Agent and the two columns must not disagree about one Session.
        const status = resolveAppliedRuntimeStatus(props.sessionActive);
        return {
            optionValue: found?.value ?? appliedModelId,
            iconName: APPLIED_RUNTIME_MARKER_ICON[status],
            summary: t(`agentInput.model.${status}`, { model: label }),
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
        return supportsFreeformModelSelectionForSession(agentId, props.metadata ?? null);
    }, [agentId, props.metadata]);

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
        return computeSessionModePickerControl({ agentId, metadata: props.metadata ?? null });
    }, [agentId, props.metadata, preflightAcpSessionModeOptions, props.onAcpSessionModeChange]);

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
        if (!props.onSessionConfigOptionChange) return null;
        if (props.acpConfigOptionsOverride) {
            return computeSessionConfigOptionControlsForProvider({
                providerId: agentId,
                configOptions: props.acpConfigOptionsOverride,
                overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
                hideModeOption: Boolean(sessionModeChipControl),
                hideModelOption: modelOptions.length > 0,
            });
        }
        return computeSessionConfigOptionControls({ agentId, metadata: props.metadata ?? null });
    }, [
        agentId,
        modelOptions.length,
        props.acpConfigOptionsOverride,
        props.acpConfigOptionOverridesOverride,
        props.metadata,
        props.onSessionConfigOptionChange,
        sessionModeChipControl,
    ]);

    const selectedModelForControls = React.useMemo(() => {
        return findModelOptionForEffectiveModelId(modelOptions, effectiveModelPolicy.selectedModelId);
    }, [effectiveModelPolicy.selectedModelId, modelOptions]);

    const selectedModelOptionControls = React.useMemo(() => {
        if (!props.onSessionConfigOptionChange) return null;
        const selectedModel = selectedModelForControls;
        if (!selectedModel) return null;
        const baseControls = selectedModel.modelOptions?.length
            ? computeSessionConfigOptionControlsFromOverride({
                agentId,
                configOptions: selectedModel.modelOptions,
                overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
            }) ?? []
            : [];
        // Extended-context (e.g. Claude `[1m]`) is a MODEL-ID VARIANT, not a config option:
        // the toggle is synthesized here and routed through the model-override pipeline.
        if (selectedModel.extendedContextModelId && props.onModelModeChange) {
            const extendedSelected = effectiveModelPolicy.selectedModelId === selectedModel.extendedContextModelId;
            const value = extendedSelected ? 'true' : 'false';
            baseControls.push({
                option: {
                    id: EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID,
                    name: t('agentInput.model.extendedContextToggleLabel'),
                    description: t('agentInput.model.extendedContextToggleDescription'),
                    type: 'boolean',
                    currentValue: value,
                },
                effectiveValue: value,
                isPending: false,
            });
        }
        return baseControls.length > 0 ? baseControls : null;
    }, [
        agentId,
        effectiveModelPolicy.selectedModelId,
        selectedModelForControls,
        props.acpConfigOptionOverridesOverride,
        props.onSessionConfigOptionChange,
        props.onModelModeChange,
    ]);

    const handleSelectModelOptionValue = React.useCallback((configId: string, valueId: SessionConfigOptionValueId) => {
        if (configId === EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID) {
            const selectedModel = selectedModelForControls;
            if (!selectedModel?.extendedContextModelId) return;
            hapticsLight();
            props.onModelModeChange?.(valueId === 'true' ? selectedModel.extendedContextModelId : selectedModel.value);
            return;
        }
        hapticsLight();
        props.onSessionConfigOptionChange?.(configId, valueId);
    }, [props.onSessionConfigOptionChange, props.onModelModeChange, selectedModelForControls]);
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

    const renderResolvedEngineDetail = React.useCallback((surfaceVariant: 'carded' | 'plain' = 'carded') => (
        <AgentInputEngineDetail
            modelOptions={modelOptions.map((option) => ({
                value: option.value,
                label: option.label,
                ...(appliedModelPresentation?.optionValue === option.value
                    ? {
                        trailingStatusIcon: (
                            <Icon
                                name={appliedModelPresentation.iconName}
                                size={16}
                                color={theme.colors.text.secondary}
                            />
                        ),
                        accessibilityLabel: appliedModelPresentation.summary,
                    }
                    : {}),
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
            onSelectModel={(value) => {
                hapticsLight();
                props.onModelModeChange?.(value);
            }}
            onSubmitCustomValue={canEnterCustomModel ? submitCustomModel : undefined}
            selectedModelOptionControls={selectedModelOptionControls}
            onSelectModelOptionValue={props.onSessionConfigOptionChange ? handleSelectModelOptionValue : undefined}
            configControls={acpConfigOptionControls}
            onSelectConfigValue={
                props.onSessionConfigOptionChange
                    ? (configId, valueId) => {
                        hapticsLight();
                        props.onSessionConfigOptionChange?.(configId, valueId);
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
        modelNotes,
        modelOptions,
        appliedModelPresentation,
        unifiedEnginePickerProbe,
        shouldShowModelOptionDescriptions,
        props.onSessionConfigOptionChange,
        props.onModelModeChange,
        submitCustomModel,
        selectedModelOptionControls,
        handleSelectModelOptionValue,
        theme.colors.text.secondary,
    ]);

    const hasInternalAgentPickerOptions = Boolean(
        props.agentType
        && (props.onModelModeChange || hasSettingsAcpConfigSection),
    );

    const currentAgentPickerRow = React.useMemo<AgentInputChipPickerOption | null>(() => (
        props.agentType
            ? {
                id: `engine:${props.agentType}`,
                label: props.agentLabel ?? t(getAgentCore(props.agentType).displayNameKey),
                icon: (
                    <AgentIcon
                        agentId={props.agentType}
                        size={12}
                        style={{ transform: [{ scale: getAgentPickerIconScale(props.agentType) }] }}
                    />
                ),
            }
            : null
    ), [props.agentLabel, props.agentType]);

    const internalAgentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!hasInternalAgentPickerOptions || !props.agentType || !currentAgentPickerRow) return [];
        return [{
            ...currentAgentPickerRow,
            deferRenderDetailContent: true,
            deferredDetailContentCacheKey: `session-engine:${props.agentType}`,
            renderDetailContent: () => renderResolvedEngineDetail('carded'),
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
    const composerKeyboardLayout = useComposerKeyboardLayoutContext();

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
    const statusBadgeAnchorRef = React.useRef<any>(null);
    const [uncontrolledActiveStatusBadgeKey, setUncontrolledActiveStatusBadgeKey] = React.useState<string | null>(null);
    const activeStatusBadgeKey = props.activeStatusBadgeKey !== undefined
        ? props.activeStatusBadgeKey
        : uncontrolledActiveStatusBadgeKey;
    const setActiveStatusBadgeKey = props.onActiveStatusBadgeKeyChange ?? setUncontrolledActiveStatusBadgeKey;
    const closeActionMenu = React.useCallback(() => {
        setShowActionMenu(false);
    }, []);
    const closeStatusBadgePopover = React.useCallback(() => {
        setActiveStatusBadgeKey(null);
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
        retainKeyboardLift: composerKeyboardLayout?.retainKeyboardLift,
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
        return getPermissionModeLabelForAgentType(agentId, effectivePermissionPolicy.effectiveMode);
    }, [agentId, effectivePermissionPolicy.effectiveMode]);

    const activeStatusBadge = React.useMemo(() => (
        activeStatusBadgeKey
            ? props.statusBadges?.find((badge) => badge.key === activeStatusBadgeKey) ?? null
            : null
    ), [activeStatusBadgeKey, props.statusBadges]);

    const permissionChipLabel = React.useMemo(() => {
        return getPermissionModeBadgeLabelForAgentType(agentId, effectivePermissionPolicy.effectiveMode);
    }, [agentId, effectivePermissionPolicy.effectiveMode]);

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
        agentType: props.agentType,
        agentLabel: props.agentLabel,
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
    /**
     * The mark on the engine chip: the armed Agent while one is armed, otherwise
     * the Agent running this Session.
     *
     * Scoped to the chip on purpose. `agentId` above still resolves the RUNNING
     * Agent, because permission modes, model options and session modes are facts
     * about what is running — only this one control is about what runs next.
     */
    const engineChipAgentId: AgentId = (
        armedComposerTarget && isAgentId(armedComposerTarget.agentId)
            ? armedComposerTarget.agentId
            : agentId
    );
    const engineChipLabel = React.useMemo(() => {
        // Selection IS the selection. An armed target with a model chosen names
        // that model; an armed target still on the Agent's own defaults names the
        // Agent, because no model has been chosen to name.
        if (armedComposerTarget) {
            return armedComposerTarget.modelLabel ?? armedComposerTarget.label;
        }
        return hasAgentPickerOptions ? selectedModelLabel : resolvedAgentLabel;
    }, [armedComposerTarget, hasAgentPickerOptions, resolvedAgentLabel, selectedModelLabel]);
    const hasRecipient = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'recipient');
    }, [props.extraActionChips]);
    const hasDelivery = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'delivery');
    }, [props.extraActionChips]);
    const hasExtraActionChips = (props.extraActionChips?.length ?? 0) > 0;
    const composerAttachmentBadges = React.useMemo<readonly AgentInputComposerAttachmentBadge[]>(() => {
        return (props.extraActionChips ?? [])
            .map((chip) => chip.composerAttachmentBadge)
            .filter((badge): badge is AgentInputComposerAttachmentBadge => Boolean(badge));
    }, [props.extraActionChips]);
    const hasVariableContentBeforeInput = (props.attachments?.length ?? 0) > 0 || composerAttachmentBadges.length > 0;
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

    // Fade the chip rows out to the composer's own fill: the glass surface in glass
    // mode, the standard input background otherwise.
    const actionBarFadeColor = React.useMemo(() => {
        return isGlassComposer ? theme.colors.surface.base : theme.colors.input.background;
    }, [isGlassComposer, theme.colors.surface.base, theme.colors.input.background]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;
        abortConfirmationExpiresAtRef.current = 0;

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
        // The engine control names what runs NEXT, so it follows the armed target.
        agentId: engineChipAgentId,
        profileLabel,
        profileIcon,
        envVarsCount: props.envVarsCount,
        engineLabel: engineChipLabel,
        agentType: props.agentType,
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
        // The engine chip names what runs NEXT, so it follows the armed target.
        agentId: engineChipAgentId,
        hasAgentSelection: hasAgent,
        agentChipAnchorRef,
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

        // D21: Command menu keyboard navigation — THIRD in precedence.
        // Replaces the old inline autocomplete navigation block.
        // useCommandMenuKeyboard handles ArrowUp/Down, Enter, Tab (no-shift), Escape.
        // Shift+Tab returns false so Shift+Tab permission-mode cycling still works.
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
        const hasSendableInput = liveTextStatus.hasText || props.hasSendableAttachments === true;
        if (!hasSendableInput) return;
        handleSend();
    }, [enterToSendEnabled, handleSend, liveTextStatus.hasText, props.hasSendableAttachments, sendActionDisabled]);

    const submitBehavior = React.useMemo<MultiTextInputSubmitBehavior | undefined>(() => {
        if (Platform.OS === 'web') return undefined;
        return enterToSendEnabled ? 'submit' : 'newline';
    }, [enterToSendEnabled]);

    const handlePanelFilesDropped = React.useCallback((event: any) => {
        const files = extractWebAttachmentFilesFromDataTransfer(event?.dataTransfer);
        if (files.length > 0) {
            props.onAttachmentsAdded?.(files);
        }
    }, [props.onAttachmentsAdded]);

    const panelDropZoneHandlers = useWebFileDropZone({
        enabled: Platform.OS === 'web' && typeof props.onAttachmentsAdded === 'function',
        onFilesDropped: handlePanelFilesDropped,
        onFileDragActiveChange: setFileDragActive,
    });

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
    const deferredParentTextSync = deferredParentTextSyncRef.current;
    const renderedComposerInputValue = deferredParentTextSync && props.value === lastControlledValueRef.current
        ? deferredParentTextSync.text
        : props.value;

    const renderComposerInput = () => (
        <View
            ref={composerAnchorRef}
            collapsable={false}
            testID="agent-input-composer-input-container"
            style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}
            onLayout={(event) => {
                updateNullableLayoutHeight(setInputContainerHeightPx, event.nativeEvent.layout.height);
            }}
        >
            <MultiTextInput
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
                editable={!props.disabled}
                onFilesPasted={props.onAttachmentsAdded}
                onContentHeightChange={handleInputContentHeightChange}
            />
            {props.inputExpansion && shouldShowInputExpansionToggle ? (
                <Pressable
                    accessibilityLabel={props.inputExpansion.expanded ? t('common.collapse') : t('common.expand')}
                    accessibilityRole="button"
                    hitSlop={8}
                    testID="agent-input-expand-toggle"
                    onPress={props.inputExpansion.onToggle}
                    style={({ pressed }) => [
                        styles.inputExpansionToggle,
                        pressed ? styles.inputExpansionTogglePressed : null,
                    ]}
                >
                    {renderIoniconNode(
                        props.inputExpansion.expanded ? 'arrows-in' : 'arrows-out',
                        16,
                        theme.colors.text.secondary,
                    )}
                </Pressable>
            ) : null}
        </View>
    );

    const renderComposerAttentionRequests = () => (
        props.sessionId && hasComposerAttentionRequests ? (
            <View
                testID="agentInput.permissionRequests.fixed"
                onLayout={(event) => {
                    updateLayoutHeight(setComposerAttentionHeightPx, event.nativeEvent.layout.height);
                }}
            >
                {composerPermissionRequests.length > 0 || pendingApprovalRequests.length > 0 ? (
                    <AgentInputAttentionRequestsWithLocations
                        sessionId={props.sessionId}
                        permissionRequests={composerPermissionRequests}
                        approvalRequests={pendingApprovalRequests}
                        metadata={props.metadata || null}
                        canApprovePermissions={canApprovePermissions}
                        disabledReason={props.permissionDisabledReason}
                        maxHeightPx={permissionRequestsMaxHeightPx}
                        onContentSizeChange={(_w, h) => {
                            permissionRequestsFades.onContentSizeChange?.(_w, h);
                        }}
                        onLayout={(e) => {
                            permissionRequestsFades.onViewportLayout?.(e);
                        }}
                        onScroll={(e) => {
                            permissionRequestsFades.onScroll?.(e);
                        }}
                        fadeVisibility={permissionRequestsFades.visibility}
                    />
                ) : (
                    <AgentInputAttentionRequests
                        sessionId={props.sessionId}
                        permissionRequests={composerPermissionRequests}
                        approvalRequests={pendingApprovalRequests}
                        permissionLocationsById={EMPTY_PERMISSION_LOCATIONS_BY_ID}
                        approvalLocationsByArtifactId={EMPTY_PERMISSION_LOCATIONS_BY_ID}
                        metadata={props.metadata || null}
                        canApprovePermissions={canApprovePermissions}
                        disabledReason={props.permissionDisabledReason}
                        maxHeightPx={permissionRequestsMaxHeightPx}
                        onContentSizeChange={(_w, h) => {
                            permissionRequestsFades.onContentSizeChange?.(_w, h);
                        }}
                        onLayout={(e) => {
                            permissionRequestsFades.onViewportLayout?.(e);
                        }}
                        onScroll={(e) => {
                            permissionRequestsFades.onScroll?.(e);
                        }}
                        fadeVisibility={permissionRequestsFades.visibility}
                    />
                )}
            </View>
        ) : null
    );

    const renderVariableContentBeforeInput = () => {
        if (!hasVariableContentBeforeInput) return null;

        const attachmentsRow = (
            <AgentInputAttachmentsRow
                attachments={props.attachments ?? []}
                composerBadges={composerAttachmentBadges}
            />
        );

        if (Platform.OS !== 'web') {
            return attachmentsRow;
        }

        return (
            <View
                testID="agent-input-variable-content-before-input"
                onLayout={(event) => {
                    updateLayoutHeight(setVariableContentBeforeInputHeightPx, event.nativeEvent.layout.height);
                }}
            >
                {attachmentsRow}
            </View>
        );
    };

    const renderComposerVariableContent = () => (
        <>
            {renderVariableContentBeforeInput()}
            {renderComposerInput()}
        </>
    );

    const renderActionRows = () => (
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
                    <AgentInputSubmitButton
                        testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                        sessionId={props.sessionId}
                        submitAccessibilityLabel={props.submitAccessibilityLabel}
                        disabled={Boolean(props.disabled || props.isSendDisabled || props.isSending || (!hasSendableContent && !micPressHandler && !canStopFromComposer))}
                        isSending={props.isSending}
                        isStopping={isAborting}
                        hasSendableContent={hasSendableContent}
                        canStop={canStopFromComposer}
                        micPressHandler={micPressHandler}
                        micActive={micActive}
                        armedContinuationTarget={props.armedContinuationTarget ?? null}
                        onSend={handleSend}
                        onStop={handleAbortPress}
                    />
                </View>,
                showSecondaryControlsRow ? (
                    actionBarShouldScroll ? (
                        <AgentInputScrollableChipRow
                            key="row2"
                            containerStyle={styles.actionButtonsSecondaryScroll}
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
        </View>
    );

    const renderActionFooterSection = () => (
        <View
            style={styles.nativeKeyboardFooterSection}
            onLayout={(event) => {
                updateLayoutHeight(setActionFooterHeightPx, event.nativeEvent.layout.height);
            }}
        >
            {renderActionRows()}
        </View>
    );

    const hasStatusIndicators = Boolean(
        props.connectionStatus || contextUsageState || props.providerUsageGauge || (props.statusBadges && props.statusBadges.length > 0),
    );
    const statusRowElement = hasStatusIndicators ? (
        <>
            <View style={[
                styles.statusContainer,
                isMobileLayoutWidth(screenWidth) ? { paddingBottom: 0, paddingTop: 4 } : undefined,
            ]}>
                <View style={styles.statusRow}>
                    {props.connectionStatus && (
                        <View style={styles.connectionStatusGroup}>
                            <StatusDot
                                color={props.connectionStatus.dotColor}
                                isPulsing={props.connectionStatus.isPulsing}
                                size={6}
                                style={styles.statusDot}
                            />
                            <Text
                                testID={AGENT_INPUT_TEST_IDS.connectionStatusText}
                                style={[styles.statusText, { color: props.connectionStatus.color }]}
                            >
                                {props.connectionStatus.text}
                            </Text>
                        </View>
                    )}
                    {props.statusBadges?.map(({ key, renderPopover, onPress, ...badge }) => (
                        <AgentInputStatusBadge
                            key={key}
                            anchorRef={renderPopover ? statusBadgeAnchorRef : undefined}
                            onPress={renderPopover
                                ? () => {
                                    setActiveStatusBadgeKey(activeStatusBadgeKey === key ? null : key);
                                    onPress?.();
                                }
                                : onPress}
                            renderPopover={renderPopover}
                            {...badge}
                        />
                    ))}
                </View>
                <View testID="agent-input-status-trailing" style={styles.statusTrailing}>
                    <View style={[
                        styles.permissionModeContainer,
                        (contextUsageState || props.providerUsageGauge) ? { marginRight: 8 } : null,
                    ]}>
                        {shouldRenderPermissionChip(permissionChipLabel) ? (
                            <Text
                                style={[
                                    styles.permissionModeText,
                                    {
                                        color: effectivePermissionPolicy.effectiveMode === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                                            effectivePermissionPolicy.effectiveMode === 'bypassPermissions' ? theme.colors.permission.bypass :
                                                effectivePermissionPolicy.effectiveMode === 'plan' ? theme.colors.permission.plan :
                                                    effectivePermissionPolicy.effectiveMode === 'read-only' ? theme.colors.permission.readOnly :
                                                        effectivePermissionPolicy.effectiveMode === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                                            effectivePermissionPolicy.effectiveMode === 'yolo' ? theme.colors.permission.yolo :
                                                                theme.colors.text.secondary,
                                    },
                                ]}
                            >
                                {permissionChipLabel}
                            </Text>
                        ) : null}
                    </View>
                    {(() => {
                        const showOnlyOneGauge = screenWidth < 375 && Boolean(contextUsageState && props.providerUsageGauge);
                        const providerIsMoreUrgent = props.providerUsageGauge?.tone === 'critical'
                            || (props.providerUsageGauge?.tone === 'warning' && contextUsageState?.severity !== 'critical');
                        const showProviderGauge = Boolean(props.providerUsageGauge) && (!showOnlyOneGauge || providerIsMoreUrgent);
                        const showContextGauge = Boolean(contextUsageState) && (!showOnlyOneGauge || !providerIsMoreUrgent);
                        const hiddenContextUsageState = showOnlyOneGauge && !showContextGauge ? contextUsageState : null;
                        const hiddenProviderUsageGauge = showOnlyOneGauge && !showProviderGauge ? props.providerUsageGauge : null;
                        const showHiddenGaugeOverflow = Boolean(hiddenContextUsageState || hiddenProviderUsageGauge);
                        return (
                            <>
                                {showContextGauge && contextUsageState ? (
                                    <AgentInputContextUsageBadge state={contextUsageState} />
                                ) : null}
                                {showProviderGauge && props.providerUsageGauge ? (
                                    <AgentInputProviderUsageBadge
                                        viewModel={props.providerUsageGauge}
                                        marginLeft={showContextGauge ? 8 : 0}
                                        onRecoveryCreditPress={props.onProviderUsageRecoveryCreditPress}
                                        recoveryCreditActionPending={props.providerUsageRecoveryCreditPending}
                                    />
                                ) : null}
                                {showHiddenGaugeOverflow ? (
                                    <AgentInputHiddenUsageOverflow
                                        contextUsageState={hiddenContextUsageState}
                                        providerUsageGauge={hiddenProviderUsageGauge}
                                        onProviderUsageRecoveryCreditPress={props.onProviderUsageRecoveryCreditPress}
                                        providerUsageRecoveryCreditPending={props.providerUsageRecoveryCreditPending}
                                        marginLeft={(showContextGauge || showProviderGauge) ? 8 : 0}
                                    />
                                ) : null}
                            </>
                        );
                    })()}
                </View>
            </View>
            {activeStatusBadge?.renderPopover?.({
                open: true,
                anchorRef: statusBadgeAnchorRef,
                onRequestClose: closeStatusBadgePopover,
            })}
        </>
    ) : null;

    return (
        <SyncPerformanceReactProfiler id="sessions.agentInput">
            <View
                pointerEvents={Platform.OS === 'web' ? 'auto' : undefined}
                testID="agent-input-root"
                onLayout={(event) => {
                    updateNullableLayoutHeight(setRootHeightPx, event.nativeEvent.layout.height);
                }}
                style={[
                    styles.container,
                    { paddingHorizontal: props.contentPaddingHorizontal ?? (screenWidth > 700 ? 16 : 8) },
                    // On phone layouts the status row is the lowest composer element and the
                    // floating cockpit bar floats its capsule directly beneath it — the bar owns
                    // the whole gap (its topGap), so the container adds no extra bottom padding.
                    isMobileLayoutWidth(screenWidth) ? styles.containerMobileBottomSpacing : null,
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
                    screenWidth={screenWidth}
                    showPermissionPopover={showPermissionPopover && Boolean(props.onPermissionModeChange)}
                    permissionChipAnchorRef={permissionChipAnchorRef}
                    onPermissionPopoverRequestClose={closePermissionPopover}
                    onPermissionSelect={handlePermissionSelect}
                    agentId={agentId}
                    permissionModeOptions={permissionModeOptions}
                    effectivePermissionMode={effectivePermissionPolicy.effectiveMode}
                    effectivePermissionLabel={effectivePermissionLabel}
                    effectivePermissionPolicy={effectivePermissionPolicy}
                    // FR4-16: Unistyles' inferred output type may not structurally
                    // match the narrow `PermissionModePickerStyles` contract, so
                    // we use a documented boundary cast here. The contract is
                    // enforced inside the overlay + picker; this cast is the only
                    // narrow seam between Unistyles and the typed picker fields.
                    styles={styles as unknown as PermissionModePickerStyles}
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
                {/* CommandMenu renders autocomplete suggestions with caret-anchor fallback. */}
                <AgentInputCommandMenu
                    open={commandMenuOpen}
                    anchor={commandMenuAnchor}
                    query={commandMenuQuery}
                    items={commandMenuItems}
                    selectedIndex={commandMenuSelectedIndex}
                    onMoveUp={commandMenuMoveUp}
                    onMoveDown={commandMenuMoveDown}
                    onSelect={(item, index) => {
                        handleSuggestionSelect(index);
                    }}
                    onRequestClose={commandMenuOnClose}
                    maxHeight={240}
                    testID="agent-input-command-menu"
                />
                {/* Connection status, context usage, and permission mode */}
                {isMobileLayoutWidth(screenWidth) ? null : statusRowElement}

                {/* Box 2: Action Area (Input + Send) */}
                <View style={[styles.panelShadow, isGlassComposer ? styles.panelShadowGlass : null]}>
                <WebDropTargetView
                    testID="agent-input-drop-zone"
                    style={[
                        styles.unifiedPanel,
                        isGlassComposer ? styles.unifiedPanelGlass : null,
                        props.panelStyle,
                        typeof effectivePanelMaxHeight === 'number' ? { maxHeight: effectivePanelMaxHeight } : null,
                    ]}
                    onLayout={(event) => {
                        updateNullableLayoutHeight(setPanelHeightPx, event.nativeEvent.layout.height);
                    }}
                    {...panelDropZoneHandlers}
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
                            {renderComposerAttentionRequests()}
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
                            >
                                {renderComposerVariableContent()}
                            </ScrollView>
                            {renderActionFooterSection()}
                        </>
                    ) : (
                        <View style={styles.nativeKeyboardPanelContent}>
                            {renderComposerAttentionRequests()}
                            <View
                                style={[
                                    styles.nativeKeyboardVariableSection,
                                    styles.nativeKeyboardVariableSectionContent,
                                    typeof panelVariableSectionMaxHeight === 'number'
                                        ? { maxHeight: panelVariableSectionMaxHeight }
                                        : null,
                                ]}
                            >
                                {renderComposerVariableContent()}
                            </View>
                            {renderActionFooterSection()}
                        </View>
                    )}
                </WebDropTargetView>
                </View>
                {/* On mobile, status row renders below the composer to extend chat space. */}
                {isMobileLayoutWidth(screenWidth) ? statusRowElement : null}
                </View>
            </View>
        </SyncPerformanceReactProfiler>
    );
}));
