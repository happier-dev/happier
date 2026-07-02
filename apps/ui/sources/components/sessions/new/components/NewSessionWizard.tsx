import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, ScrollView, View, useWindowDimensions, type View as RNView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Color from 'color';
import { Typography } from '@/constants/Typography';
import { AgentInput } from '@/components/sessions/agentInput';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { PathSelectionList } from '@/components/sessions/new/components/PathSelectionList';
import { WizardSectionHeaderRow } from '@/components/sessions/new/components/WizardSectionHeaderRow';
import { NewSessionModelSelectionContent } from '@/components/sessions/new/components/NewSessionModelSelectionContent';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { AdaptiveSelectionSection } from '@/components/ui/selection/AdaptiveSelectionSection';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { isProfileCompatibleWithAgent, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { SecretSatisfactionResult } from '@/utils/secrets/secretSatisfaction';
import type { CLIAvailability } from '@/hooks/auth/useCLIDetection';
import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore } from '@/agents/catalog/catalog';
import { getAgentPickerOptions } from '@/agents/catalog/agentPickerOptions';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { CliNotDetectedBanner, type CliNotDetectedBannerDismissScope } from '@/components/sessions/new/components/CliNotDetectedBanner';
import { InstallableDepInstaller, type InstallableDepInstallerProps } from '@/components/machines/InstallableDepInstaller';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import {
    resolveDirectoryFavoriteComparisonKey,
    toggleHomeAwareDirectoryFavorite,
} from '@/utils/sessions/favoriteDirectoriesToggle';
import type { HandleCreateSessionOptions } from '../hooks/useCreateNewSession';
import { buildNewSessionProfileSelectionPopover } from '@/components/sessions/new/components/buildNewSessionProfileSelectionPopover';
import { NewSessionProfilesBrowserContent } from '@/components/sessions/new/components/NewSessionProfilesBrowserContent';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import { useNewSessionAttachmentsController } from '@/components/sessions/new/attachments/useNewSessionAttachmentsController';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import {
    ComposerKeyboardScaffold,
    useComposerAvailablePanelHeight,
    useComposerKeyboardLayoutContext,
} from '@/components/sessions/keyboardAvoidance';
import { computeNewSessionComposerPanelMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import {
    NewSessionWizardDropdownSelectionItem,
    NewSessionWizardPopoverItem,
    resolveWizardAdaptivePresentation,
} from './NewSessionWizardAdaptiveSelection';
import type {
    NewSessionWizardSectionPresentation,
    NewSessionWizardSelectionSectionId,
} from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';


export interface NewSessionWizardLayoutProps {
    theme: any;
    styles: any;
    safeAreaTop?: number;
    safeAreaBottom: number;
    headerHeight: number;
    newSessionTopPadding?: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    shouldBottomAnchor?: boolean;
}

export interface NewSessionWizardProfilesProps {
    useProfiles: boolean;
    profiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    setFavoriteProfileIds: (ids: string[]) => void;
    selectedProfileId: string | null;
    onPressDefaultEnvironment: () => void;
    onPressProfile: (profile: AIBackendProfile) => void;
    selectedMachineId: string | null;
    getProfileDisabled: (profile: AIBackendProfile) => boolean;
    getProfileSubtitleExtra: (profile: AIBackendProfile) => string | null;
    handleAddProfile: () => void;
    openProfileEdit: (params: { profileId: string }) => void;
    handleDuplicateProfile: (profile: AIBackendProfile) => void;
    handleDeleteProfile: (profile: AIBackendProfile) => void;
    suppressNextSecretAutoPromptKeyRef: React.MutableRefObject<string | null>;
    openSecretRequirementModal: (profile: AIBackendProfile, opts: { revertOnCancel: boolean }) => void;
    profilesGroupTitles: { favorites: string; custom: string; builtIn: string };
    getSecretOverrideReady: (profile: AIBackendProfile) => boolean;
    // NOTE: Multi-secret satisfaction result shape is evolving; wizard only needs `isSatisfied`.
    // Keep this permissive to avoid cross-file type coupling.
    getSecretSatisfactionForProfile: (profile: AIBackendProfile) => { isSatisfied: boolean };
    getSecretMachineEnvOverride?: (profile: AIBackendProfile) => { isReady: boolean; isLoading: boolean } | null;
}

export interface NewSessionWizardAgentProps {
    cliAvailability: CLIAvailability;
    tmuxRequested: boolean;
    enabledAgentIds: AgentId[];
    isAgentSelectable: (agentId: AgentId) => boolean;
    isCliBannerDismissed: (agentId: AgentId) => boolean;
    dismissCliBanner: (agentId: AgentId, scope: CliNotDetectedBannerDismissScope) => void;
    agentType: AgentId;
    agentLabel?: string;
    setAgentType: (agent: AgentId) => void;
    agentPickerTitle?: React.ComponentProps<typeof AgentInput>['agentPickerTitle'];
    agentPickerOptions?: React.ComponentProps<typeof AgentInput>['agentPickerOptions'];
    agentPickerSelectedOptionId?: React.ComponentProps<typeof AgentInput>['agentPickerSelectedOptionId'];
    onAgentPickerSelect?: React.ComponentProps<typeof AgentInput>['onAgentPickerSelect'];
    agentPickerProbe?: React.ComponentProps<typeof AgentInput>['agentPickerProbe'];
    selectedBackendEntry?: ResolvedBackendCatalogEntry | null;
    modelOptions: ReadonlyArray<{ value: ModelMode; label: string; description: string }>;
    modelOptionsProbe?: React.ComponentProps<typeof AgentInput>['modelOptionsOverrideProbe'];
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    setFavoriteModelSelections?: (favorites: FavoriteModelSelectionV1[]) => void;
    acpSessionModeOptions?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    acpSessionModeProbe?: React.ComponentProps<typeof AgentInput>['acpSessionModeOptionsOverrideProbe'];
    acpSessionModeId?: string | null;
    setAcpSessionModeId?: (modeId: string | null) => void;
    acpConfigOptions?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverride'];
    acpConfigOptionsProbe?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverrideProbe'];
    acpConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    setAcpConfigOptionOverride?: (configId: string, value: string) => void;
    modelMode: ModelMode | undefined;
    setModelMode: (mode: ModelMode) => void;
    selectedIndicatorColor: string;
    profileMap: Map<string, AIBackendProfile>;
    permissionMode: PermissionMode;
    handlePermissionModeChange: (mode: PermissionMode) => void;
    installableDepInstallers?: InstallableDepInstallerProps[];
}

export interface NewSessionWizardMachineProps {
    machines: ReadonlyArray<Machine>;
    serverId?: string | null;
    selectedMachine: Machine | null;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    useMachinePickerSearch: boolean;
    onRefreshMachines?: () => void;
    setSelectedMachineId: (id: string) => void;
    getBestPathForMachine: (id: string) => string;
    setSelectedPath: (path: string) => void;
    setDraftSelectedPath?: (path: string) => void;
    favoriteMachines: ReadonlyArray<string>;
    setFavoriteMachines: (ids: string[]) => void;
    selectedPath: string;
    recentPaths: ReadonlyArray<string>;
    usePathPickerSearch: boolean;
    favoriteDirectories: ReadonlyArray<string>;
    setFavoriteDirectories: (dirs: string[]) => void;
}

export interface NewSessionWizardFooterProps {
    sessionPrompt: string;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    canCreate: boolean;
    isCreating: boolean;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    emptyAutocompletePrefixes: React.ComponentProps<typeof AgentInput>['autocompletePrefixes'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    onAutocompleteSuggestionSelect?: React.ComponentProps<typeof AgentInput>['onAutocompleteSuggestionSelect'];
    connectionStatus?: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    machinePopover?: React.ComponentProps<typeof AgentInput>['machinePopover'];
    pathPopover?: React.ComponentProps<typeof AgentInput>['pathPopover'];
    resumeSessionId?: string | null;
    resumePopover?: React.ComponentProps<typeof AgentInput>['resumePopover'];
    resumeIsChecking?: boolean;
    inputMaxHeight?: number;
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    attachmentFlowId?: string | null;
}

export interface NewSessionWizardProps {
    popoverBoundaryRef: React.RefObject<RNView>;
    layout: NewSessionWizardLayoutProps;
    sectionPresentation?: Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>;
    useColumnLayout?: boolean;
    profiles: NewSessionWizardProfilesProps;
    agent: NewSessionWizardAgentProps;
    machine: NewSessionWizardMachineProps;
    footer: NewSessionWizardFooterProps;
}

const WIZARD_AUTO_DROPDOWN_MIN_VISIBLE_ROWS = 5;

function countVisibleWizardMachineRows(params: Readonly<{
    machines: ReadonlyArray<Machine>;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachines: ReadonlyArray<Machine>;
}>): number {
    const visibleMachines = params.machines.filter((machine) => !machine.revokedAt);
    const visibleRecentMachines = params.recentMachines.filter((machine) => !machine.revokedAt);
    const visibleFavoriteMachines = params.favoriteMachines.filter((machine) => !machine.revokedAt);
    const favoriteIds = new Set(visibleFavoriteMachines.map((machine) => machine.id));
    const recentMachinesWithoutFavorites = visibleRecentMachines.filter((machine) => !favoriteIds.has(machine.id));
    const pinnedIds = new Set<string>([
        ...visibleFavoriteMachines.map((machine) => machine.id),
        ...recentMachinesWithoutFavorites.map((machine) => machine.id),
    ]);
    const allMachinesWithoutPinned = visibleMachines.filter((machine) => !pinnedIds.has(machine.id));

    return visibleFavoriteMachines.length + recentMachinesWithoutFavorites.length + allMachinesWithoutPinned.length;
}

function countVisibleWizardSavedPathRows(params: Readonly<{
    recentPaths: ReadonlyArray<string>;
    favoriteDirectories: ReadonlyArray<string>;
}>): number {
    return new Set([
        ...params.favoriteDirectories.filter((path) => path.trim().length > 0),
        ...params.recentPaths.filter((path) => path.trim().length > 0),
    ]).size;
}

export const NewSessionWizard = React.memo(function NewSessionWizard(props: NewSessionWizardProps) {
    const {
        theme,
        styles,
        safeAreaTop = 0,
        safeAreaBottom,
        headerHeight,
        newSessionSidePadding,
        newSessionBottomPadding,
        shouldBottomAnchor: shouldBottomAnchorOverride,
    } = props.layout;
    const { width: windowWidth } = useWindowDimensions();
    const shouldBottomAnchor =
        shouldBottomAnchorOverride ?? (Platform.OS !== 'web' || isMobileLayoutWidth(windowWidth));
    const useSelectionColumns = props.useColumnLayout === true
        && Platform.OS === 'web'
        && !isMobileLayoutWidth(windowWidth)
        && windowWidth >= 1100;

    // Wizard-only scroll bookkeeping (keep it out of NewSessionScreen)
    const scrollViewRef = React.useRef<ScrollView>(null);
    const wizardSectionOffsets = React.useRef<{
        profile?: number;
        agent?: number;
        model?: number;
        machine?: number;
        path?: number;
        permission?: number;
    }>({});
    const registerWizardSectionOffset = React.useCallback((key: keyof typeof wizardSectionOffsets.current) => {
        return (e: any) => {
            wizardSectionOffsets.current[key] = e?.nativeEvent?.layout?.y ?? 0;
        };
    }, []);
    const scrollToWizardSection = React.useCallback((key: keyof typeof wizardSectionOffsets.current) => {
        const y = wizardSectionOffsets.current[key];
        if (typeof y !== 'number' || !scrollViewRef.current) return;
        scrollViewRef.current.scrollTo({ y: Math.max(0, y - 20), animated: true });
    }, []);

    const handleAgentInputProfileClick = React.useCallback(() => {
        scrollToWizardSection('profile');
    }, [scrollToWizardSection]);

    const handleAgentInputMachineClick = React.useCallback(() => {
        scrollToWizardSection('machine');
    }, [scrollToWizardSection]);

    const handleAgentInputPathClick = React.useCallback(() => {
        scrollToWizardSection('path');
    }, [scrollToWizardSection]);

    const handleAgentInputPermissionClick = React.useCallback(() => {
        scrollToWizardSection('permission');
    }, [scrollToWizardSection]);

    const handleAgentInputAgentClick = React.useCallback(() => {
        scrollToWizardSection('agent');
    }, [scrollToWizardSection]);

    const {
        attachmentsUploadsEnabled,
        filePickerRef,
        hasSendableAttachments,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        extraActionChips,
        handleSend,
    } = useNewSessionAttachmentsController({
        flowId: props.footer.attachmentFlowId,
        isCreating: props.footer.isCreating,
        sessionPrompt: props.footer.sessionPrompt,
        handleCreateSession: props.footer.handleCreateSession,
        selectedProfileId: props.profiles.selectedProfileId,
        targetServerId: props.machine.serverId,
        selectedMachineId: props.machine.selectedMachine?.id ?? null,
        selectedMachineHomeDir: props.machine.selectedMachine?.metadata?.homeDir ?? null,
        selectedPath: props.machine.selectedPath,
        baseActionChips: props.footer.agentInputExtraActionChips,
    });
    const renderIconNode = React.useCallback(
        (
            name: React.ComponentProps<typeof Ionicons>['name'],
            size: number,
            color: string,
            style?: React.ComponentProps<typeof Ionicons>['style'],
        ) => normalizeNodeForView(<Ionicons name={name} size={size} color={color} style={style} />),
        [],
    );

    const onRefreshMachines = props.machine.onRefreshMachines;

    const {
        useProfiles,
        profiles,
        favoriteProfileIds,
        setFavoriteProfileIds,
        selectedProfileId,
        onPressDefaultEnvironment,
        onPressProfile,
        selectedMachineId,
        getProfileDisabled,
        getProfileSubtitleExtra,
        handleAddProfile,
        openProfileEdit,
        handleDuplicateProfile,
        handleDeleteProfile,
        suppressNextSecretAutoPromptKeyRef,
        openSecretRequirementModal,
        profilesGroupTitles,
        getSecretOverrideReady,
        getSecretSatisfactionForProfile,
        getSecretMachineEnvOverride,
    } = props.profiles;
    const {
        cliAvailability,
        tmuxRequested,
        enabledAgentIds,
        isAgentSelectable,
        isCliBannerDismissed,
        dismissCliBanner,
        agentType,
        agentLabel,
        agentPickerOptions,
        onAgentPickerSelect,
        selectedBackendEntry,
        setAgentType,
        modelOptions,
        modelOptionsProbe,
        favoriteModelSelections,
        setFavoriteModelSelections,
        modelMode,
        setModelMode,
        selectedIndicatorColor,
        profileMap,
        permissionMode,
        handlePermissionModeChange,
        installableDepInstallers,
    } = props.agent;
    const resolvedProfileMap = React.useMemo(() => {
        return profileMap ?? new Map(profiles.map((profile) => [profile.id, profile]));
    }, [profileMap, profiles]);

    const {
        machines,
        serverId,
        selectedMachine,
        recentMachines,
        favoriteMachineItems,
        useMachinePickerSearch,
        setSelectedMachineId,
        getBestPathForMachine,
        setSelectedPath,
        setDraftSelectedPath,
        favoriteMachines,
        setFavoriteMachines,
        selectedPath,
        recentPaths,
        favoriteDirectories,
        setFavoriteDirectories,
    } = props.machine;
    const selectedMachineIsOffline = React.useMemo(() => {
        if (!selectedMachine) return false;
        return !isMachineOnline(selectedMachine);
    }, [selectedMachine]);
    const selectedMachineHomeDir = selectedMachine?.metadata?.homeDir || '/home';
    const favoriteDirectoryKeys = React.useMemo(() => new Set(
        favoriteDirectories.map((path) =>
            resolveDirectoryFavoriteComparisonKey(path, selectedMachineHomeDir)
        ),
    ), [favoriteDirectories, selectedMachineHomeDir]);

      const {
          sessionPrompt,
          setSessionPrompt,
          canCreate,
          isCreating,
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        connectionStatus,
        resumeSessionId,
        resumeIsChecking,
        inputMaxHeight,
    } = props.footer;

    const machineDisplayName = selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host;
    const { sharedProfilesListProps, profilePopover } = React.useMemo(() => {
        return buildNewSessionProfileSelectionPopover({
            useProfiles,
            profilesProps: props.profiles,
            serverId,
            machineName: machineDisplayName,
            popoverBoundaryRef: props.popoverBoundaryRef,
        });
    }, [machineDisplayName, props.popoverBoundaryRef, props.profiles, serverId]);

    const sectionPresentation = props.sectionPresentation ?? {};
    const profilePresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.profiles,
        profiles.length > 8 ? 'compact' : 'expanded',
    );
    const backendOptions = React.useMemo(() => getAgentPickerOptions(enabledAgentIds), [enabledAgentIds]);
    const backendPresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.backends,
        backendOptions.length > 6 ? 'compact' : 'expanded',
    );
    const modelPresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.models,
        modelOptions.length > 8 ? 'compact' : 'expanded',
    );
    const machineVisibleRowCount = React.useMemo(() => countVisibleWizardMachineRows({
        machines,
        recentMachines,
        favoriteMachines: favoriteMachineItems,
    }), [favoriteMachineItems, machines, recentMachines]);
    const pathVisibleRowCount = React.useMemo(() => countVisibleWizardSavedPathRows({
        favoriteDirectories,
        recentPaths,
    }), [favoriteDirectories, recentPaths]);
    const machinePresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.machines,
        machineVisibleRowCount >= WIZARD_AUTO_DROPDOWN_MIN_VISIBLE_ROWS ? 'compact' : 'expanded',
    );
    const pathPresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.paths,
        pathVisibleRowCount >= WIZARD_AUTO_DROPDOWN_MIN_VISIBLE_ROWS ? 'compact' : 'expanded',
    );
    const permissionOptions = React.useMemo(() => getPermissionModeOptionsForAgentType(agentType), [agentType]);
    const permissionPresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.permissions,
        permissionOptions.length > 6 ? 'compact' : 'expanded',
    );
    const modelOptionsProbePhase = modelOptionsProbe?.phase ?? 'idle';
    const modelOptionsProbeIsBusy = modelOptionsProbePhase === 'loading' || modelOptionsProbePhase === 'refreshing';
    const hasModelOptionsProbeAffordance = modelOptionsProbeIsBusy || typeof modelOptionsProbe?.onRefresh === 'function';
    const shouldRenderModelSection = modelOptions.length > 0 || hasModelOptionsProbeAffordance;
    const pairAgentAndModelSections = useSelectionColumns && shouldRenderModelSection;
    const warningBackgroundColor = theme.colors.state?.warning?.background ?? theme.colors.box?.warning?.background;
    const warningBorderColor = theme.colors.state?.warning?.border ?? theme.colors.box?.warning?.border;
    const neutralForegroundColor = theme.colors.state?.neutral?.foreground
        ?? theme.colors.text?.secondary
        ?? theme.colors.textSecondary;
    const dangerForegroundColor = theme.colors.state?.danger?.foreground ?? neutralForegroundColor;
    const defaultBorderColor = theme.colors.border?.default ?? theme.colors.divider;
    const canvasBackgroundColor = theme.colors.background?.canvas
        ?? theme.colors.groupped?.background
        ?? theme.colors.input?.background;
    const handleSelectMachine = React.useCallback((machine: Machine) => {
        setSelectedMachineId(machine.id);
        const bestPath = getBestPathForMachine(machine.id);
        setSelectedPath(bestPath);
    }, [getBestPathForMachine, setSelectedMachineId, setSelectedPath]);
    const handleToggleFavoriteMachine = React.useCallback((machine: Machine) => {
        const isInFavorites = favoriteMachines.includes(machine.id);
        if (isInFavorites) {
            setFavoriteMachines(favoriteMachines.filter(id => id !== machine.id));
        } else {
            setFavoriteMachines([...favoriteMachines, machine.id]);
        }
    }, [favoriteMachines, setFavoriteMachines]);

    const shellStyle = [
        styles.container,
        {
            backgroundColor: canvasBackgroundColor,
            justifyContent: shouldBottomAnchor ? 'flex-end' : 'center',
            ...(shouldBottomAnchor ? { paddingTop: 0 } : {}),
        },
    ];
    return (
        <View
            ref={props.popoverBoundaryRef}
            style={{
                flex: 1,
                width: '100%',
            }}
        >
            <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                <ComposerKeyboardScaffold
                    headerHeight={headerHeight}
                    safeAreaBottom={safeAreaBottom}
                    mode="newSession"
                    testID="new-session-wizard-keyboard-host"
                    contentTestID="new-session-wizard-keyboard-content"
                    composerTestID="new-session-wizard-composer-keyboard-host"
                    style={shellStyle}
                    composer={(
                        <View style={{
                            paddingTop: 12,
                            paddingBottom: newSessionBottomPadding,
                            position: 'relative',
                            overflow: 'visible',
                            ...Platform.select({
                                web: { boxShadow: '0 -10px 30px rgba(0,0,0,0.08)' } as any,
                                ios: {
                                    shadowColor: theme.colors.shadow.color,
                                    shadowOffset: { width: 0, height: -4 },
                                    shadowOpacity: 0.08,
                                    shadowRadius: 14,
                                },
                                android: { borderTopWidth: 1, borderTopColor: defaultBorderColor },
                                default: {},
                            }),
                        }}>
                            {/* Always-on top divider gradient (wizard only).
                                Matches web: boxShadow 0 -10px 30px rgba(0,0,0,0.08) and fades into true transparency above. */}
                            {Platform.OS !== 'web' ? (
                                <LinearGradient
                                    pointerEvents="none"
                                    colors={[
                                        (() => {
                                            try {
                                                return Color(theme.colors.shadow.color).alpha(0.08).rgb().string();
                                            } catch {
                                                return 'rgba(0,0,0,0.08)';
                                            }
                                        })(),
                                        'transparent',
                                    ]}
                                    start={{ x: 0.5, y: 1 }}
                                    end={{ x: 0.5, y: 0 }}
                                    style={{
                                        position: 'absolute',
                                        top: -30,
                                        left: -1000,
                                        right: -1000,
                                        height: 30,
                                        zIndex: 10,
                                    }}
                                />
                            ) : null}
                            <View style={{ paddingHorizontal: newSessionSidePadding, width: '100%', alignSelf: 'stretch' }}>
                                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                    <NewSessionWizardComposerInput
                                        composerReservedHeight={12 + newSessionBottomPadding}
                                        value={sessionPrompt}
                                        onChangeText={setSessionPrompt}
                                        onSend={handleSend}
                                        isSendDisabled={!canCreate}
                                        isSending={isCreating}
                                        submitAccessibilityLabel={props.footer.submitAccessibilityLabel}
                                        placeholder={t('session.inputPlaceholder')}
                                        autocompletePrefixes={emptyAutocompletePrefixes}
                                        autocompleteSuggestions={emptyAutocompleteSuggestions}
                                        onAutocompleteSuggestionSelect={props.footer.onAutocompleteSuggestionSelect}
                                        extraActionChips={extraActionChips}
                                        attachments={agentInputAttachments}
                                        onAttachmentsAdded={attachmentsUploadsEnabled ? addWebFiles : undefined}
                                        hasSendableAttachments={hasSendableAttachments}
                                        inputMaxHeight={inputMaxHeight}
                                        agentType={agentType}
                                        agentLabel={props.agent.agentLabel}
                                        onAgentClick={props.agent.agentPickerOptions ? undefined : handleAgentInputAgentClick}
                                        agentPickerOptions={props.agent.agentPickerOptions}
                                        agentPickerSelectedOptionId={props.agent.agentPickerSelectedOptionId}
                                        onAgentPickerSelect={props.agent.onAgentPickerSelect}
                                        agentPickerProbe={props.agent.agentPickerProbe}
                                        permissionMode={permissionMode}
                                        onPermissionModeChange={handlePermissionModeChange}
                                        onPermissionClick={handleAgentInputPermissionClick}
                                        modelMode={modelMode}
                                        onModelModeChange={setModelMode}
                                        modelOptionsOverride={modelOptions}
                                        modelOptionsOverrideProbe={modelOptionsProbe}
                                        acpSessionModeOptionsOverride={props.agent.acpSessionModeOptions}
                                        acpSessionModeSelectedIdOverride={props.agent.acpSessionModeId ?? null}
                                        acpSessionModeOptionsOverrideProbe={props.agent.acpSessionModeProbe}
                                        onAcpSessionModeChange={
                                            (props.agent.acpSessionModeOptions?.length ?? 0) > 0 && props.agent.setAcpSessionModeId
                                                ? (modeId) => props.agent.setAcpSessionModeId?.(modeId === 'default' ? null : modeId)
                                                : undefined
                                        }
                                        acpConfigOptionsOverride={props.agent.acpConfigOptions}
                                        acpConfigOptionsOverrideProbe={props.agent.acpConfigOptionsProbe}
                                        acpConfigOptionOverridesOverride={props.agent.acpConfigOptionOverrides ?? null}
                                        onAcpConfigOptionChange={props.agent.setAcpConfigOptionOverride}
                                        connectionStatus={connectionStatus}
                                        machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                                        machinePopover={props.footer.machinePopover}
                                        onMachineClick={props.footer.machinePopover ? undefined : handleAgentInputMachineClick}
                                        currentPath={selectedPath}
                                        pathPopover={props.footer.pathPopover}
                                        onPathClick={props.footer.pathPopover ? undefined : handleAgentInputPathClick}
                                        resumeSessionId={resumeSessionId}
                                        onResumeClick={undefined}
                                        resumePopover={props.footer.resumePopover}
                                        resumeIsChecking={resumeIsChecking}
                                        contentPaddingHorizontal={0}
                                        attachmentsUploadsEnabled={attachmentsUploadsEnabled}
                                        filePickerRef={filePickerRef}
                                        onAttachmentsPicked={addPickedAttachments}
                                        {...(useProfiles ? {
                                            profileId: selectedProfileId,
                                            profilePopover,
                                            envVarsCount: undefined,
                                            envVarsPopover: undefined,
                                            onEnvVarsClick: undefined,
                                        } : {})}
                                    />
                                </View>
                            </View>
                        </View>
                    )}
                >
                    <ScrollView
                        ref={scrollViewRef}
                        style={styles.scrollContainer}
                        contentContainerStyle={styles.contentContainer}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={{ paddingHorizontal: 0 }}>
                            <View style={[
                                {
                                    maxWidth: layout.maxWidth,
                                    flex: 1,
                                    width: '100%',
                                    alignSelf: 'center',
                                    paddingTop: safeAreaTop,
                                },
                            ]}>
                                        <View onLayout={registerWizardSectionOffset('profile')} style={styles.wizardContainer}>
                                {useProfiles && (
                                    <>
                                        <View style={styles.wizardSectionHeaderRow}>
                                            {renderIconNode('person-outline', 18, theme.colors.text.primary)}
                                            <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>
                                                {t('newSession.selectAiProfileTitle')}
                                            </Text>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectAiProfileDescription')}
                                        </Text>
                                        <AdaptiveSelectionSection
                                            presentation={profilePresentation}
                                            expandedContent={(
                                                <NewSessionProfilesBrowserContent
                                                    profilesListProps={sharedProfilesListProps}
                                                    machineId={selectedMachineId}
                                                    serverId={serverId}
                                                    machineName={machineDisplayName}
                                                    previewDisplay="below-list"
                                                    inlinePreviewSpacingTop={16}
                                                    renderListContent={(profilesListProps) => (
                                                        <ProfilesList {...profilesListProps} />
                                                    )}
                                                />
                                            )}
                                            compactContent={(
                                                <NewSessionWizardPopoverItem
                                                    testID="new-session-profile-dropdown-trigger"
                                                    title={t('newSession.selectAiProfileTitle')}
                                                    subtitle={
                                                        selectedProfileId
                                                            ? (resolvedProfileMap.get(selectedProfileId)?.name ?? getBuiltInProfile(selectedProfileId)?.name ?? selectedProfileId)
                                                            : t('profiles.noProfile')
                                                    }
                                                    icon={renderIconNode('person-outline', 24, theme.colors.text.secondary)}
                                                    popover={profilePopover}
                                                    boundaryRef={props.popoverBoundaryRef}
                                                />
                                            )}
                                        />

                                        <View style={{ height: 24 }} />
                                    </>
                                )}

                                <View style={pairAgentAndModelSections ? styles.wizardSelectionPair : undefined}>
                                    <View style={pairAgentAndModelSections ? styles.wizardSelectionPairColumn : undefined}>
                                        {/* Section: AI Backend */}
                                        <View onLayout={registerWizardSectionOffset('agent')}>
                                            <View style={styles.wizardSectionHeaderRow}>
                                                {renderIconNode('hardware-chip-outline', 18, theme.colors.text.primary)}
                                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>
                                                    {t('newSession.selectAiBackendTitle')}
                                                </Text>
                                            </View>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {useProfiles && selectedProfileId
                                                ? t('newSession.aiBackendLimitedByProfileAndMachineClis')
                                                : t('newSession.aiBackendSelectWhichAiRuns')}
                                        </Text>

                                        {/* Missing CLI Installation Banners */}
                                        {selectedMachineId && tmuxRequested && cliAvailability.tmux === false && (
                                            <View style={{
                                                backgroundColor: warningBackgroundColor,
                                                borderRadius: 10,
                                                padding: 12,
                                                marginBottom: 12,
                                                borderWidth: 1,
                                                borderColor: warningBorderColor ?? defaultBorderColor,
                                            }}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                                    {renderIconNode('warning', 16, neutralForegroundColor)}
                                                    <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
                                                        {t('machine.tmux.notDetectedSubtitle')}
                                                    </Text>
                                                </View>
                                                <Text style={{ fontSize: 11, color: theme.colors.text.secondary, ...Typography.default() }}>
                                                    {t('machine.tmux.notDetectedMessage')}
                                                </Text>
                                            </View>
                                        )}

                                        {installableDepInstallers && installableDepInstallers.length > 0 ? (
                                            <>
                                                {installableDepInstallers.map((installer) => (
                                                    <InstallableDepInstaller key={installer.depId} {...installer} />
                                                ))}
                                            </>
                                        ) : null}

                                        {selectedMachineId ? (
                                            enabledAgentIds
                                                .filter((agentId) => cliAvailability.available[agentId] === false)
                                                .filter((agentId) => !isCliBannerDismissed(agentId))
                                                .map((agentId) => (
                                                    <CliNotDetectedBanner
                                                        key={agentId}
                                                        agentId={agentId}
                                                        theme={theme}
                                                        onDismiss={(scope) => dismissCliBanner(agentId, scope)}
                                                    />
                                                ))
                                        ) : null}

                                        {(() => {
                                            const selectedProfile = useProfiles && selectedProfileId
                                                ? (resolvedProfileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId))
                                                : null;

                                            const backendRows = backendOptions.map((option) => {
                                                const compatible = !selectedProfile || isProfileCompatibleWithAgent(selectedProfile, option.agentId);
                                                const selectable = isAgentSelectable(option.agentId);
                                                const disabledReason = !compatible
                                                    ? t('newSession.aiBackendNotCompatibleWithSelectedProfile')
                                                    : !selectable
                                                        ? t('newSession.aiBackendCliNotDetectedOnMachine', { cli: t(option.titleKey) })
                                                        : null;

                                                return {
                                                    option,
                                                    compatible,
                                                    disabledReason,
                                                    isSelected: agentType === option.agentId,
                                                };
                                            });
                                            const dropdownItems: DropdownMenuItem[] = backendRows.map(({ option, disabledReason }) => ({
                                                id: option.agentId,
                                                title: t(option.titleKey),
                                                subtitle: disabledReason ?? t(option.subtitleKey),
                                                disabled: Boolean(disabledReason),
                                                icon: renderIconNode(option.iconName as any, 20, theme.colors.text.secondary),
                                            }));

                                            return (
                                                <AdaptiveSelectionSection
                                                    presentation={backendPresentation}
                                                    expandedContent={(
                                                        <ItemGroup title={<View />} headerStyle={{ paddingTop: 0, paddingBottom: 0 }}>
                                                            {backendRows.map(({ option, compatible, disabledReason, isSelected }, index) => (
                                                                <Item
                                                                    key={option.agentId}
                                                                    testID={`new-session-agent:${option.agentId}`}
                                                                    title={t(option.titleKey)}
                                                                    subtitle={disabledReason ?? t(option.subtitleKey)}
                                                                    leftElement={renderIconNode(option.iconName as any, 24, theme.colors.text.secondary)}
                                                                    selected={isSelected}
                                                                    disabled={!!disabledReason}
                                                                    onPress={() => {
                                                                        if (disabledReason) {
                                                                            Modal.alert(
                                                                                t('profiles.aiBackend.title'),
                                                                                disabledReason,
                                                                                compatible
                                                                                    ? [{ text: t('common.ok'), style: 'cancel' }]
                                                                                    : [
                                                                                        { text: t('common.ok'), style: 'cancel' },
                                                                                        ...(useProfiles && selectedProfileId ? [{ text: t('newSession.changeProfile'), onPress: handleAgentInputProfileClick }] : []),
                                                                                    ],
                                                                            );
                                                                            return;
                                                                        }
                                                                        setAgentType(option.agentId);
                                                                    }}
                                                                    rightElement={(
                                                                        <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                                                                            {renderIconNode(
                                                                                'checkmark-circle',
                                                                                24,
                                                                                selectedIndicatorColor,
                                                                                { opacity: isSelected ? 1 : 0 },
                                                                            )}
                                                                        </View>
                                                                    )}
                                                                    showChevron={false}
                                                                    showDivider={index < backendRows.length - 1}
                                                                />
                                                            ))}
                                                        </ItemGroup>
                                                    )}
                                                    compactContent={(
                                                        <NewSessionWizardDropdownSelectionItem
                                                            testID="new-session-agent-dropdown-trigger"
                                                            title={t('newSession.selectAiBackendTitle')}
                                                            subtitle={agentLabel ?? dropdownItems.find((item) => item.id === agentType)?.title ?? t('newSession.aiBackendSelectWhichAiRuns')}
                                                            icon={renderIconNode('hardware-chip-outline', 24, theme.colors.text.secondary)}
                                                            items={dropdownItems}
                                                            selectedId={agentType}
                                                            onSelect={(id) => {
                                                                if (onAgentPickerSelect && agentPickerOptions?.some((option) => option.id === id)) {
                                                                    onAgentPickerSelect(id);
                                                                    return;
                                                                }
                                                                setAgentType(id as AgentId);
                                                            }}
                                                            search={dropdownItems.length >= 10}
                                                            searchPlaceholder={t('subAgentGuidance.ruleEditor.backendPicker.searchPlaceholder')}
                                                            boundaryRef={props.popoverBoundaryRef}
                                                        />
                                                    )}
                                                />
                                            );
                                        })()}
                                    </View>

                                    {shouldRenderModelSection && (
                                        <View style={pairAgentAndModelSections ? styles.wizardSelectionPairColumn : { marginTop: 24 }}>
                                        <View onLayout={registerWizardSectionOffset('model')}>
                                            <WizardSectionHeaderRow
                                                rowStyle={styles.wizardSectionHeaderRow}
                                                iconName="sparkles-outline"
                                                iconColor={theme.colors.text.primary}
                                                title={t('newSession.selectModelTitle')}
                                                titleStyle={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}
                                                action={hasModelOptionsProbeAffordance ? {
                                                    accessibilityLabel: modelOptionsProbe?.refreshAccessibilityLabel ?? t('common.refresh'),
                                                    iconName: 'refresh-outline',
                                                    iconColor: theme.colors.text.secondary,
                                                    loading: modelOptionsProbeIsBusy,
                                                    loadingAccessibilityLabel: modelOptionsProbePhase === 'loading'
                                                        ? (modelOptionsProbe?.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
                                                        : (modelOptionsProbe?.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y')),
                                                    onPress: modelOptionsProbePhase === 'idle' ? modelOptionsProbe?.onRefresh : undefined,
                                                    testID: 'new-session-model-refresh',
                                                } : undefined}
                                            />
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectModelDescription')}
                                        </Text>
                                        <NewSessionModelSelectionContent
                                            presentation={modelPresentation}
                                            modelOptions={modelOptions}
                                            selectedModelId={modelMode}
                                            selectedIndicatorColor={selectedIndicatorColor}
                                            selectedBackendEntry={selectedBackendEntry}
                                            popoverBoundaryRef={props.popoverBoundaryRef}
                                            favoriteModelSelections={favoriteModelSelections}
                                            onFavoriteModelSelectionsChange={setFavoriteModelSelections}
                                            onSelectModel={setModelMode}
                                        />
                                        </View>
                                    )}
                                </View>

                                <View style={{ height: 24 }} />

                                <View style={useSelectionColumns ? styles.wizardSelectionPair : undefined}>
                                    <View style={useSelectionColumns ? styles.wizardSelectionPairColumn : undefined}>
                                        {/* Section 2: Machine Selection */}
                                        <View onLayout={registerWizardSectionOffset('machine')}>
                                            <WizardSectionHeaderRow
                                                rowStyle={styles.wizardSectionHeaderRow}
                                                iconName="desktop-outline"
                                                iconColor={theme.colors.text.primary}
                                                title={t('newSession.selectMachineTitle')}
                                                titleStyle={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}
                                                action={onRefreshMachines ? {
                                                    accessibilityLabel: t('common.refresh'),
                                                    iconName: 'refresh-outline',
                                                    iconColor: theme.colors.text.secondary,
                                                    onPress: onRefreshMachines,
                                                } : undefined}
                                            />
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectMachineDescription')}
                                        </Text>

                                        <View style={{ marginBottom: 24 }}>
                                            <AdaptiveSelectionSection
                                                presentation={machinePresentation}
                                                expandedContent={(
                                                    <MachineSelector
                                                        machines={machines}
                                                        serverId={serverId}
                                                        selectedMachine={selectedMachine || null}
                                                        recentMachines={recentMachines}
                                                        favoriteMachines={favoriteMachineItems}
                                                        testIdPrefix="new-session-machine"
                                                        showCliGlyphs={true}
                                                        autoDetectCliGlyphs={false}
                                                        showFavorites={true}
                                                        showSearch={useMachinePickerSearch}
                                                        searchPlacement="all"
                                                        favoriteGroupPlacement="beforeRecent"
                                                        onSelect={handleSelectMachine}
                                                        onToggleFavorite={handleToggleFavoriteMachine}
                                                    />
                                                )}
                                                compactContent={(
                                                    <MachineSelector
                                                        presentation="dropdown"
                                                        machines={machines}
                                                        serverId={serverId}
                                                        selectedMachine={selectedMachine || null}
                                                        recentMachines={recentMachines}
                                                        favoriteMachines={favoriteMachineItems}
                                                        testIdPrefix="new-session-machine"
                                                        showCliGlyphs={false}
                                                        autoDetectCliGlyphs={false}
                                                        showFavorites={true}
                                                        showSearch={useMachinePickerSearch}
                                                        searchPlacement="all"
                                                        favoriteGroupPlacement="beforeRecent"
                                                        dropdownTitle={t('newSession.selectMachineTitle')}
                                                        dropdownSubtitle={machineDisplayName ?? t('newSession.selectMachineDescription')}
                                                        dropdownTestID="new-session-machine-dropdown-trigger"
                                                        popoverBoundaryRef={props.popoverBoundaryRef}
                                                        onSelect={handleSelectMachine}
                                                        onToggleFavorite={handleToggleFavoriteMachine}
                                                    />
                                                )}
                                            />
                                            {selectedMachineIsOffline && (
                                                <View
                                                    style={{
                                                        marginTop: 12,
                                                        borderRadius: 10,
                                                        padding: 12,
                                                        borderWidth: 1,
                                                        backgroundColor: warningBackgroundColor,
                                                        borderColor: warningBorderColor ?? defaultBorderColor,
                                                    }}
                                                >
                                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                                        {renderIconNode(
                                                            'warning-outline',
                                                            16,
                                                            neutralForegroundColor ?? dangerForegroundColor,
                                                        )}
                                                        <Text style={{ color: theme.colors.text.primary, fontWeight: '600', ...Typography.default('semiBold') }}>
                                                            {t('newSession.machineOfflineInlineTitle')}
                                                        </Text>
                                                    </View>
                                                    <Text style={{ color: theme.colors.text.secondary, ...Typography.default() }}>
                                                        {t('newSession.machineOfflineInlineBody')}
                                                    </Text>
                                                </View>
                                            )}
                                        </View>
                                    </View>

                                    <View style={useSelectionColumns ? styles.wizardSelectionPairColumn : undefined}>
                                        {/* API key selection is now handled inline from the profile list (via the requirements badge). */}

                                        {/* Section 3: Working Directory */}
                                        <View onLayout={registerWizardSectionOffset('path')}>
                                            <View style={styles.wizardSectionHeaderRow}>
                                                {renderIconNode('folder-outline', 18, theme.colors.text.primary)}
                                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectWorkingDirectoryTitle')}</Text>
                                            </View>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectWorkingDirectoryDescription')}
                                        </Text>

                                        <View style={{ marginBottom: 24 }}>
                                            <PathSelectionList
                                                initialValue={selectedPath}
                                                machineHomeDir={selectedMachineHomeDir}
                                                favorites={favoriteDirectories.map((path) => ({ path }))}
                                                recents={recentPaths.map((path, index) => ({ path, lastUsedAt: index }))}
                                                machineId={selectedMachine?.id ?? null}
                                                serverId={serverId ?? null}
                                                machinePlatform={machineMetadataPlatformToTarget(selectedMachine?.metadata?.platform)}
                                                onCommit={(path) => {
                                                    setDraftSelectedPath?.(path);
                                                    setSelectedPath(path);
                                                }}
                                                onChangeDraftPath={setDraftSelectedPath}
                                                onRequestClose={() => {}}
                                                isFavorite={(path) =>
                                                    favoriteDirectoryKeys.has(resolveDirectoryFavoriteComparisonKey(path, selectedMachineHomeDir))
                                                }
                                                onToggleFavorite={(path) => {
                                                    setFavoriteDirectories([...toggleHomeAwareDirectoryFavorite(
                                                        favoriteDirectories,
                                                        path,
                                                        selectedMachineHomeDir,
                                                    )]);
                                                }}
                                                maxHeight={pathPresentation === 'compact' ? 320 : 420}
                                            />
                                        </View>
                                    </View>
                                </View>

                                {/* Section 4: Permission Mode */}
                                <View onLayout={registerWizardSectionOffset('permission')}>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        {renderIconNode('shield-outline', 18, theme.colors.text.primary)}
                                        <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectPermissionModeTitle')}</Text>
                                    </View>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('newSession.selectPermissionModeDescription')}
                                </Text>
                                <AdaptiveSelectionSection
                                    presentation={permissionPresentation}
                                    expandedContent={(
                                        <ItemGroup title="">
                                            {permissionOptions.map((option, index, array) => (
                                                <Item
                                                    key={option.value}
                                                    title={option.label}
                                                    subtitle={option.description}
                                                    leftElement={renderIconNode(option.icon as any, 24, theme.colors.text.secondary)}
                                                    rightElement={permissionMode === option.value
                                                        ? renderIconNode('checkmark-circle', 24, selectedIndicatorColor)
                                                        : null}
                                                    onPress={() => handlePermissionModeChange(option.value)}
                                                    showChevron={false}
                                                    selected={permissionMode === option.value}
                                                    showDivider={index < array.length - 1}
                                                />
                                            ))}
                                        </ItemGroup>
                                    )}
                                    compactContent={(
                                        <NewSessionWizardDropdownSelectionItem
                                            testID="new-session-permission-dropdown-trigger"
                                            title={t('newSession.selectPermissionModeTitle')}
                                            subtitle={permissionOptions.find((option) => option.value === permissionMode)?.label ?? t('newSession.selectPermissionModeDescription')}
                                            icon={renderIconNode('shield-outline', 24, theme.colors.text.secondary)}
                                            items={permissionOptions.map((option) => ({
                                                id: option.value,
                                                title: option.label,
                                                subtitle: option.description,
                                                icon: renderIconNode(option.icon as any, 20, theme.colors.text.secondary),
                                            }))}
                                            selectedId={permissionMode}
                                            boundaryRef={props.popoverBoundaryRef}
                                            onSelect={(id) => handlePermissionModeChange(id as PermissionMode)}
                                        />
                                    )}
                                />

                                <View style={{ height: 24 }} />

                            </View>
                        </View>
                    </View>
                </ScrollView>
                </ComposerKeyboardScaffold>
            </PopoverBoundaryProvider>
        </View>
    );
});

