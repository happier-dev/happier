import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SessionListDensityPreview, SessionListLayoutPreview } from '@/components/settings/session/SessionListPreview';
import React from 'react';
import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
    type CodingPromptBehaviorV1,
    type CodingPromptSessionTitleUpdatesModeV1,
} from '@happier-dev/protocol/prompts/codingPromptBehaviorV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getPreferredLanguage, t } from '@/text';
import { useLocalSettingMutable, useSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SessionGestureSettingsRows } from '@/components/settings/session/SessionGestureSettingsRows';
import {
    resolveSessionListViewOptionSelectionDelta,
    resolveSessionListViewOptionsPresentation,
} from '@/components/sessions/shell/sessionListViewOptionsPresentation';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionListLayoutChoice } from '@/hooks/session/sessionListLayoutIntent';
import { Icon } from '@/components/ui/icons/Icon';

export const WorkspaceRouteBody = React.memo(function SessionSettingsScreen() {
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
    const [sessionHeaderIdentityDisplay, setSessionHeaderIdentityDisplay] = useSettingMutable('sessionHeaderIdentityDisplay');
    const [sessionListActiveColorMode, setSessionListActiveColorMode] = useSettingMutable('sessionListActiveColorModeV1');
    const [sessionListAttentionPromotionMode] = useSettingMutable('sessionListAttentionPromotionModeV1');
    const [sessionReminderAutoClearOnOpen, setSessionReminderAutoClearOnOpen] = useSettingMutable('sessionReminderAutoClearOnOpen');
    const [sessionListAttentionStandingDefault, setSessionListAttentionStandingDefault] = useSettingMutable('sessionListAttentionStandingDefaultV1');
    const [sessionListWorkingPlacementMode] = useSettingMutable('sessionListWorkingPlacementModeV1');
    const [sessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
    const [sessionListFolderSortModeV1] = useSettingMutable('sessionListFolderSortModeV1');
    const [sessionFolderViewModeV1] = useSettingMutable('sessionFolderViewModeV1');
    const [sessionListNarrowWorkingIndicatorStyle, setSessionListNarrowWorkingIndicatorStyle] = useSettingMutable('sessionListNarrowWorkingIndicatorStyle');
    const [sessionListWorkingStatusAnimatedTextEnabled, setSessionListWorkingStatusAnimatedTextEnabled] = useSettingMutable('sessionListWorkingStatusAnimatedTextEnabled');
    const [workspacePathDisplayModeV1, setWorkspacePathDisplayModeV1] = useSettingMutable('workspacePathDisplayModeV1');
    const [workspaceFaviconsEnabled, setWorkspaceFaviconsEnabled] = useSettingMutable('workspaceFaviconsEnabled');
    const [workspaceMachineSubtitlesEnabled, setWorkspaceMachineSubtitlesEnabled] = useSettingMutable('workspaceMachineSubtitlesEnabled');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [sessionListActiveGroupingV1] = useSettingMutable('sessionListActiveGroupingV1');
    const [sessionListInactiveGroupingV1] = useSettingMutable('sessionListInactiveGroupingV1');
    const [sessionListSectionModeV1] = useSettingMutable('sessionListSectionModeV1');
    const applySettings = useApplySettings();
    // Account settings intentionally describe the currently selected Home set;
    // exact Session/Team/list-row surfaces scope their own admission separately.
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders', { scopeKind: 'main_selection' });
    const [mobileWorkspaceExperience, setMobileWorkspaceExperience] = useSettingMutable('mobileWorkspaceExperienceV1');
    const [workspaceTabsSyncEnabled, setWorkspaceTabsSyncEnabled] = useSettingMutable('workspaceTabsSyncEnabled');
    const [sessionsRightPaneDefaultOpen, setSessionsRightPaneDefaultOpen] = useLocalSettingMutable('sessionsRightPaneDefaultOpen');
    const [uiMultiPanePanelsEnabled] = useLocalSettingMutable('uiMultiPanePanelsEnabled');

    const [openGroupingMenu, setOpenGroupingMenu] = React.useState<null | 'active' | 'inactive'>(null);
    const [openSessionListIdentityDisplayMenu, setOpenSessionListIdentityDisplayMenu] = React.useState(false);
    const [openSessionHeaderIdentityDisplayMenu, setOpenSessionHeaderIdentityDisplayMenu] = React.useState(false);
    const [openSessionListActiveColorModeMenu, setOpenSessionListActiveColorModeMenu] = React.useState(false);
    const [openSessionListAttentionPromotionModeMenu, setOpenSessionListAttentionPromotionModeMenu] = React.useState(false);
    const [openSessionListWorkingPlacementModeMenu, setOpenSessionListWorkingPlacementModeMenu] = React.useState(false);
    const [openSessionListOrderingModeMenu, setOpenSessionListOrderingModeMenu] = React.useState(false);
    const [openSessionFolderDisplayMenu, setOpenSessionFolderDisplayMenu] = React.useState(false);
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

    // Settings hosts no list, so this resolves to the stored preference; it still
    // goes through the one effective-layout reader rather than re-deriving it.
    const sessionListLayoutChoice = useSessionListLayoutChoice();
    const sessionListViewOptions = resolveSessionListViewOptionsPresentation({
        sessionListSectionModeV1,
        sessionListActiveGroupingV1,
        sessionListInactiveGroupingV1,
        sessionListOrderingModeV1,
        sessionListAttentionPromotionModeV1: sessionListAttentionPromotionMode,
        sessionListWorkingPlacementModeV1: sessionListWorkingPlacementMode,
        sessionFolderViewModeV1,
        sessionListFolderSortModeV1,
        foldersFeatureEnabled: sessionFoldersFeatureEnabled,
    }, sessionListLayoutChoice);
    const applySessionListViewOption = React.useCallback((itemId: string) => {
        const delta = resolveSessionListViewOptionSelectionDelta(itemId, {
            sessionListSectionModeV1,
            sessionListActiveGroupingV1,
            sessionListInactiveGroupingV1,
            sessionListOrderingModeV1,
        });
        if (delta) applySettings(delta);
    }, [
        applySettings,
        sessionListActiveGroupingV1,
        sessionListInactiveGroupingV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
    ]);
    const sessionListDensityItems = React.useMemo(() => [
        {
            id: 'detailed' as const,
            title: t('settingsAppearance.sessionListDensity.detailed'),
            subtitle: t('settingsAppearance.sessionListDensity.detailedDescription'),
        },
        {
            id: 'cozy' as const,
            title: t('settingsAppearance.sessionListDensity.cozy'),
            subtitle: t('settingsAppearance.sessionListDensity.cozyDescription'),
        },
        {
            id: 'narrow' as const,
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
    const sessionHeaderIdentityDisplayItems = React.useMemo(() => [
        {
            id: 'avatar',
            title: t('settingsSession.sessionList.headerIdentityDisplayAvatarTitle'),
            subtitle: t('settingsSession.sessionList.headerIdentityDisplayAvatarSubtitle'),
        },
        {
            id: 'agentLogo',
            title: t('settingsSession.sessionList.headerIdentityDisplayAgentLogoTitle'),
            subtitle: t('settingsSession.sessionList.headerIdentityDisplayAgentLogoSubtitle'),
        },
        {
            id: 'none',
            title: t('settingsSession.sessionList.headerIdentityDisplayNoneTitle'),
            subtitle: t('settingsSession.sessionList.headerIdentityDisplayNoneSubtitle'),
        },
    ], []);

    const normalizedSessionHeaderIdentityDisplay =
        sessionHeaderIdentityDisplay === 'agentLogo' || sessionHeaderIdentityDisplay === 'none'
            ? sessionHeaderIdentityDisplay
            : 'avatar';
    const handleSessionHeaderIdentityDisplaySelect = React.useCallback((itemId: string) => {
        if (itemId !== 'avatar' && itemId !== 'agentLogo' && itemId !== 'none') return;
        setSessionHeaderIdentityDisplay(itemId);
    }, [setSessionHeaderIdentityDisplay]);

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

    const sessionListAttentionPromotionModeItems = sessionListViewOptions.attentionItems;
    const normalizedSessionListAttentionPromotionMode = sessionListViewOptions.selectedAttentionPlacement;
    // Standing only reaches the list through the attention placement lane, so with
    // "Sessions needing attention" left in normal position this switch would change
    // nothing. Lock it and name the prerequisite instead of letting it lie.
    const sessionListAttentionStandingUnavailable = normalizedSessionListAttentionPromotionMode === 'off';
    const handleSessionListAttentionPromotionModeSelect = React.useCallback((itemId: string) => {
        applySessionListViewOption(itemId);
    }, [applySessionListViewOption]);

    const sessionListWorkingPlacementModeItems = sessionListViewOptions.workingItems;
    const normalizedSessionListWorkingPlacementMode = sessionListViewOptions.selectedWorkingPlacement;
    const handleSessionListWorkingPlacementModeSelect = React.useCallback((itemId: string) => {
        applySessionListViewOption(itemId);
    }, [applySessionListViewOption]);

    const normalizedSessionListOrderingMode = sessionListViewOptions.selectedOrdering;
    const sessionListOrderingModeItems = sessionListViewOptions.orderingItems;

    const handleSessionListOrderingModeSelect = React.useCallback((itemId: string) => {
        applySessionListViewOption(itemId);
    }, [applySessionListViewOption]);

    const effectiveSessionListFolderSortMode = sessionListViewOptions.selectedFolderSort;
    const sessionListFolderSortModeItems = sessionListViewOptions.folderSortItems;

    const handleSessionListFolderSortModeSelect = React.useCallback((itemId: string) => {
        applySessionListViewOption(itemId);
    }, [applySessionListViewOption]);

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
            <SettingsPageHeader description={t('settingsSession.pageDescription')} />
            <SettingSection section={SESSION_SETTINGS.sectionRefs.launchDefaults}>
                <ItemGroup
                    title={t('settingsSession.rootGroups.launchDefaults.title')}
                    description={t('settingsSession.rootGroups.launchDefaults.footer')}
                >
                    <SettingAnchor setting={SESSION_SETTINGS.settings.startWith}>
                        <SegmentedChoiceItem<'composer' | 'wizard'>
                            testID="settings-new-session-wizard-mode"
                            testIDPrefix="settings-session-startWith"
                            title={t(SESSION_SETTINGS.settings.startWith.titleKey)}
                            subtitle={t('settingsSession.sessionCreation.startWithDescription')}
                            subtitleLines={0}
                            options={[
                                { id: 'composer', label: t('settingsSession.sessionCreation.startWithComposer') },
                                { id: 'wizard', label: t('settingsSession.sessionCreation.startWithWizard') },
                            ]}
                            value={useEnhancedSessionWizard ? 'wizard' : 'composer'}
                            onChange={(next) => setUseEnhancedSessionWizard(next === 'wizard')}
                        />
                    </SettingAnchor>
                    {useEnhancedSessionWizard ? (
                        <SettingAnchor setting={SESSION_SETTINGS.settings.wizardDisposition}>
                            <Item
                                title={t(SESSION_SETTINGS.settings.wizardDisposition.titleKey)}
                                icon={<Icon name="grid-four" />}
                                subtitle={t('settingsSession.sessionCreation.wizardDispositionSubtitle')}
                                onPress={() => router.push('/settings/session/new-session-wizard')}
                            />
                        </SettingAnchor>
                    ) : null}
                    <SettingAnchor setting={SESSION_SETTINGS.settings.rememberProjectSelections}>
                        <Item
                            title={t(SESSION_SETTINGS.settings.rememberProjectSelections.titleKey)}
                            subtitle={t(
                                rememberProjectSelectionsEnabled
                                    ? 'settingsSession.sessionCreation.rememberLastProjectSelectionsEnabledSubtitle'
                                    : 'settingsSession.sessionCreation.rememberLastProjectSelectionsDisabledSubtitle',
                            )}
                            rightElement={
                                <Switch
                                    value={rememberProjectSelectionsEnabled}
                                    onValueChange={(next) => setRememberLastProjectSessionSelections(Boolean(next) as any)}
                                />
                            }
                            showChevron={false}
                            onPress={() => setRememberLastProjectSessionSelections((!rememberProjectSelectionsEnabled) as any)}
                        />
                    </SettingAnchor>
                    <SettingAnchor setting={SESSION_SETTINGS.settings.rememberEngineSelections}>
                        <Item
                            title={t(SESSION_SETTINGS.settings.rememberEngineSelections.titleKey)}
                            subtitle={t(
                                rememberEngineSelectionsEnabled
                                    ? 'settingsSession.sessionCreation.rememberLastEngineSelectionsEnabledSubtitle'
                                    : 'settingsSession.sessionCreation.rememberLastEngineSelectionsDisabledSubtitle',
                            )}
                            rightElement={
                                <Switch
                                    value={rememberEngineSelectionsEnabled}
                                    onValueChange={(next) => setRememberLastEngineSelections(Boolean(next) as any)}
                                />
                            }
                            showChevron={false}
                            onPress={() => setRememberLastEngineSelections((!rememberEngineSelectionsEnabled) as any)}
                        />
                    </SettingAnchor>
                </ItemGroup>
            </SettingSection>

            <SettingSection section={SESSION_SETTINGS.sectionRefs.listOrganization}>
                <ItemGroup
                    title={t('settingsSession.rootGroups.listOrganization.title')}
                    description={t('settingsSession.rootGroups.listOrganization.footer')}
                >
                    <SettingAnchor setting={SESSION_SETTINGS.settings.listDensity}>
                        <Item
                            testID="settings-session-sessionListDensity"
                            title={t(SESSION_SETTINGS.settings.listDensity.titleKey)}
                            subtitle={t('settingsAppearance.sessionListDensity.subtitle')}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={
                                <SelectionTiles
                                    variant="visual"
                                    accessibilityLabel={t('settingsAppearance.sessionListDensity.title')}
                                    testIdPrefix="settings-session-sessionListDensity"
                                    value={sessionListDensity}
                                    onChange={(next) => { if (next) handleSessionListDensitySelect(next); }}
                                    options={sessionListDensityItems.map((item) => ({
                                        id: item.id,
                                        title: item.title,
                                        preview: <SessionListDensityPreview density={item.id} />,
                                    }))}
                                />
                            }
                        />
                    </SettingAnchor>
                    {sessionListViewOptions.showProjectOrdering ? (
                        <SettingAnchor setting={SESSION_SETTINGS.settings.ordering}>
                            <DropdownMenu
                                open={openSessionListOrderingModeMenu}
                                onOpenChange={setOpenSessionListOrderingModeMenu}
                                variant="selectable"
                                search={false}
                                selectedId={`ordering:${normalizedSessionListOrderingMode}`}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: t(SESSION_SETTINGS.settings.ordering.titleKey),
                                    subtitle: t('settingsSession.sessionList.orderingSubtitle'),
                                    showSelectedSubtitle: false,
                                    itemProps: { testID: 'settings-session-sessionListOrderingMode-trigger' },
                                }}
                                items={sessionListOrderingModeItems}
                                onSelect={handleSessionListOrderingModeSelect}
                            />
                        </SettingAnchor>
                    ) : null}
                    {sessionListViewOptions.showFolderOptions ? (
                        <SettingAnchor setting={SESSION_SETTINGS.settings.folderView}>
                            <DropdownMenu
                                open={openSessionFolderDisplayMenu}
                                onOpenChange={setOpenSessionFolderDisplayMenu}
                                variant="selectable"
                                search={false}
                                selectedId={`folderDisplay:${sessionListViewOptions.selectedFolderDisplay}`}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: t(SESSION_SETTINGS.settings.folderView.titleKey),
                                    showSelectedSubtitle: false,
                                    itemProps: { testID: 'settings-session-sessionFolderViewMode-trigger' },
                                }}
                                items={sessionListViewOptions.folderDisplayItems}
                                onSelect={applySessionListViewOption}
                            />
                        </SettingAnchor>
                    ) : null}
                    {sessionListViewOptions.showFolderOptions ? (
                        <SettingAnchor setting={SESSION_SETTINGS.settings.folderSort}>
                            <DropdownMenu
                                open={openSessionListFolderSortModeMenu}
                                onOpenChange={setOpenSessionListFolderSortModeMenu}
                                variant="selectable"
                                search={false}
                                selectedId={`folderSort:${effectiveSessionListFolderSortMode}`}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: t(SESSION_SETTINGS.settings.folderSort.titleKey),
                                    subtitle: t('settingsSession.sessionList.folderSortModeSubtitle'),
                                    showSelectedSubtitle: false,
                                    itemProps: { testID: 'settings-session-sessionListFolderSortMode-trigger' },
                                }}
                                items={sessionListFolderSortModeItems}
                                onSelect={handleSessionListFolderSortModeSelect}
                            />
                        </SettingAnchor>
                    ) : null}
                    <SettingAnchor setting={SESSION_SETTINGS.settings.layout}>
                        <Item
                            testID="settings-session-sessionListLayout"
                            title={t(SESSION_SETTINGS.settings.layout.titleKey)}
                            subtitle={t('settingsSession.sessionList.layoutSubtitle')}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={<SelectionTiles
                                variant="visual"
                                accessibilityLabel={t(SESSION_SETTINGS.settings.layout.titleKey)}
                                testIdPrefix="settings-session-sessionListLayout"
                                value={`layout:${sessionListViewOptions.selectedLayout}`}
                                onChange={(next) => { if (next) applySessionListViewOption(next); }}
                                options={sessionListViewOptions.layoutItems.map((item) => ({
                                    id: item.id,
                                    title: item.title,
                                    preview: <SessionListLayoutPreview layout={item.id} />,
                                }))}
                            />}
                        />
                    </SettingAnchor>
                    {sessionListViewOptions.showSectionGrouping ? (
                        <SettingAnchor setting={SESSION_SETTINGS.settings.activeGrouping}>
                            <DropdownMenu
                                open={openGroupingMenu === 'active'}
                                onOpenChange={(next) => setOpenGroupingMenu(next ? 'active' : null)}
                                variant="selectable"
                                search={false}
                                selectedId={sessionListViewOptions.selectedActiveGroupingId}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: t(SESSION_SETTINGS.settings.activeGrouping.titleKey),
                                    subtitle: t('settingsFeatures.sessionListActiveGroupingSubtitle'),
                                    showSelectedSubtitle: false,
                                }}
                                items={sessionListViewOptions.activeGroupingItems}
                                onSelect={applySessionListViewOption}
                            />
                        </SettingAnchor>
                    ) : null}
                    {sessionListViewOptions.showSectionGrouping ? (
                        <SettingAnchor setting={SESSION_SETTINGS.settings.inactiveGrouping}>
                            <DropdownMenu
                                open={openGroupingMenu === 'inactive'}
                                onOpenChange={(next) => setOpenGroupingMenu(next ? 'inactive' : null)}
                                variant="selectable"
                                search={false}
                                selectedId={sessionListViewOptions.selectedInactiveGroupingId}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: t(SESSION_SETTINGS.settings.inactiveGrouping.titleKey),
                                    subtitle: t('settingsFeatures.sessionListInactiveGroupingSubtitle'),
                                    showSelectedSubtitle: false,
                                }}
                                items={sessionListViewOptions.inactiveGroupingItems}
                                onSelect={applySessionListViewOption}
                            />
                        </SettingAnchor>
                    ) : null}
                    <SettingAnchor setting={SESSION_SETTINGS.settings.hideInactive}>
                        <Item
                            title={t(SESSION_SETTINGS.settings.hideInactive.titleKey)}
                            subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                            rightElement={<Switch value={hideInactiveSessions} onValueChange={setHideInactiveSessions} />}
                            showChevron={false}
                        />
                    </SettingAnchor>
                    <SettingAnchor setting={SESSION_SETTINGS.settings.rightPaneDefaultOpen}>
                        <Item
                            title={t(SESSION_SETTINGS.settings.rightPaneDefaultOpen.titleKey)}
                            subtitle={t('settingsAppearance.sessionsRightPaneDefaultOpenDescription')}
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
                    </SettingAnchor>
                </ItemGroup>
            </SettingSection>

            <ItemGroup
                title={t('settingsSession.rootGroups.rowDetails.title')}
                description={t('settingsSession.rootGroups.rowDetails.footer')}
            >
                <SettingAnchor setting={SESSION_SETTINGS.settings.tags}>
                    <Item
                        title={t(SESSION_SETTINGS.settings.tags.titleKey)}
                        subtitle={sessionTagsEnabled ? t('settingsSession.sessionList.tagsEnabledSubtitle') : t('settingsSession.sessionList.tagsDisabledSubtitle')}
                        rightElement={<Switch value={Boolean(sessionTagsEnabled)} onValueChange={setSessionTagsEnabled} />}
                        showChevron={false}
                        onPress={() => setSessionTagsEnabled(!sessionTagsEnabled)}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.identityDisplay}>
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
                            title: t(SESSION_SETTINGS.settings.identityDisplay.titleKey),
                            subtitle: t('settingsSession.sessionList.identityDisplaySubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-sessionListIdentityDisplay-trigger' },
                        }}
                        items={sessionListIdentityDisplayItems}
                        onSelect={handleSessionListIdentityDisplaySelect}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.headerIdentityDisplay}>
                    <DropdownMenu
                        open={openSessionHeaderIdentityDisplayMenu}
                        onOpenChange={setOpenSessionHeaderIdentityDisplayMenu}
                        variant="selectable"
                        search={false}
                        selectedId={normalizedSessionHeaderIdentityDisplay}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t(SESSION_SETTINGS.settings.headerIdentityDisplay.titleKey),
                            subtitle: t('settingsSession.sessionList.headerIdentityDisplaySubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-sessionHeaderIdentityDisplay-trigger' },
                        }}
                        items={sessionHeaderIdentityDisplayItems}
                        onSelect={handleSessionHeaderIdentityDisplaySelect}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.activeColor}>
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
                            title: t(SESSION_SETTINGS.settings.activeColor.titleKey),
                            subtitle: t('settingsSession.sessionList.activeColorSubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-sessionListActiveColorMode-trigger' },
                        }}
                        items={sessionListActiveColorModeItems}
                        onSelect={handleSessionListActiveColorModeSelect}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.workspacePathDisplay}>
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
                            title: t(SESSION_SETTINGS.settings.workspacePathDisplay.titleKey),
                            subtitle: workspacePathDisplayMode === 'path'
                                ? t('settingsSession.sessionList.workspacePathDisplayPathSelectedSubtitle')
                                : t('settingsSession.sessionList.workspacePathDisplayNameSelectedSubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-workspacePathDisplay-trigger' },
                        }}
                        items={workspacePathDisplayItems}
                        onSelect={handleWorkspacePathDisplaySelect}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.workspaceFavicons}>
                    <Item
                        testID="settings-session-workspaceFavicons-item"
                        title={t(SESSION_SETTINGS.settings.workspaceFavicons.titleKey)}
                        subtitle={workspaceFaviconsEnabled !== false
                            ? t('settingsSession.sessionList.workspaceFaviconsEnabledSubtitle')
                            : t('settingsSession.sessionList.workspaceFaviconsDisabledSubtitle')}
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
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.workspaceMachineSubtitles}>
                    <Item
                        testID="settings-session-workspaceMachineSubtitles-item"
                        title={t(SESSION_SETTINGS.settings.workspaceMachineSubtitles.titleKey)}
                        subtitle={workspaceMachineSubtitlesEnabled !== false
                            ? t('settingsSession.sessionList.workspaceMachineSubtitlesEnabledSubtitle')
                            : t('settingsSession.sessionList.workspaceMachineSubtitlesDisabledSubtitle')}
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
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.activitySignals.title')}
                description={t('settingsSession.rootGroups.activitySignals.footer')}
            >
                <SettingAnchor setting={SESSION_SETTINGS.settings.workingStatusAnimatedText}>
                    <Item
                        testID="settings-session-workingStatusAnimatedText-item"
                        title={t(SESSION_SETTINGS.settings.workingStatusAnimatedText.titleKey)}
                        subtitle={sessionListWorkingStatusAnimatedTextEnabled !== false
                            ? t('settingsSession.sessionList.workingStatusAnimatedTextEnabledSubtitle')
                            : t('settingsSession.sessionList.workingStatusAnimatedTextDisabledSubtitle')}
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
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.attentionPromotion}>
                    <DropdownMenu
                        open={openSessionListAttentionPromotionModeMenu}
                        onOpenChange={setOpenSessionListAttentionPromotionModeMenu}
                        variant="selectable"
                        search={false}
                        selectedId={`attention:${normalizedSessionListAttentionPromotionMode}`}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t(SESSION_SETTINGS.settings.attentionPromotion.titleKey),
                            subtitle: t('settingsSession.sessionList.attentionPromotionModeSubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-attentionPromotionMode-trigger' },
                        }}
                        items={sessionListAttentionPromotionModeItems}
                        onSelect={handleSessionListAttentionPromotionModeSelect}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.reminderAutoClearOnOpen}>
                    <Item
                        testID="settings-session-reminderAutoClearOnOpen-item"
                        title={t(SESSION_SETTINGS.settings.reminderAutoClearOnOpen.titleKey)}
                        subtitle={t('settingsSession.sessionList.reminderAutoClearOnOpenSubtitle')}
                        rightElement={
                            <Switch
                                testID="settings-session-reminderAutoClearOnOpen-toggle"
                                value={sessionReminderAutoClearOnOpen !== false}
                                onValueChange={setSessionReminderAutoClearOnOpen}
                            />
                        }
                        showChevron={false}
                        onPress={() => setSessionReminderAutoClearOnOpen(sessionReminderAutoClearOnOpen === false)}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.attentionStandingDefault}>
                    <Item
                        testID="settings-session-attentionStandingDefault-item"
                        title={t(SESSION_SETTINGS.settings.attentionStandingDefault.titleKey)}
                        subtitle={sessionListAttentionStandingUnavailable
                            ? t('settingsSession.sessionList.attentionStandingDefaultUnavailableSubtitle')
                            : sessionListAttentionStandingDefault === true
                                ? t('settingsSession.sessionList.attentionStandingDefaultEnabledSubtitle')
                                : t('settingsSession.sessionList.attentionStandingDefaultDisabledSubtitle')}
                        rightElement={
                            <Switch
                                testID="settings-session-attentionStandingDefault-toggle"
                                value={sessionListAttentionStandingDefault === true}
                                onValueChange={(next) => setSessionListAttentionStandingDefault(Boolean(next))}
                                disabled={sessionListAttentionStandingUnavailable}
                            />
                        }
                        disabled={sessionListAttentionStandingUnavailable}
                        showChevron={false}
                        onPress={() => setSessionListAttentionStandingDefault(sessionListAttentionStandingDefault !== true)}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.workingPlacement}>
                    <DropdownMenu
                        open={openSessionListWorkingPlacementModeMenu}
                        onOpenChange={setOpenSessionListWorkingPlacementModeMenu}
                        variant="selectable"
                        search={false}
                        selectedId={`working:${normalizedSessionListWorkingPlacementMode}`}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t(SESSION_SETTINGS.settings.workingPlacement.titleKey),
                            subtitle: t('settingsSession.sessionList.workingPlacementModeSubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-workingPlacementMode-trigger' },
                        }}
                        items={sessionListWorkingPlacementModeItems}
                        onSelect={handleSessionListWorkingPlacementModeSelect}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.workingIndicator}>
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
                            title: t(SESSION_SETTINGS.settings.workingIndicator.titleKey),
                            subtitle: workingIndicatorStyle === 'pulse'
                                ? t('settingsSession.sessionList.workingIndicatorPulseSelectedSubtitle')
                                : t('settingsSession.sessionList.workingIndicatorSpinnerSelectedSubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-workingIndicator-trigger' },
                        }}
                        items={workingIndicatorItems}
                        onSelect={handleWorkingIndicatorSelect}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.mobileLayout.title')}
                description={t('phoneNav.settings.sectionDescription')}
            >
                <SettingAnchor setting={SESSION_SETTINGS.settings.mobileWorkspaceExperience}>
                    <Item
                        title={t(SESSION_SETTINGS.settings.mobileWorkspaceExperience.titleKey)}
                        subtitle={mobileWorkspaceExperience === 'classic'
                            ? t('settingsSession.mobileWorkspaceExperience.options.classicSubtitle')
                            : t('settingsSession.mobileWorkspaceExperience.options.cockpitSubtitle')}
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
                </SettingAnchor>
                <SessionGestureSettingsRows />
            </ItemGroup>

            <ItemGroup title={t(SESSION_SETTINGS.sections.openTabs.titleKey)}>
                <SettingAnchor setting={SESSION_SETTINGS.settings.syncOpenTabs}>
                    <Item title={t(SESSION_SETTINGS.settings.syncOpenTabs.titleKey)}
                        subtitle={t('workspaceTabs.syncDescription')}
                        rightElement={<Switch testID="settings-session-workspaceTabsSync-switch"
                            value={workspaceTabsSyncEnabled !== false} onValueChange={setWorkspaceTabsSyncEnabled} />}
                        showChevron={false} onPress={() => setWorkspaceTabsSyncEnabled(workspaceTabsSyncEnabled === false)}
                        testID="settings-session-workspaceTabsSync-trigger" />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.rootGroups.agentPersonalization.title')}
                description={t('settingsSession.rootGroups.agentPersonalization.footer')}
            >
                <SettingAnchor setting={SESSION_SETTINGS.settings.renameSessions}>
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
                            title: t(SESSION_SETTINGS.settings.renameSessions.titleKey),
                            subtitle: t(
                                normalizedCodingPromptBehavior.sessionTitleUpdates === 'disabled'
                                    ? 'settingsSession.promptPersonalization.askAgentToRenameSessionsDisabledSubtitle'
                                    : normalizedCodingPromptBehavior.sessionTitleUpdates === 'initial'
                                        ? 'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSelectedSubtitle'
                                        : 'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSelectedSubtitle',
                            ),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-title-updates-mode-trigger' },
                        }}
                        items={titleUpdatesModeItems}
                        onSelect={handleSessionTitleUpdatesModeSelect}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.suggestReplyOptions}>
                    <Item
                        title={t(SESSION_SETTINGS.settings.suggestReplyOptions.titleKey)}
                        subtitle={t(
                            normalizedCodingPromptBehavior.responseOptions === 'agent'
                                ? 'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsEnabledSubtitle'
                                : 'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsDisabledSubtitle',
                        )}
                        rightElement={
                            <Switch
                                value={normalizedCodingPromptBehavior.responseOptions === 'agent'}
                                onValueChange={(next) => setCodingPromptResponseOptionsEnabled(Boolean(next))}
                            />
                        }
                        showChevron={false}
                        onPress={() => setCodingPromptResponseOptionsEnabled(normalizedCodingPromptBehavior.responseOptions !== 'agent')}
                    />
                </SettingAnchor>
            </ItemGroup>


            <ItemGroup
                title={t('settingsSession.detailedBehavior.title')}
                description={t('settingsSession.detailedBehavior.footer')}
            >
                <SettingAnchor setting={SESSION_SETTINGS.settings.composer}>
                    <Item
                        title={t(SESSION_SETTINGS.settings.composer.titleKey)}
                        icon={<Icon name="paper-plane-tilt" />}
                        subtitle={t('settingsSession.composer.entrySubtitle')}
                        onPress={() => router.push('/(app)/settings/session/composer')}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.providerLimits}>
                    <Item
                        title={t(SESSION_SETTINGS.settings.providerLimits.titleKey)}
                        icon={<Icon name="speedometer" />}
                        subtitle={t('settingsSession.providerLimits.entrySubtitle')}
                        onPress={() => router.push('/(app)/settings/session/provider-limits')}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.resume}>
                    <Item
                        title={t(SESSION_SETTINGS.settings.resume.titleKey)}
                        icon={<Icon name="arrow-clockwise" />}
                        subtitle={t('settingsSession.resume.entrySubtitle')}
                        onPress={() => router.push('/(app)/settings/session/resume')}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.runtime}>
                    <Item
                        title={t(SESSION_SETTINGS.settings.runtime.titleKey)}
                        icon={<Icon name="terminal" />}
                        subtitle={t('settingsSession.runtime.entrySubtitle')}
                        onPress={() => router.push('/(app)/settings/session/runtime')}
                    />
                </SettingAnchor>
            </ItemGroup>
        </ItemList>
    );
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
