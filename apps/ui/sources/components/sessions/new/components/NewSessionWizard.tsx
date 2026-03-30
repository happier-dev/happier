import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, ScrollView, View, useWindowDimensions, type View as RNView } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { LinearGradient } from 'expo-linear-gradient';
import Color from 'color';
import { Typography } from '@/constants/Typography';
import { AgentInput } from '@/components/sessions/agentInput';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { PathSelector } from '@/components/sessions/new/components/PathSelector';
import { WizardSectionHeaderRow } from '@/components/sessions/new/components/WizardSectionHeaderRow';
import { ProfilesList } from '@/components/profiles/ProfilesList';
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
import { CliNotDetectedBanner, type CliNotDetectedBannerDismissScope } from '@/components/sessions/new/components/CliNotDetectedBanner';
import { InstallableDepInstaller, type InstallableDepInstallerProps } from '@/components/machines/InstallableDepInstaller';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { CreatedSessionFollowUpContext } from '../hooks/useCreateNewSession';
import { buildNewSessionProfileSelectionPopover } from '@/components/sessions/new/components/buildNewSessionProfileSelectionPopover';
import { NewSessionProfilesBrowserContent } from '@/components/sessions/new/components/NewSessionProfilesBrowserContent';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import { useNewSessionAttachmentsController } from '@/components/sessions/new/attachments/useNewSessionAttachmentsController';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';


export interface NewSessionWizardLayoutProps {
    theme: any;
    styles: any;
    safeAreaBottom: number;
    headerHeight: number;
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
    modelOptions: ReadonlyArray<{ value: ModelMode; label: string; description: string }>;
    modelOptionsProbe?: React.ComponentProps<typeof AgentInput>['modelOptionsOverrideProbe'];
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
    handleCreateSession: (opts?: Readonly<{ initialMessage?: 'send' | 'skip'; afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void> }>) => void;
    canCreate: boolean;
    isCreating: boolean;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    emptyAutocompletePrefixes: React.ComponentProps<typeof AgentInput>['autocompletePrefixes'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
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
    profiles: NewSessionWizardProfilesProps;
    agent: NewSessionWizardAgentProps;
    machine: NewSessionWizardMachineProps;
    footer: NewSessionWizardFooterProps;
}

export const NewSessionWizard = React.memo(function NewSessionWizard(props: NewSessionWizardProps) {
    const {
        theme,
        styles,
        safeAreaBottom,
        headerHeight,
        newSessionSidePadding,
        newSessionBottomPadding,
        shouldBottomAnchor: shouldBottomAnchorOverride,
    } = props.layout;
    const { width: windowWidth } = useWindowDimensions();
    const shouldBottomAnchor =
        shouldBottomAnchorOverride ?? (Platform.OS !== 'web' || isMobileLayoutWidth(windowWidth));

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
        setAgentType,
        modelOptions,
        modelOptionsProbe,
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
        favoriteMachines,
        setFavoriteMachines,
        selectedPath,
        recentPaths,
        usePathPickerSearch,
        favoriteDirectories,
        setFavoriteDirectories,
    } = props.machine;
    const selectedMachineIsOffline = React.useMemo(() => {
        if (!selectedMachine) return false;
        return !isMachineOnline(selectedMachine);
    }, [selectedMachine]);

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

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight + safeAreaBottom + 16 : 0}
            style={[
                styles.container,
                {
                    backgroundColor: theme.colors.groupped.background,
                    justifyContent: shouldBottomAnchor ? 'flex-end' : 'center',
                    ...(shouldBottomAnchor ? { paddingTop: 0 } : {}),
                },
            ]}
        >
            <View
                ref={props.popoverBoundaryRef}
                style={{
                    flex: 1,
                    width: '100%',
                }}
            >
                <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                    <ScrollView
                        ref={scrollViewRef}
                        style={styles.scrollContainer}
                        contentContainerStyle={styles.contentContainer}
                        keyboardShouldPersistTaps="handled"
                    >
                                <View style={{ paddingHorizontal: 0 }}>
                                    <View style={[
                                        { maxWidth: layout.maxWidth, flex: 1, width: '100%', alignSelf: 'center' }
                                    ]}>
                                        <View onLayout={registerWizardSectionOffset('profile')} style={styles.wizardContainer}>
                                {useProfiles && (
                                    <>
                                        <View style={styles.wizardSectionHeaderRow}>
                                            {renderIconNode('person-outline', 18, theme.colors.text)}
                                            <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>
                                                {t('newSession.selectAiProfileTitle')}
                                            </Text>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectAiProfileDescription')}
                                        </Text>
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

                                        <View style={{ height: 24 }} />
                                    </>
                                )}

