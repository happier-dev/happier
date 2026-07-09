import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    Ionicons,
    Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View,
    Platform,
    useWindowDimensions,
    ViewStyle,
    Pressable,
    ScrollView } from 'react-native';
import { layout } from '@/components/ui/layout/layout';
import { useComposerKeyboardLayoutContext } from '@/components/sessions/keyboardAvoidance';
import { createBackdropNativeStyle,
    createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { MultiTextInput,
    KeyPressEvent,
    type MultiTextInputSubmitBehavior } from '@/components/ui/forms/MultiTextInput';
import {
    TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
    isLargeTextInputValueLength,
} from '@/components/ui/forms/largeTextInputPolicy';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';
import { Typography } from '@/constants/Typography';
import type { PermissionMode,
    ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { findModelOptionForEffectiveModelId,
    getModelOptionsForSession,
    supportsFreeformModelSelectionForSession,
    type ModelOption } from '@/sync/domains/models/modelOptions';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { Modal } from '@/modal';
import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeLabelForAgentType,
    getPermissionModeOptionsForSession,
    } from '@/sync/domains/permissions/permissionModeOptions';
import { describeEffectivePermissionMode } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { hapticsLight,
    hapticsError } from '@/components/ui/theme/haptics';
import { type ShakeInstance } from '@/components/ui/feedback/Shaker';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { findActiveWord,
    type ActiveWord } from '@/components/autocomplete/findActiveWord';
import { useActiveSuggestions } from '@/components/autocomplete/useActiveSuggestions';
import { TextInputState,
    MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import { useCommandMenuKeyboard,
    type CommandMenuAnchor } from '@/components/ui/commandMenu';
import { useTextInputCaretRect } from '@/hooks/ui/textInputCaretRect';
import { type ModelPickerProbeState } from '@/components/model/ModelPickerOverlay';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { StyleSheet,
    useUnistyles } from 'react-native-unistyles';
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
import { getProfileEnvironmentVariables,
    type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { DEFAULT_AGENT_ID,
    getAgentCore,
    type AgentId,
} from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputScrollableChipRow } from './layout/AgentInputScrollableChipRow';
import { PathAndResumeRow } from './layout/PathAndResumeRow';
import { getHasAnyAgentInputActions, shouldShowSecondaryControlRow } from './layout/actionBarLogic';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    clampNumber,
    computeAgentInputDefaultMaxHeight,
    computeAgentInputKeyboardOpenVariableSectionMaxHeight,
    computeMeasuredPanelInputMaxHeight,
    resolveAgentInputHostPanelMaxHeight,
    type AgentInputPanelMaxHeightMode,
} from './inputMaxHeight';
import { getContextWarning } from './contextWarning';
import { resolveContextWarningWindowTokens } from './resolveContextWarningWindowTokens';
import { shouldRenderPermissionChip } from './permissionChipVisibility';
import { type AgentInputContentPopoverConfig } from './components/AgentInputContentPopover';
import { AgentInputEngineDetail } from './components/AgentInputEngineDetail';
import { AgentInputProviderUsageBadge } from './components/AgentInputProviderUsageBadge';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { AgentInputAttachmentsRow } from './components/AgentInputAttachmentsRow';
import { AgentInputOverlayLayer } from './components/AgentInputOverlayLayer';
import { AgentInputExpansionToggle } from './components/AgentInputExpansionToggle';
import { AgentInputPermissionRequests } from './components/AgentInputPermissionRequests';
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
import type { AcpConfigOptionOverridesV1, SessionContextUsageSnapshotV1 } from '@happier-dev/protocol';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import type {
    AgentInputAttachment,
    AgentInputComposerAttachmentBadge,
    AgentInputExtraActionChip,
    AgentInputStatusBadge as AgentInputStatusBadgeDescriptor,
} from './agentInputContracts';
import type { AgentInputSendIntentOptions, AgentInputSendOptions } from './agentInputSendOptions';
import { AgentInputStatusBadge } from './status/AgentInputStatusBadge';
import type { AgentInputChipPickerOption } from './components/AgentInputChipPickerTypes';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { insertTextAtSelection } from './insertTextAtSelection';
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
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
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
import {
    areActiveWordsEqual,
    areLiveInputTextStatusesEqual,
    resolveLiveInputTextStatus,
} from './liveInputState';

const NATIVE_ACTION_CHIP_GAP_Y = 1;
const NATIVE_ACTION_BAR_SECTION_GAP_Y = 6;
const WEB_ACTION_BAR_ROW_GAP_Y = 2;
const WEB_ACTION_BAR_ROW_GAP_MOBILE_Y = 1;
const ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT = 30;
const STATUS_ROW_ITEM_GAP = 8;
const STATUS_ROW_WRAP_GAP = 4;
const AGENT_INPUT_CONTAINER_VERTICAL_PADDING = 4;
const AGENT_INPUT_CONTAINER_VERTICAL_CHROME_HEIGHT = AGENT_INPUT_CONTAINER_VERTICAL_PADDING * 2;
const AGENT_INPUT_PANEL_PADDING_TOP = 2;
const AGENT_INPUT_PANEL_PADDING_BOTTOM = 8;
// Composer panel corner radius. Shared by the panel surface and its cast-shadow
// wrapper so the drop shadow follows the same rounded shape.
const AGENT_INPUT_PANEL_RADIUS = Platform.select({ default: 16, android: 20 });
const AGENT_INPUT_PANEL_VERTICAL_CHROME_HEIGHT = AGENT_INPUT_PANEL_PADDING_TOP + AGENT_INPUT_PANEL_PADDING_BOTTOM;
const AGENT_INPUT_VARIABLE_SECTION_CONTENT_PADDING_BOTTOM = 4;

const AGENT_INPUT_TEST_IDS = {
    sessionInput: 'session-composer-input',
    sessionSend: 'session-composer-send',
    newSessionInput: 'new-session-composer-input',
    newSessionSend: 'new-session-composer-send',
    connectionStatusText: 'agent-input-connection-status-text',
} as const;

export type AgentInputAutocompleteSelectionResult = Readonly<{
    handled: boolean;
    text?: string;
    cursorPosition?: number;
}>;

export type AgentInputAutocompleteSelectionHandler = (args: Readonly<{
    input: string;
    selection: Readonly<{ start: number; end: number }>;
    activeWord: ActiveWord | undefined;
    suggestion: AutocompleteSuggestion;
}>) => Promise<AgentInputAutocompleteSelectionResult> | AgentInputAutocompleteSelectionResult;

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
    acpSessionModeOptionsOverrideProbe?: ModelPickerProbeState;
    acpConfigOptionsOverride?: ReadonlyArray<AcpConfigOption>;
    acpConfigOptionsOverrideProbe?: ModelPickerProbeState;
    acpConfigOptionOverridesOverride?: AcpConfigOptionOverridesV1 | null;
    onAcpConfigOptionChange?: (configId: string, valueId: AcpConfigOptionValueId) => void;
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
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
    };
    providerUsageGauge?: ConnectedServiceQuotaGaugeViewModel | null;
    onProviderUsageRecoveryCreditPress?: () => void;
    providerUsageRecoveryCreditPending?: boolean;
    statusBadges?: ReadonlyArray<AgentInputStatusBadgeDescriptor>;
    activeStatusBadgeKey?: string | null;
    onActiveStatusBadgeKeyChange?: (key: string | null) => void;
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<AutocompleteSuggestion[]>;
    onAutocompleteSuggestionSelect?: AgentInputAutocompleteSelectionHandler;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindowTokens?: number;
        contextSnapshot?: SessionContextUsageSnapshotV1;
        contextSnapshotStale?: boolean;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: AgentId;
    agentLabel?: string | null;
    onAgentClick?: () => void;
    agentPickerTitle?: string;
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
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
    contextWarningText: {
        fontSize: 11,
        marginLeft: 8,
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
            name: React.ComponentProps<typeof Ionicons>['name'],
            size: number,
            color: string,
            style?: React.ComponentProps<typeof Ionicons>['style'],
        ) => normalizeNodeForView(<Ionicons name={name} size={size} color={color} style={style} />),
        [],
    );
    const renderOcticonNode = React.useCallback(
        (
            name: React.ComponentProps<typeof Octicons>['name'],
            size: number,
            color: string,
            style?: React.ComponentProps<typeof Octicons>['style'],
        ) => normalizeNodeForView(<Octicons name={name} size={size} color={color} style={style} />),
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
    const micPressHandler = voiceEnabled ? props.onMicPress : undefined;
    const micActive = voiceEnabled && props.isMicActive === true;
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

    const agentId: AgentId = resolveAgentIdFromSessionMetadata(props.metadata) ?? DEFAULT_AGENT_ID;
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
                return 'person-circle-outline';
            }, []);

    const contextWindowTokens = React.useMemo(
        () => resolveContextWarningWindowTokens({
            agentId,
            metadata: props.metadata ?? null,
            usageData: props.usageData,
        }),
        [agentId, props.metadata, props.usageData],
    );

    const contextWarning = React.useMemo(() => {
        const alwaysShow = props.alwaysShowContextSize ?? false;
        if (typeof contextWindowTokens !== 'number') {
            return null;
        }
        if (!props.usageData && !alwaysShow) {
            return null;
        }

        return getContextWarning({
            contextSize: props.usageData?.contextSize ?? 0,
            contextWindowTokens,
            contextSnapshot: props.usageData?.contextSnapshot,
            contextSnapshotStale: props.usageData?.contextSnapshotStale,
            alwaysShow,
            theme,
        });
    }, [contextWindowTokens, props.alwaysShowContextSize, props.usageData, theme]);

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
    const lastControlledValueRef = React.useRef(props.value);
    const onChangeTextRef = React.useRef(props.onChangeText);
    const deferredParentTextSyncRef = React.useRef<AgentInputPendingParentTextSync | null>(null);
    const deferredParentTextSyncTimerRef = React.useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
    const sendActionDisabled = Boolean(props.disabled || props.isSendDisabled || props.isSending);
    const enterToSendEnabled = Platform.OS === 'web'
        ? agentInputEnterToSend === true
        : agentInputEnterToSendNative === true;

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
        findActiveWord(initialInputState.text, initialInputState.selection, props.autocompletePrefixes)
    ));
    const [hasAutocompleteTextInteraction, setHasAutocompleteTextInteraction] = React.useState(false);
    const inputScopeKeyRef = React.useRef<string | null>(props.sessionId ?? null);
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
        const nextActiveWord = findActiveWord(state.text, state.selection, props.autocompletePrefixes);
        setActiveWordState((currentActiveWord) => (
            areActiveWordsEqual(currentActiveWord, nextActiveWord) ? currentActiveWord : nextActiveWord
        ));
    }, [props.autocompletePrefixes]);

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

    React.useEffect(() => {
        historyAppliedInputStateRef.current = null;
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
        if (!selection) return;
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
            props.autocompletePrefixes,
        );
        if (focusedActiveWord) {
            setActiveWordState((currentActiveWord) => (
                areActiveWordsEqual(currentActiveWord, focusedActiveWord) ? currentActiveWord : focusedActiveWord
            ));
            setHasAutocompleteTextInteraction(true);
        }
        messageHistory.warmup();
    }, [composerKeyboardLayoutForFocus, messageHistory, props.autocompletePrefixes]);

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
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeSuggestionQuery, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];
        const currentInputState = inputStateRef.current;
        const activeWordForSelection = findActiveWord(currentInputState.text, currentInputState.selection, props.autocompletePrefixes);
        const insertionStart = activeWordForSelection?.offset ?? currentInputState.selection.start;
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
                props.autocompletePrefixes,
                true,
            );
            applyResolvedSelection(result);

            const mention = createStructuredInputMentionFromSuggestion({ suggestion, start: insertionStart });
            if (mention) {
                updateStructuredInputMentions((current) => [
                    ...current.filter((existing) => existing.start !== mention.start || existing.end !== mention.end),
                    mention,
                ]);
            }
        };

        const override = props.onAutocompleteSuggestionSelect?.({
            input: currentInputState.text,
            selection: currentInputState.selection,
            activeWord: activeWordForSelection,
            suggestion,
        });
        if (override) {
            void Promise.resolve(override).then((result) => {
                if (!inputRef.current) {
                    return;
                }
                if (result.handled && typeof result.text === 'string' && typeof result.cursorPosition === 'number') {
                    applyResolvedSelection({
                        text: result.text,
                        cursorPosition: result.cursorPosition,
                    });
                } else if (!result.handled) {
                    applyDefaultSelection();
                }
                hapticsLight();
            });
            return;
        }

        applyDefaultSelection();
        hapticsLight();
    }, [props.autocompletePrefixes, props.onAutocompleteSuggestionSelect, suggestions, updateStructuredInputMentions]);

    // Action menu popover state
    const composerAnchorRef = React.useRef<View>(null);

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

    const effectiveModelLabel = React.useMemo(() => {
        const found = modelOptions.find((o) => o.value === effectiveModelPolicy.effectiveModelId);
        if (found) return found.label;
        return effectiveModelPolicy.effectiveModelId === 'default'
            ? t('agentInput.model.useCliSettings')
            : effectiveModelPolicy.effectiveModelId;
    }, [effectiveModelPolicy.effectiveModelId, modelOptions]);

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
        if (!props.onAcpConfigOptionChange) return null;
        if (props.acpConfigOptionsOverride) {
            return computeAcpConfigOptionControlsFromOverride({
                agentId,
                configOptions: props.acpConfigOptionsOverride,
                overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
            });
        }
        return computeAcpConfigOptionControls({ agentId, metadata: props.metadata ?? null });
    }, [
        agentId,
        props.acpConfigOptionsOverride,
        props.acpConfigOptionOverridesOverride,
        props.metadata,
        props.onAcpConfigOptionChange,
    ]);

    const selectedModelOptionControls = React.useMemo(() => {
        if (!props.onAcpConfigOptionChange) return null;
        // [1m]-tolerant: a Claude extended-context variant id (`<id>[1m]`) keeps the base
        // model's controls (Thinking / Ultracode) while the variant is selected.
        const selectedModel = findModelOptionForEffectiveModelId(modelOptions, effectiveModelPolicy.effectiveModelId);
        if (!selectedModel?.modelOptions?.length) return null;
        return computeAcpConfigOptionControlsFromOverride({
            agentId,
            configOptions: selectedModel.modelOptions,
            overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
        });
    }, [
        agentId,
        effectiveModelPolicy.effectiveModelId,
        modelOptions,
        props.acpConfigOptionOverridesOverride,
        props.onAcpConfigOptionChange,
    ]);
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
                description:
                    option.value === 'default'
                    && shouldShowModelOptionDescriptions
                    && (typeof option.description !== 'string' || option.description.trim().length === 0)
                        ? t('agentInput.model.configureInCli')
                        : option.description,
                ...(option.modelOptions ? { modelOptions: option.modelOptions } : {}),
            }))}
            selectedModelId={effectiveModelPolicy.effectiveModelId}
            effectiveModelLabel={effectiveModelLabel}
            modelNotes={effectiveModelPolicy.notes}
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
            onSelectModelOptionValue={
                props.onAcpConfigOptionChange
                    ? (configId, valueId) => {
                        hapticsLight();
                        props.onAcpConfigOptionChange?.(configId, valueId);
                    }
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
        effectiveModelLabel,
        effectiveModelPolicy.effectiveModelId,
        effectiveModelPolicy.notes,
        modelOptions,
        unifiedEnginePickerProbe,
        shouldShowModelOptionDescriptions,
        props.onAcpConfigOptionChange,
        props.onModelModeChange,
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
        return props.agentType ? t(getAgentCore(props.agentType).displayNameKey) : '';
    }, [props.agentLabel, props.agentType]);

    const internalAgentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!hasInternalAgentPickerOptions || !props.agentType) return [];
        return [{
            id: `engine:${props.agentType}`,
            label: effectiveAgentLabel,
            icon: (
                <AgentIcon
                    agentId={props.agentType}
                    size={12}
                    style={{ transform: [{ scale: getAgentPickerIconScale(props.agentType) }] }}
                />
            ),
            deferRenderDetailContent: true,
            deferredDetailContentCacheKey: `session-engine:${props.agentType}`,
            renderDetailContent: () => renderResolvedEngineDetail('carded'),
        }];
    }, [
        effectiveAgentLabel,
        hasInternalAgentPickerOptions,
        props.agentType,
        renderResolvedEngineDetail,
    ]);

    const agentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if ((props.agentPickerOptions?.length ?? 0) > 0) {
            return props.agentPickerOptions ?? [];
        }
        return internalAgentPickerOptions;
    }, [internalAgentPickerOptions, props.agentPickerOptions]);

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
    }, [setActiveStatusBadgeKey]);
    const activeStatusBadge = React.useMemo(() => (
        activeStatusBadgeKey
            ? props.statusBadges?.find((badge) => badge.key === activeStatusBadgeKey) ?? null
            : null
    ), [activeStatusBadgeKey, props.statusBadges]);
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

    const effectivePermissionLabel = React.useMemo(() => {
        return getPermissionModeLabelForAgentType(agentId, effectivePermissionPolicy.effectiveMode);
    }, [agentId, effectivePermissionPolicy.effectiveMode]);

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
    const engineChipLabel = React.useMemo(() => {
        return hasAgentPickerOptions ? effectiveModelLabel : resolvedAgentLabel;
    }, [effectiveModelLabel, hasAgentPickerOptions, resolvedAgentLabel]);
    const engineChipAgentId = props.agentType ?? agentId;
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

    const deferredParentTextSync = deferredParentTextSyncRef.current;
    const renderedComposerInputValue = deferredParentTextSync && props.value === lastControlledValueRef.current
        ? deferredParentTextSync.text
        : props.value;

    return (
        <SyncPerformanceReactProfiler id="sessions.agentInput">
            <View
                pointerEvents={Platform.OS === 'web' ? 'auto' : undefined}
                style={[
                    styles.container,
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
                    agentId={agentId}
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
                    testID="agent-input-command-menu"
                />

                {/* Connection status, context warning, status badges, and permission mode */}
                {(props.connectionStatus || contextWarning || props.providerUsageGauge || (props.statusBadges && props.statusBadges.length > 0)) && (
                    <View style={styles.statusContainer}>
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
                            {contextWarning && (
                                <Text
                                    style={[
                                        styles.statusText,
                                        { color: contextWarning.color },
                                    ]}
                                >
                                    {props.connectionStatus ? '• ' : ''}{contextWarning.text}
                                </Text>
                            )}
                            {props.providerUsageGauge ? (
                                <AgentInputProviderUsageBadge
                                    viewModel={props.providerUsageGauge}
                                    onRecoveryCreditPress={props.onProviderUsageRecoveryCreditPress}
                                    recoveryCreditActionPending={props.providerUsageRecoveryCreditPending}
                                />
                            ) : null}
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
                        <View style={styles.permissionModeContainer}>
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
                                                                    theme.colors.text.secondary, // Use secondary text color for default
                                        },
                                    ]}
                                >
                                    {permissionChipLabel}
                                </Text>
                            ) : null}
                        </View>
                    </View>
                )}
                {activeStatusBadge?.renderPopover?.({
                    open: true,
                    anchorRef: statusBadgeAnchorRef,
                    onRequestClose: closeStatusBadgePopover,
                })}

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
                                {renderIoniconNode('attach-outline', 18, theme.colors.text.primary)}
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
                                        <AgentInputExpansionToggle
                                            expanded={props.inputExpansion.expanded}
                                            onToggle={props.inputExpansion.onToggle}
                                        />
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
                                            onSend={handleSend}
                                            onStop={handleAbortPress}
                                        />
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
                                        editable={!props.disabled}
                                        onFilesPasted={props.onAttachmentsAdded}
                                        onContentHeightChange={handleInputContentHeightChange}
                                    />
                                    {props.inputExpansion && shouldShowInputExpansionToggle ? (
                                        <AgentInputExpansionToggle
                                            expanded={props.inputExpansion.expanded}
                                            onToggle={props.inputExpansion.onToggle}
                                        />
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
                                                onSend={handleSend}
                                                onStop={handleAbortPress}
                                            />
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
