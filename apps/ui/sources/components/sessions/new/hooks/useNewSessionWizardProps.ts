import * as React from 'react';

import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import type { ActiveSuggestionsHandler } from '@/components/autocomplete/useActiveSuggestions';

import type { AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { getRequiredSecretEnvVarNames } from '@/sync/domains/profiles/profileSecrets';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol';
import type { CLIAvailability } from '@/hooks/auth/useCLIDetection';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { buildCliAvailabilityProbeState } from '@/components/sessions/new/modules/buildCliAvailabilityProbeState';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';

import type { AgentInputExtraActionChip, AgentInputExtraActionPresentation } from '@/components/sessions/agentInput';
import type { InstallableDepInstallerProps } from '@/components/machines/InstallableDepInstaller';
import type {
    NewSessionWizardAgentProps,
    NewSessionWizardFooterProps,
    NewSessionWizardLayoutProps,
    NewSessionWizardMachineProps,
    NewSessionWizardProfilesProps,
    NewSessionWizardProps,
} from '../components/NewSessionWizard';
import type { CliNotDetectedBannerDismissScope } from '../components/CliNotDetectedBanner';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';

function tNoParams(key: string): string {
    return (t as any)(key);
}

export function useNewSessionWizardProps(params: Readonly<{
    // Layout
    theme: any;
    styles: any;
    safeAreaTop?: number;
    safeAreaBottom: number;
    headerHeight: number;
    newSessionTopPadding?: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    shouldBottomAnchor: boolean;

    // Profiles section
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

    // Secret satisfaction helpers
    machineEnvPresence: UseMachineEnvPresenceResult;
    secrets: SavedSecret[];
    secretBindingsByProfileId: Record<string, Record<string, string>>;
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;

    // Installable deps
    wizardInstallableDeps: Array<{ entry: any; depStatus: any }>;
    selectedMachineCapabilities: { status: any };

    // Agent section
    cliAvailability: CLIAvailability;
    tmuxRequested: boolean;
    enabledAgentIds: AgentId[];
    isAgentSelectable: (agentId: AgentId) => boolean;
    isCliBannerDismissed: (agentId: AgentId) => boolean;
    dismissCliBanner: (agentId: AgentId, scope: CliNotDetectedBannerDismissScope) => void;
    agentType: string;
    agentLabel?: string;
    setAgentType: (agent: AgentId) => void;
    agentPickerTitle?: NewSessionWizardAgentProps['agentPickerTitle'];
    agentPickerOptions?: NewSessionWizardAgentProps['agentPickerOptions'];
    agentPickerSelectedOptionId?: NewSessionWizardAgentProps['agentPickerSelectedOptionId'];
    onAgentPickerSelect?: NewSessionWizardAgentProps['onAgentPickerSelect'];
    selectedBackendEntry?: NewSessionWizardAgentProps['selectedBackendEntry'];
    modelOptions: ReadonlyArray<{ value: ModelMode; label: string; description: string }>;
    modelOptionsProbe?: NewSessionWizardAgentProps['modelOptionsProbe'];
    favoriteModelSelections?: NewSessionWizardAgentProps['favoriteModelSelections'];
    setFavoriteModelSelections?: NewSessionWizardAgentProps['setFavoriteModelSelections'];
    acpSessionModeOptions?: NewSessionWizardAgentProps['acpSessionModeOptions'];
    acpSessionModeProbe?: NewSessionWizardAgentProps['acpSessionModeProbe'];
    acpSessionModeId?: NewSessionWizardAgentProps['acpSessionModeId'];
    setAcpSessionModeId?: NewSessionWizardAgentProps['setAcpSessionModeId'];
    acpConfigOptions?: NewSessionWizardAgentProps['acpConfigOptions'];
    acpConfigOptionsProbe?: NewSessionWizardAgentProps['acpConfigOptionsProbe'];
    acpConfigOptionOverrides?: NewSessionWizardAgentProps['acpConfigOptionOverrides'];
    setAcpConfigOptionOverride?: NewSessionWizardAgentProps['setAcpConfigOptionOverride'];
    modelMode: ModelMode | undefined;
    modelSelection?: SessionModelSelectionV1 | null;
    setModelMode: (mode: ModelMode) => void;
    setModelSelection?: NewSessionWizardAgentProps['setModelSelection'];
    providerModelGroups?: NewSessionWizardAgentProps['providerModelGroups'];
    providerModelProjectionAuthoritative?: NewSessionWizardAgentProps['providerModelProjectionAuthoritative'];
    providerModelProjectionError?: NewSessionWizardAgentProps['providerModelProjectionError'];
    providerModelProjectionFailures?: NewSessionWizardAgentProps['providerModelProjectionFailures'];
    retryProviderModelProjection?: NewSessionWizardAgentProps['retryProviderModelProjection'];
    providerCurrentSelectionRecovery?: NewSessionWizardAgentProps['providerCurrentSelectionRecovery'];
    hiddenNativeModelKeys?: NewSessionWizardAgentProps['hiddenNativeModelKeys'];
    experimentalModelConfirmation?: NewSessionWizardAgentProps['experimentalModelConfirmation'];
    selectedIndicatorColor: string;
    profileMap: Map<string, AIBackendProfile>;
    permissionMode: PermissionMode;
    handlePermissionModeChange: (mode: PermissionMode) => void;

    // Machine section
    machines: ReadonlyArray<Machine>;
    targetServerId?: string | null;
    selectedMachine: Machine | null;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    useMachinePickerSearch: boolean;
    refreshMachineData: () => void;
    setSelectedMachineId: (id: string) => void;
    getBestPathForMachine: (id: string | null) => string;
    setSelectedPath: (path: string) => void;
    setDraftSelectedPath?: (path: string) => void;
    favoriteMachines: ReadonlyArray<string>;
    setFavoriteMachines: (ids: string[]) => void;
    selectedPath: string;
    recentPaths: ReadonlyArray<string>;
    usePathPickerSearch: boolean;
    favoriteDirectories: ReadonlyArray<string>;
    setFavoriteDirectories: (dirs: string[]) => void;

    // Footer section
    promptStore: NewSessionPromptStore;
    composerDocument?: NewSessionWizardFooterProps['composerDocument'];
    setSessionPrompt: (v: string) => void;
    handleCreateSession: () => void;
    canCreate: boolean;
    isCreating: boolean;
    pendingLaunchAttempt?: NewSessionWizardFooterProps['pendingLaunchAttempt'];
    providerLaunchError?: NewSessionWizardFooterProps['providerLaunchError'];
    retryProviderLaunch?: NewSessionWizardFooterProps['retryProviderLaunch'];
    submitAccessibilityLabel?: NewSessionWizardFooterProps['submitAccessibilityLabel'];
    emptyAutocompleteKinds: readonly ComposerSuggestionKindId[];
    emptyAutocompleteSuggestions: ActiveSuggestionsHandler;
    connectionStatus?: any;
    statusBadges?: NewSessionWizardFooterProps['statusBadges'];
    composerTopContent?: NewSessionWizardFooterProps['composerTopContent'];
    statusTrailingActions?: NewSessionWizardFooterProps['statusTrailingActions'];
    machinePopover?: NewSessionWizardFooterProps['machinePopover'];
    pathPopover?: NewSessionWizardFooterProps['pathPopover'];
    resumeSessionId: string;
    resumePopover?: NewSessionWizardFooterProps['resumePopover'];
    isResumeSupportChecking: boolean;
    sessionPromptInputMaxHeight?: number;
    agentInputExtraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    sourceContextPresentation?: AgentInputExtraActionPresentation | null;
    attachmentFlowId?: string | null;
    sectionPresentation?: NewSessionWizardProps['sectionPresentation'];
    useColumnLayout?: NewSessionWizardProps['useColumnLayout'];
}>): Readonly<{
    layout: NewSessionWizardLayoutProps;
    sectionPresentation?: NewSessionWizardProps['sectionPresentation'];
    useColumnLayout?: NewSessionWizardProps['useColumnLayout'];
    profiles: NewSessionWizardProfilesProps;
    agent: NewSessionWizardAgentProps;
    machine: NewSessionWizardMachineProps;
    footer: NewSessionWizardFooterProps;
}> {
    const wizardLayoutProps = React.useMemo((): NewSessionWizardLayoutProps => {
        return {
            theme: params.theme,
            styles: params.styles,
            safeAreaTop: params.safeAreaTop,
            safeAreaBottom: params.safeAreaBottom,
            headerHeight: params.headerHeight,
            newSessionTopPadding: params.newSessionTopPadding,
            newSessionSidePadding: params.newSessionSidePadding,
            newSessionBottomPadding: params.newSessionBottomPadding,
            shouldBottomAnchor: params.shouldBottomAnchor,
        };
    }, [
        params.headerHeight,
        params.newSessionBottomPadding,
        params.newSessionSidePadding,
        params.newSessionTopPadding,
        params.safeAreaTop,
        params.shouldBottomAnchor,
        params.safeAreaBottom,
        params.theme,
        params.styles,
    ]);

    const getSecretSatisfactionForProfile = React.useCallback((profile: AIBackendProfile) => {
        const selectedSecretIds = params.selectedSecretIdByProfileIdByEnvVarName[profile.id] ?? null;
        const sessionOnlyValues = params.sessionOnlySecretValueByProfileIdByEnvVarName[profile.id] ?? null;
        const machineEnvReadyByName = Object.fromEntries(
            Object.entries(params.machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
        );
        return getSecretSatisfaction({
            profile,
            secrets: params.secrets,
            defaultBindings: params.secretBindingsByProfileId[profile.id] ?? null,
            selectedSecretIds,
            sessionOnlyValues,
            machineEnvReadyByName,
        });
    }, [
        params.machineEnvPresence.meta,
        params.secrets,
        params.secretBindingsByProfileId,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.sessionOnlySecretValueByProfileIdByEnvVarName,
    ]);

    const getSecretOverrideReady = React.useCallback((profile: AIBackendProfile): boolean => {
        const satisfaction = getSecretSatisfactionForProfile(profile);
        // Override should only represent non-machine satisfaction (defaults / saved / session-only).
        if (!satisfaction.hasSecretRequirements) return false;
        const required = satisfaction.items.filter((i) => i.required);
        if (required.length === 0) return false;
        if (!required.every((i) => i.isSatisfied)) return false;
        return required.some((i) => i.satisfiedBy !== 'machineEnv');
    }, [getSecretSatisfactionForProfile]);

    const getSecretMachineEnvOverride = React.useCallback((profile: AIBackendProfile) => {
        if (!params.selectedMachineId) return null;
        if (!params.machineEnvPresence.isPreviewEnvSupported) return null;
        const requiredNames = getRequiredSecretEnvVarNames(profile);
        if (requiredNames.length === 0) return null;
        return {
            isReady: requiredNames.every((name) => Boolean(params.machineEnvPresence.meta[name]?.isSet)),
            isLoading: params.machineEnvPresence.isLoading,
        };
    }, [
        params.machineEnvPresence.isLoading,
        params.machineEnvPresence.isPreviewEnvSupported,
        params.machineEnvPresence.meta,
        params.selectedMachineId,
    ]);

    const wizardProfilesProps = React.useMemo((): NewSessionWizardProfilesProps => {
        return {
            useProfiles: params.useProfiles,
            profiles: params.profiles,
            favoriteProfileIds: params.favoriteProfileIds,
            setFavoriteProfileIds: params.setFavoriteProfileIds,
            selectedProfileId: params.selectedProfileId,
            onPressDefaultEnvironment: params.onPressDefaultEnvironment,
            onPressProfile: params.onPressProfile,
            selectedMachineId: params.selectedMachineId,
            getProfileDisabled: params.getProfileDisabled,
            getProfileSubtitleExtra: params.getProfileSubtitleExtra,
            handleAddProfile: params.handleAddProfile,
            openProfileEdit: params.openProfileEdit,
            handleDuplicateProfile: params.handleDuplicateProfile,
            handleDeleteProfile: params.handleDeleteProfile,
            suppressNextSecretAutoPromptKeyRef: params.suppressNextSecretAutoPromptKeyRef,
            openSecretRequirementModal: params.openSecretRequirementModal,
            profilesGroupTitles: params.profilesGroupTitles,
            getSecretOverrideReady,
            getSecretSatisfactionForProfile,
            getSecretMachineEnvOverride,
        };
    }, [
        params.favoriteProfileIds,
        params.getProfileDisabled,
        params.getProfileSubtitleExtra,
        params.handleAddProfile,
        params.handleDeleteProfile,
        params.handleDuplicateProfile,
        params.onPressDefaultEnvironment,
        params.onPressProfile,
        params.openProfileEdit,
        params.openSecretRequirementModal,
        params.profiles,
        params.profilesGroupTitles,
        params.selectedMachineId,
        params.selectedProfileId,
        params.setFavoriteProfileIds,
        params.suppressNextSecretAutoPromptKeyRef,
        params.useProfiles,
        getSecretOverrideReady,
        getSecretSatisfactionForProfile,
        getSecretMachineEnvOverride,
    ]);

    const installableDepInstallers = React.useMemo((): InstallableDepInstallerProps[] => {
        if (!params.selectedMachineId) return [];
        if (params.wizardInstallableDeps.length === 0) return [];

        return params.wizardInstallableDeps.map(({ entry, depStatus }) => ({
            machineId: params.selectedMachineId!,
            serverId: params.targetServerId,
            enabled: true,
            groupTitle: `${tNoParams(entry.groupTitleKey)}${entry.experimental ? ' (experimental)' : ''}`,
            depId: entry.capabilityId,
            depTitle: entry.title,
            depSubtitle: entry.subtitle,
            depIconName: entry.iconName as any,
            setupUrl: entry.setupUrl,
            depStatus,
            capabilitiesStatus: params.selectedMachineCapabilities.status,
            installLabels: {
                install: entry.installLabels.install,
                update: entry.installLabels.update,
                reinstall: entry.installLabels.reinstall,
            },
            installModal: {
                installTitle: entry.installModal.installTitle,
                updateTitle: entry.installModal.updateTitle,
                reinstallTitle: entry.installModal.reinstallTitle,
                description: entry.installModal.description,
            },
            refreshStatus: () => {
                void prefetchMachineCapabilities({
                    machineId: params.selectedMachineId!,
                    serverId: params.targetServerId,
                    request: CAPABILITIES_REQUEST_NEW_SESSION,
                });
            },
            refreshLatestVersion: () => {
                void prefetchMachineCapabilities({
                    machineId: params.selectedMachineId!,
                    serverId: params.targetServerId,
                    request: entry.buildLatestVersionDetectRequest(),
                    timeoutMs: 12_000,
                });
            },
        }));
    }, [params.selectedMachineCapabilities.status, params.selectedMachineId, params.targetServerId, params.wizardInstallableDeps]);

    const wizardAgentProps = React.useMemo((): NewSessionWizardAgentProps => {
        const agentPickerProbe: NewSessionWizardAgentProps['agentPickerProbe'] =
            buildCliAvailabilityProbeState({
                selectedMachineId: params.selectedMachineId,
                cliAvailability: params.cliAvailability,
                onRefresh: () => {
                    void params.cliAvailability.refresh({ bypassCache: true });
                },
            });

        return {
            cliAvailability: params.cliAvailability,
            tmuxRequested: params.tmuxRequested,
            enabledAgentIds: params.enabledAgentIds,
            isAgentSelectable: params.isAgentSelectable,
            isCliBannerDismissed: params.isCliBannerDismissed,
            dismissCliBanner: params.dismissCliBanner,
            agentType: params.agentType,
            agentLabel: params.agentLabel,
            setAgentType: params.setAgentType,
            agentPickerTitle: params.agentPickerTitle,
            agentPickerOptions: params.agentPickerOptions,
            agentPickerSelectedOptionId: params.agentPickerSelectedOptionId,
            onAgentPickerSelect: params.onAgentPickerSelect,
            agentPickerProbe,
            selectedBackendEntry: params.selectedBackendEntry,
            modelOptions: params.modelOptions,
            modelOptionsProbe: params.modelOptionsProbe,
            favoriteModelSelections: params.favoriteModelSelections,
            setFavoriteModelSelections: params.setFavoriteModelSelections,
            acpSessionModeOptions: params.acpSessionModeOptions,
            acpSessionModeProbe: params.acpSessionModeProbe,
            acpSessionModeId: params.acpSessionModeId,
            setAcpSessionModeId: params.setAcpSessionModeId,
            acpConfigOptions: params.acpConfigOptions,
            acpConfigOptionsProbe: params.acpConfigOptionsProbe,
            acpConfigOptionOverrides: params.acpConfigOptionOverrides,
            setAcpConfigOptionOverride: params.setAcpConfigOptionOverride,
            modelMode: params.modelMode,
            modelSelection: params.modelSelection,
            setModelMode: params.setModelMode,
            setModelSelection: params.setModelSelection,
            providerModelGroups: params.providerModelGroups,
            providerModelProjectionAuthoritative: params.providerModelProjectionAuthoritative,
            providerModelProjectionError: params.providerModelProjectionError,
            providerModelProjectionFailures: params.providerModelProjectionFailures,
            retryProviderModelProjection: params.retryProviderModelProjection,
            providerCurrentSelectionRecovery: params.providerCurrentSelectionRecovery,
            hiddenNativeModelKeys: params.hiddenNativeModelKeys,
            experimentalModelConfirmation: params.experimentalModelConfirmation,
            selectedIndicatorColor: params.selectedIndicatorColor,
            profileMap: params.profileMap,
            permissionMode: params.permissionMode,
            handlePermissionModeChange: params.handlePermissionModeChange,
            installableDepInstallers,
        };
    }, [
        params.agentType,
        params.agentLabel,
        params.agentPickerOptions,
        params.agentPickerSelectedOptionId,
        params.agentPickerTitle,
        params.selectedBackendEntry,
        params.cliAvailability,
        params.selectedMachineId,
        params.dismissCliBanner,
        params.enabledAgentIds,
        params.isAgentSelectable,
        params.isCliBannerDismissed,
        params.modelMode,
        params.modelSelection,
        params.providerModelGroups,
        params.providerModelProjectionAuthoritative,
        params.providerModelProjectionError,
        params.providerModelProjectionFailures,
        params.retryProviderModelProjection,
        params.providerCurrentSelectionRecovery,
        params.hiddenNativeModelKeys,
        params.experimentalModelConfirmation,
        params.modelOptions,
        params.modelOptionsProbe,
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
        params.acpSessionModeId,
        params.acpSessionModeOptions,
        params.acpSessionModeProbe,
        params.acpConfigOptions,
        params.acpConfigOptionsProbe,
        params.acpConfigOptionOverrides,
        params.permissionMode,
        params.profileMap,
        params.selectedIndicatorColor,
        params.onAgentPickerSelect,
        params.setAgentType,
        params.setAcpConfigOptionOverride,
        params.setAcpSessionModeId,
        params.setModelMode,
        params.setModelSelection,
        params.handlePermissionModeChange,
        params.tmuxRequested,
        installableDepInstallers,
    ]);

    const wizardMachineProps = React.useMemo((): NewSessionWizardMachineProps => {
        return {
            machines: params.machines,
            serverId: params.targetServerId,
            selectedMachine: params.selectedMachine || null,
            recentMachines: params.recentMachines,
            favoriteMachineItems: params.favoriteMachineItems,
            useMachinePickerSearch: params.useMachinePickerSearch,
            onRefreshMachines: params.refreshMachineData,
            setSelectedMachineId: params.setSelectedMachineId as any,
            getBestPathForMachine: params.getBestPathForMachine as any,
            setSelectedPath: params.setSelectedPath,
            setDraftSelectedPath: params.setDraftSelectedPath,
            favoriteMachines: params.favoriteMachines,
            setFavoriteMachines: params.setFavoriteMachines,
            selectedPath: params.selectedPath,
            recentPaths: params.recentPaths,
            usePathPickerSearch: params.usePathPickerSearch,
            favoriteDirectories: params.favoriteDirectories,
            setFavoriteDirectories: params.setFavoriteDirectories,
        };
    }, [
        params.favoriteDirectories,
        params.favoriteMachineItems,
        params.favoriteMachines,
        params.getBestPathForMachine,
        params.machines,
        params.targetServerId,
        params.recentMachines,
        params.recentPaths,
        params.refreshMachineData,
        params.selectedMachine,
        params.selectedPath,
        params.setFavoriteDirectories,
        params.setFavoriteMachines,
        params.setSelectedMachineId,
        params.setSelectedPath,
        params.setDraftSelectedPath,
        params.useMachinePickerSearch,
        params.usePathPickerSearch,
    ]);

    const wizardFooterProps = React.useMemo((): NewSessionWizardFooterProps => {
        return {
            promptStore: params.promptStore,
            composerDocument: params.composerDocument,
            setSessionPrompt: params.setSessionPrompt,
            handleCreateSession: params.handleCreateSession,
            canCreate: params.canCreate,
            isCreating: params.isCreating,
            pendingLaunchAttempt: params.pendingLaunchAttempt,
            providerLaunchError: params.providerLaunchError,
            retryProviderLaunch: params.retryProviderLaunch,
            submitAccessibilityLabel: params.submitAccessibilityLabel,
            emptyAutocompleteKinds: params.emptyAutocompleteKinds,
            emptyAutocompleteSuggestions: params.emptyAutocompleteSuggestions,
            connectionStatus: params.connectionStatus,
            statusBadges: params.statusBadges,
            composerTopContent: params.composerTopContent,
            statusTrailingActions: params.statusTrailingActions,
            machinePopover: params.machinePopover,
            pathPopover: params.pathPopover,
            resumeSessionId: params.resumeSessionId,
            resumePopover: params.resumePopover,
            resumeIsChecking: params.isResumeSupportChecking,
            inputMaxHeight: params.sessionPromptInputMaxHeight,
            agentInputExtraActionChips: params.agentInputExtraActionChips,
            sourceContextPresentation: params.sourceContextPresentation ?? null,
            attachmentFlowId: params.attachmentFlowId,
        };
        // NOTE: Agent selection doesn't affect these props, but keeping dependencies
        // broad mirrors the previous in-screen memoization behavior and avoids subtle
        // referential changes during refactors.
    }, [
        params.agentType,
        params.agentInputExtraActionChips,
        params.sourceContextPresentation,
        params.attachmentFlowId,
        params.canCreate,
        params.connectionStatus,
        params.composerTopContent,
        params.emptyAutocompleteKinds,
        params.emptyAutocompleteSuggestions,
        params.handleCreateSession,
        params.isCreating,
        params.isResumeSupportChecking,
        params.machinePopover,
        params.pendingLaunchAttempt,
        params.pathPopover,
        params.providerLaunchError,
        params.resumePopover,
        params.resumeSessionId,
        params.retryProviderLaunch,
        params.composerDocument,
        params.promptStore,
        params.sessionPromptInputMaxHeight,
        params.setSessionPrompt,
        params.statusBadges,
        params.statusTrailingActions,
    ]);

    return {
        layout: wizardLayoutProps,
        sectionPresentation: params.sectionPresentation,
        useColumnLayout: params.useColumnLayout,
        profiles: wizardProfilesProps,
        agent: wizardAgentProps,
        machine: wizardMachineProps,
        footer: wizardFooterProps,
    };
}