type NewSessionWizardComposerInputProps = React.ComponentProps<typeof AgentInput> & Readonly<{
    attachmentsUploadsEnabled: boolean;
    composerReservedHeight: number;
    filePickerRef: React.ComponentPropsWithRef<typeof AttachmentFilePicker>['ref'];
    onAttachmentsPicked: React.ComponentProps<typeof AttachmentFilePicker>['onAttachmentsPicked'];
}>;

function NewSessionWizardComposerInput(props: NewSessionWizardComposerInputProps) {
    const {
        attachmentsUploadsEnabled,
        composerReservedHeight,
        filePickerRef,
        onAttachmentsPicked,
        ...agentInputProps
    } = props;
    const availablePanelHeight = useComposerAvailablePanelHeight();
    const { height: windowHeight } = useWindowDimensions();
    const maxPanelHeight = computeNewSessionComposerPanelMaxHeight({
        mode: 'wizard',
        availablePanelHeight,
        reservedHeight: composerReservedHeight,
        viewportHeight: windowHeight,
    });
    const composerKeyboardLayout = useComposerKeyboardLayoutContext();
    const retainKeyboardLift = agentInputProps.retainKeyboardLift ?? composerKeyboardLayout?.retainKeyboardLift;

    return (
        <>
            <AgentInput
                {...agentInputProps}
                maxPanelHeight={maxPanelHeight}
                panelMaxHeightMode="host-constrained"
                retainKeyboardLift={retainKeyboardLift}
            />
            {attachmentsUploadsEnabled ? (
                <AttachmentFilePicker ref={filePickerRef} onAttachmentsPicked={onAttachmentsPicked} multiple />
            ) : null}
        </>
    );
}
