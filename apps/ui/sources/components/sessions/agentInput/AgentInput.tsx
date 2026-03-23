import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, ActivityIndicator, Pressable, ScrollView, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { layout } from '@/components/ui/layout/layout';
import { MultiTextInput, KeyPressEvent } from '@/components/ui/forms/MultiTextInput';
import { Typography } from '@/constants/Typography';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getModelOptionsForSession, supportsFreeformModelSelectionForSession, type ModelOption } from '@/sync/domains/models/modelOptions';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { Modal } from '@/modal';
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
import { useActiveWord } from '@/components/autocomplete/useActiveWord';
import { useActiveSuggestions } from '@/components/autocomplete/useActiveSuggestions';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { TextInputState, MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import { type ModelPickerProbeState } from '@/components/model/ModelPickerOverlay';
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

const ScrollViewWithWheel = ScrollView as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof ScrollView> & {
        onWheel?: any;
    }
>;
import { Metadata } from '@/sync/domains/state/storageTypes';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { PathAndResumeRow } from './layout/PathAndResumeRow';
import { getHasAnyAgentInputActions, shouldShowSecondaryControlRow } from './layout/actionBarLogic';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { computeAgentInputDefaultMaxHeight } from './inputMaxHeight';
import { getContextWarning } from './contextWarning';
import { shouldRenderPermissionChip } from './permissionChipVisibility';
import { type AgentInputContentPopoverConfig } from './components/AgentInputContentPopover';
import { AgentInputEngineDetail } from './components/AgentInputEngineDetail';
import { AgentInputAttachmentsRow } from './components/AgentInputAttachmentsRow';
import { AgentInputOverlayLayer } from './components/AgentInputOverlayLayer';
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
import { buildAgentInputSelectionOverlayViewModel } from './selection/buildAgentInputSelectionOverlayViewModel';
import { useAgentInputSelectionAnchors } from './selection/useAgentInputSelectionAnchors';
import { useAgentInputSelectionOverlayController } from './selection/useAgentInputSelectionOverlayController';
import { computeSessionModePickerControl } from '@/sync/acp/sessionModeControl';
import {
    computeAcpConfigOptionControls,
    computeAcpConfigOptionControlsFromOverride,
    type AcpConfigOption,
    type AcpConfigOptionValueId,
} from '@/sync/acp/configOptionsControl';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { Text } from '@/components/ui/text/Text';
import { attachActionBarMouseDragScroll } from './layout/attachActionBarMouseDragScroll';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import {
    resolveAgentRequestKind,
    resolvePermissionPromptSurface,
    shouldShowGenericPermissionPromptForRequest,
} from '@/utils/sessions/permissions/permissionPromptPolicy';
import { buildSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type {
    AgentInputAttachment,
    AgentInputExtraActionChip,
} from './agentInputContracts';
import type { AgentInputChipPickerOption } from './components/AgentInputChipPickerTypes';

const ACTION_BAR_SCROLL_END_GUTTER_WIDTH = 24;

const AGENT_INPUT_TEST_IDS = {
    sessionInput: 'session-composer-input',
    sessionSend: 'session-composer-send',
    newSessionInput: 'new-session-composer-input',
    newSessionSend: 'new-session-composer-send',
    connectionStatusText: 'agent-input-connection-status-text',
} as const;

interface AgentInputProps {
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
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
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
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
    userActionRequests?: ReadonlyArray<PendingPermissionRequest>;
    canApprovePermissions?: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
}

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
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
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
        color: theme.colors.textSecondary,
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
        borderColor: theme.colors.divider,
        backgroundColor: 'transparent',
    },
    overlayInlineRefreshButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
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
        backgroundColor: theme.colors.surfacePressed,
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
        color: theme.colors.text,
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
        ...(Platform.OS === 'web' ? { gap: 3 } : {}),
    },
    actionButtonsColumnNarrow: {
        flexDirection: 'column',
        flex: 1,
        ...(Platform.OS === 'web' ? { gap: 2 } : {}),
    },
    actionButtonsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    actionButtonsRowWithBelow: {
        // Match the vertical rhythm of wrapped chip rows on native.
        marginBottom: Platform.OS === 'web' ? 3 : 6,
    },
    pathRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        ...(Platform.OS === 'web' ? { columnGap: 6, rowGap: 3 } : { marginBottom: -6 }),
        flex: 1,
        flexWrap: 'wrap',
        overflow: 'visible',
    },
    actionButtonsLeftScroll: {
        flex: 1,
        overflow: 'visible',
    },
    actionButtonsLeftScrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        ...(Platform.OS === 'web' ? { columnGap: 6 } : { marginBottom: -6 }),
        paddingRight: 6 + ACTION_BAR_SCROLL_END_GUTTER_WIDTH,
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
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: 6 }),
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
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: 6 }),
    },
    actionChipIconOnly: {
        paddingHorizontal: 8,
        gap: 0,
    },
    actionChipPressed: {
        opacity: 0.7,
    },
    actionChipText: {
        fontSize: 13,
        color: theme.colors.button.secondary.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    actionChipCountText: {
        color: theme.colors.textTertiary,
    },
    overlayOptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    overlayOptionRowPressed: {
        backgroundColor: theme.colors.surfacePressed,
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
        color: theme.colors.text,
        ...Typography.default(),
    },
    overlayOptionLabelSelected: {
        color: theme.colors.radio.active,
    },
    overlayOptionLabelUnselected: {
        color: theme.colors.text,
    },
    overlayOptionDescription: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    overlayEmptyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
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
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: 6 }),
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
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
        borderColor: theme.colors.divider,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        ...(Platform.OS === 'web'
            ? ({
                // RN-web supports `backdropFilter`; native platforms ignore it.
                backdropFilter: 'blur(2px)',
            } as any)
            : null),
    },
    fileDropOverlayContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 999,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    fileDropOverlayText: {
        color: theme.colors.text,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
}));

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();
    const voiceEnabled = useFeatureEnabled('voice');
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
            keyboardHeight,
        });
    }, [keyboardHeight, screenHeight]);

    const hasText = props.value.trim().length > 0;
    const hasSendableContent = hasText || props.hasSendableAttachments === true;
    const micPressHandler = voiceEnabled ? props.onMicPress : undefined;
    const micActive = voiceEnabled && props.isMicActive === true;
    const [fileDragActive, setFileDragActive] = React.useState(false);

    const pendingPermissionRequests = props.permissionRequests ?? [];
    const pendingUserActionRequests = props.userActionRequests ?? [];
    const canApprovePermissions = props.canApprovePermissions ?? true;
    const permissionPromptSurface = useSetting('permissionPromptSurface');
    const resolvedPermissionPromptSurface = resolvePermissionPromptSurface(permissionPromptSurface);
    const showComposerPermissionCards = resolvedPermissionPromptSurface === 'composer';
    const composerPermissionRequests = React.useMemo(
        () => pendingPermissionRequests.filter((req) => shouldShowGenericPermissionPromptForRequest({ toolName: req.tool, requestKind: req.kind })),
        [pendingPermissionRequests],
    );
    const composerUserActionRequests = React.useMemo(
        () =>
            pendingUserActionRequests.filter(
                (req) => resolveAgentRequestKind({ toolName: req.tool, requestKind: req.kind }) === 'user_action'
            ),
        [pendingUserActionRequests],
    );
    const sessionIdForStorage = props.sessionId ?? '';
    const { ids: committedMessageIdsOldestFirst } = useSessionTranscriptIds(sessionIdForStorage);
    const committedMessagesById = useSessionMessagesById(sessionIdForStorage);
    const committedMessagesReducerState = useSessionMessagesReducerState(sessionIdForStorage);
    const permissionLocationVersion = useSessionMessagesVersion(
        sessionIdForStorage,
        Boolean(props.sessionId && showComposerPermissionCards && (composerPermissionRequests.length > 0 || composerUserActionRequests.length > 0)),
    );

    const permissionLocationsById = React.useMemo(() => {
        if (!props.sessionId) return new Map<string, PermissionToolCallMessageLocation | null>();
        if (!showComposerPermissionCards) return new Map<string, PermissionToolCallMessageLocation | null>();
        if (composerPermissionRequests.length === 0 && composerUserActionRequests.length === 0) return new Map<string, PermissionToolCallMessageLocation | null>();
        const ids = [...composerPermissionRequests, ...composerUserActionRequests].map((r) => r.id);
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
        composerPermissionRequests,
        composerUserActionRequests,
        props.sessionId,
        showComposerPermissionCards,
        permissionLocationVersion,
    ]);

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
                return 'person-circle-outline';
            }, []);

    // Calculate context warning
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(props.usageData.contextSize, props.alwaysShowContextSize ?? false, theme)
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');
    const agentInputHistoryScope = useSetting('agentInputHistoryScope');
    const agentInputActionBarLayout = useSetting('agentInputActionBarLayout');
    const agentInputChipDensity = useSetting('agentInputChipDensity');
    const sessionPermissionModeApplyTiming = useSetting('sessionPermissionModeApplyTiming');

    const messageHistory = useUserMessageHistory({
        scope: agentInputHistoryScope === 'global' ? 'global' : 'perSession',
        sessionId: props.sessionId ?? null,
    });

    const sendActionDisabled = Boolean(props.disabled || props.isSendDisabled || props.isSending);

    const handleSend = React.useCallback(() => {
        if (sendActionDisabled) {
            return;
        }
        messageHistory.reset();
        props.onSend();
    }, [messageHistory, props.onSend, sendActionDisabled]);

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
        return screenWidth < 420 ? 'scroll' : 'wrap';
    }, [agentInputActionBarLayout, screenWidth]);

    // In labels mode: always show; in icons mode: never show; in auto: show for 'always' policy chips.
    const showChipLabels = effectiveChipDensity === 'labels' || effectiveChipDensity === 'auto';
    const showAutoHideChipLabels = effectiveChipDensity === 'labels';


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Autocomplete state - track text and selection together
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: 0, end: 0 }
    });

    // Handle combined text and selection state changes
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        setInputState(newState);
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Action menu popover state
    const composerAnchorRef = React.useRef<View>(null);

    const actionBarFades = useScrollEdgeFades({
        enabledEdges: { left: true, right: true },
        // Match previous behavior: require a bit of overflow before enabling scroll.
        overflowThreshold: 8,
        // Match previous behavior: avoid showing fades for tiny offsets.
        edgeThreshold: 2,
    });
    const actionBarScrollRef = React.useRef<any>(null);

    const permissionRequestsFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });
    const [permissionRequestsContentHeightPx, setPermissionRequestsContentHeightPx] = React.useState<number | null>(null);
    const permissionRequestsMaxHeightPx = React.useMemo(() => {
        const available = Math.max(1, screenHeight - keyboardHeight);
        const desired = Math.round(available * 0.34);
        return Math.max(160, Math.min(320, desired));
    }, [keyboardHeight, screenHeight]);
    const permissionRequestsClampedHeightPx = React.useMemo(() => {
        const raw = permissionRequestsContentHeightPx;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
        return Math.max(1, Math.min(Math.trunc(raw), permissionRequestsMaxHeightPx));
    }, [permissionRequestsContentHeightPx, permissionRequestsMaxHeightPx]);

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
        hapticsLight();
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

    const sessionModeSectionSummary = React.useMemo<React.ReactNode>(() => {
        if (sessionModePickerControl) {
            return sessionModePickerControl.isPending
                ? t('agentInput.mode.pendingSwitching', {
                    from: sessionModePickerControl.currentModeName,
                    to:
                        sessionModePickerControl.requestedModeName
                        ?? sessionModePickerControl.requestedModeId
                        ?? '',
                })
                : t('agentInput.mode.currentMode', { name: sessionModePickerControl.currentModeName });
        }
        if (preflightAcpSessionModeOptions) {
            return sessionModeOptionsOverrideProbe?.phase === 'loading'
                ? t('agentInput.mode.loadingModes')
                : sessionModeOptionsOverrideProbe?.phase === 'refreshing'
                    ? t('agentInput.mode.refreshingModes')
                    : preflightAcpSessionModeEffective.id === 'default'
                        ? t('agentInput.mode.useDefaultModeHint')
                        : t('agentInput.mode.startIn', { name: preflightAcpSessionModeEffective.name });
        }
        return null;
    }, [
        preflightAcpSessionModeEffective.id,
        preflightAcpSessionModeEffective.name,
        preflightAcpSessionModeOptions,
        sessionModeOptionsOverrideProbe?.phase,
        sessionModePickerControl,
    ]);

    const sessionModeSectionHeaderAccessory = React.useMemo<React.ReactNode>(() => {
        if (
            !preflightAcpSessionModeOptions
            || !sessionModeOptionsOverrideProbe
            || (
                sessionModeOptionsOverrideProbe.phase === 'idle'
                && typeof sessionModeOptionsOverrideProbe.onRefresh !== 'function'
            )
        ) {
            return null;
        }
        if (typeof sessionModeOptionsOverrideProbe.onRefresh === 'function') {
            return (
                <Pressable
                    testID="agent-input-session-mode-refresh"
                    accessibilityRole="button"
                    accessibilityLabel={t('agentInput.mode.refreshModesA11y')}
                    onPress={
                        sessionModeOptionsOverrideProbe.phase === 'idle'
                            ? sessionModeOptionsOverrideProbe.onRefresh
                            : undefined
                    }
                    style={({ pressed }) => [
                        styles.overlayInlineRefreshButton,
                        pressed ? styles.overlayInlineRefreshButtonPressed : null,
                        sessionModeOptionsOverrideProbe.phase !== 'idle'
                            ? styles.overlayInlineRefreshButtonDisabled
                            : null,
                    ]}
                >
                    {sessionModeOptionsOverrideProbe.phase === 'idle' ? (
                        renderIoniconNode('refresh-outline', 18, theme.colors.textSecondary)
                    ) : (
                        <ActivityIndicator size="small" />
                    )}
                </Pressable>
            );
        }
        return (
            <View style={styles.overlayInlineRefreshButton}>
                <ActivityIndicator size="small" />
            </View>
        );
    }, [
        preflightAcpSessionModeOptions,
        sessionModeOptionsOverrideProbe,
        styles.overlayInlineRefreshButton,
        styles.overlayInlineRefreshButtonDisabled,
        styles.overlayInlineRefreshButtonPressed,
        theme.colors.textSecondary,
    ]);

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
        const selectedModel = modelOptions.find((option) => option.value === effectiveModelPolicy.effectiveModelId) ?? null;
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

    const acpConfigSectionHeaderAccessory = React.useMemo<React.ReactNode>(() => {
        if (
            !acpConfigOptionsOverrideProbe
            || (
                acpConfigOptionsOverrideProbe.phase === 'idle'
                && typeof acpConfigOptionsOverrideProbe.onRefresh !== 'function'
            )
        ) {
            return null;
        }
        if (typeof acpConfigOptionsOverrideProbe.onRefresh === 'function') {
            return (
                <Pressable
                    testID="agent-input-config-options-refresh"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.refresh')}
                    onPress={
                        acpConfigOptionsOverrideProbe.phase === 'idle'
                            ? acpConfigOptionsOverrideProbe.onRefresh
                            : undefined
                    }
                    style={({ pressed }) => [
                        styles.overlayInlineRefreshButton,
                        pressed ? styles.overlayInlineRefreshButtonPressed : null,
                        acpConfigOptionsOverrideProbe.phase !== 'idle'
                            ? styles.overlayInlineRefreshButtonDisabled
                            : null,
                    ]}
                >
                    {acpConfigOptionsOverrideProbe.phase === 'idle' ? (
                        renderIoniconNode('refresh-outline', 18, theme.colors.textSecondary)
                    ) : (
                        <ActivityIndicator size="small" />
                    )}
                </Pressable>
            );
        }
        return (
            <View style={styles.overlayInlineRefreshButton}>
                <ActivityIndicator size="small" />
            </View>
        );
    }, [
        acpConfigOptionsOverrideProbe,
        renderIoniconNode,
        styles.overlayInlineRefreshButton,
        styles.overlayInlineRefreshButtonDisabled,
        styles.overlayInlineRefreshButtonPressed,
        theme.colors.textSecondary,
    ]);

    const hasSettingsSessionModeSection = Boolean(
        sessionModePickerControl || (preflightAcpSessionModeOptions && props.onAcpSessionModeChange),
    );
    const hasSettingsAcpConfigSection = Boolean(acpConfigOptionControls || acpConfigSectionHeaderAccessory);
    const hasSettingsModelSection = Boolean(props.onModelModeChange);

    const renderResolvedEngineDetail = React.useCallback((surfaceVariant: 'carded' | 'plain' = 'carded') => (
        <AgentInputEngineDetail
            modelOptions={modelOptions.map((option) => ({
                value: option.value,
                label: option.label,
                description: option.description,
                ...(option.modelOptions ? { modelOptions: option.modelOptions } : {}),
            }))}
            selectedModelId={effectiveModelPolicy.effectiveModelId}
            effectiveModelLabel={effectiveModelLabel}
            modelNotes={effectiveModelPolicy.notes}
            modelEmptyText={t('agentInput.model.configureInCli')}
            canEnterCustomModel={canEnterCustomModel}
            modelProbe={props.modelOptionsOverrideProbe ?? (sessionModelOptionsProbe ?? undefined)}
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
            sessionModeOptions={
                sessionModePickerControl?.options
                ?? preflightAcpSessionModeOptions
                ?? undefined
            }
            selectedSessionModeId={
                sessionModePickerControl?.effectiveModeId
                ?? preflightAcpSessionModeEffective.id
            }
            sessionModeSummary={sessionModeSectionSummary}
            sessionModeHeaderAccessory={sessionModeSectionHeaderAccessory}
            onSelectSessionMode={
                props.onAcpSessionModeChange
                    ? (optionId) => {
                        hapticsLight();
                        props.onAcpSessionModeChange?.(optionId);
                    }
                    : undefined
            }
            configControls={acpConfigOptionControls}
            configHeaderAccessory={acpConfigSectionHeaderAccessory}
            onSelectConfigValue={
                props.onAcpConfigOptionChange
                    ? (configId, valueId) => {
                        hapticsLight();
                        props.onAcpConfigOptionChange?.(configId, valueId);
                    }
                    : undefined
            }
            sectionOrder={['model', 'mode', 'config']}
            surfaceVariant={surfaceVariant}
        />
    ), [
        acpConfigOptionControls,
        acpConfigSectionHeaderAccessory,
        canEnterCustomModel,
        effectiveModelLabel,
        effectiveModelPolicy.effectiveModelId,
        effectiveModelPolicy.notes,
        modelOptions,
        preflightAcpSessionModeEffective.id,
        preflightAcpSessionModeOptions,
        props.modelOptionsOverrideProbe,
        props.onAcpConfigOptionChange,
        props.onAcpSessionModeChange,
        props.onModelModeChange,
        submitCustomModel,
        selectedModelOptionControls,
        sessionModePickerControl,
        sessionModeSectionHeaderAccessory,
        sessionModeSectionSummary,
        sessionModelOptionsProbe,
    ]);

    const hasInternalAgentPickerOptions = Boolean(
        props.agentType
        && (props.onModelModeChange || hasSettingsSessionModeSection || hasSettingsAcpConfigSection),
    );

    const internalAgentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!hasInternalAgentPickerOptions || !props.agentType) return [];
        return [{
            id: `engine:${props.agentType}`,
            label: props.agentLabel ?? t(getAgentCore(props.agentType).displayNameKey),
            icon: <AgentIcon agentId={props.agentType} size={12} />,
            renderDetailContent: () => renderResolvedEngineDetail('carded'),
        }];
    }, [
        hasInternalAgentPickerOptions,
        props.agentLabel,
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
    const hasRecipient = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'recipient');
    }, [props.extraActionChips]);
    const hasDelivery = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'delivery');
    }, [props.extraActionChips]);
    const hasExtraActionChips = (props.extraActionChips?.length ?? 0) > 0;
    const hasMachine = Boolean(props.onMachineClick || props.machinePopover);
    const hasPath = Boolean(props.onPathClick || props.pathPopover);
    const hasResume = Boolean(props.onResumeClick || props.resumePopover);
    const hasFiles = Boolean(props.sessionId && props.onFileViewerPress);
    const hasStop = Boolean(props.onAbort && props.showAbortButton);
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
    const chipStyle = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        !showChipLabels ? styles.actionChipIconOnly : null,
        pressed ? styles.actionChipPressed : null,
    ]), [
        showChipLabels,
        styles.actionChip,
        styles.actionChipIconOnly,
        styles.actionChipPressed,
    ]);
    const chipStyleAutoHide = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        !showAutoHideChipLabels ? styles.actionChipIconOnly : null,
        pressed ? styles.actionChipPressed : null,
    ]), [
        showAutoHideChipLabels,
        styles.actionChip,
        styles.actionChipIconOnly,
        styles.actionChipPressed,
    ]);

    const canActionBarScroll = actionBarShouldScroll && actionBarFades.canScrollX;
    const showActionBarFadeLeft = canActionBarScroll && actionBarFades.visibility.left;
    const showActionBarFadeRight = canActionBarScroll && actionBarFades.visibility.right;

    const actionBarFadeColor = React.useMemo(() => {
        return theme.colors.input.background;
    }, [theme.colors.input.background]);

    const getActionBarScrollNode = React.useCallback(() => {
        const raw = actionBarScrollRef.current;
        if (!raw) return null;
        // RN ScrollView refs often expose getScrollableNode()
        return raw.getScrollableNode?.() ?? raw;
    }, []);

    const seedActionBarScrollMeasurements = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const node = getActionBarScrollNode() as any;
        if (!node) return;
        const clientWidth = typeof node.clientWidth === 'number' ? node.clientWidth : null;
        const clientHeight = typeof node.clientHeight === 'number' ? node.clientHeight : null;
        const scrollWidth = typeof node.scrollWidth === 'number' ? node.scrollWidth : null;
        if (clientWidth === null || scrollWidth === null) return;

        // Seed both viewport and content sizes so chevrons/fades can render even before the first scroll event.
        const layoutEvent = {
            nativeEvent: { layout: { x: 0, y: 0, width: clientWidth, height: clientHeight ?? 0 } },
        } as unknown as LayoutChangeEvent;
        actionBarFades.onViewportLayout(layoutEvent);
        actionBarFades.onContentSizeChange(
            Math.max(0, scrollWidth - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
            clientHeight ?? 0
        );
    }, [actionBarFades, getActionBarScrollNode]);

    const reportActionBarWebScroll = React.useCallback((nodeOverride?: any) => {
        if (Platform.OS !== 'web') return;
        const node = (nodeOverride ?? getActionBarScrollNode()) as any;
        if (!node) return;

        const clientWidth = typeof node.clientWidth === 'number' ? node.clientWidth : null;
        const clientHeight = typeof node.clientHeight === 'number' ? node.clientHeight : 0;
        const scrollWidth = typeof node.scrollWidth === 'number' ? node.scrollWidth : null;
        const scrollLeft = typeof node.scrollLeft === 'number' ? node.scrollLeft : 0;
        if (clientWidth === null || scrollWidth === null) return;

        const scrollEvent = {
            nativeEvent: {
                contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
                contentOffset: { x: scrollLeft, y: 0 },
                layoutMeasurement: { width: clientWidth, height: clientHeight },
                contentSize: {
                    width: Math.max(0, scrollWidth - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
                    height: clientHeight,
                },
                zoomScale: 1,
            },
        } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
        actionBarFades.onScroll(scrollEvent);
    }, [actionBarFades, getActionBarScrollNode]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!actionBarShouldScroll) return;

        const requestAnimationFrameSafe: (cb: () => void) => any =
            (globalThis as any).requestAnimationFrame?.bind(globalThis) ??
            ((cb: () => void) => setTimeout(cb, 0));
        const cancelAnimationFrameSafe: (id: any) => void =
            (globalThis as any).cancelAnimationFrame?.bind(globalThis) ??
            ((id: any) => clearTimeout(id));

        const rAF = requestAnimationFrameSafe(() => {
            seedActionBarScrollMeasurements();
            reportActionBarWebScroll();
        });

        const node = getActionBarScrollNode();
        if (!node) return () => cancelAnimationFrameSafe(rAF);

        // Keep measurements up-to-date as the viewport changes (resizes, chip density changes, etc).
        // Prefer ResizeObserver (more accurate), but fall back to window resize.
        const ResizeObserverAny = (globalThis as any).ResizeObserver as (new (cb: () => void) => { observe: (n: any) => void; disconnect: () => void }) | undefined;
        if (typeof ResizeObserverAny === 'function') {
            const observer = new ResizeObserverAny(() => {
                seedActionBarScrollMeasurements();
                reportActionBarWebScroll();
            });
            observer.observe(node as any);
            return () => {
                cancelAnimationFrameSafe(rAF);
                observer.disconnect();
            };
        }

        const onResize = () => {
            seedActionBarScrollMeasurements();
            reportActionBarWebScroll();
        };
        const w = (globalThis as any).window as Window | undefined;
        w?.addEventListener?.('resize', onResize);
        return () => {
            cancelAnimationFrameSafe(rAF);
            w?.removeEventListener?.('resize', onResize);
        };
    }, [actionBarShouldScroll, getActionBarScrollNode, reportActionBarWebScroll, seedActionBarScrollMeasurements]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!actionBarShouldScroll) return;

        const requestAnimationFrameSafe: (cb: () => void) => any =
            (globalThis as any).requestAnimationFrame?.bind(globalThis) ??
            ((cb: () => void) => setTimeout(cb, 0));
        const cancelAnimationFrameSafe: (id: any) => void =
            (globalThis as any).cancelAnimationFrame?.bind(globalThis) ??
            ((id: any) => clearTimeout(id));

        let cleanup: (() => void) | undefined;

        const rAF = requestAnimationFrameSafe(() => {
            const node = getActionBarScrollNode() as any;
            if (!node || typeof node.addEventListener !== 'function') return;
            cleanup = attachActionBarMouseDragScroll({
                node,
                onScroll: () => reportActionBarWebScroll(node),
            });
        });

        return () => {
            cancelAnimationFrameSafe(rAF);
            cleanup?.();
        };
    }, [actionBarShouldScroll, getActionBarScrollNode, reportActionBarWebScroll]);

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
        tint: theme.colors.button.secondary.tint,
        agentId,
        profileLabel,
        profileIcon,
        envVarsCount: props.envVarsCount,
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
        canStop: Boolean(props.onAbort && props.showAbortButton),
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
        themeTint: theme.colors.button.secondary.tint,
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
        agentLabel: resolvedAgentLabel,
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
        // Keep the chip popover open so users can compare permission choices.
    }, [props.onPermissionModeChange]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Clear suggestions by collapsing selection (triggers activeWord to clear)
                if (inputRef.current) {
                    const cursorPos = inputState.selection.start;
                    inputRef.current.setTextAndSelection(inputState.text, {
                        start: cursorPos,
                        end: cursorPos
                    });
                }
                return true;
            }
        }

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            // Shell-like history: only when suggestions are not visible and cursor is at the boundary.
            const isCollapsedSelection = inputState.selection.start === inputState.selection.end;
            if (isCollapsedSelection && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                if (event.key === 'ArrowUp' && inputState.selection.start === 0) {
                    const next = messageHistory.moveUp(inputState.text);
                    if (next !== null) {
                        if (inputRef.current?.setTextAndSelection) {
                            inputRef.current.setTextAndSelection(next, { start: next.length, end: next.length });
                        } else {
                            props.onChangeText(next);
                        }
                        return true;
                    }
                }

                if (event.key === 'ArrowDown' && inputState.selection.end === inputState.text.length) {
                    const next = messageHistory.moveDown();
                    if (next !== null) {
                        if (inputRef.current?.setTextAndSelection) {
                            inputRef.current.setTextAndSelection(next, { start: next.length, end: next.length });
                        } else {
                            props.onChangeText(next);
                        }
                        return true;
                    }
                }
            }

            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey) {
                if (!sendActionDisabled && props.value.trim()) {
                    handleSend();
                    return true; // Key was handled
                }
            }
                // Handle Shift+Tab for permission mode switching
                if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange) {
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
            }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, inputState.text, inputState.selection.start, inputState.selection.end, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.value, handleSend, props.onPermissionModeChange, agentId, permissionModeOrder, effectivePermissionPolicy.effectiveMode, messageHistory, props.onChangeText, sendActionDisabled]);




    return (
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
                    suggestions={suggestions}
                    overlayAnchorRef={overlayAnchorRef}
                    screenWidth={screenWidth}
                    autocompleteSelectedIndex={selected}
                    onAutocompleteSelect={handleSuggestionSelect}
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
                    agentPickerTitle={props.agentPickerTitle ?? t('newSession.selectAiBackendTitle')}
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

                {/* Connection status, context warning, and permission mode */}
                {(props.connectionStatus || contextWarning) && (
                    <View style={styles.statusContainer}>
                        <View style={styles.statusRow}>
                            {props.connectionStatus && (
                                <>
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
                                </>
                            )}
                            {contextWarning && (
                                <Text
                                    style={[
                                        styles.statusText,
                                        {
                                            color: contextWarning.color,
                                            marginLeft: props.connectionStatus ? 8 : 0,
                                        },
                                    ]}
                                >
                                    {props.connectionStatus ? '• ' : ''}{contextWarning.text}
                                </Text>
                            )}
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
                                                                    theme.colors.textSecondary, // Use secondary text color for default
                                        },
                                    ]}
                                >
                                    {permissionChipLabel}
                                </Text>
                            ) : null}
                        </View>
                    </View>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <View style={[styles.unifiedPanel, props.panelStyle]}>
                    {fileDragActive && typeof props.onAttachmentsAdded === 'function' ? (
                        <View testID="agent-input-drop-overlay" pointerEvents="none" style={styles.fileDropOverlay}>
                            <View style={styles.fileDropOverlayContent}>
                                {renderIoniconNode('attach-outline', 18, theme.colors.text)}
                                <Text style={styles.fileDropOverlayText}>{t('agentInput.dropToAttach')}</Text>
                            </View>
                        </View>
                    ) : null}
                    {props.sessionId && (composerPermissionRequests.length > 0 || composerUserActionRequests.length > 0) && showComposerPermissionCards ? (
                        <AgentInputPermissionRequests
                            sessionId={props.sessionId}
                            permissionRequests={composerPermissionRequests}
                            userActionRequests={composerUserActionRequests}
                            permissionLocationsById={permissionLocationsById}
                            metadata={props.metadata || null}
                            canApprovePermissions={canApprovePermissions}
                            disabledReason={props.permissionDisabledReason}
                            maxHeightPx={permissionRequestsMaxHeightPx}
                            clampedHeightPx={permissionRequestsClampedHeightPx ?? permissionRequestsMaxHeightPx}
                            onContentSizeChange={(_w, h) => {
                                setPermissionRequestsContentHeightPx(h);
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
                    ) : null}

                    {props.attachments && props.attachments.length > 0 ? (
                        <AgentInputAttachmentsRow attachments={props.attachments} />
                    ) : null}
                    {/* Input field */}
                    <View
                        ref={composerAnchorRef}
                        collapsable={false}
                        style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}
                    >
                        <MultiTextInput
                            ref={inputRef}
                            testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionInput : AGENT_INPUT_TEST_IDS.newSessionInput}
                            value={props.value}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            onChangeText={props.onChangeText}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={props.inputMaxHeight ?? defaultInputMaxHeight}
                            editable={!props.disabled}
                            onFilesDropped={props.onAttachmentsAdded}
                            onFilesPasted={props.onAttachmentsAdded}
                            onFileDragActiveChange={typeof props.onAttachmentsAdded === 'function' ? setFileDragActive : undefined}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={screenWidth < 420 ? styles.actionButtonsColumnNarrow : styles.actionButtonsColumn}>{[
                            // Row 1: Settings, Profile (FIRST), Agent, Abort, Source control status
                            <View
                                key="row1"
                                style={[styles.actionButtonsRow, showSecondaryControlsRow ? styles.actionButtonsRowWithBelow : null]}
                            >
                                {actionBarShouldScroll ? (
                                    <View style={styles.actionButtonsLeftScroll}>
                                        <ScrollViewWithWheel
                                            ref={actionBarScrollRef}
                                            horizontal
                                            showsHorizontalScrollIndicator={false}
                                            scrollEnabled={Platform.OS === 'web' ? true : canActionBarScroll}
                                            alwaysBounceHorizontal={false}
                                            directionalLockEnabled
                                            keyboardShouldPersistTaps="handled"
                                            onWheel={(e: any) => {
                                                if (Platform.OS !== 'web') return;
                                                const node = getActionBarScrollNode() as any;
                                                if (!node) return;
                                                const ne = e?.nativeEvent ?? e;
                                                const dx = typeof ne?.deltaX === 'number' ? ne.deltaX : 0;
                                                const dy = typeof ne?.deltaY === 'number' ? ne.deltaY : 0;
                                                const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
                                                if (!delta) return;
                                                const before = node.scrollLeft ?? 0;
                                                node.scrollLeft = before + delta;
                                                reportActionBarWebScroll(node);
                                            }}
                                            onLayout={actionBarFades.onViewportLayout}
                                            onContentSizeChange={(width: number, height: number) => {
                                                actionBarFades.onContentSizeChange(
                                                    Math.max(0, width - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
                                                    height
                                                );
                                            }}
                                            onScroll={(e: any) => {
                                                if (Platform.OS === 'web') {
                                                    reportActionBarWebScroll();
                                                    return;
                                                }
                                                const nativeEvent = e?.nativeEvent;
                                                const contentSizeWidth = nativeEvent?.contentSize?.width;
                                                if (typeof contentSizeWidth !== 'number') {
                                                    actionBarFades.onScroll(e);
                                                    return;
                                                }
                                                actionBarFades.onScroll({
                                                    ...e,
                                                    nativeEvent: {
                                                        ...nativeEvent,
                                                        contentSize: {
                                                            ...nativeEvent.contentSize,
                                                            width: Math.max(0, contentSizeWidth - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
                                                        },
                                                    },
                                                });
                                            }}
                                            scrollEventThrottle={16}
                                        >
                                            <View style={styles.actionButtonsLeftScrollContent as any}>
                                                {renderedActionControlNodes as any}
                                            </View>
                                        </ScrollViewWithWheel>
                                        <ScrollEdgeFades
                                            color={actionBarFadeColor}
                                            size={24}
                                            edges={{ left: showActionBarFadeLeft, right: showActionBarFadeRight }}
                                            leftStyle={styles.actionButtonsFadeLeft as any}
                                            rightStyle={styles.actionButtonsFadeRight as any}
                                        />
                                        <ScrollEdgeIndicators
                                            edges={{ left: showActionBarFadeLeft, right: showActionBarFadeRight }}
                                            color={theme.colors.button.secondary.tint}
                                            size={14}
                                            opacity={0.28}
                                            leftStyle={styles.actionButtonsFadeLeft as any}
                                            rightStyle={styles.actionButtonsFadeRight as any}
                                        />
                                    </View>
                                ) : (
                                    <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                                        {renderedActionControlNodes as any}
                                    </View>
                                )}

                                {/* Send/Voice button - aligned with first row */}
                                <AgentInputSubmitButton
                                    testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                                    sessionId={props.sessionId}
                                    submitAccessibilityLabel={props.submitAccessibilityLabel}
                                    disabled={Boolean(props.disabled || props.isSendDisabled || props.isSending || (!hasSendableContent && !micPressHandler))}
                                    isSending={props.isSending}
                                    hasSendableContent={hasSendableContent}
                                    micPressHandler={micPressHandler}
                                    micActive={micActive}
                                    onSend={handleSend}
                                />
                                    </View>,

                                    // Row 2: Path + Resume selectors (separate line to match pre-PR272 layout)
                                    // - wrap: shown below
                                    // - scroll: folds into row 1
                                    // - collapsed: moved into action menu
                                    (showSecondaryControlsRow) ? (
                                        <PathAndResumeRow
                                            key="row2"
                                            styles={{
                                                pathRow: styles.pathRow,
                                                actionButtonsLeft: styles.actionButtonsLeft,
                                                actionChip: styles.actionChip,
                                                actionChipIconOnly: styles.actionChipIconOnly,
                                                actionChipPressed: styles.actionChipPressed,
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
                                            resumeLabelTitle={t('newSession.resume.title')}
                                            resumeLabelOptional={t('newSession.resume.optional')}
                                        />
                            ) : null,
                        ]}</View>
                    </View>
                </View>
            </View>
        </View>
    );
}));
