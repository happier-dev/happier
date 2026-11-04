import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { CollectionSpacesSettingsSection } from '@/components/settings/session/CollectionSpacesSettingsView';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SessionListDensityPreview, SessionListLayoutPreview } from '@/components/settings/session/SessionListPreview';
import React from 'react';
import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    CodingPromptBehaviorV1Schema,
    type CodingPromptSessionTitleUpdatesModeV1,
} from '@happier-dev/protocol/prompts/codingPromptBehaviorV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getPreferredLanguage, t } from '@/text';
import { useLocalSettingMutable, useSettingMutable, useSettingsSelector } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SessionGestureSettingsRows } from '@/components/settings/session/SessionGestureSettingsRows';
import {
    resolveSessionListIdentityItems,
    resolveSessionListViewOptionsPresentation,
} from '@/components/sessions/shell/sessionListViewOptionsPresentation';
import { useSessionListViewOptionWriter } from '@/components/sessions/shell/useSessionListViewOptionWriter';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { normalizeSessionListBackgroundWorkAttentionMode } from '@/sync/domains/session/listing/sessionListBackgroundWorkAttention';
import { useSessionListLayoutChoice } from '@/hooks/session/sessionListLayoutIntent';
import { Icon } from '@/components/ui/icons/Icon';

// View tiles are half the sheet and show a readable list; placement and density tiles are a third of it.
const LAYOUT_PREVIEW_ASPECT_RATIO = 1.7;
const ATTENTION_PREVIEW_ASPECT_RATIO = 1.5;
const DENSITY_PREVIEW_ASPECT_RATIO = 1.9;

