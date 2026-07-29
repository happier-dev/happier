import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import {
    DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
    type CodingPromptBehaviorV1,
    type CodingPromptSessionTitleUpdatesModeV1,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getPreferredLanguage, t } from '@/text';
import { useLocalSettingMutable, useSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import {
    normalizeSessionListAttentionPlacementMode,
    normalizeSessionListWorkingPlacementMode,
} from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import {
    normalizeSessionListFolderSortModeV1,
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListFolderSortMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

export default React.memo(function SessionSettingsScreen() {
    const { theme } = useUnistyles();
    const preferredLanguage = getPreferredLanguage();
    const router = useRouter();
    const popoverBoundaryRef = React.useRef<any>(null);
    const [codingPromptBehavior, setCodingPromptBehavior] = useSettingMutable('codingPromptBehaviorV1');
    const [rememberLastProjectSessionSelections, setRememberLastProjectSessionSelections] = useSettingMutable('rememberLastProjectSessionSelections');
    const [rememberLastEngineSelections, setRememberLastEngineSelections] = useSettingMutable('rememberLastEngineSelectionsV1');
    const [useEnhancedSessionWizard, setUseEnhancedSessionWizard] = useSettingMutable('useEnhancedSessionWizard');

    const [sessionTagsEnabled, setSessionTagsEnabled] = useSettingMutable('sessionTagsEnabled');

    // Session list settings (moved from Appearance)
    const deviceType = useDeviceType();
    const panelsSupported = Platform.OS === 'web' || deviceType === 'tablet';
    const [sessionListDensity, setSessionListDensity] = useSettingMutable('sessionListDensity');
    const [sessionListIdentityDisplay, setSessionListIdentityDisplay] = useSettingMutable('sessionListIdentityDisplay');
    const [sessionListActiveColorMode, setSessionListActiveColorMode] = useSettingMutable('sessionListActiveColorModeV1');
    const [sessionListAttentionPromotionMode, setSessionListAttentionPromotionMode] = useSettingMutable('sessionListAttentionPromotionModeV1');
    const [sessionListWorkingPlacementMode, setSessionListWorkingPlacementMode] = useSettingMutable('sessionListWorkingPlacementModeV1');
    const [sessionListOrderingModeV1, setSessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
    const [sessionListFolderSortModeV1, setSessionListFolderSortModeV1] = useSettingMutable('sessionListFolderSortModeV1');
    const [sessionListNarrowWorkingIndicatorStyle, setSessionListNarrowWorkingIndicatorStyle] = useSettingMutable('sessionListNarrowWorkingIndicatorStyle');
    const [sessionListWorkingStatusAnimatedTextEnabled, setSessionListWorkingStatusAnimatedTextEnabled] = useSettingMutable('sessionListWorkingStatusAnimatedTextEnabled');
    const [workspacePathDisplayModeV1, setWorkspacePathDisplayModeV1] = useSettingMutable('workspacePathDisplayModeV1');
    const [workspaceFaviconsEnabled, setWorkspaceFaviconsEnabled] = useSettingMutable('workspaceFaviconsEnabled');
    const [workspaceMachineSubtitlesEnabled, setWorkspaceMachineSubtitlesEnabled] = useSettingMutable('workspaceMachineSubtitlesEnabled');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [sessionListActiveGroupingV1, setSessionListActiveGroupingV1] = useSettingMutable('sessionListActiveGroupingV1');
    const [sessionListInactiveGroupingV1, setSessionListInactiveGroupingV1] = useSettingMutable('sessionListInactiveGroupingV1');
    const [sessionListSectionModeV1, setSessionListSectionModeV1] = useSettingMutable('sessionListSectionModeV1');
    const [mobileWorkspaceExperience, setMobileWorkspaceExperience] = useSettingMutable('mobileWorkspaceExperienceV1');
    const [sessionsRightPaneDefaultOpen, setSessionsRightPaneDefaultOpen] = useLocalSettingMutable('sessionsRightPaneDefaultOpen');
    const [uiMultiPanePanelsEnabled] = useLocalSettingMutable('uiMultiPanePanelsEnabled');

    const [openGroupingMenu, setOpenGroupingMenu] = React.useState<null | 'active' | 'inactive'>(null);
    const [openSessionListDensityMenu, setOpenSessionListDensityMenu] = React.useState(false);
    const [openSessionListIdentityDisplayMenu, setOpenSessionListIdentityDisplayMenu] = React.useState(false);
    const [openSessionListActiveColorModeMenu, setOpenSessionListActiveColorModeMenu] = React.useState(false);
    const [openSessionListAttentionPromotionModeMenu, setOpenSessionListAttentionPromotionModeMenu] = React.useState(false);
    const [openSessionListWorkingPlacementModeMenu, setOpenSessionListWorkingPlacementModeMenu] = React.useState(false);
    const [openSessionListOrderingModeMenu, setOpenSessionListOrderingModeMenu] = React.useState(false);
    const [openSessionListSectionModeMenu, setOpenSessionListSectionModeMenu] = React.useState(false);
    const [openSessionListFolderSortModeMenu, setOpenSessionListFolderSortModeMenu] = React.useState(false);
    const [openWorkspacePathDisplayMenu, setOpenWorkspacePathDisplayMenu] = React.useState(false);
    const [openWorkingIndicatorMenu, setOpenWorkingIndicatorMenu] = React.useState(false);
    const [openTitleUpdatesModeMenu, setOpenTitleUpdatesModeMenu] = React.useState(false);
    const rememberProjectSelectionsEnabled = rememberLastProjectSessionSelections !== false;
    const rememberEngineSelectionsEnabled = rememberLastEngineSelections !== false;
    const normalizedCodingPromptBehavior = React.useMemo<CodingPromptBehaviorV1>(() => {
        const raw = codingPromptBehavior && typeof codingPromptBehavior === 'object' && !Array.isArray(codingPromptBehavior)
            ? codingPromptBehavior as Partial<CodingPromptBehaviorV1>
            : {};
        return {
            ...DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
            ...(raw.sessionTitleUpdates === 'disabled' || raw.sessionTitleUpdates === 'initial' || raw.sessionTitleUpdates === 'ongoing'
                ? { sessionTitleUpdates: raw.sessionTitleUpdates }
                : {}),
            ...(raw.responseOptions === 'disabled' ? { responseOptions: 'disabled' as const } : {}),
        };
    }, [codingPromptBehavior]);
    const titleUpdatesModeItems = React.useMemo(() => [
        {
            id: 'disabled',
            title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsNeverTitle'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsNeverSubtitle'),
        },
        {
            id: 'initial',
            title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsInitialTitle'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSubtitle'),
        },
        {
            id: 'ongoing',
            title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingTitle'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSubtitle'),
        },
    ], [preferredLanguage]);
    const setSessionTitleUpdatesMode = React.useCallback(
        (mode: CodingPromptSessionTitleUpdatesModeV1) => {
            setCodingPromptBehavior({
                ...normalizedCodingPromptBehavior,
                sessionTitleUpdates: mode,
            } satisfies CodingPromptBehaviorV1);
        },
        [normalizedCodingPromptBehavior, setCodingPromptBehavior],
    );
    const handleSessionTitleUpdatesModeSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'disabled' && itemId !== 'initial' && itemId !== 'ongoing') return;
        setSessionTitleUpdatesMode(itemId);
    }, [setSessionTitleUpdatesMode]);
    const setCodingPromptResponseOptionsEnabled = React.useCallback(
        (enabled: boolean) => {
            setCodingPromptBehavior({
                ...normalizedCodingPromptBehavior,
                responseOptions: enabled ? 'agent' : 'disabled',
            } satisfies CodingPromptBehaviorV1);
        },
        [normalizedCodingPromptBehavior, setCodingPromptBehavior],
    );

    const groupingMenuItems = React.useMemo(() => [
        {
            id: 'project',
            title: t('settingsFeatures.sessionListGrouping.projectTitle'),
            subtitle: t('settingsFeatures.sessionListGrouping.projectSubtitle'),
        },
        {
            id: 'date',
            title: t('settingsFeatures.sessionListGrouping.dateTitle'),
            subtitle: t('settingsFeatures.sessionListGrouping.dateSubtitle'),
        },
    ], [preferredLanguage]);

    const selectGrouping = React.useCallback((itemId: string, section: 'active' | 'inactive') => {
        if (itemId !== 'project' && itemId !== 'date') return;
        if (section === 'active') {
            setSessionListActiveGroupingV1(itemId);
            return;
        }
        setSessionListInactiveGroupingV1(itemId);
    }, [setSessionListActiveGroupingV1, setSessionListInactiveGroupingV1]);

    const sessionListSectionModeItems = React.useMemo(() => [
        {
            id: 'activity',
            title: t('settingsSession.sessionList.sectionModeActivityTitle'),
            subtitle: t('settingsSession.sessionList.sectionModeActivitySubtitle'),
        },
        {
            id: 'single',
            title: t('settingsSession.sessionList.sectionModeSingleTitle'),
            subtitle: t('settingsSession.sessionList.sectionModeSingleSubtitle'),
        },
    ], [preferredLanguage]);

    const normalizedSessionListSectionMode = sessionListSectionModeV1 === 'single' ? 'single' : 'activity';
    const selectSessionListSectionMode = React.useCallback((itemId: string) => {
        if (itemId !== 'activity' && itemId !== 'single') return;
        setSessionListSectionModeV1(itemId);
    }, [setSessionListSectionModeV1]);

    const sessionListDensityItems = React.useMemo(() => [
        {
            id: 'detailed',
            title: t('settingsAppearance.sessionListDensity.detailed'),
            subtitle: t('settingsAppearance.sessionListDensity.detailedDescription'),
        },
        {
            id: 'cozy',
            title: t('settingsAppearance.sessionListDensity.cozy'),
            subtitle: t('settingsAppearance.sessionListDensity.cozyDescription'),
        },
        {
            id: 'narrow',
            title: t('settingsAppearance.sessionListDensity.narrow'),
            subtitle: t('settingsAppearance.sessionListDensity.narrowDescription'),
        },
    ], [preferredLanguage]);

    const handleSessionListDensitySelect = React.useCallback((itemId: string) => {
        if (itemId !== 'detailed' && itemId !== 'cozy' && itemId !== 'narrow') return;
        setSessionListDensity(itemId);
    }, [setSessionListDensity]);

    const sessionListIdentityDisplayItems = React.useMemo(() => [
        {
            id: 'avatar',
            title: t('settingsSession.sessionList.identityDisplayAvatarTitle'),
            subtitle: t('settingsSession.sessionList.identityDisplayAvatarSubtitle'),
        },
        {
            id: 'agentLogo',
            title: t('settingsSession.sessionList.identityDisplayAgentLogoTitle'),
            subtitle: t('settingsSession.sessionList.identityDisplayAgentLogoSubtitle'),
        },
        {
            id: 'none',
            title: t('settingsSession.sessionList.identityDisplayNoneTitle'),
            subtitle: t('settingsSession.sessionList.identityDisplayNoneSubtitle'),
        },
    ], [preferredLanguage]);

    const normalizedSessionListIdentityDisplay =
        sessionListIdentityDisplay === 'agentLogo' || sessionListIdentityDisplay === 'none'
            ? sessionListIdentityDisplay
            : 'avatar';
    const handleSessionListIdentityDisplaySelect = React.useCallback((itemId: string) => {
        if (itemId !== 'avatar' && itemId !== 'agentLogo' && itemId !== 'none') return;
        setSessionListIdentityDisplay(itemId);
    }, [setSessionListIdentityDisplay]);

    const sessionListActiveColorModeItems = React.useMemo(() => [
        {
            id: 'activityAndAttention',
            title: t('settingsSession.sessionList.activeColorActivityAndAttentionTitle'),
            subtitle: t('settingsSession.sessionList.activeColorActivityAndAttentionSubtitle'),
        },
        {
            id: 'attentionOnly',
            title: t('settingsSession.sessionList.activeColorAttentionOnlyTitle'),
            subtitle: t('settingsSession.sessionList.activeColorAttentionOnlySubtitle'),
        },
        {
            id: 'allActive',
            title: t('settingsSession.sessionList.activeColorAllActiveTitle'),
            subtitle: t('settingsSession.sessionList.activeColorAllActiveSubtitle'),
        },
    ], [preferredLanguage]);
    const normalizedSessionListActiveColorMode =
        sessionListActiveColorMode === 'attentionOnly' || sessionListActiveColorMode === 'allActive'
            ? sessionListActiveColorMode
            : 'activityAndAttention';
    const handleSessionListActiveColorModeSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'activityAndAttention' && itemId !== 'attentionOnly' && itemId !== 'allActive') return;
        setSessionListActiveColorMode(itemId);
    }, [setSessionListActiveColorMode]);

    const sessionListAttentionPromotionModeItems = React.useMemo(() => [
        {
            id: 'off',
            title: t('settingsSession.sessionList.attentionPromotionModeOffTitle'),
            subtitle: t('settingsSession.sessionList.attentionPromotionModeOffSubtitle'),
        },
        {
            id: 'global',
            title: t('settingsSession.sessionList.attentionPromotionModeGlobalTitle'),
            subtitle: t('settingsSession.sessionList.attentionPromotionModeGlobalSubtitle'),
        },
        {
            id: 'withinGroups',
            title: t('settingsSession.sessionList.attentionPromotionModeWithinGroupsTitle'),
            subtitle: t('settingsSession.sessionList.attentionPromotionModeWithinGroupsSubtitle'),
        },
    ], [preferredLanguage]);
    const normalizedSessionListAttentionPromotionMode = normalizeSessionListAttentionPlacementMode(sessionListAttentionPromotionMode);
    const handleSessionListAttentionPromotionModeSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'off' && itemId !== 'global' && itemId !== 'withinGroups') return;
        setSessionListAttentionPromotionMode(itemId);
    }, [setSessionListAttentionPromotionMode]);

    const sessionListWorkingPlacementModeItems = React.useMemo(() => [
        {
            id: 'off',
            title: t('settingsSession.sessionList.workingPlacementModeOffTitle'),
            subtitle: t('settingsSession.sessionList.workingPlacementModeOffSubtitle'),
        },
        {
            id: 'global',
            title: t('settingsSession.sessionList.workingPlacementModeGlobalTitle'),
            subtitle: t('settingsSession.sessionList.workingPlacementModeGlobalSubtitle'),
        },
        {
            id: 'withinGroups',
            title: t('settingsSession.sessionList.workingPlacementModeWithinGroupsTitle'),
            subtitle: t('settingsSession.sessionList.workingPlacementModeWithinGroupsSubtitle'),
        },
    ], [preferredLanguage]);
    const normalizedSessionListWorkingPlacementMode = normalizeSessionListWorkingPlacementMode(sessionListWorkingPlacementMode);
    const handleSessionListWorkingPlacementModeSelect = React.useCallback((itemId: string) => {
        const mode = normalizeSessionListWorkingPlacementMode(itemId);
        setSessionListWorkingPlacementMode(mode);
    }, [setSessionListWorkingPlacementMode]);

    const normalizedSessionListOrderingMode = normalizeSessionListOrderingModeV1(sessionListOrderingModeV1);
    const sessionListOrderingModeItems = React.useMemo(() => [
        {
            id: 'custom',
            title: t('settingsSession.sessionList.orderingOptions.custom'),
        },
        {
            id: 'created',
            title: t('settingsSession.sessionList.orderingOptions.created'),
        },
        {
            id: 'updated',
            title: t('settingsSession.sessionList.orderingOptions.updated'),
        },
    ], [preferredLanguage]);

    const handleSessionListOrderingModeSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'custom' && itemId !== 'created' && itemId !== 'updated') return;
        setSessionListOrderingModeV1(itemId);
    }, [setSessionListOrderingModeV1]);

    const normalizedSessionListFolderSortMode = normalizeSessionListFolderSortModeV1(sessionListFolderSortModeV1);
    const effectiveSessionListFolderSortMode = resolveEffectiveSessionListFolderSortMode({
        orderingMode: normalizedSessionListOrderingMode,
        folderSortMode: normalizedSessionListFolderSortMode,
    });
    const isDateSessionListOrderingMode = normalizedSessionListOrderingMode !== 'custom';
    const sessionListFolderSortModeItems = React.useMemo(() => [
        {
            id: 'foldersFirst',
            title: t('settingsSession.sessionList.folderSortModeFoldersFirstTitle'),
            subtitle: t('settingsSession.sessionList.folderSortModeFoldersFirstSubtitle'),
        },
        {
            id: 'mixed',
            title: t('settingsSession.sessionList.folderSortModeMixedTitle'),
            subtitle: isDateSessionListOrderingMode
                ? t('settingsSession.sessionList.folderSortModeMixedDisabledInDateModeSubtitle')
                : t('settingsSession.sessionList.folderSortModeMixedSubtitle'),
            disabled: isDateSessionListOrderingMode,
        },
    ], [isDateSessionListOrderingMode, preferredLanguage]);

    const handleSessionListFolderSortModeSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'foldersFirst' && itemId !== 'mixed') return;
        if (itemId === 'mixed' && normalizedSessionListOrderingMode !== 'custom') return;
        setSessionListFolderSortModeV1(itemId);
    }, [normalizedSessionListOrderingMode, setSessionListFolderSortModeV1]);

    const workspacePathDisplayMode = workspacePathDisplayModeV1 === 'path' ? 'path' : 'name';
    const workspacePathDisplayItems = React.useMemo(() => [
        {
            id: 'name',
            title: t('settingsSession.sessionList.workspacePathDisplayName'),
            subtitle: t('settingsSession.sessionList.workspacePathDisplayNameDescription'),
        },
        {
            id: 'path',
            title: t('settingsSession.sessionList.workspacePathDisplayPath'),
            subtitle: t('settingsSession.sessionList.workspacePathDisplayPathDescription'),
        },
    ], [preferredLanguage]);

    const handleWorkspacePathDisplaySelect = React.useCallback((itemId: string) => {
        if (itemId !== 'name' && itemId !== 'path') return;
        setWorkspacePathDisplayModeV1(itemId);
    }, [setWorkspacePathDisplayModeV1]);

    const workingIndicatorStyle = sessionListNarrowWorkingIndicatorStyle === 'pulse' ? 'pulse' : 'spinner';
    const workingIndicatorItems = React.useMemo(() => [
        {
            id: 'spinner',
            title: t('settingsSession.sessionList.workingIndicatorSpinnerTitle'),
            subtitle: t('settingsSession.sessionList.workingIndicatorSpinnerSubtitle'),
        },
        {
            id: 'pulse',
            title: t('settingsSession.sessionList.workingIndicatorPulseTitle'),
            subtitle: t('settingsSession.sessionList.workingIndicatorPulseSubtitle'),
        },
    ], [preferredLanguage]);

    const handleWorkingIndicatorSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'spinner' && itemId !== 'pulse') return;
        setSessionListNarrowWorkingIndicatorStyle(itemId);
    }, [setSessionListNarrowWorkingIndicatorStyle]);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.detailedBehavior.title')}
                footer={t('settingsSession.detailedBehavior.footer')}
            >
                <Item
                    title={t('settingsSession.composer.title')}
                    subtitle={t('settingsSession.composer.entrySubtitle')}
                    icon={<Ionicons name="send-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/(app)/settings/session/composer')}
                />
                <Item
                    title={t('settingsSession.providerLimits.title')}
                    subtitle={t('settingsSession.providerLimits.entrySubtitle')}
                    icon={<Ionicons name="speedometer-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push('/(app)/settings/session/provider-limits')}
                />
                <Item
                    title={t('settingsSession.resume.title')}
                    subtitle={t('settingsSession.resume.entrySubtitle')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/(app)/settings/session/resume')}
                />
                <Item
                    title={t('settingsSession.runtime.title')}
                    subtitle={t('settingsSession.runtime.entrySubtitle')}
                    icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push('/(app)/settings/session/runtime')}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.launchDefaults.title')}
                footer={t('settingsSession.rootGroups.launchDefaults.footer')}
            >
                <Item
                    testID="settings-new-session-wizard-mode"
                    title={t('settingsSession.sessionCreation.wizardModeTitle')}
                    subtitle={t(
                        useEnhancedSessionWizard
                            ? 'settingsSession.sessionCreation.wizardModeEnabledSubtitle'
                            : 'settingsSession.sessionCreation.wizardModeDisabledSubtitle',
                    )}
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.purple} />}
                    rightElement={
                        <Switch
                            value={Boolean(useEnhancedSessionWizard)}
                            onValueChange={(next) => setUseEnhancedSessionWizard(Boolean(next))}
                        />
                    }
                    showChevron={false}
                    onPress={() => setUseEnhancedSessionWizard(!useEnhancedSessionWizard)}
                />
                {useEnhancedSessionWizard ? (
                    <Item
                        title={t('settingsSession.sessionCreation.wizardDispositionTitle')}
                        subtitle={t('settingsSession.sessionCreation.wizardDispositionSubtitle')}
                        icon={<Ionicons name="grid-outline" size={29} color={theme.colors.accent.indigo} />}
                        onPress={() => router.push('/settings/session/new-session-wizard')}
                    />
                ) : null}
                <Item
                    title={t('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle')}
                    subtitle={t(
                        rememberProjectSelectionsEnabled
                            ? 'settingsSession.sessionCreation.rememberLastProjectSelectionsEnabledSubtitle'
                            : 'settingsSession.sessionCreation.rememberLastProjectSelectionsDisabledSubtitle',
                    )}
                    icon={<Ionicons name="copy-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={rememberProjectSelectionsEnabled}
                            onValueChange={(next) => setRememberLastProjectSessionSelections(Boolean(next) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setRememberLastProjectSessionSelections((!rememberProjectSelectionsEnabled) as any)}
                />
                <Item
                    title={t('settingsSession.sessionCreation.rememberLastEngineSelectionsTitle')}
                    subtitle={t(
                        rememberEngineSelectionsEnabled
                            ? 'settingsSession.sessionCreation.rememberLastEngineSelectionsEnabledSubtitle'
                            : 'settingsSession.sessionCreation.rememberLastEngineSelectionsDisabledSubtitle',
                    )}
                    icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={rememberEngineSelectionsEnabled}
                            onValueChange={(next) => setRememberLastEngineSelections(Boolean(next) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setRememberLastEngineSelections((!rememberEngineSelectionsEnabled) as any)}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.listOrganization.title')}
                footer={t('settingsSession.rootGroups.listOrganization.footer')}
            >
                <DropdownMenu
                    open={openSessionListDensityMenu}
                    onOpenChange={setOpenSessionListDensityMenu}
                    variant="selectable"
                    search={false}
                    selectedId={sessionListDensity}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsAppearance.sessionListDensity.title'),
                        subtitle: t('settingsAppearance.sessionListDensity.subtitle'),
                        icon: <Ionicons name="albums-outline" size={29} color={theme.colors.accent.indigo} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-sessionListDensity-trigger' },
                    }}
                    items={sessionListDensityItems}
                    onSelect={handleSessionListDensitySelect}
                />
                <DropdownMenu
                    open={openSessionListOrderingModeMenu}
                    onOpenChange={setOpenSessionListOrderingModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedSessionListOrderingMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.orderingTitle'),
                        subtitle: t('settingsSession.sessionList.orderingSubtitle'),
                        icon: <Ionicons name="swap-vertical-outline" size={29} color={theme.colors.accent.indigo} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-sessionListOrderingMode-trigger' },
                    }}
                    items={sessionListOrderingModeItems}
                    onSelect={handleSessionListOrderingModeSelect}
                />
                <DropdownMenu
                    open={openSessionListFolderSortModeMenu}
                    onOpenChange={setOpenSessionListFolderSortModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={effectiveSessionListFolderSortMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.folderSortModeTitle'),
                        subtitle: t('settingsSession.sessionList.folderSortModeSubtitle'),
                        icon: <Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.indigo} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-sessionListFolderSortMode-trigger' },
                    }}
                    items={sessionListFolderSortModeItems}
                    onSelect={handleSessionListFolderSortModeSelect}
                />
                <DropdownMenu
                    open={openSessionListSectionModeMenu}
                    onOpenChange={setOpenSessionListSectionModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedSessionListSectionMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.sectionModeTitle'),
                        subtitle: t('settingsSession.sessionList.sectionModeSubtitle'),
                        icon: <Ionicons name="albums-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-sessionListSectionMode-trigger' },
                    }}
                    items={sessionListSectionModeItems}
                    onSelect={selectSessionListSectionMode}
                />
                <DropdownMenu
                    open={openGroupingMenu === 'active'}
                    onOpenChange={(next) => setOpenGroupingMenu(next ? 'active' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={sessionListActiveGroupingV1 as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsFeatures.sessionListActiveGrouping'),
                        subtitle: t('settingsFeatures.sessionListActiveGroupingSubtitle'),
                        icon: <Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                    }}
                    items={groupingMenuItems}
                    onSelect={(itemId) => selectGrouping(itemId, 'active')}
                />
                <DropdownMenu
                    open={openGroupingMenu === 'inactive'}
                    onOpenChange={(next) => setOpenGroupingMenu(next ? 'inactive' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={sessionListInactiveGroupingV1 as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsFeatures.sessionListInactiveGrouping'),
                        subtitle: t('settingsFeatures.sessionListInactiveGroupingSubtitle'),
                        icon: <Ionicons name="calendar-outline" size={29} color={theme.colors.state.success.foreground} />,
                        showSelectedSubtitle: false,
                    }}
                    items={groupingMenuItems}
                    onSelect={(itemId) => selectGrouping(itemId, 'inactive')}
                />
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color={theme.colors.accent.orange} />}
                    rightElement={<Switch value={hideInactiveSessions} onValueChange={setHideInactiveSessions} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsAppearance.sessionsRightPaneDefaultOpen')}
                    subtitle={t('settingsAppearance.sessionsRightPaneDefaultOpenDescription')}
                    icon={<Ionicons name="documents-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={sessionsRightPaneDefaultOpen}
                            onValueChange={setSessionsRightPaneDefaultOpen}
                            disabled={!panelsSupported || !uiMultiPanePanelsEnabled}
                        />
                    }
                    disabled={!panelsSupported || !uiMultiPanePanelsEnabled}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.rowDetails.title')}
                footer={t('settingsSession.rootGroups.rowDetails.footer')}
            >
                <Item
                    title={t('settingsSession.sessionList.tagsTitle')}
                    subtitle={sessionTagsEnabled ? t('settingsSession.sessionList.tagsEnabledSubtitle') : t('settingsSession.sessionList.tagsDisabledSubtitle')}
                    icon={<Ionicons name="pricetag-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={<Switch value={Boolean(sessionTagsEnabled)} onValueChange={setSessionTagsEnabled} />}
                    showChevron={false}
                    onPress={() => setSessionTagsEnabled(!sessionTagsEnabled)}
                />
                <DropdownMenu
                    open={openSessionListIdentityDisplayMenu}
                    onOpenChange={setOpenSessionListIdentityDisplayMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedSessionListIdentityDisplay}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.identityDisplayTitle'),
                        subtitle: t('settingsSession.sessionList.identityDisplaySubtitle'),
                        icon: <Ionicons name="person-circle-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-sessionListIdentityDisplay-trigger' },
                    }}
                    items={sessionListIdentityDisplayItems}
                    onSelect={handleSessionListIdentityDisplaySelect}
                />
                <DropdownMenu
                    open={openSessionListActiveColorModeMenu}
                    onOpenChange={setOpenSessionListActiveColorModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedSessionListActiveColorMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.activeColorTitle'),
                        subtitle: t('settingsSession.sessionList.activeColorSubtitle'),
                        icon: <Ionicons name="color-palette-outline" size={29} color={theme.colors.accent.purple} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-sessionListActiveColorMode-trigger' },
                    }}
                    items={sessionListActiveColorModeItems}
                    onSelect={handleSessionListActiveColorModeSelect}
                />
                <DropdownMenu
                    open={openWorkspacePathDisplayMenu}
                    onOpenChange={setOpenWorkspacePathDisplayMenu}
                    variant="selectable"
                    search={false}
                    selectedId={workspacePathDisplayMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.workspacePathDisplayTitle'),
                        subtitle: workspacePathDisplayMode === 'path'
                            ? t('settingsSession.sessionList.workspacePathDisplayPathSelectedSubtitle')
                            : t('settingsSession.sessionList.workspacePathDisplayNameSelectedSubtitle'),
                        icon: <Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-workspacePathDisplay-trigger' },
                    }}
                    items={workspacePathDisplayItems}
                    onSelect={handleWorkspacePathDisplaySelect}
                />
                <Item
                    testID="settings-session-workspaceFavicons-item"
                    title={t('settingsSession.sessionList.workspaceFaviconsTitle')}
                    subtitle={workspaceFaviconsEnabled !== false
                        ? t('settingsSession.sessionList.workspaceFaviconsEnabledSubtitle')
                        : t('settingsSession.sessionList.workspaceFaviconsDisabledSubtitle')}
                    icon={<Ionicons name="image-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            testID="settings-session-workspaceFavicons-toggle"
                            value={workspaceFaviconsEnabled !== false}
                            onValueChange={(next) => setWorkspaceFaviconsEnabled(Boolean(next))}
                        />
                    }
                    showChevron={false}
                    onPress={() => setWorkspaceFaviconsEnabled(workspaceFaviconsEnabled === false)}
                />
                <Item
                    testID="settings-session-workspaceMachineSubtitles-item"
                    title={t('settingsSession.sessionList.workspaceMachineSubtitlesTitle')}
                    subtitle={workspaceMachineSubtitlesEnabled !== false
                        ? t('settingsSession.sessionList.workspaceMachineSubtitlesEnabledSubtitle')
                        : t('settingsSession.sessionList.workspaceMachineSubtitlesDisabledSubtitle')}
                    icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            testID="settings-session-workspaceMachineSubtitles-toggle"
                            value={workspaceMachineSubtitlesEnabled !== false}
                            onValueChange={(next) => setWorkspaceMachineSubtitlesEnabled(Boolean(next))}
                        />
                    }
                    showChevron={false}
                    onPress={() => setWorkspaceMachineSubtitlesEnabled(workspaceMachineSubtitlesEnabled === false)}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.activitySignals.title')}
                footer={t('settingsSession.rootGroups.activitySignals.footer')}
            >
                <Item
                    testID="settings-session-workingStatusAnimatedText-item"
                    title={t('settingsSession.sessionList.workingStatusAnimatedTextTitle')}
                    subtitle={sessionListWorkingStatusAnimatedTextEnabled !== false
                        ? t('settingsSession.sessionList.workingStatusAnimatedTextEnabledSubtitle')
                        : t('settingsSession.sessionList.workingStatusAnimatedTextDisabledSubtitle')}
                    icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            testID="settings-session-workingStatusAnimatedText-toggle"
                            value={sessionListWorkingStatusAnimatedTextEnabled !== false}
                            onValueChange={(next) => setSessionListWorkingStatusAnimatedTextEnabled(Boolean(next))}
                        />
                    }
                    showChevron={false}
                    onPress={() => setSessionListWorkingStatusAnimatedTextEnabled(sessionListWorkingStatusAnimatedTextEnabled === false)}
                />
                <DropdownMenu
                    open={openSessionListAttentionPromotionModeMenu}
                    onOpenChange={setOpenSessionListAttentionPromotionModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedSessionListAttentionPromotionMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.attentionPromotionModeTitle'),
                        subtitle: t('settingsSession.sessionList.attentionPromotionModeSubtitle'),
                        icon: <Ionicons name="alert-circle-outline" size={29} color={theme.colors.state.warning.foreground} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-attentionPromotionMode-trigger' },
                    }}
                    items={sessionListAttentionPromotionModeItems}
                    onSelect={handleSessionListAttentionPromotionModeSelect}
                />
                <DropdownMenu
                    open={openSessionListWorkingPlacementModeMenu}
                    onOpenChange={setOpenSessionListWorkingPlacementModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedSessionListWorkingPlacementMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.workingPlacementModeTitle'),
                        subtitle: t('settingsSession.sessionList.workingPlacementModeSubtitle'),
                        icon: <Ionicons name="play-circle-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-workingPlacementMode-trigger' },
                    }}
                    items={sessionListWorkingPlacementModeItems}
                    onSelect={handleSessionListWorkingPlacementModeSelect}
                />
                <DropdownMenu
                    open={openWorkingIndicatorMenu}
                    onOpenChange={setOpenWorkingIndicatorMenu}
                    variant="selectable"
                    search={false}
                    selectedId={workingIndicatorStyle}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.sessionList.workingIndicatorTitle'),
                        subtitle: workingIndicatorStyle === 'pulse'
                            ? t('settingsSession.sessionList.workingIndicatorPulseSelectedSubtitle')
                            : t('settingsSession.sessionList.workingIndicatorSpinnerSelectedSubtitle'),
                        icon: <Ionicons name={workingIndicatorStyle === 'pulse' ? 'radio-button-on-outline' : 'sync-outline'} size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-workingIndicator-trigger' },
                    }}
                    items={workingIndicatorItems}
                    onSelect={handleWorkingIndicatorSelect}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.mobileLayout.title')}
                footer={t('settingsSession.rootGroups.mobileLayout.footer')}
            >
                <Item
                    title={t('settingsSession.mobileWorkspaceExperience.title')}
                    subtitle={mobileWorkspaceExperience === 'classic'
                        ? t('settingsSession.mobileWorkspaceExperience.options.classicSubtitle')
                        : t('settingsSession.mobileWorkspaceExperience.options.cockpitSubtitle')}
                    icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            testID="settings-session-mobileWorkspaceExperience-switch"
                            value={mobileWorkspaceExperience !== 'classic'}
                            onValueChange={(enabled) => setMobileWorkspaceExperience(enabled ? 'cockpit' : 'classic')}
                        />
                    }
                    showChevron={false}
                    onPress={() => setMobileWorkspaceExperience(mobileWorkspaceExperience === 'classic' ? 'cockpit' : 'classic')}
                    testID="settings-session-mobileWorkspaceExperience-trigger"
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.agentPersonalization.title')}
                footer={t('settingsSession.rootGroups.agentPersonalization.footer')}
            >
                <DropdownMenu
                    open={openTitleUpdatesModeMenu}
                    onOpenChange={setOpenTitleUpdatesModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedCodingPromptBehavior.sessionTitleUpdates}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle'),
                        subtitle: t(
                            normalizedCodingPromptBehavior.sessionTitleUpdates === 'disabled'
                                ? 'settingsSession.promptPersonalization.askAgentToRenameSessionsDisabledSubtitle'
                                : normalizedCodingPromptBehavior.sessionTitleUpdates === 'initial'
                                    ? 'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSelectedSubtitle'
                                    : 'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSelectedSubtitle',
                        ),
                        icon: <Ionicons name="text-outline" size={29} color={theme.colors.accent.indigo} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-session-title-updates-mode-trigger' },
                    }}
                    items={titleUpdatesModeItems}
                    onSelect={handleSessionTitleUpdatesModeSelect}
                />
                <Item
                    title={t('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle')}
                    subtitle={t(
                        normalizedCodingPromptBehavior.responseOptions === 'agent'
                            ? 'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsEnabledSubtitle'
                            : 'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsDisabledSubtitle',
                    )}
                    icon={<Ionicons name="list-circle-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={normalizedCodingPromptBehavior.responseOptions === 'agent'}
                            onValueChange={(next) => setCodingPromptResponseOptionsEnabled(Boolean(next))}
                        />
                    }
                    showChevron={false}
                    onPress={() => setCodingPromptResponseOptionsEnabled(normalizedCodingPromptBehavior.responseOptions !== 'agent')}
                />
            </ItemGroup>

        </ItemList>
    );
});
