import * as React from 'react';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBinding, useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { useAtmosphereSendSignal } from '@/components/atmosphere/atmosphereStage';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { resolveRequestedSessionModeId } from '@happier-dev/protocol/actions/sessionModeIds';
import { Platform, ScrollView, View, useWindowDimensions, type View as RNView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Color from 'color';
import { AgentInput } from '@/components/sessions/agentInput';
import { projectAgentInputAttachmentRowItems } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputExtraActionPresentation } from '@/components/sessions/agentInput/agentInputContracts';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ContainedPageScopeProvider } from '@/components/ui/lists/listPresentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PathSelectionList } from '@/components/sessions/new/components/PathSelectionList';
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
import type { OrganizationPolicyLock } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { describeNativeSandbox } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { OrganizationPolicyManagedLine } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import type { SecretSatisfactionResult } from '@/utils/secrets/secretSatisfaction';
import type { CLIAvailability } from '@/agents/machineAgents/machineAgentCliAvailability';
import { getAgentCore, isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId } from '@/agents/catalog/catalog';
import { getAgentPickerOptions } from '@/agents/catalog/agentPickerOptions';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { InstallableDepInstaller, type InstallableDepInstallerProps } from '@/components/machines/InstallableDepInstaller';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import {
    resolveDirectoryFavoriteComparisonKey,
    toggleHomeAwareDirectoryFavorite,
} from '@/utils/sessions/favoriteDirectoriesToggle';
import type { HandleCreateSessionOptions } from '../hooks/useCreateNewSession';
import { buildNewSessionProfileSelectionPopover } from '@/components/sessions/new/components/buildNewSessionProfileSelectionPopover';
import { NewSessionProfilesBrowserContent } from '@/components/sessions/new/components/NewSessionProfilesBrowserContent';
import type {
    AcpConfigOptionOverridesV1} from '@happier-dev/protocol/sessions/metadata/overrides';