                                {/* Section: AI Backend */}
                                <View onLayout={registerWizardSectionOffset('agent')}>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        {renderIconNode('hardware-chip-outline', 18, theme.colors.text)}
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
                                        backgroundColor: theme.colors.box.warning.background,
                                        borderRadius: 10,
                                        padding: 12,
                                        marginBottom: 12,
                                        borderWidth: 1,
                                        borderColor: theme.colors.box.warning.border,
                                    }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                            {renderIconNode('warning', 16, theme.colors.warning)}
                                            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                {t('machine.tmux.notDetectedSubtitle')}
                                            </Text>
                                        </View>
                                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
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

                                <ItemGroup title={<View />} headerStyle={{ paddingTop: 0, paddingBottom: 0 }}>
                                    {(() => {
                                        const selectedProfile = useProfiles && selectedProfileId
                                            ? (resolvedProfileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId))
                                            : null;

                                        const options = getAgentPickerOptions(enabledAgentIds);

                                        return options.map((option, index) => {
                                            const compatible = !selectedProfile || isProfileCompatibleWithAgent(selectedProfile, option.agentId);
                                            const selectable = isAgentSelectable(option.agentId);
                                            const disabledReason = !compatible
                                                ? t('newSession.aiBackendNotCompatibleWithSelectedProfile')
                                                : !selectable
                                                    ? t('newSession.aiBackendCliNotDetectedOnMachine', { cli: t(option.titleKey) })
                                                    : null;

                                            const isSelected = agentType === option.agentId;

                                            return (
                                                <Item
                                                    key={option.agentId}
                                                    testID={`new-session-agent:${option.agentId}`}
                                                    title={t(option.titleKey)}
                                                    subtitle={disabledReason ?? t(option.subtitleKey)}
                                                    leftElement={renderIconNode(option.iconName as any, 24, theme.colors.textSecondary)}
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
                                                    showDivider={index < options.length - 1}
                                                />
                                            );
                                        });
                                    })()}
                                </ItemGroup>

                                {modelOptions.length > 0 && (
                                    <View style={{ marginTop: 24 }}>
                                        <View onLayout={registerWizardSectionOffset('model')}>
                                            <View style={styles.wizardSectionHeaderRow}>
                                                {renderIconNode('sparkles-outline', 18, theme.colors.text)}
                                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectModelTitle')}</Text>
                                            </View>
                                        </View>
                                        <Text style={styles.sectionDescription}>
                                            {t('newSession.selectModelDescription')}
                                        </Text>
                                        <ItemGroup title="">
                                            {modelOptions.map((option, index, options) => {
                                                const isSelected = modelMode === option.value;
                                                return (
                                                    <Item
                                                        key={option.value}
                                                        testID={`new-session-model:${option.value}`}
                                                        title={option.label}
                                                        subtitle={option.description}
                                                        leftElement={renderIconNode('sparkles-outline', 24, theme.colors.textSecondary)}
                                                        showChevron={false}
                                                        selected={isSelected}
                                                        onPress={() => setModelMode(option.value)}
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
                                                        showDivider={index < options.length - 1}
                                                    />
                                                );
                                            })}
                                        </ItemGroup>
                                    </View>
                                )}

                                <View style={{ height: 24 }} />

                                {/* Section 2: Machine Selection */}
                                <View onLayout={registerWizardSectionOffset('machine')}>
                                    <WizardSectionHeaderRow
                                        rowStyle={styles.wizardSectionHeaderRow}
                                        iconName="desktop-outline"
                                        iconColor={theme.colors.text}
                                        title={t('newSession.selectMachineTitle')}
                                        titleStyle={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}
                                        action={onRefreshMachines ? {
                                            accessibilityLabel: t('common.refresh'),
                                            iconName: 'refresh-outline',
                                            iconColor: theme.colors.textSecondary,
                                            onPress: onRefreshMachines,
                                        } : undefined}
                                    />
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('newSession.selectMachineDescription')}
                                </Text>

                                <View style={{ marginBottom: 24 }}>
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
                                        searchPlaceholder="Search machines..."
                                        onSelect={(machine) => {
                                            setSelectedMachineId(machine.id);
                                            const bestPath = getBestPathForMachine(machine.id);
                                            setSelectedPath(bestPath);
                                        }}
                                        onToggleFavorite={(machine) => {
                                            const isInFavorites = favoriteMachines.includes(machine.id);
                                            if (isInFavorites) {
                                                setFavoriteMachines(favoriteMachines.filter(id => id !== machine.id));
                                            } else {
                                                setFavoriteMachines([...favoriteMachines, machine.id]);
                                            }
                                        }}
                                    />
                                    {selectedMachineIsOffline && (
                                        <View
                                            style={{
                                                marginTop: 12,
                                                borderRadius: 10,
                                                padding: 12,
                                                borderWidth: 1,
                                                backgroundColor: theme.colors.box.warning.background,
                                                borderColor: theme.colors.box.warning.border,
                                            }}
                                        >
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                                {renderIconNode(
                                                    'warning-outline',
                                                    16,
                                                    theme.colors.warning ?? theme.colors.textDestructive,
                                                )}
                                                <Text style={{ color: theme.colors.text, fontWeight: '600', ...Typography.default('semiBold') }}>
                                                    {t('newSession.machineOfflineInlineTitle')}
                                                </Text>
                                            </View>
                                            <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('newSession.machineOfflineInlineBody')}
                                            </Text>
                                        </View>
                                    )}
                                </View>

                                {/* API key selection is now handled inline from the profile list (via the requirements badge). */}

                                {/* Section 3: Working Directory */}
                                <View onLayout={registerWizardSectionOffset('path')}>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        {renderIconNode('folder-outline', 18, theme.colors.text)}
                                        <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectWorkingDirectoryTitle')}</Text>
                                    </View>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('newSession.selectWorkingDirectoryDescription')}
                                </Text>

                                <View style={{ marginBottom: 24 }}>
                                    <PathSelector
                                        machineHomeDir={selectedMachine?.metadata?.homeDir || '/home'}
                                        selectedPath={selectedPath}
                                        onChangeSelectedPath={setSelectedPath}
                                        recentPaths={recentPaths}
                                        usePickerSearch={usePathPickerSearch}
                                        searchVariant="group"
                                        focusInputOnSelect={false}
                                        favoriteDirectories={favoriteDirectories}
                                        onChangeFavoriteDirectories={setFavoriteDirectories}
                                        machineBrowse={{
                                            enabled: true,
                                            machineId: selectedMachine?.id ?? null,
                                            serverId: serverId ?? null,
                                        }}
                                    />
                                </View>

                                {/* Section 4: Permission Mode */}
                                <View onLayout={registerWizardSectionOffset('permission')}>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        {renderIconNode('shield-outline', 18, theme.colors.text)}
                                        <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('newSession.selectPermissionModeTitle')}</Text>
                                    </View>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('newSession.selectPermissionModeDescription')}
                                </Text>
                                <ItemGroup title="">
                                    {getPermissionModeOptionsForAgentType(agentType).map((option, index, array) => (
                                        <Item
                                            key={option.value}
                                            title={option.label}
                                            subtitle={option.description}
                                            leftElement={renderIconNode(option.icon as any, 24, theme.colors.textSecondary)}
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

                                <View style={{ height: 24 }} />

                            </View>
                        </View>
                    </View>
                </ScrollView>

                {/* AgentInput - Sticky at bottom */}
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
                        android: { borderTopWidth: 1, borderTopColor: theme.colors.divider },
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
                              <AgentInput
                                  value={sessionPrompt}
                                  onChangeText={setSessionPrompt}
                                  onSend={handleSend}
                                  isSendDisabled={!canCreate}
                                  isSending={isCreating}
                                  submitAccessibilityLabel={props.footer.submitAccessibilityLabel}
                                  placeholder={t('session.inputPlaceholder')}
                                  autocompletePrefixes={emptyAutocompletePrefixes}
                                  autocompleteSuggestions={emptyAutocompleteSuggestions}
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
                                  {...(useProfiles ? {
                                      profileId: selectedProfileId,
                                      profilePopover,
                                      envVarsCount: undefined,
                                      envVarsPopover: undefined,
                                      onEnvVarsClick: undefined,
                                  } : {})}
                              />
                              {attachmentsUploadsEnabled ? (
                                  <AttachmentFilePicker ref={filePickerRef} onAttachmentsPicked={addPickedAttachments} multiple />
                              ) : null}
                          </View>
                      </View>
                </View>
                </PopoverBoundaryProvider>
            </View>
        </KeyboardAvoidingView>
    );
});
