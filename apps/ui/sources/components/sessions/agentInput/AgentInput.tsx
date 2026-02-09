import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, Pressable, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { layout } from '@/components/ui/layout/layout';
import { MultiTextInput, KeyPressEvent } from '@/components/ui/forms/MultiTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Typography } from '@/constants/Typography';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getModelOptionsForSession, supportsFreeformModelSelectionForSession } from '@/sync/domains/models/modelOptions';
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
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { TextInputState, MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from '@/components/git';
import { ModelPickerOverlay } from '@/components/model/ModelPickerOverlay';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/domains/state/storage';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/domains/state/storageTypes';
import { AIBackendProfile, getProfileEnvironmentVariables } from '@/sync/domains/settings/settings';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ResumeChip, formatResumeChipLabel, RESUME_CHIP_ICON_NAME, RESUME_CHIP_ICON_SIZE } from './ResumeChip';
import { PathAndResumeRow } from './PathAndResumeRow';
import { getHasAnyAgentInputActions, shouldShowPathAndResumeRow } from './actionBarLogic';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { computeAgentInputDefaultMaxHeight } from './inputMaxHeight';
import { getContextWarning } from './contextWarning';
import { buildAgentInputActionMenuActions } from './actionMenuActions';
import { PermissionModePicker } from './components/PermissionModePicker';
import { computeAcpPlanModeControl, computeAcpSessionModePickerControl } from '@/sync/acp/sessionModeControl';
import { computeAcpConfigOptionControls, type AcpConfigOptionValueId } from '@/sync/acp/configOptionsControl';

export type AgentInputExtraActionChipRenderContext = Readonly<{
    chipStyle: (pressed: boolean) => any;
    showLabel: boolean;
    iconColor: string;
    textStyle: any;
}>;

export type AgentInputExtraActionChip = Readonly<{
    key: string;
    render: (ctx: AgentInputExtraActionChipRenderContext) => React.ReactNode;
}>;

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
    onAcpConfigOptionChange?: (configId: string, valueId: AcpConfigOptionValueId) => void;
    modelMode?: ModelMode;
    onModelModeChange?: (mode: ModelMode) => void;
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
}