export const WorkspaceRouteBody = React.memo(function SessionSettingsScreen() {
    const preferredLanguage = useSettingsSelector(getPreferredLanguage);
    const router = useRouter();
    const popoverBoundaryRef = React.useRef<any>(null);
    const [codingPromptBehavior] = useSettingMutable('codingPromptBehaviorV1');
    const { setSetting } = useSettingActionFeedback();
    const [rememberLastProjectSessionSelections, setRememberLastProjectSessionSelections] = useSettingMutable('rememberLastProjectSessionSelections');
    const [rememberLastEngineSelections, setRememberLastEngineSelections] = useSettingMutable('rememberLastEngineSelectionsV1');
    const [useEnhancedSessionWizard, setUseEnhancedSessionWizard] = useSettingMutable('useEnhancedSessionWizard');

    const [sessionTagsEnabled, setSessionTagsEnabled] = useSettingMutable('sessionTagsEnabled');

    // Session list settings (moved from Appearance)
    const deviceType = useDeviceType();
    const panelsSupported = Platform.OS === 'web' || deviceType === 'tablet';
    const [sessionListDensity, setSessionListDensity] = useSettingMutable('sessionListDensity');
    const [sessionListIdentityDisplay] = useSettingMutable('sessionListIdentityDisplay');
    const [sessionListRowContextV1] = useSettingMutable('sessionListRowContextV1');
    const [sessionListStatusWords] = useSettingMutable('sessionListStatusWords');
    const [sessionHeaderIdentityDisplay, setSessionHeaderIdentityDisplay] = useSettingMutable('sessionHeaderIdentityDisplay');
    const [sessionListActiveColorMode, setSessionListActiveColorMode] = useSettingMutable('sessionListActiveColorModeV1');
    const [sessionListAttentionPlacement] = useSettingMutable('sessionListAttentionPlacementV1');
    const [sessionListBackgroundWorkAttentionMode] = useSettingMutable('sessionListBackgroundWorkAttentionModeV1');
    const [sessionReminderAutoClearOnOpen, setSessionReminderAutoClearOnOpen] = useSettingMutable('sessionReminderAutoClearOnOpen');
    const [sessionListAttentionStandingDefault, setSessionListAttentionStandingDefault] = useSettingMutable('sessionListAttentionStandingDefaultV1');
    const [workspaceFaviconsEnabled, setWorkspaceFaviconsEnabled] = useSettingMutable('workspaceFaviconsEnabled');
    const [workspaceMachineSubtitlesEnabled, setWorkspaceMachineSubtitlesEnabled] = useSettingMutable('workspaceMachineSubtitlesEnabled');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const applySessionListViewOption = useSessionListViewOptionWriter();
    // Account settings intentionally describe the currently selected Home set;
    // exact Session/Team/list-row surfaces scope their own admission separately.
    const [mobileWorkspaceExperience, setMobileWorkspaceExperience] = useSettingMutable('mobileWorkspaceExperienceV1');
    const [workspaceTabsSyncEnabled, setWorkspaceTabsSyncEnabled] = useSettingMutable('workspaceTabsSyncEnabled');
    const [sessionsRightPaneDefaultOpen, setSessionsRightPaneDefaultOpen] = useLocalSettingMutable('sessionsRightPaneDefaultOpen');
    const [uiMultiPanePanelsEnabled] = useLocalSettingMutable('uiMultiPanePanelsEnabled');

    const [openSessionListIdentityDisplayMenu, setOpenSessionListIdentityDisplayMenu] = React.useState(false);
    const [openSessionHeaderIdentityDisplayMenu, setOpenSessionHeaderIdentityDisplayMenu] = React.useState(false);
    const [openSessionListActiveColorModeMenu, setOpenSessionListActiveColorModeMenu] = React.useState(false);
    const [openSessionListBackgroundWorkAttentionModeMenu, setOpenSessionListBackgroundWorkAttentionModeMenu] = React.useState(false);
    const [openTitleUpdatesModeMenu, setOpenTitleUpdatesModeMenu] = React.useState(false);
    const rememberProjectSelectionsEnabled = rememberLastProjectSessionSelections !== false;
    const rememberEngineSelectionsEnabled = rememberLastEngineSelections !== false;
    const normalizedCodingPromptBehavior = React.useMemo(() => CodingPromptBehaviorV1Schema.parse(codingPromptBehavior), [codingPromptBehavior]);
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
            void setSetting(SESSION_SETTINGS.settings.renameSessions, mode);
        },
        [setSetting],
    );
    const handleSessionTitleUpdatesModeSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'disabled' && itemId !== 'initial' && itemId !== 'ongoing') return;
        setSessionTitleUpdatesMode(itemId);
    }, [setSessionTitleUpdatesMode]);
    const setCodingPromptResponseOptionsEnabled = React.useCallback(
        (enabled: boolean) => {
            void setSetting(SESSION_SETTINGS.settings.suggestReplyOptions, enabled);
        },
        [setSetting],
    );

    // Settings hosts no list, so this resolves to the stored preference; it still
    // goes through the one effective-layout reader rather than re-deriving it.
    const sessionListLayoutChoice = useSessionListLayoutChoice();
    const sessionListViewOptions = resolveSessionListViewOptionsPresentation({
        sessionListAttentionPlacementV1: sessionListAttentionPlacement,
    }, sessionListLayoutChoice);
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

    const sessionListPreviewDensity = sessionListDensity === 'detailed' || sessionListDensity === 'cozy' ? sessionListDensity : 'narrow';
    const handleSessionListDensitySelect = React.useCallback((itemId: string) => {
        if (itemId !== 'detailed' && itemId !== 'cozy' && itemId !== 'narrow') return;
        setSessionListDensity(itemId);
    }, [setSessionListDensity]);

    // The list's View menu and this page offer the same leading-mark choices from one owner.
    const sessionListIdentityItems = React.useMemo(() => resolveSessionListIdentityItems(), [preferredLanguage]);
    const selectedSessionListIdentity = sessionListIdentityItems.find((item) => item.id === `identity:${sessionListIdentityDisplay}`)?.id
        ?? sessionListIdentityItems[0]!.id;
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
    const sessionListAttentionStandingUnavailable = normalizedSessionListAttentionPromotionMode === 'inPlace';

    const normalizedSessionListBackgroundWorkAttentionMode = normalizeSessionListBackgroundWorkAttentionMode(sessionListBackgroundWorkAttentionMode);
    const sessionListBackgroundWorkAttentionModeItems = React.useMemo(() => [
        {
            id: 'keepWorking',
            title: t('settingsSession.sessionList.backgroundWorkAttentionKeepWorkingTitle'),
            subtitle: t('settingsSession.sessionList.backgroundWorkAttentionKeepWorkingSubtitle'),
        },
        {
            id: 'keepWorkingUnread',
            title: t('settingsSession.sessionList.backgroundWorkAttentionKeepWorkingUnreadTitle'),
            subtitle: t('settingsSession.sessionList.backgroundWorkAttentionKeepWorkingUnreadSubtitle'),
        },
        {
            id: 'showUnread',
            title: t('settingsSession.sessionList.backgroundWorkAttentionShowUnreadTitle'),
            subtitle: t('settingsSession.sessionList.backgroundWorkAttentionShowUnreadSubtitle'),
        },
    ], [preferredLanguage]);
    const handleSessionListBackgroundWorkAttentionModeSelect = React.useCallback((itemId: string) => {
        void setSetting(SESSION_SETTINGS.settings.backgroundWorkAttention, normalizeSessionListBackgroundWorkAttentionMode(itemId));
    }, [setSetting]);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSession.pageDescription')} />
            {/* The list's own arrangement leads (lab cllayout/clctx): view and density, row details, spaces; new-session defaults follow. */}
            <SettingSection section={SESSION_SETTINGS.sectionRefs.listOrganization}>
                <ItemGroup
                    title={t('settingsSession.rootGroups.listOrganization.title')}
                    description={t('settingsSession.rootGroups.listOrganization.footer')}
                >
                    <SettingAnchor setting={SESSION_SETTINGS.settings.layout}>
                        <Item
                            testID="settings-session-sessionListLayout"
                            title={t(SESSION_SETTINGS.settings.layout.titleKey)}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={<SelectionTiles
                                variant="visual"
                                tileSizing="fill"
                                previewAspectRatio={LAYOUT_PREVIEW_ASPECT_RATIO}
                                accessibilityLabel={t(SESSION_SETTINGS.settings.layout.titleKey)}
                                testIdPrefix="settings-session-sessionListLayout"
                                value={`layout:${sessionListViewOptions.selectedLayout}`}
                                onChange={(next) => { if (next) applySessionListViewOption(next); }}
                                options={sessionListViewOptions.layoutItems.map((item) => ({
                                    id: item.id,
                                    title: item.title,
                                    subtitle: t(item.id === 'layout:recent_activity' ? 'settingsSession.sessionList.layoutRecentActivitySubtitle' : 'settingsSession.sessionList.layoutProjectsSubtitle'),
                                    preview: <SessionListLayoutPreview layout={item.id} attention={normalizedSessionListAttentionPromotionMode} density={sessionListPreviewDensity} />,
                                }))}
                            />}
                        />
                    </SettingAnchor>
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
                                    tileSizing="fill"
                                    previewAspectRatio={DENSITY_PREVIEW_ASPECT_RATIO}
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
                <SettingAnchor setting={SESSION_SETTINGS.settings.rowContext}>
                    <Item
                        testID="settings-session-rowContext-item"
                        title={t(SESSION_SETTINGS.settings.rowContext.titleKey)}
                        subtitle={t('settingsSession.sessionList.rowContextSubtitle')}
                        rightElement={<Switch
                            testID="settings-session-rowContext-toggle"
                            value={sessionListRowContextV1 !== false}
                            onValueChange={(next) => { void applySessionListViewOption(`rowContext:${Boolean(next)}`); }}
                        />}
                        showChevron={false}
                        onPress={() => { void applySessionListViewOption(`rowContext:${sessionListRowContextV1 === false}`); }}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.identityDisplay}>
                    <DropdownMenu
                        open={openSessionListIdentityDisplayMenu}
                        onOpenChange={setOpenSessionListIdentityDisplayMenu}
                        variant="selectable"
                        search={false}
                        selectedId={selectedSessionListIdentity}
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
                        items={sessionListIdentityItems}
                        onSelect={applySessionListViewOption}
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

            <CollectionSpacesSettingsSection entityKind="sessionWork" />

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


            <ItemGroup
                title={t('settingsSession.rootGroups.activitySignals.title')}
                description={t('settingsSession.rootGroups.activitySignals.footer')}
            >
                <SettingAnchor setting={SESSION_SETTINGS.settings.statusWords}>
                    <Item
                        testID="settings-session-statusWords-item"
                        title={t(SESSION_SETTINGS.settings.statusWords.titleKey)}
                        subtitle={t('settingsSession.sessionList.statusWordsSubtitle')}
                        rightElement={<Switch
                            testID="settings-session-statusWords-toggle"
                            value={sessionListStatusWords === true}
                            onValueChange={(next) => { void applySessionListViewOption(`statusWords:${Boolean(next)}`); }}
                        />}
                        showChevron={false}
                        onPress={() => { void applySessionListViewOption(`statusWords:${sessionListStatusWords !== true}`); }}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.attentionPromotion}>
                    <Item
                        testID="settings-session-attentionPromotionMode"
                        title={t('settingsSession.sessionList.attentionPlacementTitle')}
                        subtitle={t('settingsSession.sessionList.attentionPromotionModeSubtitle')}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={<SelectionTiles
                            variant="visual"
                            tileSizing="fill"
                            previewAspectRatio={ATTENTION_PREVIEW_ASPECT_RATIO}
                            accessibilityLabel={t('settingsSession.sessionList.attentionPlacementTitle')}
                            testIdPrefix="settings-session-attentionPromotionMode"
                            value={`attention:${normalizedSessionListAttentionPromotionMode}`}
                            onChange={(next) => { if (next) applySessionListViewOption(next); }}
                            options={sessionListAttentionPromotionModeItems.map((item) => ({
                                id: item.id,
                                title: item.title,
                                preview: <SessionListLayoutPreview
                                    layout={sessionListViewOptions.selectedLayout}
                                    attention={item.id === 'attention:top' ? 'top' : item.id === 'attention:inPlace' ? 'inPlace' : 'both'}
                                    density={sessionListPreviewDensity}
                                />,
                            }))}
                        />}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SESSION_SETTINGS.settings.backgroundWorkAttention}>
                    <DropdownMenu
                        open={openSessionListBackgroundWorkAttentionModeMenu}
                        onOpenChange={setOpenSessionListBackgroundWorkAttentionModeMenu}
                        variant="selectable"
                        search={false}
                        selectedId={normalizedSessionListBackgroundWorkAttentionMode}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t(SESSION_SETTINGS.settings.backgroundWorkAttention.titleKey),
                            subtitle: t('settingsSession.sessionList.backgroundWorkAttentionModeSubtitle'),
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-backgroundWorkAttentionMode-trigger' },
                        }}
                        items={sessionListBackgroundWorkAttentionModeItems}
                        onSelect={handleSessionListBackgroundWorkAttentionModeSelect}
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
                <SettingAnchor setting={SESSION_SETTINGS.settings.suggestCompaction}>
                    <Item
                        testID="settings-session-compaction-nudge"
                        title={t(SESSION_SETTINGS.settings.suggestCompaction.titleKey)}
                        subtitle={t('settingsSession.promptPersonalization.sessionCompactionNudgeDescription')}
                        rightElement={<Switch
                            testID="settings-session-compaction-nudge-switch"
                            value={normalizedCodingPromptBehavior.sessionCompactionNudge}
                            onValueChange={(next) => { void setSetting(SESSION_SETTINGS.settings.suggestCompaction, Boolean(next)); }}
                        />}
                        showChevron={false}
                        onPress={() => { void setSetting(SESSION_SETTINGS.settings.suggestCompaction, !normalizedCodingPromptBehavior.sessionCompactionNudge); }}
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
