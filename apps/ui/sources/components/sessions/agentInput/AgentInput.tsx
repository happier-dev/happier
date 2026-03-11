import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, ActivityIndicator, Pressable, ScrollView, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { layout } from '@/components/ui/layout/layout';
import { MultiTextInput, KeyPressEvent } from '@/components/ui/forms/MultiTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Typography } from '@/constants/Typography';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getModelOptionsForSession, supportsFreeformModelSelectionForSession, type ModelOption } from '@/sync/domains/models/modelOptions';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { Modal } from '@/modal';
import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeLabelForAgentType,
    getPermissionModeOptionsForSession,
    getPermissionModeTitleForAgentType,
} from '@/sync/domains/permissions/permissionModeOptions';
import { describeEffectivePermissionMode } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { hapticsLight, hapticsError } from '@/components/ui/theme/haptics';
import { Shaker, ShakeInstance } from '@/components/ui/feedback/Shaker';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useActiveWord } from '@/components/autocomplete/useActiveWord';
import { useActiveSuggestions } from '@/components/autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './components/AgentInputAutocomplete';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { TextInputState, MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import { SourceControlStatusBadge, useHasMeaningfulScmStatus } from '@/components/sessions/sourceControl/status';
import { ModelPickerOverlay, type ModelPickerProbeState } from '@/components/model/ModelPickerOverlay';
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
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ResumeChip, formatResumeChipLabel, RESUME_CHIP_ICON_NAME, RESUME_CHIP_ICON_SIZE } from './ResumeChip';
import { PathAndResumeRow } from './PathAndResumeRow';
import { getHasAnyAgentInputActions, shouldShowPathAndResumeRow } from './actionBarLogic';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { computeAgentInputDefaultMaxHeight } from './inputMaxHeight';
import { getContextWarning } from './contextWarning';
import { shouldRenderPermissionChip } from './permissionChipVisibility';
import { buildAgentInputActionMenuActions } from './actionMenuActions';
import { PermissionModePicker } from './components/PermissionModePicker';
import { AgentInputChipLabel } from './components/AgentInputChipLabel';
import { AgentInputChipPickerModal } from './components/AgentInputChipPickerModal';
import { DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS, resolveChipOptionInteraction, shouldRenderChipForOptions } from './chipOptionInteraction';
import { computeSessionModePickerControl } from '@/sync/acp/sessionModeControl';
import { computeAcpConfigOptionControls, type AcpConfigOptionValueId } from '@/sync/acp/configOptionsControl';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { Text } from '@/components/ui/text/Text';
import { attachActionBarMouseDragScroll } from './attachActionBarMouseDragScroll';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import {
    resolveAgentRequestKind,
    resolvePermissionPromptSurface,
    shouldShowGenericPermissionPromptForRequest,
} from '@/utils/sessions/permissions/permissionPromptPolicy';
import { buildSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';

const ACTION_BAR_SCROLL_END_GUTTER_WIDTH = 24;


export type AgentInputExtraActionChipRenderContext = Readonly<{
    chipStyle: (pressed: boolean) => any;
    showLabel: boolean;
    iconColor: string;
    textStyle: any;
    countTextStyle: any;
    /**
     * Full-width anchor for agent-input popovers (matches the overall composer width).
     * Useful for chip-triggered popovers (e.g. "Link file") that should size like the @ suggestions.
     */
    popoverAnchorRef: React.RefObject<any>;
}>;

/**
 * Controls whether a chip's label is displayed in `auto` density mode.
 *
 * - `'always'` – label is always visible (selector chips like agent, machine, permission mode).
 * - `'auto-hide'` – label is hidden in auto mode because the icon is self-explanatory (attach, link file).
 */
export type ChipLabelPolicy = 'always' | 'auto-hide';

export type AgentInputExtraActionChip = Readonly<{
    key: string;
    /**
     * Determines whether the label should be shown in auto chip density mode.
     * Defaults to `'always'` when not specified.
     */
    labelPolicy?: ChipLabelPolicy;
    render: (ctx: AgentInputExtraActionChipRenderContext) => React.ReactNode;
}>;

export type AgentInputAttachmentPreview =
    | Readonly<{ kind: 'image'; uri: string }>;

export type AgentInputAttachmentUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

export type AgentInputAttachment = Readonly<{
    key: string;
    label: string;
    status?: 'pending' | 'uploading' | 'uploaded' | 'error';
    preview?: AgentInputAttachmentPreview;
    uploadProgress?: AgentInputAttachmentUploadProgress;
    error?: string;
    onRemove?: () => void;
}>;

type ComposerAttachmentImagePreviewItem = Extract<AttachmentImagePreviewModalImage, Readonly<{ kind: 'direct' }>>;

function resolveAttachmentImagePreviewItems(attachments: readonly AgentInputAttachment[]): ComposerAttachmentImagePreviewItem[] {
    const previews: ComposerAttachmentImagePreviewItem[] = [];
    for (const attachment of attachments) {
        const imagePreviewUri =
            attachment.preview?.kind === 'image' && typeof attachment.preview.uri === 'string' && attachment.preview.uri.trim().length > 0
                ? attachment.preview.uri
                : null;
        if (!imagePreviewUri) continue;
        previews.push({
            kind: 'direct',
            uri: imagePreviewUri,
            title: attachment.label,
        });
    }
    return previews;
}

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
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    resumeSessionId?: string | null;
    onResumeClick?: () => void;
    resumeIsChecking?: boolean;
    isSendDisabled?: boolean;
    isSending?: boolean;
    disabled?: boolean;
    minHeight?: number;
    inputMaxHeight?: number;
    profileId?: string | null;
    onProfileClick?: () => void;
    envVarsCount?: number;
    onEnvVarsClick?: () => void;
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

function truncateWithEllipsis(value: string, maxChars: number) {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}…`;
}

function resolveUploadProgressPercent(progress?: AgentInputAttachmentUploadProgress): number | null {
    const uploadedBytes = progress?.uploadedBytes;
    const totalBytes = progress?.totalBytes;
    if (typeof uploadedBytes !== 'number' || !Number.isFinite(uploadedBytes)) return null;
    if (typeof totalBytes !== 'number' || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;

    const raw = Math.round((uploadedBytes / totalBytes) * 100);
    return Math.max(0, Math.min(100, raw));
}

function parseAcpBooleanValueId(valueId: string): boolean {
    const normalized = valueId.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
    return false;
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
    permissionRequestsContainer: {
        paddingTop: 10,
        gap: 8,
    },
    permissionRequestTitle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    permissionRequestCard: {
        overflow: 'hidden',
    },
    permissionRequestSummary: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 2,
        color: theme.colors.text,
        fontSize: 13,
        ...Typography.default(),
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
    overlayBackdrop: {
        position: 'absolute',
        top: -1000,
        left: -1000,
        right: -1000,
        bottom: -1000,
        zIndex: 999,
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
        position: 'absolute',
        top: 10,
        right: 16,
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
    overlayDivider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginHorizontal: 16,
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
    attachmentsRow: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
    },
    attachmentChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    attachmentChipText: {
        color: theme.colors.text,
        fontSize: 12,
        maxWidth: 180,
        ...Typography.default(),
    },
    attachmentChipMeta: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    attachmentImageTile: {
        width: 58,
        height: 58,
        position: 'relative',
    },
    attachmentImageSurface: {
        width: 52,
        height: 52,
        marginTop: 6,
        marginRight: 6,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    attachmentImage: {
    },
    attachmentImageOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.overlay.scrim,
    },
    attachmentImageOverlayText: {
        color: theme.colors.overlay.text,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    attachmentImageErrorOverlay: {
        backgroundColor: 'rgba(210, 0, 0, 0.32)',
    },
    attachmentImageRemoveButton: {
        position: 'absolute',
        top: 0,
        right: 0,
        zIndex: 10,
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
    const attachmentImagePreviewItems = React.useMemo(
        () => resolveAttachmentImagePreviewItems(props.attachments ?? []),
        [props.attachments],
    );
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
        const raw = (props.metadata as any)?.acpSessionModelsV1;
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

    // Settings modal state
    const [showSettings, setShowSettings] = React.useState(false);
    const overlayAnchorRef = React.useRef<View>(null);
    const composerAnchorRef = React.useRef<View>(null);
    const settingsAnchorRef = React.useRef<View>(null);

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

    const acpConfigOptionControls = React.useMemo(() => {
        if (!props.onAcpConfigOptionChange) return null;
        return computeAcpConfigOptionControls({ agentId, metadata: props.metadata ?? null });
    }, [agentId, props.metadata, props.onAcpConfigOptionChange]);

    const effectivePermissionLabel = React.useMemo(() => {
        return getPermissionModeLabelForAgentType(agentId, effectivePermissionPolicy.effectiveMode);
    }, [agentId, effectivePermissionPolicy.effectiveMode]);

    const permissionChipLabel = React.useMemo(() => {
        return getPermissionModeBadgeLabelForAgentType(agentId, effectivePermissionPolicy.effectiveMode);
    }, [agentId, effectivePermissionPolicy.effectiveMode]);

    // Handle settings button press
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(prev => !prev);
    }, []);

    // NOTE: settings overlay sizing is handled by `Popover` now (anchor + boundary measurement).

    const showPermissionChip = Boolean(props.onPermissionModeChange || props.onPermissionClick);
    const hasProfile = Boolean(props.onProfileClick);
    const hasEnvVars = Boolean(props.onEnvVarsClick);
    const hasAgent = Boolean(props.agentType && props.onAgentClick);
    const hasMachine = Boolean(props.onMachineClick);
    const hasPath = Boolean(props.onPathClick);
    const hasResume = Boolean(props.onResumeClick);
    const hasFiles = Boolean(props.sessionId && props.onFileViewerPress);
    const hasStop = Boolean(props.onAbort && props.showAbortButton);
    const hasAnyActions = getHasAnyAgentInputActions({
        showPermissionChip,
        hasProfile,
        hasEnvVars,
        hasAgent,
        hasMachine,
        hasPath,
        hasResume,
        hasFiles,
        hasStop,
    });

    const actionBarShouldScroll = effectiveActionBarLayout === 'scroll';
    const actionBarIsCollapsed = effectiveActionBarLayout === 'collapsed';
    const showPathAndResumeRow = shouldShowPathAndResumeRow(effectiveActionBarLayout);

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

    const actionMenuActions = React.useMemo(() => {
        return buildAgentInputActionMenuActions({
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
            onProfileClick: props.onProfileClick,
            onEnvVarsClick: props.onEnvVarsClick,
            onAgentClick: props.onAgentClick,
            onMachineClick: props.onMachineClick,
            onPathClick: props.onPathClick,
            onResumeClick: props.onResumeClick,
            onFileViewerPress: props.onFileViewerPress,
            canStop: Boolean(props.onAbort && props.showAbortButton),
            onStop: () => {
                void handleAbortPress();
            },
            dismiss: () => setShowSettings(false),
            blurInput: () => inputRef.current?.blur(),
        });
        }, [
            actionBarIsCollapsed,
            hasAnyActions,
            handleAbortPress,
            agentId,
            profileIcon,
            profileLabel,
            props.agentType,
            props.currentPath,
            props.envVarsCount,
            props.machineName,
            props.onResumeClick,
            props.resumeSessionId,
            props.onAbort,
            props.onAgentClick,
            props.onEnvVarsClick,
            props.onFileViewerPress,
            props.onMachineClick,
            props.onPathClick,
            props.onProfileClick,
            props.sessionId,
            theme.colors.button.secondary.tint,
        ]);

    // Handle settings selection
    const handleSettingsSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        // Don't close the settings overlay - let users see the change and potentially switch again
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
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <Popover
                        open={suggestions.length > 0}
                        anchorRef={overlayAnchorRef}
                        placement="top"
                        gap={8}
                        maxHeightCap={240}
                        // Allow the suggestions popover to match the full input width on wide screens.
                        maxWidthCap={layout.maxWidth}
                        backdrop={false}
                        containerStyle={{ paddingHorizontal: screenWidth > 700 ? 0 : 8 }}
                    >
                        {({ maxHeight }) => (
                            <AgentInputAutocomplete
                                maxHeight={maxHeight}
                                suggestions={suggestions.map(s => {
                                    const Component = s.component;
                                    return <Component key={s.key} />;
                                })}
                                selectedIndex={selected}
                                onSelect={handleSuggestionSelect}
                                itemHeight={Platform.select({ ios: 42, default: 34 }) ?? 34}
                            />
                        )}
                    </Popover>
                )}

                {/* Settings overlay */}
                {showSettings && (
                    <Popover
                        open={showSettings}
                        anchorRef={settingsAnchorRef}
                        boundaryRef={null}
                        placement="top"
                        gap={8}
                        maxHeightCap={400}
                        maxWidthCap={layout.maxWidth}
                        portal={{
                            web: true,
                            native: true,
                            matchAnchorWidth: false,
                            anchorAlign: 'start',
                        }}
                        edgePadding={{
                            horizontal: Platform.OS === 'web' ? (screenWidth > 700 ? 12 : 16) : 0,
                            vertical: 12,
                        }}
                        onRequestClose={() => setShowSettings(false)}
                        backdrop={{ style: styles.overlayBackdrop }}
                    >
                        {({ maxHeight }) => (
                            <FloatingOverlay
                                maxHeight={maxHeight}
                                keyboardShouldPersistTaps="always"
                                edgeFades={{ top: true, bottom: true, size: 28 }}
                                edgeIndicators={true}
                                initialVisibility={{ bottom: true }}
                            >
                                <View testID="agent-input-settings-overlay">
                                    {/* Action shortcuts (collapsed layout) */}
                                    {actionMenuActions.length > 0 ? (
                                        <ActionListSection
                                            title={t('agentInput.actionMenu.title')}
                                            actions={actionMenuActions}
                                        />
                                    ) : null}

                                        {actionBarIsCollapsed && hasAnyActions ? (
                                            <View style={styles.overlayDivider} />
                                        ) : null}

                                        {/* Permission Mode Section */}
                                        <PermissionModePicker
                                            title={getPermissionModeTitleForAgentType(agentId)}
                                            options={permissionModeOptions}
                                            selected={effectivePermissionPolicy.effectiveMode}
                                            onSelect={handleSettingsSelect}
                                            styles={styles}
                                            effectivePermissionLabel={effectivePermissionLabel}
                                            effectivePermissionPolicy={effectivePermissionPolicy}
                                        />

                                    {sessionModePickerControl ? (
                                        <>
                                            <View style={styles.overlayDivider} />
                                            <View style={styles.overlaySection}>
                                                <Text style={styles.overlaySectionTitle}>
                                                    {t('agentInput.mode.sectionTitle')}
                                                </Text>

                                                <Text testID="agent-input-session-mode-summary" style={styles.overlayOptionDescription}>
                                                    {sessionModePickerControl.isPending
                                                        ? t('agentInput.mode.pendingSwitching', {
                                                            from: sessionModePickerControl.currentModeName,
                                                            to:
                                                                sessionModePickerControl.requestedModeName
                                                                ?? sessionModePickerControl.requestedModeId
                                                                ?? '',
                                                        })
                                                        : t('agentInput.mode.currentMode', { name: sessionModePickerControl.currentModeName })}
                                                </Text>

                                                {sessionModePickerControl.options.map((option) => {
                                                    const isSelected = sessionModePickerControl.effectiveModeId === option.id;
                                                    return (
                                                        <Pressable
                                                            testID={`agent-input-session-mode-option:${option.id}`}
                                                            key={option.id}
                                                            onPress={() => {
                                                                hapticsLight();
                                                                props.onAcpSessionModeChange?.(option.id);
                                                            }}
                                                            style={({ pressed }) => [
                                                                styles.overlayOptionRow,
                                                                pressed ? styles.overlayOptionRowPressed : null,
                                                            ]}
                                                        >
                                                            <View
                                                                style={[
                                                                    styles.overlayRadioOuter,
                                                                    isSelected
                                                                        ? styles.overlayRadioOuterSelected
                                                                        : styles.overlayRadioOuterUnselected,
                                                                ]}
                                                            >
                                                                {isSelected && (
                                                                    <View style={styles.overlayRadioInner} />
                                                                )}
                                                            </View>
                                                            <View style={{ flexShrink: 1 }}>
                                                                <Text
                                                                    style={[
                                                                        styles.overlayOptionLabel,
                                                                        isSelected
                                                                            ? styles.overlayOptionLabelSelected
                                                                            : styles.overlayOptionLabelUnselected,
                                                                    ]}
                                                                >
                                                                    {option.name}
                                                                </Text>
                                                                {option.description ? (
                                                                    <Text style={styles.overlayOptionDescription}>
                                                                        {option.description}
                                                                    </Text>
                                                                ) : null}
                                                            </View>
                                                        </Pressable>
                                                    );
                                                })}
                                            </View>
                                        </>
                                    ) : preflightAcpSessionModeOptions && props.onAcpSessionModeChange ? (
                                        <>
                                            <View style={styles.overlayDivider} />
                                            <View style={styles.overlaySection}>
                                                <Text style={styles.overlaySectionTitle}>
                                                    {t('agentInput.mode.sectionTitle')}
                                                </Text>
                                                {props.acpSessionModeOptionsOverrideProbe &&
                                                (props.acpSessionModeOptionsOverrideProbe!.phase !== 'idle' ||
                                                    typeof props.acpSessionModeOptionsOverrideProbe.onRefresh === 'function') ? (
                                                    typeof props.acpSessionModeOptionsOverrideProbe.onRefresh === 'function' ? (
                                                        <Pressable
                                                            testID="agent-input-session-mode-refresh"
                                                            accessibilityRole="button"
                                                            accessibilityLabel={t('agentInput.mode.refreshModesA11y')}
                                                            onPress={
                                                                props.acpSessionModeOptionsOverrideProbe!.phase === 'idle'
                                                                    ? props.acpSessionModeOptionsOverrideProbe.onRefresh
                                                                    : undefined
                                                            }
                                                            style={({ pressed }) => [
                                                                styles.overlayInlineRefreshButton,
                                                                pressed ? styles.overlayInlineRefreshButtonPressed : null,
                                                                props.acpSessionModeOptionsOverrideProbe!.phase !== 'idle'
                                                                    ? styles.overlayInlineRefreshButtonDisabled
                                                                    : null,
                                                            ]}
                                                        >
                                                            {props.acpSessionModeOptionsOverrideProbe!.phase === 'idle' ? (
                                                                renderIoniconNode('refresh-outline', 18, theme.colors.textSecondary)
                                                            ) : (
                                                                <ActivityIndicator size="small" />
                                                            )}
                                                        </Pressable>
                                                    ) : (
                                                        <View style={styles.overlayInlineRefreshButton}>
                                                            <ActivityIndicator size="small" />
                                                        </View>
                                                    )
                                                ) : null}

                                                <Text testID="agent-input-session-mode-summary" style={styles.overlayOptionDescription}>
                                                    {props.acpSessionModeOptionsOverrideProbe?.phase === 'loading'
                                                        ? t('agentInput.mode.loadingModes')
                                                        : props.acpSessionModeOptionsOverrideProbe?.phase === 'refreshing'
                                                            ? t('agentInput.mode.refreshingModes')
                                                            : preflightAcpSessionModeEffective.id === 'default'
                                                                ? t('agentInput.mode.useDefaultModeHint')
                                                                : t('agentInput.mode.startIn', { name: preflightAcpSessionModeEffective.name })}
                                                </Text>

                                                {preflightAcpSessionModeOptions.map((option) => {
                                                    const isSelected = preflightAcpSessionModeEffective.id === option.id;
                                                    return (
                                                        <Pressable
                                                            testID={`agent-input-session-mode-option:${option.id}`}
                                                            key={option.id}
                                                            onPress={() => {
                                                                hapticsLight();
                                                                props.onAcpSessionModeChange?.(option.id);
                                                            }}
                                                            style={({ pressed }) => [
                                                                styles.overlayOptionRow,
                                                                pressed ? styles.overlayOptionRowPressed : null,
                                                            ]}
                                                        >
                                                            <View
                                                                style={[
                                                                    styles.overlayRadioOuter,
                                                                    isSelected
                                                                        ? styles.overlayRadioOuterSelected
                                                                        : styles.overlayRadioOuterUnselected,
                                                                ]}
                                                            >
                                                                {isSelected && (
                                                                    <View style={styles.overlayRadioInner} />
                                                                )}
                                                            </View>
                                                            <View style={{ flexShrink: 1 }}>
                                                                <Text
                                                                    style={[
                                                                        styles.overlayOptionLabel,
                                                                        isSelected
                                                                            ? styles.overlayOptionLabelSelected
                                                                            : styles.overlayOptionLabelUnselected,
                                                                    ]}
                                                                >
                                                                    {option.name}
                                                                </Text>
                                                                {option.description ? (
                                                                    <Text style={styles.overlayOptionDescription}>
                                                                        {option.description}
                                                                    </Text>
                                                                ) : null}
                                                            </View>
                                                        </Pressable>
                                                    );
                                                })}
                                            </View>
                                        </>
                                    ) : null}

                                    {acpConfigOptionControls ? (
                                        <>
                                            <View style={styles.overlayDivider} />
                                            <View style={styles.overlaySection}>
                                                <Text style={styles.overlaySectionTitle}>
                                                    {t('agentInput.acp.optionsSectionTitle')}
                                                </Text>

                                                {acpConfigOptionControls.map((control) => {
                                                    const option = control.option;
                                                    const effectiveValue = control.effectiveValue;
                                                    const isBool =
                                                        option.type === 'boolean' ||
                                                        option.type === 'bool' ||
                                                        option.type === 'toggle';

                                                    const formatValue = (valueId: AcpConfigOptionValueId): string => {
                                                        return valueId;
                                                    };

                                                    if (isBool) {
                                                        const boolValue = parseAcpBooleanValueId(effectiveValue);
                                                        return (
                                                            <Pressable
                                                                key={option.id}
                                                                onPress={() => {
                                                                    hapticsLight();
                                                                    props.onAcpConfigOptionChange?.(option.id, boolValue ? 'false' : 'true');
                                                                }}
                                                                style={({ pressed }) => [
                                                                    styles.overlayOptionRow,
                                                                    pressed ? styles.overlayOptionRowPressed : null,
                                                                ]}
                                                            >
                                                                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                                                                    <View style={{ flex: 1, flexShrink: 1 }}>
                                                                        <Text style={styles.overlayOptionLabel}>
                                                                            {option.name}
                                                                        </Text>
                                                                        <Text style={styles.overlayOptionDescription}>
                                                                            {control.isPending
                                                                                ? t('agentInput.acp.pendingValue', {
                                                                                    current: formatValue(option.currentValue),
                                                                                    requested: formatValue(control.requestedValue!),
                                                                                })
                                                                                : t('agentInput.acp.currentValue', { value: formatValue(option.currentValue) })}
                                                                        </Text>
                                                                        {option.description ? (
                                                                            <Text style={styles.overlayOptionDescription}>
                                                                                {option.description}
                                                                            </Text>
                                                                        ) : null}
                                                                    </View>
                                                                        <View style={{ paddingLeft: 12 }}>
                                                                            <Switch
                                                                                value={boolValue}
                                                                                onValueChange={(next) => {
                                                                                    hapticsLight();
                                                                                    props.onAcpConfigOptionChange?.(option.id, next ? 'true' : 'false');
                                                                                }}
                                                                            />
                                                                        </View>
                                                                </View>
                                                            </Pressable>
                                                        );
                                                    }

                                                    const isSelect = option.type === 'select';
                                                    if (!isSelect || !option.options || option.options.length === 0) {
                                                        return (
                                                            <View key={option.id} testID={`agent-input-config-option:${option.id}`} style={styles.overlaySection}>
                                                                <Text style={styles.overlayOptionLabel}>
                                                                    {option.name}
                                                                </Text>
                                                                <Text testID={`agent-input-config-option-summary:${option.id}`} style={styles.overlayOptionDescription}>
                                                                    {t('agentInput.acp.currentValue', { value: formatValue(option.currentValue) })}
                                                                </Text>
                                                                {option.description ? (
                                                                    <Text style={styles.overlayOptionDescription}>
                                                                        {option.description}
                                                                    </Text>
                                                                ) : null}
                                                            </View>
                                                        );
                                                    }

                                                    const currentLabel =
                                                        option.options.find((o) => o.value === option.currentValue)?.name ??
                                                        formatValue(option.currentValue);
                                                    const requestedLabel =
                                                        control.requestedValue !== undefined
                                                            ? (option.options.find((o) => o.value === control.requestedValue)?.name ??
                                                                formatValue(control.requestedValue))
                                                            : null;

                                                    return (
                                                        <View key={option.id} testID={`agent-input-config-option:${option.id}`} style={styles.overlaySection}>
                                                            <Text style={styles.overlayOptionLabel}>
                                                                {option.name}
                                                            </Text>
                                                            <Text testID={`agent-input-config-option-summary:${option.id}`} style={styles.overlayOptionDescription}>
                                                                {control.isPending && requestedLabel
                                                                    ? t('agentInput.acp.pendingValue', { current: currentLabel, requested: requestedLabel })
                                                                    : t('agentInput.acp.currentValue', { value: currentLabel })}
                                                            </Text>
                                                            {option.description ? (
                                                                <Text style={styles.overlayOptionDescription}>
                                                                    {option.description}
                                                                </Text>
                                                            ) : null}

                                                            {option.options.map((opt) => {
                                                                const isSelected = effectiveValue === opt.value;
                                                                    return (
                                                                        <Pressable
                                                                            testID={`agent-input-config-option-option:${option.id}:${String(opt.value)}`}
                                                                            key={`${option.id}:${String(opt.value)}`}
                                                                            onPress={() => {
                                                                                hapticsLight();
                                                                                props.onAcpConfigOptionChange?.(option.id, opt.value);
                                                                            }}
                                                                        style={({ pressed }) => [
                                                                            styles.overlayOptionRow,
                                                                            pressed ? styles.overlayOptionRowPressed : null,
                                                                        ]}
                                                                    >
                                                                        <View
                                                                            style={[
                                                                                styles.overlayRadioOuter,
                                                                                isSelected
                                                                                    ? styles.overlayRadioOuterSelected
                                                                                    : styles.overlayRadioOuterUnselected,
                                                                            ]}
                                                                        >
                                                                            {isSelected && (
                                                                                <View style={styles.overlayRadioInner} />
                                                                            )}
                                                                        </View>
                                                                        <View style={{ flexShrink: 1 }}>
                                                                            <Text
                                                                                style={[
                                                                                    styles.overlayOptionLabel,
                                                                                    isSelected
                                                                                        ? styles.overlayOptionLabelSelected
                                                                                        : styles.overlayOptionLabelUnselected,
                                                                                ]}
                                                                            >
                                                                                {opt.name}
                                                                            </Text>
                                                                            {opt.description ? (
                                                                                <Text style={styles.overlayOptionDescription}>
                                                                                    {opt.description}
                                                                                </Text>
                                                                            ) : null}
                                                                        </View>
                                                                    </Pressable>
                                                                );
                                                            })}
                                                        </View>
                                                    );
                                                })}
                                            </View>
                                        </>
                                    ) : null}

                                        {/* Divider */}
                                        <View style={styles.overlayDivider} />

                                    <ModelPickerOverlay
                                        title={t('agentInput.model.title')}
                                        effectiveLabel={effectiveModelLabel}
                                        notes={effectiveModelPolicy.notes}
                                        options={modelOptions.map((option) => ({
                                            value: option.value,
                                            label: option.label,
                                            description: option.description,
                                        }))}
                                        selectedValue={effectiveModelPolicy.effectiveModelId}
                                        emptyText={t('agentInput.model.configureInCli')}
                                        canEnterCustomModel={canEnterCustomModel}
                                        customLabel={`${t('profiles.custom')}...`}
                                        customDescription={t('agentInput.model.customDescription')}
                                        probe={props.modelOptionsOverrideProbe ?? (sessionModelOptionsProbe ?? undefined)}
                                        onSelect={(value) => {
                                            hapticsLight();
                                            props.onModelModeChange?.(value);
                                        }}
                                        onRequestCustomModel={canEnterCustomModel ? async () => {
                                            hapticsLight();
                                            const next = await Modal.prompt(
                                                t('profiles.model'),
                                                t('agentInput.model.customPromptBody'),
                                                {
                                                    placeholder: t('agentInput.model.customPlaceholder'),
                                                    confirmText: t('common.save'),
                                                },
                                            );
                                            const normalized = typeof next === 'string' ? next.trim() : '';
                                            if (!normalized) return;
                                            props.onModelModeChange?.(normalized);
                                        } : undefined}
                                    />
                                </View>
                            </FloatingOverlay>
                        )}
                    </Popover>
                )}

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
                        <View style={styles.permissionRequestsContainer}>
                            <View style={{ position: 'relative' }}>
                                <ScrollView
                                    testID="agentInput.permissionRequests.scroll"
                                    style={{ maxHeight: permissionRequestsMaxHeightPx, height: permissionRequestsClampedHeightPx }}
                                    contentContainerStyle={{ paddingBottom: 2 }}
                                    nestedScrollEnabled={true}
                                    scrollEventThrottle={16}
                                    showsVerticalScrollIndicator={false}
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
                                >
                                    <View style={{ gap: 8, paddingTop: 2 }}>
                                        {composerPermissionRequests.map((req) => {
                                            const location =
                                                props.sessionId
                                                    ? (permissionLocationsById.get(req.id) ?? null)
                                                    : null;
                                            return (
                                                <View key={req.id} style={styles.permissionRequestCard}>
                                                    <PermissionPromptCard
                                                        request={req}
                                                        location={location}
                                                        sessionId={props.sessionId!}
                                                        metadata={props.metadata || null}
                                                        canApprovePermissions={canApprovePermissions}
                                                        disabledReason={props.permissionDisabledReason}
                                                    />
                                                </View>
                                            );
                                        })}
                                        {composerUserActionRequests.map((req) => {
                                            const location =
                                                props.sessionId
                                                    ? (permissionLocationsById.get(req.id) ?? null)
                                                    : null;
                                            return (
                                                <View key={req.id} style={styles.permissionRequestCard}>
                                                    <UserActionPromptCard
                                                        request={req}
                                                        location={location}
                                                        sessionId={props.sessionId!}
                                                        metadata={props.metadata || null}
                                                        canApprovePermissions={canApprovePermissions}
                                                        disabledReason={props.permissionDisabledReason}
                                                    />
                                                </View>
                                            );
                                        })}
                                    </View>
                                </ScrollView>

                                <ScrollEdgeFades
                                    color={theme.colors.input.background}
                                    edges={{
                                        top: permissionRequestsFades.visibility?.top === true,
                                        bottom: permissionRequestsFades.visibility?.bottom === true,
                                    }}
                                />
                                <ScrollEdgeIndicators
                                    color={theme.colors.textSecondary}
                                    edges={{
                                        top: permissionRequestsFades.visibility?.top === true,
                                        bottom: permissionRequestsFades.visibility?.bottom === true,
                                    }}
                                />
                            </View>
                        </View>
                    ) : null}

                    {props.attachments && props.attachments.length > 0 ? (
                        <View style={styles.attachmentsRow}>
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={{ gap: 8 }}
                            >
                                {props.attachments.map((att) => {
                                    const removingDisabled = att.status === 'uploading';
                                    const percent = att.status === 'uploading' ? resolveUploadProgressPercent(att.uploadProgress) : null;
                                    const imagePreviewUri =
                                        att.preview?.kind === 'image' && typeof att.preview.uri === 'string' && att.preview.uri.trim().length > 0
                                            ? att.preview.uri
                                            : null;
                                    const imagePreviewIndex = attachmentImagePreviewItems.findIndex((item) => item.uri === imagePreviewUri && item.title === att.label);

                                    if (imagePreviewUri) {
                                        return (
                                            <View key={att.key} style={styles.attachmentImageTile}>
                                                <Pressable
                                                    accessibilityLabel={t('common.open')}
                                                    accessibilityRole="imagebutton"
                                                    onPress={() => {
                                                        Modal.show({
                                                            component: AttachmentImagePreviewModal,
                                                            props: {
                                                                images: attachmentImagePreviewItems,
                                                                initialIndex: imagePreviewIndex >= 0 ? imagePreviewIndex : 0,
                                                            },
                                                        });
                                                    }}
                                                    style={styles.attachmentImageSurface}
                                                    testID={`agent-input-attachment-image:${att.key}`}
                                                >
                                                    <Image
                                                        source={{ uri: imagePreviewUri }}
                                                        style={[{ width: '100%', height: '100%' }, styles.attachmentImage]}
                                                        contentFit="cover"
                                                    />
                                                    {att.status === 'uploading' && percent != null ? (
                                                        <View style={styles.attachmentImageOverlay}>
                                                            <Text style={styles.attachmentImageOverlayText}>{percent}%</Text>
                                                        </View>
                                                    ) : null}
                                                    {att.status === 'error' ? (
                                                        <View style={[styles.attachmentImageOverlay, styles.attachmentImageErrorOverlay]}>
                                                            {renderIoniconNode('alert-circle', 20, theme.colors.overlay.text)}
                                                        </View>
                                                    ) : null}
                                                </Pressable>
                                                {att.onRemove ? (
                                                    <Pressable
                                                        testID={`agent-input-attachment-remove:${att.key}`}
                                                        onPress={() => {
                                                            if (removingDisabled) return;
                                                            hapticsLight();
                                                            att.onRemove?.();
                                                        }}
                                                        disabled={removingDisabled}
                                                        hitSlop={8}
                                                        style={styles.attachmentImageRemoveButton}
                                                    >
                                                        {renderIoniconNode('close-circle', 18, theme.colors.textSecondary)}
                                                    </Pressable>
                                                ) : null}
                                            </View>
                                        );
                                    }

                                    return (
                                        <View key={att.key} style={styles.attachmentChip}>
                                            {renderIoniconNode('document-outline', 14, theme.colors.textSecondary)}
                                            <Text
                                                numberOfLines={1}
                                                style={styles.attachmentChipText}
                                            >
                                                {att.label}
                                            </Text>
                                            {att.status === 'uploading' ? (
                                                percent != null ? (
                                                    <Text style={styles.attachmentChipMeta}>{percent}%</Text>
                                                ) : (
                                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                                )
                                            ) : null}
                                            {att.onRemove ? (
                                                <Pressable
                                                    testID={`agent-input-attachment-remove:${att.key}`}
                                                    onPress={() => {
                                                        if (removingDisabled) return;
                                                        hapticsLight();
                                                        att.onRemove?.();
                                                    }}
                                                    disabled={removingDisabled}
                                                    hitSlop={8}
                                                >
                                                    {renderIoniconNode('close-circle', 16, theme.colors.textSecondary)}
                                                </Pressable>
                                            ) : null}
                                        </View>
                                    );
                                })}
                            </ScrollView>
                        </View>
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
                                style={[styles.actionButtonsRow, showPathAndResumeRow ? styles.actionButtonsRowWithBelow : null]}
                            >
                                {(() => {
                                    const chipStyle = (pressed: boolean) => ([
                                        styles.actionChip,
                                        !showChipLabels ? styles.actionChipIconOnly : null,
                                        pressed ? styles.actionChipPressed : null,
                                    ]);
                                    const chipStyleAutoHide = (pressed: boolean) => ([
                                        styles.actionChip,
                                        !showAutoHideChipLabels ? styles.actionChipIconOnly : null,
                                        pressed ? styles.actionChipPressed : null,
                                    ]);
                                    const extraChips = (props.extraActionChips ?? []).map((chip) => {
                                        const isAutoHide = chip.labelPolicy === 'auto-hide';
                                        return (
                                            <React.Fragment key={chip.key}>
                                                {chip.render({
                                                    chipStyle: isAutoHide ? chipStyleAutoHide : chipStyle,
                                                    showLabel: isAutoHide ? showAutoHideChipLabels : showChipLabels,
                                                    iconColor: theme.colors.button.secondary.tint,
                                                    textStyle: styles.actionChipText,
                                                    countTextStyle: styles.actionChipCountText,
                                                    popoverAnchorRef: overlayAnchorRef,
                                                })}
                                            </React.Fragment>
                                        );
                                    });

                                    const permissionOrControlsChip = (showPermissionChip || actionBarIsCollapsed) ? (
                                        <Pressable
                                            ref={settingsAnchorRef}
                                            key="permission"
                                            testID="agent-input-settings-button"
                                            onPress={() => {
                                                hapticsLight();
                                                if (!actionBarIsCollapsed && props.onPermissionClick) {
                                                    props.onPermissionClick();
                                                    return;
                                                }
                                                handleSettingsPress();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            {renderOcticonNode('gear', 16, theme.colors.button.secondary.tint)}
                                            {showChipLabels && permissionChipLabel ? (
                                                <Text style={styles.actionChipText}>
                                                    {permissionChipLabel}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                    const modeChip = (!actionBarIsCollapsed && props.onAcpSessionModeChange) ? (() => {
                                        const control = sessionModePickerControl
                                            ? {
                                                options: sessionModePickerControl.options,
                                                selectedId: sessionModePickerControl.requestedModeId ?? 'default',
                                                label: sessionModePickerControl.effectiveModeName,
                                                isPending: sessionModePickerControl.isPending,
                                            }
                                            : preflightAcpSessionModeOptions
                                                ? {
                                                    options: preflightAcpSessionModeOptions,
                                                    selectedId: preflightAcpSessionModeEffective.id,
                                                    label: preflightAcpSessionModeEffective.name,
                                                    isPending: false,
                                                }
                                                : null;
                                        if (!control) return null;

                                        const optionIds = [
                                            'default',
                                            ...control.options.map((o) => o.id).filter((id) => id && id !== 'default'),
                                        ];
                                        const uniqueIds = Array.from(new Set(optionIds));
                                        const shouldRender = shouldRenderChipForOptions({
                                            optionCount: uniqueIds.length,
                                            showWhenNoOptions: false,
                                            showWhenSingleOption: false,
                                        });
                                        if (!shouldRender) return null;

                                        const interaction = resolveChipOptionInteraction({
                                            currentOptionId: control.selectedId,
                                            selectableOptionIds: uniqueIds,
                                            cycleMaxOptions: DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
                                        });
                                        const optionsById = new Map(control.options.map((option) => [option.id, option]));

                                        return (
                                            <Pressable
                                                testID="agent-input-session-mode-chip"
                                                key="mode"
                                                onPress={() => {
                                                    hapticsLight();
                                                    if (interaction.kind === 'cycle') {
                                                        props.onAcpSessionModeChange?.(interaction.nextOptionId);
                                                        return;
                                                    }
                                                    if (interaction.kind === 'picker') {
                                                        Modal.show({
                                                            component: AgentInputChipPickerModal,
                                                            props: {
                                                                title: t('agentInput.mode.sectionTitle'),
                                                                options: interaction.selectableOptionIds.map((id) => ({
                                                                    id,
                                                                    label: optionsById.get(id)?.name
                                                                        ?? (id === 'default' ? t('common.default') : id),
                                                                    subtitle: optionsById.get(id)?.description,
                                                                })),
                                                                selectedOptionId: control.selectedId,
                                                                onSelect: (selectedId) => props.onAcpSessionModeChange?.(selectedId),
                                                            },
                                                        });
                                                    }
                                                }}
                                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                                style={(p) => chipStyle(p.pressed)}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('agentInput.mode.badgeA11y', { name: control.label })}
                                            >
                                                {renderIoniconNode('list-outline', 18, theme.colors.button.secondary.tint)}
                                                {showChipLabels ? (
                                                    <Text style={styles.actionChipText}>
                                                        {control.isPending
                                                            ? t('agentInput.mode.badgePending', { name: control.label })
                                                            : t('agentInput.mode.badge', { name: control.label })}
                                                    </Text>
                                                ) : null}
                                            </Pressable>
                                        );
                                    })() : null;

                                    const profileChip = props.onProfileClick ? (
                                        <Pressable
                                            key="profile"
                                            onPress={() => {
                                                hapticsLight();
                                                props.onProfileClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            {renderIoniconNode(profileIcon as any, 18, theme.colors.button.secondary.tint)}
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {profileLabel ?? t('profiles.noProfile')}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                    const envVarsChip = props.onEnvVarsClick ? (
                                        <Pressable
                                            key="envVars"
                                            onPress={() => {
                                                hapticsLight();
                                                props.onEnvVarsClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            {renderIoniconNode('list-outline', 18, theme.colors.button.secondary.tint)}
                                            {showChipLabels ? (
                                                <AgentInputChipLabel
                                                    label={t('agentInput.envVars.title')}
                                                    count={props.envVarsCount}
                                                    textStyle={styles.actionChipText}
                                                    countTextStyle={styles.actionChipCountText}
                                                />
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                    const agentChip = (props.agentType && props.onAgentClick) ? (
                                        <Pressable
                                            key="agent"
                                            testID="agent-input-agent-chip"
                                            onPress={() => {
                                                hapticsLight();
                                                props.onAgentClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            {renderOcticonNode('cpu', 16, theme.colors.button.secondary.tint)}
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {props.agentLabel ?? t(getAgentCore(props.agentType).displayNameKey)}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                        const machineChip = props.onMachineClick ? (
                                            <Pressable
                                                key="machine"
                                                testID="agent-input-machine-chip"
                                                onPress={() => {
                                                    hapticsLight();
                                                    props.onMachineClick?.();
                                                }}
                                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            {renderIoniconNode('desktop-outline', 18, theme.colors.button.secondary.tint)}
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {props.machineName === null
                                                        ? t('agentInput.noMachinesAvailable')
                                                        : (typeof props.machineName === 'string'
                                                            ? truncateWithEllipsis(props.machineName, 12)
                                                            : t('newSession.selectMachineTitle'))}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                        const pathChip = props.onPathClick ? (
                                            <Pressable
                                                key="path"
                                                testID="agent-input-path-chip"
                                                onPress={() => {
                                                    hapticsLight();
                                                    props.onPathClick?.();
                                                }}
                                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            {renderIoniconNode('folder-outline', 18, theme.colors.button.secondary.tint)}
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {typeof props.currentPath === 'string' && props.currentPath.length > 0
                                                        ? props.currentPath
                                                        : t('newSession.selectPathTitle')}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                        const resumeChip = props.onResumeClick ? (
                                            <ResumeChip
                                                key="resume"
                                                onPress={() => {
                                                    hapticsLight();
                                                    inputRef.current?.blur();
                                                    props.onResumeClick?.();
                                                }}
                                                showLabel={showChipLabels}
                                                resumeSessionId={props.resumeSessionId}
                                                isChecking={props.resumeIsChecking === true}
                                                labelTitle={t('newSession.resume.title')}
                                            labelOptional={t('newSession.resume.optional')}
                                            iconColor={theme.colors.button.secondary.tint}
                                            pressableStyle={chipStyle}
                                            textStyle={styles.actionChipText}
                                        />
                                    ) : null;

                                    const abortButton = props.onAbort && props.showAbortButton && !actionBarIsCollapsed ? (
                                        <Shaker key="abort" ref={shakerRef}>
                                            <Pressable
                                                testID="agent-input-abort"
                                                accessibilityRole="button"
                                                accessibilityLabel={t('runs.stop.stopRunA11y')}
                                                style={(p) => [
                                                    styles.actionButton,
                                                    p.pressed ? styles.actionButtonPressed : null,
                                                ]}
                                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                                onPress={handleAbortPress}
                                                disabled={isAborting}
                                            >
                                                {isAborting ? (
                                                    <ActivityIndicator
                                                        size="small"
                                                        color={theme.colors.button.secondary.tint}
                                                    />
                                                ) : (
                                                    renderOcticonNode('stop', 16, theme.colors.button.secondary.tint)
                                                )}
                                            </Pressable>
                                        </Shaker>
                                    ) : null;

                                    const sourceControlStatusChip = !actionBarIsCollapsed ? (
                                        <View key="git" style={styles.actionItemWrapper}>
                                            <SourceControlStatusButton
                                                sessionId={props.sessionId}
                                                onPress={props.onFileViewerPress}
                                                compact={actionBarShouldScroll || !showChipLabels}
                                            />
                                        </View>
                                    ) : null;

                                    const chips = actionBarIsCollapsed
                                        ? [permissionOrControlsChip].filter(Boolean)
                                        : [
                                            permissionOrControlsChip,
                                            agentChip,
                                            modeChip,
                                            profileChip,
                                            envVarsChip,
                                            ...extraChips,
                                            machineChip,
                                            ...(actionBarShouldScroll ? [pathChip, resumeChip] : []),
                                            abortButton,
                                            sourceControlStatusChip,
                                        ].filter(Boolean);

                                    // IMPORTANT: We must always render the ScrollView in "scroll layout" mode,
                                    // otherwise we never measure content/viewport widths and can't know whether
                                    // scrolling is needed (deadlock).
                                    if (actionBarShouldScroll) {
                                        const scrollEnabled = Platform.OS === 'web' ? true : canActionBarScroll;

                                        const handleWheel = (e: any) => {
                                            if (Platform.OS !== 'web') return;
                                            const node = getActionBarScrollNode() as any;
                                            if (!node) return;
                                            const ne = e?.nativeEvent ?? e;
                                            const dx = typeof ne?.deltaX === 'number' ? ne.deltaX : 0;
                                            const dy = typeof ne?.deltaY === 'number' ? ne.deltaY : 0;
                                            // Map vertical wheel to horizontal scrolling (mouse-friendly).
                                            const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
                                            if (!delta) return;
                                            const before = node.scrollLeft ?? 0;
                                            node.scrollLeft = before + delta;
                                            reportActionBarWebScroll(node);
                                        };

                                        const handleScrollContentSizeChange = (width: number, height: number) => {
                                            actionBarFades.onContentSizeChange(
                                                Math.max(0, width - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
                                                height
                                            );
                                        };

                                        const handleScroll = (e: any) => {
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
                                        };

                                        return (
                                            <View style={styles.actionButtonsLeftScroll}>
                                                <ScrollViewWithWheel
                                                    ref={actionBarScrollRef}
                                                    horizontal
                                                    showsHorizontalScrollIndicator={false}
                                                    scrollEnabled={scrollEnabled}
                                                    alwaysBounceHorizontal={false}
                                                    directionalLockEnabled
                                                    keyboardShouldPersistTaps="handled"
                                                    onWheel={handleWheel}
                                                    onLayout={actionBarFades.onViewportLayout}
                                                    onContentSizeChange={handleScrollContentSizeChange}
                                                    onScroll={handleScroll}
                                                    scrollEventThrottle={16}
                                                >
                                                    <View style={styles.actionButtonsLeftScrollContent as any}>
                                                        {chips as any}
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
                                                    // Keep indicators within the same fade gutters.
                                                    leftStyle={styles.actionButtonsFadeLeft as any}
                                                    rightStyle={styles.actionButtonsFadeRight as any}
                                                />
                                            </View>
                                        );
                                    }

                                    return (
                                        <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                                            {chips as any}
                                        </View>
                                    );
                                })()}

                                {/* Send/Voice button - aligned with first row */}
                                <PrimaryCircleIconButton
                                    testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                                    active={hasSendableContent || props.isSending || Boolean(micPressHandler)}
                                    loading={props.isSending}
                                    disabled={props.disabled || props.isSendDisabled || props.isSending || (!hasSendableContent && !micPressHandler)}
                                    accessibilityLabel={
                                        hasSendableContent
                                            ? (props.sessionId ? t('common.send') : t('newSession.title'))
                                            : (micPressHandler ? t('voiceAssistant.label') : (props.sessionId ? t('common.send') : t('newSession.title')))
                                    }
                                    accessibilityHint={
                                        (!hasSendableContent && !micPressHandler)
                                            ? t('session.inputPlaceholder')
                                            : undefined
                                    }
                                    accessibilityState={{
                                        disabled: Boolean(props.disabled || props.isSendDisabled || props.isSending || (!hasSendableContent && !micPressHandler)),
                                    }}
                                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                    onPress={() => {
                                        hapticsLight();
                                        if (hasSendableContent) {
                                            handleSend();
                                        } else {
                                            micPressHandler?.();
                                        }
                                    }}
                                    style={{ marginLeft: 8, marginRight: 8 }}
                                >
                                    {hasSendableContent ? (
                                        renderOcticonNode(
                                            'arrow-up',
                                            16,
                                            theme.colors.button.primary.tint,
                                            { marginTop: Platform.OS === 'web' ? 2 : 0 },
                                        )
                                    ) : micPressHandler ? (
                                        micActive ? (
                                            renderIoniconNode('stop-circle', 22, theme.colors.button.primary.tint)
                                        ) : (
                                            <Image
                                                source={require('@/assets/images/icon-voice-white.png')}
                                                style={{ width: 24, height: 24 }}
                                                tintColor={theme.colors.button.primary.tint}
                                            />
                                        )
                                    ) : (
                                        renderOcticonNode(
                                            'arrow-up',
                                            16,
                                            theme.colors.button.primary.tint,
                                            { marginTop: Platform.OS === 'web' ? 2 : 0 },
                                        )
                                    )}
                                </PrimaryCircleIconButton>
                                    </View>,

                                    // Row 2: Path + Resume selectors (separate line to match pre-PR272 layout)
                                    // - wrap: shown below
                                    // - scroll: folds into row 1
                                    // - collapsed: moved into settings popover
                                    (showPathAndResumeRow) ? (
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
                                        showChipLabels={showChipLabels}
                                        iconColor={theme.colors.button.secondary.tint}
                                        currentPath={props.currentPath}
                                        emptyPathLabel={t('newSession.selectPathTitle')}
                                        onPathClick={props.onPathClick ? () => {
                                            hapticsLight();
                                            props.onPathClick?.();
                                        } : undefined}
                                            resumeSessionId={props.resumeSessionId}
                                            onResumeClick={props.onResumeClick ? () => {
                                                hapticsLight();
                                                inputRef.current?.blur();
                                                props.onResumeClick?.();
                                            } : undefined}
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

// Source Control Status Button Component
function SourceControlStatusButton({ sessionId, onPress, compact }: { sessionId?: string, onPress?: () => void, compact?: boolean }) {
    const hasMeaningfulScmStatus = useHasMeaningfulScmStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <Pressable
            testID="session-open-source-control"
            accessibilityRole="button"
            accessibilityLabel={t('settings.sourceControl')}
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
                flex: compact ? 0 : 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                onPress?.();
            }}
        >
            {hasMeaningfulScmStatus ? (
                <SourceControlStatusBadge sessionId={sessionId} />
            ) : (
                normalizeNodeForView(
                    <Octicons
                        name="git-branch"
                        size={16}
                        color={theme.colors.button.secondary.tint}
                    />,
                )
            )}
        </Pressable>
    );
}