import type {
    ProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';
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
import {
    buildMachineDestinationModel,
    type BuildMachineDestinationModelParams,
} from './machineSelection/buildMachineDestinationModel';
import type { ServerScopedMachinePoolGroup } from './machineSelection/useMachineSelectionListModel';
import type { ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import type {
    NewSessionWizardSectionPresentation,
    NewSessionWizardSelectionSectionId,
} from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { SessionModelProjectionGroup } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import {
    NewSessionLaunchPendingPreview,
} from '@/components/sessions/new/components/NewSessionLaunchPendingPreview';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import { NewSessionProviderLaunchError } from '@/components/sessions/new/components/NewSessionProviderLaunchError';
import { NewSessionRequesterFolderHint } from '@/components/sessions/new/components/NewSessionRequesterFolderHint';
import { NewSessionCreationReviewLine } from '@/components/sessions/new/components/NewSessionCreationReviewLine';
import { NewSessionLaunchApprovalNotice, type NewSessionLaunchApprovalNoticeState } from '@/components/sessions/new/components/NewSessionLaunchApprovalNotice';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import {
    useNewSessionPromptValue,
    type NewSessionPromptStore,
} from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import {
    isNewSessionComposerEditable,
    type NewSessionComposerDocument,
} from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import type { StyleProp, ViewStyle } from 'react-native';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';


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
    setFavoriteProfileIds: (ids: string[]) => void | Promise<void>;
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
    agentType: string;
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
    modelPickerPresentation?: React.ComponentProps<typeof AgentInput>['modelPickerPresentation'];
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    setFavoriteModelSelections?: (favorites: FavoriteModelSelectionV1[]) => void;
    acpSessionModeOptions?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    acpSessionModeProbe?: React.ComponentProps<typeof AgentInput>['acpSessionModeOptionsOverrideProbe'];
    acpSessionModeId?: string | null;
    setAcpSessionModeId?: (modeId: string | null) => void;
    acpConfigOptions?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverride'];
    acpModelConfigOptionId?: React.ComponentProps<typeof AgentInput>['acpModelConfigOptionIdOverride'];
    acpConfigOptionsProbe?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverrideProbe'];
    acpConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    setAcpConfigOptionOverride?: (configId: string, value: string) => void;
    modelMode: ModelMode | undefined;
    modelSelection?: SessionModelSelection | null;
    setModelMode: (mode: ModelMode) => void;
    setModelSelection?: (selection: SessionModelSelection | null) => void;
    providerModelGroups?: readonly SessionModelProjectionGroup[];
    declarationContext?: React.ComponentProps<typeof NewSessionModelSelectionContent>['declarationContext'];
    teamCredentialResources?: React.ComponentProps<typeof NewSessionModelSelectionContent>['teamCredentialResources'];
    teamCredentialDisplayNames?: React.ComponentProps<typeof NewSessionModelSelectionContent>['teamCredentialDisplayNames'];
    teamNameById?: React.ComponentProps<typeof NewSessionModelSelectionContent>['teamNameById'];
    homeNameByTeamId?: React.ComponentProps<typeof NewSessionModelSelectionContent>['homeNameByTeamId'];
    teamCredentialResourceStatusByKey?: React.ComponentProps<typeof NewSessionModelSelectionContent>['teamCredentialResourceStatusByKey'];
    teamCredentialServerId?: React.ComponentProps<typeof NewSessionModelSelectionContent>['teamCredentialServerId'];
    selectedTeamCredentialModel?: React.ComponentProps<typeof NewSessionModelSelectionContent>['selectedTeamCredentialModel'];
    onSelectTeamCredentialModel?: React.ComponentProps<typeof NewSessionModelSelectionContent>['onSelectTeamCredentialModel'];
    providerModelProjectionAuthoritative?: boolean;
    providerModelProjectionError?: ProviderErrorV1 | null;
    providerModelProjectionFailures?: React.ComponentProps<typeof NewSessionModelSelectionContent>['providerProjectionFailures'];
    retryProviderModelProjection?: (() => Promise<void> | void) | null;
    providerModelProjectionApproval?: React.ComponentProps<typeof NewSessionModelSelectionContent>['providerProjectionApproval'];
    providerCurrentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys?: ReadonlySet<string>;
    experimentalModelConfirmation?: SessionModelPickerExperimentalConfirmationController;
    selectedIndicatorColor: string;
    profileMap: Map<string, AIBackendProfile>;
    permissionMode: PermissionMode;
    nativeSandbox?: React.ComponentProps<typeof AgentInput>['nativeSandbox'];
    permissionModeLock?: OrganizationPolicyLock | null;
    /** The source word for an inherited permission mode, shown on the selected permission row only. */
    permissionModeAttribution?: string | null;
    handlePermissionModeChange: (mode: PermissionMode) => void;
    installableDepInstallers?: InstallableDepInstallerProps[];
}

export interface NewSessionWizardMachineProps {
    machines: ReadonlyArray<Machine>;
    /**
     * The same resolved Home groups and Pool projections the picker renders. Adaptive presentation
     * derives its visible-destination count from them through the canonical destination owner, so
     * the wizard can never disagree with the list a user actually opens.
     */
    machineGroups?: ReadonlyArray<ServerScopedMachineGroup>;
    machinePoolGroups?: ReadonlyArray<ServerScopedMachinePoolGroup>;
    temporaryComputerProjection?: BuildMachineDestinationModelParams['temporaryComputerProjection'];
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
    isTemporaryComputer?: boolean;
    machineName?: string;
    promptStore: NewSessionPromptStore;
    composerDocument?: NewSessionComposerDocument;
    composerReferenceHost?: React.ComponentProps<typeof AgentInput>['composerReferenceHost'];
    composerFileScope?: React.ComponentProps<typeof AgentInput>['composerFileScope'];
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    newSessionAfterSendMode?: React.ComponentProps<typeof AgentInput>['newSessionAfterSendMode'];
    /** Registers this footer's Send as the Temporary-computer replacement owner. */
    registerTemporaryComputerReplacementLaunch?: (send: () => void) => () => void;
    canCreate: boolean;
    isCreating: boolean;
    pendingLaunchAttempt?: NewSessionLaunchAttempt | null;
    /** Resolved once by `resolveNewSessionLaunchPresentation`; the Wizard only places the card. */
    launchPendingPreviewVisible?: boolean;
    providerLaunchError?: ProviderErrorV1 | null;
    retryProviderLaunch?: () => void;
    launchApproval?: NewSessionLaunchApprovalNoticeState | null;
    /** Canonical selected Team/account disclosure for the existing Send/Run inline review. */
    creationReviewSummary?: string | null;
    /** The requester's own folders on someone else's machine (MEMBER-WORKSPACE): read state and its hint. */
    requesterIsolation?: ReturnType<typeof import('@/hooks/machine/useMachineOwnIsolationStatus').useMachineOwnIsolationStatus>;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    emptyAutocompleteKinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    connectionStatus?: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    statusBadges?: React.ComponentProps<typeof AgentInput>['statusBadges'];
    composerTopContent?: React.ReactNode;
    composerBottomContent?: React.ReactNode;
    statusTrailingActions?: React.ComponentProps<typeof AgentInput>['statusTrailingActions'];
    machinePopover?: React.ComponentProps<typeof AgentInput>['machinePopover'];
    pathPopover?: React.ComponentProps<typeof AgentInput>['pathPopover'];
    folderChipState?: React.ComponentProps<typeof AgentInput>['folderChipState'];
    onRemoveFolder?: () => void;
    resumeSessionId?: string | null;
    resumePopover?: React.ComponentProps<typeof AgentInput>['resumePopover'];
    resumeIsChecking?: boolean;
    inputMaxHeight?: number;
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    /** Removable "continue from this Session" chip and its attachment row. */
    sourceContextPresentation?: AgentInputExtraActionPresentation | null;
    attachmentFlowId?: string | null;
}

export interface NewSessionWizardProps {
    popoverBoundaryRef: React.RefObject<RNView | null>;
    layout: NewSessionWizardLayoutProps;
    sectionPresentation?: Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>;
    useColumnLayout?: boolean;
    profiles: NewSessionWizardProfilesProps;
    agent: NewSessionWizardAgentProps;
    machine: NewSessionWizardMachineProps;
    footer: NewSessionWizardFooterProps;
}

const WIZARD_AUTO_DROPDOWN_MIN_VISIBLE_ROWS = 5;
type NewSessionWizardAgentPickerOption = NonNullable<React.ComponentProps<typeof AgentInput>['agentPickerOptions']>[number];

function isWizardBackendPickerOption(option: NewSessionWizardAgentPickerOption): boolean {
    try {
        parseBackendTargetKeyV2(option.id);
        return true;
    } catch {
        return false;
    }
}

function resolveBuiltInAgentIdFromBackendPickerOptionId(optionId: string): AgentId | null {
    const target = parseBackendTargetKeyV2(optionId);
    if (target.kind === 'agent') return resolveBundledAgentIdFromContributionIdentity(target.identity);
    return isBundledAgentId(target.backendId) ? target.backendId : null;
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
    const atmosphereBoundary = useAtmosphereBandBoundary();
    useAtmosphereSendSignal(Boolean(atmosphereBoundary) && props.footer.isCreating);
    const onComposerFocusChange = React.useCallback((focused: boolean) => {
        props.footer.composerDocument?.onComposerFocusChange?.(focused);
        atmosphereBoundary?.onFocusChange(focused);
    }, [atmosphereBoundary, props.footer.composerDocument]);
    const materialColor = useHappierMaterialColorResolver();
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
        attachmentDropHint,
        addPickedAttachments,
        actionChips,
        attachmentRowItems,
        handleSend,
    } = useNewSessionAttachmentsController({
        flowId: props.footer.attachmentFlowId,
        isCreating: props.footer.isCreating,
        promptStore: props.footer.promptStore,
        handleCreateSession: props.footer.handleCreateSession,
        selectedProfileId: props.profiles.selectedProfileId,
        targetServerId: props.machine.serverId,
        isTemporaryComputer: props.footer.isTemporaryComputer,
        selectedMachineId: props.machine.selectedMachine?.id ?? null,
        selectedMachineHomeDir: props.machine.selectedMachine?.metadata?.homeDir ?? null,
        selectedPath: props.machine.selectedPath,
        baseActionChips: [
            ...(props.footer.agentInputExtraActionChips ?? []),
            ...(props.footer.composerDocument?.extraActionChips ?? []),
        ],
        sourceContextPresentation: props.footer.sourceContextPresentation ?? null,
        composerDocument: props.footer.composerDocument,
    });
    // A Temporary-computer replacement is a fresh submission, so it runs the
    // same Send this footer already owns rather than restarting the controller.
    const registerReplacementLaunch = props.footer.registerTemporaryComputerReplacementLaunch;
    React.useEffect(() => registerReplacementLaunch?.(handleSend), [handleSend, registerReplacementLaunch]);
    const projectedAttachmentRowItems = React.useMemo(() => (
        projectAgentInputAttachmentRowItems({
            items: [
                ...(props.footer.composerDocument?.attachmentRowItems ?? []),
                ...attachmentRowItems,
            ],
            transferAttachments: agentInputAttachments,
        })
    ), [agentInputAttachments, attachmentRowItems, props.footer.composerDocument?.attachmentRowItems]);
    const renderIconNode = React.useCallback(
        (
            name: IconName,
            size: number,
            color: string,
            style?: StyleProp<ViewStyle>,
        ) => normalizeNodeForView(<Icon name={name} size={size} color={color} style={style} />),
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
        agentType,
        agentLabel,
        agentPickerOptions,
        agentPickerSelectedOptionId,
        onAgentPickerSelect,
        selectedBackendEntry,
        setAgentType,
        modelOptions,
        modelOptionsProbe,
        favoriteModelSelections,
        setFavoriteModelSelections,
        modelMode,
        modelSelection,
        setModelMode,
        setModelSelection,
        providerModelGroups,
        teamCredentialResources,
        teamCredentialDisplayNames,
        teamNameById,
        homeNameByTeamId,
        teamCredentialResourceStatusByKey,
        teamCredentialServerId,
        selectedTeamCredentialModel,
        onSelectTeamCredentialModel,
        providerModelProjectionAuthoritative,
        providerModelProjectionError,
        providerModelProjectionFailures,
        retryProviderModelProjection,
        providerModelProjectionApproval,
        providerCurrentSelectionRecovery,
        hiddenNativeModelKeys,
        experimentalModelConfirmation,
        selectedIndicatorColor,
        profileMap,
        permissionMode,
        permissionModeLock,
        permissionModeAttribution,
        handlePermissionModeChange,
        installableDepInstallers,
    } = props.agent;
    const resolvedProfileMap = React.useMemo(() => {
        return profileMap ?? new Map(profiles.map((profile) => [profile.id, profile]));
    }, [profileMap, profiles]);

    const {
        machines,
        machineGroups,
        machinePoolGroups,
        temporaryComputerProjection,
        serverId,
        selectedMachine,
        recentMachines,
        favoriteMachineItems,
        useMachinePickerSearch,
        setSelectedPath,
        setDraftSelectedPath,
        selectedPath,
        recentPaths,
        favoriteDirectories,
        setFavoriteDirectories,
    } = props.machine;
    const reachabilityRevision = useMachineReachabilityRevision();
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const scopesByServerId = useServerCredentialAccountScopeBindings((machineGroups ?? [{ serverId }]).map(group => group.serverId));
    const selectedMachineIsOffline = React.useMemo(() => {
        if (!selectedMachine) return false;
        return resolveMachineReachability(scope, selectedMachine) === 'unreachable';
    }, [reachabilityRevision, selectedMachine, scope]);
    const selectedMachineHomeDir = selectedMachine?.metadata?.homeDir || '/home';
    const favoriteDirectoryKeys = React.useMemo(() => new Set(
        favoriteDirectories.map((path) =>
            resolveDirectoryFavoriteComparisonKey(path, selectedMachineHomeDir)
        ),
    ), [favoriteDirectories, selectedMachineHomeDir]);

      const {
          promptStore,
          setSessionPrompt,
          canCreate,
          isCreating,
        emptyAutocompleteKinds,
        emptyAutocompleteSuggestions,
        connectionStatus,
        resumeSessionId,
        resumeIsChecking,
        inputMaxHeight,
    } = props.footer;

    const machineDisplayName = getMachineDisplayName(selectedMachine) ?? (props.profiles.selectedMachineId || undefined);
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
    const profileSection = {
        title: t('newSession.wizardSection.profile'),
        description: t('newSession.selectAiProfileDescription'),
    };
    const canonicalBackendPickerOptions = React.useMemo(
        () => (agentPickerOptions ?? []).filter(isWizardBackendPickerOption),
        [agentPickerOptions],
    );
    const legacyBackendOptions = React.useMemo(() => getAgentPickerOptions(enabledAgentIds), [enabledAgentIds]);
    const backendOptionCount = canonicalBackendPickerOptions.length > 0
        ? canonicalBackendPickerOptions.length
        : legacyBackendOptions.length;
    const backendPresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.backends,
        backendOptionCount > 6 ? 'compact' : 'expanded',
    );
    const modelPresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.models,
        modelOptions.length + (providerModelGroups ?? []).reduce((count, group) => count + group.rows.length, 0) > 8
            ? 'compact'
            : 'expanded',
    );
    const pathVisibleRowCount = React.useMemo(() => countVisibleWizardSavedPathRows({
        favoriteDirectories,
        recentPaths,
    }), [favoriteDirectories, recentPaths]);
    // One canonical destination projection decides how many Machine, Pool and Temporary-computer
    // rows the picker shows. Callers that have not resolved Home groups yet still describe the
    // single-Home list they render, so adaptive presentation never counts a different set.
    const destinationRowCount = React.useMemo(() => buildMachineDestinationModel({
        purpose: 'session',
        scopesByServerId,
        groups: machineGroups ?? [{
            serverId: serverId ?? '',
            machines,
            loading: false,
            signedOut: false,
        }],
        poolGroups: machinePoolGroups,
        temporaryComputerProjection,
        recentMachines,
        favoriteMachines: favoriteMachineItems,
    }).destinationRowCount, [
        favoriteMachineItems,
        machineGroups,
        machinePoolGroups,
        machines,
        recentMachines,
        serverId,
        temporaryComputerProjection,
        reachabilityRevision,
        scopesByServerId,
    ]);
    const machinePresentation = resolveWizardAdaptivePresentation(
        sectionPresentation.machines,
        destinationRowCount >= WIZARD_AUTO_DROPDOWN_MIN_VISIBLE_ROWS ? 'compact' : 'expanded',
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
    const shouldRenderModelSection = modelOptions.length > 0
        || (providerModelGroups ?? []).some((group) => group.rows.length > 0)
        || hasModelOptionsProbeAffordance;
    const pairAgentAndModelSections = useSelectionColumns && shouldRenderModelSection;
    // Amber marks what needs the user (a missing CLI, an offline machine); glyphs otherwise stay ink.
    const warningForegroundColor = theme.colors.state?.warning?.foreground ?? theme.colors.text.secondary;
    const renderSelectedMark = (selected: boolean) => (
        <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
            {renderIconNode('check-circle', 24, selectedIndicatorColor, { opacity: selected ? 1 : 0 })}
        </View>
    );
    const defaultBorderColor = theme.colors.border?.default ?? theme.colors.divider;
    const canvasBackgroundColor = theme.colors.background?.canvas
        ?? theme.colors.groupped?.background
        ?? theme.colors.input?.background
        ?? theme.colors.surface.base;

    const shellStyle = [
        styles.container,
        {
            backgroundColor: materialColor(canvasBackgroundColor, 'transparent'),
            justifyContent: shouldBottomAnchor ? 'flex-end' : 'center',
            // On the web the card's corner-controls row (`NewSessionWebDismissal`) is the top inset.
            ...(shouldBottomAnchor || Platform.OS === 'web' ? { paddingTop: 0 } : {}),
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
                            paddingTop: theme.space.s12,
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
                            <View ref={atmosphereBoundary?.ref} onLayout={atmosphereBoundary?.onLayout}
                                style={{ paddingHorizontal: newSessionSidePadding, width: '100%', alignSelf: 'stretch' }}>
                                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                    <NewSessionProviderLaunchError
                                        error={props.footer.providerLaunchError}
                                        retry={props.footer.retryProviderLaunch}
                                    />
                                    <NewSessionLaunchApprovalNotice approval={props.footer.launchApproval} />
                                    <NewSessionRequesterFolderHint isolation={props.footer.requesterIsolation} />
                                    <NewSessionCreationReviewLine summary={props.footer.creationReviewSummary} />
                                    {/*
                                      * Resolved upstream by
                                      * `resolveNewSessionLaunchPresentation`. The Wizard
                                      * places the compact card and never re-decides, so a
                                      * Temporary-computer request cannot grow a second
                                      * pending presentation behind its frozen overlay.
                                      */}
                                    {props.footer.launchPendingPreviewVisible === true
                                        && props.footer.pendingLaunchAttempt != null ? (
                                        <View style={{ paddingBottom: theme.space.s8 }}>
                                            <NewSessionLaunchPendingPreview launchAttempt={props.footer.pendingLaunchAttempt} />
                                        </View>
                                    ) : null}
                                    <PluginContextualResourceStoreProvider>
                                        {props.footer.composerDocument?.beforeComposer}
                                        {props.footer.composerTopContent}
                                        <NewSessionWizardComposerInput
                                        composerReservedHeight={12 + newSessionBottomPadding}
                                        promptStore={promptStore}
                                        onChangeText={setSessionPrompt}
                                        structuredInputMentions={props.footer.composerDocument?.structuredInputMentions}
                                        onStructuredInputMentionsChange={props.footer.composerDocument?.onStructuredInputMentionsChange}
                                        onComposerFocusChange={onComposerFocusChange}
                                        onComposerFocusRequestChange={props.footer.composerDocument?.onComposerFocusRequestChange}
                                        onComposerBlurRequestChange={props.footer.composerDocument?.onComposerBlurRequestChange}
                                        onPromptPickerOpenRequestChange={props.footer.composerDocument?.onPromptPickerOpenRequestChange}
                                        composerRef={props.footer.composerDocument?.ref}
                                        statusRegions={props.footer.composerDocument?.statusRegions}
                                        composerReferenceHost={props.footer.composerReferenceHost}
                                        composerFileScope={props.footer.composerFileScope}
                                        onComposerActionBarLayoutChange={props.footer.composerDocument?.onComposerActionBarLayoutChange}
                                        inputPersistence={props.footer.composerDocument?.inputPersistence}
                                        composerDecorations={props.footer.composerDocument?.composerDecorations ?? []}
                                        composerInputLock={props.footer.composerDocument?.composerInputLock ?? null}
                                        onSend={handleSend}
                                        newSessionAfterSendMode={props.footer.newSessionAfterSendMode}
                                        isSendDisabled={!canCreate || (props.footer.composerDocument?.composerInputLock ?? null) !== null}
                                        disabled={!isNewSessionComposerEditable({
                                            isSubmitting: isCreating,
                                            inputLock: props.footer.composerDocument?.composerInputLock,
                                        })}
                                        isSending={isCreating}
                                        submitAccessibilityLabel={props.footer.submitAccessibilityLabel}
                                        placeholder={t('session.inputPlaceholder')}
                                        autocompleteKinds={emptyAutocompleteKinds}
                                        autocompleteSuggestions={emptyAutocompleteSuggestions}
                                        extraActionChips={actionChips}
                                        attachmentRowItems={projectedAttachmentRowItems}
                                        onAttachmentsAdded={attachmentsUploadsEnabled ? addWebFiles : undefined}
                                        attachmentDropHint={attachmentDropHint}
                                        hasSendableAttachments={hasSendableAttachments
                                            || props.footer.composerDocument?.hasSendableAttachments === true}
                                        inputMaxHeight={inputMaxHeight}
                                        agentType={agentType}
                                        agentLabel={props.agent.agentLabel}
                                        onAgentClick={props.agent.agentPickerOptions ? undefined : handleAgentInputAgentClick}
                                        agentPickerOptions={props.agent.agentPickerOptions}
                                        agentPickerSelectedOptionId={props.agent.agentPickerSelectedOptionId}
                                        onAgentPickerSelect={props.agent.onAgentPickerSelect}
                                        agentPickerProbe={props.agent.agentPickerProbe}
                                        permissionMode={permissionMode}
                                        nativeSandbox={props.agent.nativeSandbox}
                                        onPermissionModeChange={permissionModeLock ? undefined : handlePermissionModeChange}
                                        permissionModeAttribution={permissionModeAttribution}
                                        onPermissionClick={handleAgentInputPermissionClick}
                                        modelMode={modelMode}
                                        modelPickerPresentation={props.agent.modelPickerPresentation}
                                        onModelModeChange={setModelMode}
                                        modelOptionsOverride={modelOptions}
                                        modelOptionsOverrideProbe={modelOptionsProbe}
                                        acpSessionModeOptionsOverride={props.agent.acpSessionModeOptions}
                                        acpSessionModeSelectedIdOverride={props.agent.acpSessionModeId ?? null}
                                        acpSessionModeOptionsOverrideProbe={props.agent.acpSessionModeProbe}
                                        onAcpSessionModeChange={
                                            (props.agent.acpSessionModeOptions?.length ?? 0) > 0 && props.agent.setAcpSessionModeId
                                                ? (modeId) => props.agent.setAcpSessionModeId?.(resolveRequestedSessionModeId(modeId, props.agent.acpSessionModeOptions) || null)
                                                : undefined
                                        }
                                        acpConfigOptionsOverride={props.agent.acpConfigOptions}
                                        acpModelConfigOptionIdOverride={props.agent.acpModelConfigOptionId}
                                        acpConfigOptionsOverrideProbe={props.agent.acpConfigOptionsProbe}
                                        acpConfigOptionOverridesOverride={props.agent.acpConfigOptionOverrides ?? null}
                                        onAcpConfigOptionChange={props.agent.setAcpConfigOptionOverride}
                                        connectionStatus={connectionStatus}
                                        statusBadges={props.footer.statusBadges}
                                        statusTrailingActions={props.footer.statusTrailingActions}
                                        showStatusPermissionMode={false}
                                        machineName={props.footer.machineName ?? machineDisplayName}
                                        machinePopover={props.footer.machinePopover}
                                        onMachineClick={props.footer.machinePopover ? undefined : handleAgentInputMachineClick}
                                        currentPath={selectedPath}
                                        folderChipState={props.footer.folderChipState}
                                        onRemoveFolder={props.footer.onRemoveFolder}
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
                                        {props.footer.composerBottomContent}
                                        {props.footer.composerDocument?.afterComposer}
                                    </PluginContextualResourceStoreProvider>
                                </View>
                            </View>
                        </View>
                    )}
                >
                    {/* One configuration page: every section is the page's `ItemGroup` (sentence-case
                        title, its description above, one sheet edge), so profile, agent, model, machine,
                        folder and permission rows share one row grammar and one column. */}
                    {/* The sections share the composer's column below them: the same side padding and
                        width cap, with the page sections filling it (a contained page scope). */}
                    <ContainedPageScopeProvider>
                    <ItemList
                        ref={scrollViewRef}
                        presentation="page"
                        style={styles.scrollContainer}
                        containerStyle={[styles.contentContainer, { paddingTop: safeAreaTop, paddingHorizontal: newSessionSidePadding }]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                {useProfiles && (
                                    <View onLayout={registerWizardSectionOffset('profile')}>
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
                                                        <ProfilesList {...profilesListProps} presentation="embedded" section={profileSection} />
                                                    )}
                                                />
                                            )}
                                            compactContent={(
                                                <ItemGroup title={profileSection.title} description={profileSection.description}>
                                                    <NewSessionWizardPopoverItem
                                                        testID="new-session-profile-dropdown-trigger"
                                                        title={
                                                            selectedProfileId
                                                                ? (resolvedProfileMap.get(selectedProfileId)?.name ?? getBuiltInProfile(selectedProfileId)?.name ?? selectedProfileId)
                                                                : t('profiles.noProfile')
                                                        }
                                                        popover={profilePopover}
                                                        boundaryRef={props.popoverBoundaryRef}
                                                    />
                                                </ItemGroup>
                                            )}
                                        />
                                    </View>
                                )}

                                <View style={pairAgentAndModelSections ? styles.wizardSelectionPair : undefined}>
                                    <View style={pairAgentAndModelSections ? styles.wizardSelectionPairColumn : undefined}>
                                        {(() => {
                                            const selectedProfile = useProfiles && selectedProfileId
                                                ? (resolvedProfileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId))
                                                : null;

                                            const showDisabledBackendAlert = (params: Readonly<{
                                                compatible: boolean;
                                                disabledReason: string;
                                            }>) => {
                                                Modal.alert(
                                                    t('profiles.aiBackend.title'),
                                                    params.disabledReason,
                                                    params.compatible
                                                        ? [{ text: t('common.ok'), style: 'cancel' }]
                                                        : [
                                                            { text: t('common.ok'), style: 'cancel' },
                                                            ...(useProfiles && selectedProfileId ? [{ text: t('newSession.changeProfile'), onPress: handleAgentInputProfileClick }] : []),
                                                        ],
                                                );
                                            };
                                            const canonicalBackendRows = canonicalBackendPickerOptions.map((option) => {
                                                const builtInAgentId = resolveBuiltInAgentIdFromBackendPickerOptionId(option.id);
                                                const disabledReason = option.disabled ? (option.subtitle ?? null) : null;
                                                return {
                                                    id: option.id,
                                                    key: option.id,
                                                    testID: `new-session-agent:${builtInAgentId ?? option.id}`,
                                                    title: option.label,
                                                    subtitle: option.subtitle ?? null,
                                                    leftElement: option.icon ?? null,
                                                    dropdownIcon: option.icon ?? undefined,
                                                    compatible: true,
                                                    disabled: Boolean(option.disabled),
                                                    disabledReason,
                                                    isSelected: agentPickerSelectedOptionId === option.id
                                                        || (!agentPickerSelectedOptionId && builtInAgentId === agentType),
                                                    onPress: () => {
                                                        if (option.disabled) {
                                                            if (disabledReason) {
                                                                showDisabledBackendAlert({ compatible: true, disabledReason });
                                                            }
                                                            return;
                                                        }
                                                        if (option.onSelectImmediate) {
                                                            option.onSelectImmediate();
                                                            return;
                                                        }
                                                        if (onAgentPickerSelect) {
                                                            onAgentPickerSelect(option.id);
                                                            return;
                                                        }
                                                        if (builtInAgentId) {
                                                            setAgentType(builtInAgentId);
                                                        }
                                                    },
                                                };
                                            });
                                            const legacyBackendRows = legacyBackendOptions.map((option) => {
                                                const compatible = !selectedProfile || isProfileCompatibleWithAgent(selectedProfile, option.agentId);
                                                const selectable = isAgentSelectable(option.agentId);
                                                const disabledReason = !compatible
                                                    ? t('newSession.aiBackendNotCompatibleWithSelectedProfile')
                                                    : !selectable
                                                        ? t('newSession.aiBackendCliNotDetectedOnMachine', { cli: option.title })
                                                        : null;

                                                return {
                                                    id: option.agentId,
                                                    key: option.agentId,
                                                    testID: `new-session-agent:${option.agentId}`,
                                                    title: option.title,
                                                    subtitle: t(option.subtitleKey),
                                                    leftElement: renderIconNode(option.iconName as any, 24, theme.colors.text.secondary),
                                                    dropdownIcon: renderIconNode(option.iconName as any, 20, theme.colors.text.secondary),
                                                    compatible,
                                                    disabled: Boolean(disabledReason),
                                                    disabledReason,
                                                    isSelected: agentType === option.agentId,
                                                    onPress: () => {
                                                        if (disabledReason) {
                                                            showDisabledBackendAlert({ compatible, disabledReason });
                                                            return;
                                                        }
                                                        setAgentType(option.agentId);
                                                    },
                                                };
                                            });
                                            const backendRows = canonicalBackendRows.length > 0 ? canonicalBackendRows : legacyBackendRows;
                                            const selectedBackendRow = backendRows.find((row) => row.isSelected) ?? null;
                                            const dropdownItems: DropdownMenuItem[] = backendRows.map((row) => ({
                                                id: row.id,
                                                title: row.title,
                                                subtitle: row.disabledReason ?? row.subtitle ?? undefined,
                                                disabled: row.disabled,
                                                icon: row.dropdownIcon,
                                            }));

                                            return (
                                                <View onLayout={registerWizardSectionOffset('agent')}>
                                                    <ItemGroup
                                                        title={t('newSession.wizardSection.agent')}
                                                        description={useProfiles && selectedProfileId
                                                            ? t('newSession.aiBackendLimitedByProfileAndMachineClis')
                                                            : t('newSession.aiBackendSelectWhichAiRuns')}
                                                    >
                                                        {/* Missing CLI installation notices lead the section they block. */}
                                                        {selectedMachineId && tmuxRequested && cliAvailability.tmux === false ? (
                                                            <Item
                                                                title={t('machine.tmux.notDetectedSubtitle')}
                                                                subtitle={t('machine.tmux.notDetectedMessage')}
                                                                leftElement={renderIconNode('warning', 20, warningForegroundColor)}
                                                                showChevron={false}
                                                            />
                                                        ) : null}
                                                        {installableDepInstallers?.map((installer) => (
                                                            <InstallableDepInstaller key={installer.depId} {...installer} />
                                                        ))}
                                                        <AdaptiveSelectionSection
                                                            presentation={backendPresentation}
                                                            expandedContent={backendRows.map((row, index) => (
                                                                <Item
                                                                    key={row.key}
                                                                    testID={row.testID}
                                                                    title={row.title}
                                                                    subtitle={row.disabledReason ?? row.subtitle ?? undefined}
                                                                    leftElement={row.leftElement ?? undefined}
                                                                    selected={row.isSelected}
                                                                    disabled={row.disabled}
                                                                    onPress={row.onPress}
                                                                    rightElement={renderSelectedMark(row.isSelected)}
                                                                    showChevron={false}
                                                                    showDivider={index < backendRows.length - 1}
                                                                />
                                                            ))}
                                                            compactContent={(
                                                                <NewSessionWizardDropdownSelectionItem
                                                                    testID="new-session-agent-dropdown-trigger"
                                                                    title={agentLabel ?? selectedBackendRow?.title ?? t('newSession.selectAiBackendTitle')}
                                                                    icon={selectedBackendRow?.leftElement ?? undefined}
                                                                    items={dropdownItems}
                                                                    selectedId={selectedBackendRow?.id ?? null}
                                                                    onSelect={(id) => {
                                                                        const row = backendRows.find((candidate) => candidate.id === id);
                                                                        if (row) {
                                                                            row.onPress();
                                                                        }
                                                                    }}
                                                                    search={dropdownItems.length >= 10}
                                                                    searchPlaceholder={t('subAgentGuidance.ruleEditor.backendPicker.searchPlaceholder')}
                                                                    boundaryRef={props.popoverBoundaryRef}
                                                                />
                                                            )}
                                                        />
                                                    </ItemGroup>
                                                </View>
                                            );
                                        })()}
                                    </View>

                                    {shouldRenderModelSection && (
                                        <View
                                            onLayout={registerWizardSectionOffset('model')}
                                            style={pairAgentAndModelSections ? styles.wizardSelectionPairColumn : undefined}
                                        >
                                            <ItemGroup
                                                title={t('newSession.wizardSection.model')}
                                                description={t('newSession.selectModelDescription')}
                                                // The expanded picker draws its rows edge to edge inside the sheet.
                                                clipContent={modelPresentation === 'expanded'}
                                                // A quiet icon at the title's end, so paired columns keep their rows level.
                                                actionLayout="trailing"
                                                action={hasModelOptionsProbeAffordance ? (
                                                    <IconButton
                                                        testID="new-session-model-refresh"
                                                        iconName="arrow-clockwise"
                                                        variant="plain"
                                                        accessibilityLabel={modelOptionsProbeIsBusy
                                                            ? (modelOptionsProbePhase === 'loading'
                                                                ? (modelOptionsProbe?.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
                                                                : (modelOptionsProbe?.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y')))
                                                            : (modelOptionsProbe?.refreshAccessibilityLabel ?? t('common.refresh'))}
                                                        busy={modelOptionsProbeIsBusy}
                                                        disabled={!modelOptionsProbeIsBusy && typeof modelOptionsProbe?.onRefresh !== 'function'}
                                                        onPress={() => {
                                                            if (modelOptionsProbePhase === 'idle') modelOptionsProbe?.onRefresh?.();
                                                        }}
                                                    />
                                                ) : undefined}
                                            >
                                                <NewSessionModelSelectionContent
                                                    modelOptionsProbe={modelOptionsProbe}
                                                    presentation={modelPresentation}
                                                    modelOptions={modelOptions}
                                                    selectedModelId={modelMode}
                                                    selectedModelSelection={modelSelection}
                                                    selectedIndicatorColor={selectedIndicatorColor}
                                                    selectedBackendEntry={selectedBackendEntry}
                                                    popoverBoundaryRef={props.popoverBoundaryRef}
                                                    favoriteModelSelections={favoriteModelSelections}
                                                    onFavoriteModelSelectionsChange={setFavoriteModelSelections}
                                                    providerGroups={providerModelGroups}
                                                    declarationContext={props.agent.declarationContext}
                                                    teamCredentialResources={teamCredentialResources}
                                                    teamCredentialDisplayNames={teamCredentialDisplayNames}
                                                    teamNameById={teamNameById}
                                                    homeNameByTeamId={homeNameByTeamId}
                                                    teamCredentialResourceStatusByKey={teamCredentialResourceStatusByKey}
                                                    teamCredentialServerId={teamCredentialServerId}
                                                    selectedTeamCredentialModel={selectedTeamCredentialModel}
                                                    onSelectTeamCredentialModel={onSelectTeamCredentialModel}
                                                    providerProjectionAuthoritative={providerModelProjectionAuthoritative === true}
                                                    providerProjectionError={providerModelProjectionError}
                                                    providerProjectionFailures={providerModelProjectionFailures}
                                                    retryProviderProjection={retryProviderModelProjection}
                                                    providerProjectionApproval={providerModelProjectionApproval}
                                                    currentSelectionRecovery={providerCurrentSelectionRecovery}
                                                    hiddenNativeModelKeys={hiddenNativeModelKeys}
                                                    experimentalConfirmation={experimentalModelConfirmation}
                                                    onSelectModel={setModelMode}
                                                    onSelectSelection={setModelSelection ? (ref) => {
                                                        setModelSelection(ref ? {
                                                            v: 1,
                                                            updatedAt: Date.now(),
                                                            ref,
                                                        } : null);
                                                    } : undefined}
                                                />
                                            </ItemGroup>
                                        </View>
                                    )}
                                </View>

                                <View style={useSelectionColumns ? styles.wizardSelectionPair : undefined}>
                                    <View
                                        onLayout={registerWizardSectionOffset('machine')}
                                        style={useSelectionColumns ? styles.wizardSelectionPairColumn : undefined}
                                    >
                                        <ItemGroup
                                            title={t('newSession.wizardSection.machine')}
                                            description={t('newSession.selectMachineDescription')}
                                            clipContent={machinePresentation === 'expanded'}
                                            actionLayout="trailing"
                                            action={onRefreshMachines ? (
                                                <IconButton
                                                    iconName="arrow-clockwise"
                                                    variant="plain"
                                                    accessibilityLabel={t('common.refresh')}
                                                    onPress={() => onRefreshMachines()}
                                                />
                                            ) : undefined}
                                        >
                                            {selectedMachineIsOffline ? (
                                                <Item
                                                    title={t('newSession.machineOfflineInlineTitle')}
                                                    subtitle={t('newSession.machineOfflineInlineBody')}
                                                    leftElement={renderIconNode('warning', 20, warningForegroundColor)}
                                                    showChevron={false}
                                                />
                                            ) : null}
                                            <AdaptiveSelectionSection
                                                presentation={machinePresentation}
                                                expandedContent={typeof props.footer.machinePopover?.renderContent === 'function'
                                                    ? props.footer.machinePopover.renderContent({
                                                        maxHeight: props.footer.machinePopover.maxHeightCap ?? 560,
                                                        requestClose: () => {},
                                                        inline: true,
                                                    })
                                                    : props.footer.machinePopover?.renderContent}
                                                compactContent={(
                                                    <NewSessionWizardPopoverItem
                                                        testID="new-session-machine-dropdown-trigger"
                                                        title={machineDisplayName ?? t('newSession.selectMachineTitle')}
                                                        icon={renderIconNode('desktop', 24, theme.colors.text.secondary)}
                                                        popover={props.footer.machinePopover}
                                                        boundaryRef={props.popoverBoundaryRef}
                                                    />
                                                )}
                                            />
                                        </ItemGroup>
                                    </View>

                                    <View
                                        onLayout={registerWizardSectionOffset('path')}
                                        style={useSelectionColumns ? styles.wizardSelectionPairColumn : undefined}
                                    >
                                        <ItemGroup
                                            title={t('newSession.wizardSection.folder')}
                                            description={t('newSession.selectWorkingDirectoryDescription')}
                                            clipContent
                                        >
                                            <PathSelectionList
                                                autoFocusInput={false}
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
                                        </ItemGroup>
                                    </View>
                                </View>

                                <View onLayout={registerWizardSectionOffset('permission')}>
                                    <ItemGroup
                                        title={t('newSession.wizardSection.permission')}
                                        description={[t('newSession.selectPermissionModeDescription'),
                                            describeNativeSandbox(props.agent.nativeSandbox)].filter(Boolean).join(' · ')}
                                    >
                                        {permissionModeLock ? <Item
                                            testID="new-session-managed-permission"
                                            title={getPermissionModeLabelForAgentType(agentType, permissionMode)}
                                            subtitle={<OrganizationPolicyManagedLine lock={permissionModeLock} />}
                                            showChevron={false}
                                        /> : <AdaptiveSelectionSection
                                            presentation={permissionPresentation}
                                            expandedContent={permissionOptions.map((option, index, array) => (
                                                <Item
                                                    key={option.value}
                                                    title={option.label}
                                                    subtitle={option.description}
                                                    detail={permissionMode === option.value ? permissionModeAttribution ?? undefined : undefined}
                                                    rightElement={renderSelectedMark(permissionMode === option.value)}
                                                    onPress={() => handlePermissionModeChange(option.value)}
                                                    showChevron={false}
                                                    selected={permissionMode === option.value}
                                                    showDivider={index < array.length - 1}
                                                />
                                            ))}
                                            compactContent={(
                                                <NewSessionWizardDropdownSelectionItem
                                                    testID="new-session-permission-dropdown-trigger"
                                                    title={permissionOptions.find((option) => option.value === permissionMode)?.label ?? t('newSession.selectPermissionModeTitle')}
                                                    items={permissionOptions.map((option) => ({
                                                        id: option.value,
                                                        title: option.label,
                                                        subtitle: option.description,
                                                    }))}
                                                    selectedId={permissionMode}
                                                    boundaryRef={props.popoverBoundaryRef}
                                                    onSelect={(id) => handlePermissionModeChange(id as PermissionMode)}
                                                />
                                            )}
                                        />}
                                    </ItemGroup>
                                </View>
                        </View>
                    </ItemList>
                    </ContainedPageScopeProvider>
                </ComposerKeyboardScaffold>
            </PopoverBoundaryProvider>
        </View>
    );
});

type NewSessionWizardComposerInputProps = Omit<React.ComponentProps<typeof AgentInput>, 'value'> & Readonly<{
    attachmentsUploadsEnabled: boolean;
    composerReservedHeight: number;
    filePickerRef: React.ComponentPropsWithRef<typeof AttachmentFilePicker>['ref'];
    onAttachmentsPicked: React.ComponentProps<typeof AttachmentFilePicker>['onAttachmentsPicked'];
    promptStore: NewSessionPromptStore;
}>;

function NewSessionWizardComposerInput(props: NewSessionWizardComposerInputProps) {
    const {
        attachmentsUploadsEnabled,
        composerReservedHeight,
        filePickerRef,
        onAttachmentsPicked,
        promptStore,
        ...agentInputProps
    } = props;
    // Subscribe at the leaf that renders the input so typing does not rebuild the
    // wizard's machine, path, provider, model, and permission selection sections.
    const value = useNewSessionPromptValue(promptStore);
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
                value={value}
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