function truncateWithEllipsis(value: string, maxChars: number) {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}…`;
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
        marginBottom: Platform.OS === 'web' ? 3 : 8,
    },
    pathRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        ...(Platform.OS === 'web' ? { columnGap: 6, rowGap: 3 } : {}),
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
        ...(Platform.OS === 'web' ? { columnGap: 6 } : {}),
        paddingRight: 6,
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
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
        marginRight: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
}));

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();

    const defaultInputMaxHeight = React.useMemo(() => {
        return computeAgentInputDefaultMaxHeight({
            platform: Platform.OS,
            screenHeight,
            keyboardHeight,
        });
    }, [keyboardHeight, screenHeight]);

    const hasText = props.value.trim().length > 0;

    const agentId: AgentId = resolveAgentIdFromFlavor(props.metadata?.flavor) ?? props.agentType ?? DEFAULT_AGENT_ID;
    const modelOptions = React.useMemo(() => getModelOptionsForSession(agentId, props.metadata ?? null), [agentId, props.metadata]);

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
    const agentInputActionBarLayout = useSetting('agentInputActionBarLayout');
    const agentInputChipDensity = useSetting('agentInputChipDensity');
    const sessionPermissionModeApplyTiming = useSetting('sessionPermissionModeApplyTiming');

    const effectiveChipDensity = React.useMemo<'labels' | 'icons'>(() => {
        if (agentInputChipDensity === 'labels' || agentInputChipDensity === 'icons') {
            return agentInputChipDensity;
        }
        // auto
        return screenWidth < 420 ? 'icons' : 'labels';
    }, [agentInputChipDensity, screenWidth]);

    const effectiveActionBarLayout = React.useMemo<'wrap' | 'scroll' | 'collapsed'>(() => {
        if (agentInputActionBarLayout === 'wrap' || agentInputActionBarLayout === 'scroll' || agentInputActionBarLayout === 'collapsed') {
            return agentInputActionBarLayout;
        }
        // auto
        return screenWidth < 420 ? 'scroll' : 'wrap';
    }, [agentInputActionBarLayout, screenWidth]);

    const showChipLabels = effectiveChipDensity === 'labels';


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

    const actionBarFades = useScrollEdgeFades({
        enabledEdges: { left: true, right: true },
        // Match previous behavior: require a bit of overflow before enabling scroll.
        overflowThreshold: 8,
        // Match previous behavior: avoid showing fades for tiny offsets.
        edgeThreshold: 2,
    });

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
        return effectiveModelPolicy.effectiveModelId === 'default' ? 'Default' : effectiveModelPolicy.effectiveModelId;
    }, [effectiveModelPolicy.effectiveModelId, modelOptions]);

    const canEnterCustomModel = React.useMemo(() => {
        return supportsFreeformModelSelectionForSession(agentId, props.metadata ?? null);
    }, [agentId, props.metadata]);

    const acpPlanModeControl = React.useMemo(() => {
        if (!props.onAcpSessionModeChange) return null;
        return computeAcpPlanModeControl(props.metadata ?? null);
    }, [props.metadata, props.onAcpSessionModeChange]);

    const acpSessionModePickerControl = React.useMemo(() => {
        if (!props.onAcpSessionModeChange) return null;
        return computeAcpSessionModePickerControl({ agentId, metadata: props.metadata ?? null });
    }, [agentId, props.metadata, props.onAcpSessionModeChange]);

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
    const hasMachine = Boolean(props.machineName !== undefined && props.onMachineClick);
    const hasPath = Boolean(props.currentPath && props.onPathClick);
    const hasResume = Boolean(props.onResumeClick);
    const hasFiles = Boolean(props.sessionId && props.onFileViewerPress);
    const hasStop = Boolean(props.onAbort);
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
            canStop: Boolean(props.onAbort),
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
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey) {
                if (props.value.trim()) {
                    props.onSend();
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
		    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, inputState.text, inputState.selection.start, inputState.selection.end, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.value, props.onSend, props.onPermissionModeChange, agentId, permissionModeOrder, effectivePermissionPolicy.effectiveMode]);




    return (
        <View style={[
            styles.container,
            { paddingHorizontal: props.contentPaddingHorizontal ?? (screenWidth > 700 ? 16 : 8) }
        ]}>
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
                                itemHeight={48}
                            />
                        )}
                    </Popover>
                )}

                {/* Settings overlay */}
	                {showSettings && (
	                    <Popover
	                        open={showSettings}
	                        anchorRef={overlayAnchorRef}
	                        boundaryRef={null}
	                        placement="top"
	                        gap={8}
	                        maxHeightCap={400}
	                        portal={{ web: true }}
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
                            >
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
		                                />

                                    <View style={styles.overlaySection}>
                                        <Text style={styles.overlayOptionDescription}>
                                            Effective: {effectivePermissionLabel}
                                        </Text>
                                        {effectivePermissionPolicy.notes.map((note, idx) => (
                                            <Text key={idx} style={styles.overlayOptionDescription}>
                                                {note}
                                            </Text>
                                        ))}
                                    </View>

                                    {acpSessionModePickerControl ? (
                                        <>
                                            <View style={styles.overlayDivider} />
                                            <View style={styles.overlaySection}>
                                                <Text style={styles.overlaySectionTitle}>
                                                    Mode
                                                </Text>

                                                <Text style={styles.overlayOptionDescription}>
                                                    {acpSessionModePickerControl.isPending
                                                        ? `Pending: switching from ${acpSessionModePickerControl.currentModeName} to ${acpSessionModePickerControl.requestedModeName}`
                                                        : `Current: ${acpSessionModePickerControl.currentModeName}`}
                                                </Text>

                                                {acpSessionModePickerControl.options.map((option) => {
                                                    const isSelected = acpSessionModePickerControl.effectiveModeId === option.id;
                                                    return (
                                                        <Pressable
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
                                                    Options
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
                                                                                ? `Pending: ${formatValue(option.currentValue)} → ${formatValue(control.requestedValue!)}`
                                                                                : `Current: ${formatValue(option.currentValue)}`}
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
                                                            <View key={option.id} style={styles.overlaySection}>
                                                                <Text style={styles.overlayOptionLabel}>
                                                                    {option.name}
                                                                </Text>
                                                                <Text style={styles.overlayOptionDescription}>
                                                                    Current: {formatValue(option.currentValue)}
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
                                                        <View key={option.id} style={styles.overlaySection}>
                                                            <Text style={styles.overlayOptionLabel}>
                                                                {option.name}
                                                            </Text>
                                                            <Text style={styles.overlayOptionDescription}>
                                                                {control.isPending && requestedLabel
                                                                    ? `Pending: ${currentLabel} → ${requestedLabel}`
                                                                    : `Current: ${currentLabel}`}
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
                                    customLabel={`${t('profiles.custom')}…`}
                                    customDescription="Use a model id that isn’t listed."
                                    onSelect={(value) => {
                                        hapticsLight();
                                        props.onModelModeChange?.(value);
                                    }}
                                    onRequestCustomModel={canEnterCustomModel ? async () => {
                                        hapticsLight();
                                        const next = await Modal.prompt(
                                            t('profiles.model'),
                                            'Enter a model id',
                                            {
                                                placeholder: 'e.g. claude-3.5-sonnet',
                                                confirmText: t('common.save'),
                                            },
                                        );
                                        const normalized = typeof next === 'string' ? next.trim() : '';
                                        if (!normalized) return;
                                        props.onModelModeChange?.(normalized);
                                    } : undefined}
                                />
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
                                    <Text style={[styles.statusText, { color: props.connectionStatus.color }]}>
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
                            {permissionChipLabel && (
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
                            )}
                        </View>
                    </View>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <View style={[styles.unifiedPanel, props.panelStyle]}>
                    {/* Input field */}
                    <View style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}>
                        <MultiTextInput
                            ref={inputRef}
                            value={props.value}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            onChangeText={props.onChangeText}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={props.inputMaxHeight ?? defaultInputMaxHeight}
                            editable={!props.disabled}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={screenWidth < 420 ? styles.actionButtonsColumnNarrow : styles.actionButtonsColumn}>{[
                            // Row 1: Settings, Profile (FIRST), Agent, Abort, Git Status
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
                                    const extraChips = (props.extraActionChips ?? []).map((chip) => (
                                        <React.Fragment key={chip.key}>
                                            {chip.render({
                                                chipStyle,
                                                showLabel: showChipLabels,
                                                iconColor: theme.colors.button.secondary.tint,
                                                textStyle: styles.actionChipText,
                                            })}
                                        </React.Fragment>
                                    ));

                                    const permissionOrControlsChip = (showPermissionChip || actionBarIsCollapsed) ? (
                                        <Pressable
                                            key="permission"
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
                                            <Octicons
                                                name="gear"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            {showChipLabels && permissionChipLabel ? (
                                                <Text style={styles.actionChipText}>
                                                    {permissionChipLabel}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                    const acpPlanChip = (acpPlanModeControl && props.onAcpSessionModeChange && !actionBarIsCollapsed) ? (
                                        <Pressable
                                            key="acp-plan"
                                            onPress={() => {
                                                hapticsLight();
                                                if (acpPlanModeControl.planOn) {
                                                    if (acpPlanModeControl.offModeId) {
                                                        props.onAcpSessionModeChange?.(acpPlanModeControl.offModeId);
                                                    }
                                                } else {
                                                    props.onAcpSessionModeChange?.('plan');
                                                }
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            <Ionicons
                                                name="list-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    Plan
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

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
                                            <Ionicons
                                                name={profileIcon as any}
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
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
                                            <Ionicons
                                                name="list-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {props.envVarsCount === undefined
                                                        ? t('agentInput.envVars.title')
                                                        : t('agentInput.envVars.titleWithCount', { count: props.envVarsCount })}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                    const agentChip = (props.agentType && props.onAgentClick) ? (
                                        <Pressable
                                            key="agent"
                                            onPress={() => {
                                                hapticsLight();
                                                props.onAgentClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            <Octicons
                                                name="cpu"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {t(getAgentCore(props.agentType).displayNameKey)}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                    const machineChip = ((props.machineName !== undefined) && props.onMachineClick) ? (
                                        <Pressable
                                            key="machine"
                                            onPress={() => {
                                                hapticsLight();
                                                props.onMachineClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            <Ionicons
                                                name="desktop-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {props.machineName === null
                                                        ? t('agentInput.noMachinesAvailable')
                                                        : truncateWithEllipsis(props.machineName, 12)}
                                                </Text>
                                            ) : null}
                                        </Pressable>
                                    ) : null;

                                    const pathChip = (props.currentPath && props.onPathClick) ? (
                                        <Pressable
                                            key="path"
                                            onPress={() => {
                                                hapticsLight();
                                                props.onPathClick?.();
                                            }}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            style={(p) => chipStyle(p.pressed)}
                                        >
                                            <Ionicons
                                                name="folder-outline"
                                                size={16}
                                                color={theme.colors.button.secondary.tint}
                                            />
                                            {showChipLabels ? (
                                                <Text style={styles.actionChipText}>
                                                    {props.currentPath}
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

                                    const abortButton = props.onAbort && !actionBarIsCollapsed ? (
                                        <Shaker key="abort" ref={shakerRef}>
                                            <Pressable
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
                                                    <Octicons
                                                        name={"stop"}
                                                        size={16}
                                                        color={theme.colors.button.secondary.tint}
                                                    />
                                                )}
                                            </Pressable>
                                        </Shaker>
                                    ) : null;

                                    const gitStatusChip = !actionBarIsCollapsed ? (
                                        <GitStatusButton
                                            key="git"
                                            sessionId={props.sessionId}
                                            onPress={props.onFileViewerPress}
                                            compact={actionBarShouldScroll || !showChipLabels}
                                        />
                                    ) : null;

                                    const chips = actionBarIsCollapsed
                                        ? [permissionOrControlsChip].filter(Boolean)
                                        : [
                                            permissionOrControlsChip,
                                            acpPlanChip,
                                            profileChip,
                                            envVarsChip,
                                            agentChip,
                                            ...extraChips,
                                            machineChip,
                                            ...(actionBarShouldScroll ? [pathChip, resumeChip] : []),
                                            abortButton,
                                            gitStatusChip,
                                        ].filter(Boolean);

                                    // IMPORTANT: We must always render the ScrollView in "scroll layout" mode,
                                    // otherwise we never measure content/viewport widths and can't know whether
                                    // scrolling is needed (deadlock).
                                    if (actionBarShouldScroll) {
                                        return (
                                            <View style={styles.actionButtonsLeftScroll}>
                                                <ScrollView
                                                    horizontal
                                                    showsHorizontalScrollIndicator={false}
                                                    scrollEnabled={canActionBarScroll}
                                                    alwaysBounceHorizontal={false}
                                                    directionalLockEnabled
                                                    keyboardShouldPersistTaps="handled"
                                                    contentContainerStyle={styles.actionButtonsLeftScrollContent as any}
                                                    onLayout={actionBarFades.onViewportLayout}
                                                    onContentSizeChange={actionBarFades.onContentSizeChange}
                                                    onScroll={actionBarFades.onScroll}
                                                    scrollEventThrottle={16}
                                                >
                                                    {chips as any}
                                                </ScrollView>
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
                                <View
                                    style={[
                                        styles.sendButton,
                                        (hasText || props.isSending || (props.onMicPress && !props.isMicActive))
                                            ? styles.sendButtonActive
                                            : styles.sendButtonInactive
                                    ]}
                                >
                                    <Pressable
                                        style={(p) => [
                                            styles.sendButtonInner,
                                            p.pressed ? styles.sendButtonInnerPressed : null,
                                        ]}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        onPress={() => {
                                            hapticsLight();
                                            if (hasText) {
                                                props.onSend();
                                            } else {
                                                props.onMicPress?.();
                                            }
                                        }}
                                        disabled={props.disabled || props.isSendDisabled || props.isSending || (!hasText && !props.onMicPress)}
                                    >
                                        {props.isSending ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.button.primary.tint}
                                            />
                                        ) : hasText ? (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        ) : props.onMicPress && !props.isMicActive ? (
                                            <Image
                                                source={require('@/assets/images/icon-voice-white.png')}
                                                style={{ width: 24, height: 24 }}
                                                tintColor={theme.colors.button.primary.tint}
                                            />
                                        ) : (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        )}
                                    </Pressable>
	                                </View>
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

// Git Status Button Component
function GitStatusButton({ sessionId, onPress, compact }: { sessionId?: string, onPress?: () => void, compact?: boolean }) {
    const hasMeaningfulGitStatus = useHasMeaningfulGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <Pressable
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
            {hasMeaningfulGitStatus ? (
                <GitStatusBadge sessionId={sessionId} />
            ) : (
                <Octicons
                    name="git-branch"
                    size={16}
                    color={theme.colors.button.secondary.tint}
                />
            )}
        </Pressable>
    );
}
