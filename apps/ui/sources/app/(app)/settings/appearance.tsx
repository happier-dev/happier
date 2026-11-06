import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { usePaneArrangement } from '@/components/appShell/panes/arrangement/usePaneArrangement';
import { PaneArrangementPreview } from '@/components/settings/appearance/PaneArrangementPreview';
import { useRightPanelPlacement } from '@/components/appShell/panes/arrangement/useRightPanelPlacement';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ThemeModePreview } from '@/components/settings/appearance/ThemeModePreview';
import { useGlassAppearanceSummary } from '@/components/settings/appearance/GlassAppearanceControls';
import { useAtmosphereMomentsSummary } from '@/components/settings/appearance/AtmosphereAppearanceRows';
import { useMotionAppearanceSummary, useWidgetsAppearanceSummary } from '@/components/settings/appearance/AppearanceSubpageScreens';
import { AppearanceLivePreview } from '@/components/settings/appearance/AppearanceLivePreview';
import { PageAsideColumns } from '@/components/ui/layout/PageAsideColumns';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { requestHomeCustomize } from '@/components/hub/header/homeCustomizeRequest';
import { useMachineSummarySettingValue } from '@/components/machines/summary/useMachineSummarySetting';
import { machineSummaryStyleTitle } from '@/components/machines/summary/MachineSummaryStyleTiles';
import { AvatarStylePreview } from '@/components/settings/appearance/AvatarStylePreview';
import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { ItemList } from '@/components/ui/lists/ItemList';
import { storage, useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useOpenPersonalize } from '@/components/onboarding/personalize/useOpenPersonalize';
import * as Localization from 'expo-localization';
import { Switch } from '@/components/ui/forms/Switch';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Slider } from '@/components/ui/forms/Slider';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ItemDensityChoiceRow } from '@/components/settings/appearance/ItemDensityPreview';
import { buildThemePresetSourceOptions } from '@/components/settings/appearance/themeProfiles/themeProfilePresetOptions';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveThemeMode, useApplyThemeSelection } from '@/components/settings/appearance/useApplyThemeSelection';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
} from '@/theme/profiles/themeProfilePersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

type UiFontScalePresetId = keyof typeof UI_FONT_SCALE_PRESETS;
const UI_FONT_SCALE_PRESET_IDS = Object.keys(UI_FONT_SCALE_PRESETS) as UiFontScalePresetId[];
type UiItemDensity = LocalSettings['uiItemDensity'];
type DetailsPaneTabsBehavior = LocalSettings['detailsPaneTabsBehavior'];

const isUiItemDensity = (value: string): value is UiItemDensity => (
    value === 'comfortable' || value === 'cozy' || value === 'compact'
);

const isDetailsPaneTabsBehavior = (value: string): value is DetailsPaneTabsBehavior => (
    value === 'preview' || value === 'persistent'
);

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

export const WorkspaceRouteBody = React.memo(function AppearanceSettingsScreen() {
    const router = useRouter();
    const openPersonalize = useOpenPersonalize();
    const { theme } = useUnistyles();
    // On a phone the theme counts would be squeezed beside the summary, so they join it instead.
    const narrowWindow = useWindowDimensions().width < PAGE_LIST_METRICS.rowStackBelowWidthPx;
    const scope = storage(state => state.settingsScope);
    const resetAction = useMountedActionExecution(scope, { retainInvocation: true });
    const deviceType = useDeviceType();
    const panelsSupported = Platform.OS === 'web' || deviceType === 'tablet';
    const { arrangement: paneArrangement, setArrangement: setPaneArrangement } = usePaneArrangement();
    const { placement: rightPanelPlacement, setPlacement: setRightPanelPlacement } = useRightPanelPlacement();
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [showChatCodeBlockWrapControls, setShowChatCodeBlockWrapControls] = useSettingMutable('showChatCodeBlockWrapControls');
    const [wrapChatCodeBlocks, setWrapChatCodeBlocks] = useSettingMutable('wrapChatCodeBlocks');
    const [themePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const [uiContentWidthMode, setUiContentWidthMode] = useLocalSettingMutable('uiContentWidthMode');
    const [uiItemDensity, setUiItemDensity] = useLocalSettingMutable('uiItemDensity');
    const [uiMultiPanePanelsEnabled, setUiMultiPanePanelsEnabled] = useLocalSettingMutable('uiMultiPanePanelsEnabled');
    const [hideConnectedAccountIdentities, setHideConnectedAccountIdentities] = useLocalSettingMutable('hideConnectedAccountIdentities');
    const [detailsPaneTabsBehavior, setDetailsPaneTabsBehavior] = useLocalSettingMutable('detailsPaneTabsBehavior');
    const [settingsNavSidebarEnabled, setSettingsNavSidebarEnabled] = useLocalSettingMutable('settingsNavSidebarEnabled');
    const [themeToggleVisible, setThemeToggleVisible] = useLocalSettingMutable('titleStripThemeToggleVisible');
    const [tabBarGitBadgeMode, setTabBarGitBadgeMode] = useSettingMutable('tabBarGitBadgeMode');
    const [tabBarFriendsBadgeEnabled, setTabBarFriendsBadgeEnabled] = useSettingMutable('tabBarFriendsBadgeEnabled');
    const [tabBarSessionsBadgeEnabled, setTabBarSessionsBadgeEnabled] = useSettingMutable('tabBarSessionsBadgeEnabled');
    const [tabBarInboxBadgeEnabled, setTabBarInboxBadgeEnabled] = useSettingMutable('tabBarInboxBadgeEnabled');
    const [tabBarOpenTabsBadgeEnabled, setTabBarOpenTabsBadgeEnabled] = useSettingMutable('tabBarOpenTabsBadgeEnabled');
    const [tabBarShowLabels, setTabBarShowLabels] = useSettingMutable('tabBarShowLabels');
    const [tabBarSize, setTabBarSize] = useSettingMutable('tabBarSize');
    const [contextGaugeStyle, setContextGaugeStyle] = useSettingMutable('contextGaugeStyle');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [badgesExpanded, setBadgesExpanded] = React.useState(false);
    const reduceMotion = useReducedMotionPreference();
    const glassSummary = useGlassAppearanceSummary();
    const momentsSummary = useAtmosphereMomentsSummary();
    const widgetsSummary = useWidgetsAppearanceSummary();
    const motionSummary = useMotionAppearanceSummary();
    const machineSummaryStyle = useMachineSummarySettingValue().style;
    const safeThemeProfiles = themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE;
    // The Themes row summarizes the library: which theme each mode uses and how many there are. The
    // library screen owns choosing them.
    const themesSummary = React.useMemo(() => {
        const options = buildThemePresetSourceOptions(safeThemeProfiles);
        const nameFor = (profileId: string | null) => {
            const option = profileId ? options.find((candidate) => candidate.id === profileId) : null;
            return option?.title ?? t('common.default');
        };
        const custom = options.filter((option) => option.kind === 'custom').length;
        return {
            slots: <Text style={styles.themesSummary}>{t('settingsAppearance.themesSummary', {
                light: '{light}', dark: '{dark}',
            }).split(/(\{light\}|\{dark\})/).map((part, index) => part === '{light}' || part === '{dark}'
                ? <Text key={index} style={styles.themeName}>{nameFor(safeThemeProfiles.activeProfileIds[part === '{light}' ? 'light' : 'dark'])}</Text>
                : part)}</Text>,
            count: t('settingsAppearance.themesCount', { builtIn: options.length - custom, custom }),
        };
    }, [safeThemeProfiles]);
    const gitBadgeMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        return [
            { id: 'changedFiles', title: t('settingsAppearance.tabBarBadges.gitChangedFiles') },
            { id: 'diffLines', title: t('settingsAppearance.tabBarBadges.gitDiffLines') },
            { id: 'off', title: t('settingsAppearance.tabBarBadges.gitOff') },
        ];
    }, []);

    const tabBarSizeMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        return [
            { id: 'compact', title: t('settingsAppearance.tabBarAppearance.sizeCompact') },
            { id: 'regular', title: t('settingsAppearance.tabBarAppearance.sizeRegular') },
            { id: 'large', title: t('settingsAppearance.tabBarAppearance.sizeLarge') },
        ];
    }, []);

    const contextGaugeMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        return [
            { id: 'gauge', title: t('settingsAppearance.visualEffects.contextGaugeOptions.gauge') },
            { id: 'text', title: t('settingsAppearance.visualEffects.contextGaugeOptions.text') },
            { id: 'hidden', title: t('settingsAppearance.visualEffects.contextGaugeOptions.hidden') },
        ];
    }, []);

    const textSizeMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        return [
            { id: 'xxsmall', title: t('settingsAppearance.textSizeOptions.xxsmall') },
            { id: 'xsmall', title: t('settingsAppearance.textSizeOptions.xsmall') },
            { id: 'small', title: t('settingsAppearance.textSizeOptions.small') },
            { id: 'default', title: t('settingsAppearance.textSizeOptions.default') },
            { id: 'large', title: t('settingsAppearance.textSizeOptions.large') },
            { id: 'xlarge', title: t('settingsAppearance.textSizeOptions.xlarge') },
            { id: 'xxlarge', title: t('settingsAppearance.textSizeOptions.xxlarge') },
        ];
    }, []);

    const detailsTabsMenuItems = React.useMemo(() => {
        return [
            { id: 'preview', title: t('settingsAppearance.detailsPaneTabsBehaviorOptions.preview') },
            { id: 'persistent', title: t('settingsAppearance.detailsPaneTabsBehaviorOptions.persistent') },
        ];
    }, []);

    const itemDensityMenuItems = React.useMemo(() => {
        return [
            {
                id: 'comfortable',
                title: t('settingsAppearance.itemDensityOptions.comfortable'),
                subtitle: t('settingsAppearance.itemDensityOptions.comfortableDescription'),
            },
            {
                id: 'cozy',
                title: t('settingsAppearance.itemDensityOptions.cozy'),
                subtitle: t('settingsAppearance.itemDensityOptions.cozyDescription'),
            },
            {
                id: 'compact',
                title: t('settingsAppearance.itemDensityOptions.compact'),
                subtitle: t('settingsAppearance.itemDensityOptions.compactDescription'),
            },
        ];
    }, []);

    const contentWidthMenuItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => {
        return [
            {
                id: 'compact',
                title: t('settingsAppearance.contentWidthOptions.compact'),
                subtitle: t('settingsAppearance.contentWidthOptions.compactDescription'),
            },
            {
                id: 'medium',
                title: t('settingsAppearance.contentWidthOptions.medium'),
                subtitle: t('settingsAppearance.contentWidthOptions.mediumDescription'),
            },
            {
                id: 'full',
                title: t('settingsAppearance.contentWidthOptions.full'),
                subtitle: t('settingsAppearance.contentWidthOptions.fullDescription'),
            },
        ];
    }, []);

    const selectedTextSizeId = React.useMemo(() => {
        const entries = Object.entries(UI_FONT_SCALE_PRESETS) as Array<[UiFontScalePresetId, number]>;
        let best: UiFontScalePresetId = 'default';
        let bestDist = Number.POSITIVE_INFINITY;
        for (const [id, scale] of entries) {
            const dist = Math.abs((uiFontScale ?? 1) - scale);
            if (dist < bestDist) {
                bestDist = dist;
                best = id;
            }
        }
        return best;
    }, [uiFontScale]);

    const selectUiFontSizeIndex = React.useCallback((index: number) => {
        const presetId = UI_FONT_SCALE_PRESET_IDS[index];
        if (presetId) setUiFontScale(UI_FONT_SCALE_PRESETS[presetId]);
    }, [setUiFontScale]);
    const textSizeLabels = React.useMemo(
        () => new Map(textSizeMenuItems.map((item) => [item.id, item.title])),
        [textSizeMenuItems],
    );

    const applyThemeSelection = useApplyThemeSelection();

    const resetToDefaults = React.useCallback(async () => {
        try {
            const result = await resetAction.execute('settings.invoke', { anchor: APPEARANCE_SETTINGS.settings.reset.anchor });
            if (!resetAction.isCurrent()) return;
            if (result.ok || isActionApprovalDeclinedErrorCode(result.errorCode)
                || presentActionTurnedOffNoticeIfOff(result, 'settings.invoke')) return;
        } catch {
            if (!resetAction.isCurrent()) return;
        }
        Modal.alert(t('common.error'), t('common.unavailable'));
    }, [resetAction.execute, resetAction.isCurrent]);

    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';
    
    // Language display
    const getLanguageDisplayText = () => {
        if (preferredLanguage === null) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ? 
                                        getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) : 
                                        getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        } else if (preferredLanguage && preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    };
    const toChoices = <T extends string>(items: ReadonlyArray<{ id: string; title: string }>) =>
        items.map((item) => ({ id: item.id as T, label: item.title }));
    const themeModeValue = resolveThemeMode(themePreference);
    const badgesSummary = [
        tabBarGitBadgeMode === 'off' ? null : t('settingsAppearance.tabBarBadges.gitTitle'),
        tabBarFriendsBadgeEnabled ? t('tabs.friends') : null,
        tabBarSessionsBadgeEnabled ? t('tabs.sessions') : null,
        tabBarInboxBadgeEnabled ? t('tabs.inbox') : null,
        tabBarOpenTabsBadgeEnabled ? t('common.tabs') : null,
    ].filter(Boolean).join(' · ');

    return (
        <ItemList style={{ paddingTop: 0 }} pageColumn={deviceType === 'phone' ? 'reading' : 'wide'}>
            <SettingsPageHeader
                description={t('settingsAppearance.pageDescription')}
                actions={
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.reset}>
                    <RoundButton
                        testID="settings-appearance-reset"
                        display="inverted"
                        title={t('common.reset')}
                        leading={<Icon name="arrow-arc-left" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                        textStyle={styles.resetText}
                        onPress={resetToDefaults}
                    />
                    </SettingAnchor>
                }
            />

            <PageAsideColumns
                aside={<AppearanceLivePreview />}
                compact={deviceType === 'phone'}
                compactAside="none"
            >
            {({ sideBySide }) => (<>
            {/* Theme: the mode is a visual choice; each mode's theme stays one tap away. */}
            <ItemGroup title={t('settingsAppearance.theme')}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.themeMode}>
                <SectionContentRow testID="settings-appearance-themeMode">
                    <SelectionTiles
                        variant="visual"
                        tileSizing="fill"
                        accessibilityLabel={t('settingsAppearance.theme')}
                        testIdPrefix="settings-appearance-themeMode"
                        value={themeModeValue}
                        onChange={(next) => {
                            if (next === 'adaptive') {
                                return applyThemeSelection('adaptive', safeThemeProfiles);
                            } else if (next === 'light' || next === 'dark') {
                                return applyThemeSelection(next, safeThemeProfiles);
                            }
                        }}
                        options={[
                            { id: 'adaptive', title: t('settingsAppearance.themeOptions.adaptive'), preview: <ThemeModePreview mode="adaptive" /> },
                            { id: 'light', title: t('settingsAppearance.themeOptions.light'), preview: <ThemeModePreview mode="light" /> },
                            { id: 'dark', title: t('settingsAppearance.themeOptions.dark'), preview: <ThemeModePreview mode="dark" /> },
                        ]}
                    />
                </SectionContentRow>
                </SettingAnchor>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.themes}
                    testID="settings-appearance-themeProfiles"
                    icon={<Icon name="palette" />}
                    subtitle={narrowWindow ? <Text style={styles.themesSummary}>{themesSummary.slots}{'\n'}{themesSummary.count}</Text> : themesSummary.slots}
                    subtitleLines={0}
                    detail={narrowWindow ? undefined : themesSummary.count}
                    onPress={() => router.push('/settings/appearance/themes')}
                />
                {/* The window toolbar exists where the app shell does (web and tablets). */}
                {panelsSupported ? (
                    <SettingRow
                        setting={APPEARANCE_SETTINGS.settings.themeToggle}
                        testID="settings-appearance-theme-toggle-visible"
                        subtitleLines={0}
                        onPress={() => setThemeToggleVisible(!themeToggleVisible)}
                        rightElement={
                            <Switch
                                testID="settings-appearance-theme-toggle-visible.switch"
                                value={themeToggleVisible}
                                onValueChange={setThemeToggleVisible}
                            />
                        }
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>

            {/* Text & density */}
            <ItemGroup title={t('settingsAppearance.text')}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.textSize}>
                    <Item
                        testID="settings-appearance-textSize"
                        title={t(APPEARANCE_SETTINGS.settings.textSize.titleKey)}
                        accessoryLayout="adaptive"
                        showChevron={false}
                        rightElement={
                            <Slider
                                testID="settings-appearance-textSize-slider"
                                value={UI_FONT_SCALE_PRESET_IDS.indexOf(selectedTextSizeId)}
                                min={0}
                                max={UI_FONT_SCALE_PRESET_IDS.length - 1}
                                step={1}
                                trackWidth={180}
                                formatValueText={(index) => textSizeLabels.get(UI_FONT_SCALE_PRESET_IDS[index] ?? 'default') ?? ''}
                                leading={<Text style={[styles.textSizeGlyph, styles.textSizeGlyphSmall]}>{t('settingsAppearance.textSizeGlyph')}</Text>}
                                trailing={<Text style={[styles.textSizeGlyph, styles.textSizeGlyphLarge]}>{t('settingsAppearance.textSizeGlyph')}</Text>}
                                onValueChange={selectUiFontSizeIndex}
                            />
                        }
                    />
                </SettingAnchor>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.density}>
                    <ItemDensityChoiceRow
                        previewShownElsewhere={sideBySide}
                        title={t(APPEARANCE_SETTINGS.settings.density.titleKey)}
                        subtitle={t('settingsAppearance.itemDensityDescription')}
                        subtitleLines={0}
                        testIDPrefix="settings-appearance-itemDensity"
                        options={toChoices<UiItemDensity>(itemDensityMenuItems)}
                        value={uiItemDensity}
                        onChange={(next) => {
                            if (!isUiItemDensity(next)) return;
                            setUiItemDensity(next);
                        }}
                    />
                </SettingAnchor>
            </ItemGroup>

            <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.chatCodeBlocks}>
                <ItemGroup title={t('settingsAppearance.chatCodeBlocks.title')}>
                    <SettingRow
                        setting={APPEARANCE_SETTINGS.settings.showChatCodeBlockWrapControls}
                        rightElement={
                            <Switch
                                testID="settings-appearance-showChatCodeBlockWrapControls-switch"
                                value={showChatCodeBlockWrapControls}
                                onValueChange={setShowChatCodeBlockWrapControls}
                            />
                        }
                        showChevron={false}
                    />
                    <SettingRow
                        setting={APPEARANCE_SETTINGS.settings.wrapChatCodeBlocks}
                        rightElement={
                            <Switch
                                testID="settings-appearance-wrapChatCodeBlocks-switch"
                                value={wrapChatCodeBlocks}
                                onValueChange={setWrapChatCodeBlocks}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>
            </SettingSection>

            {/* Layout. Pane and sidebar settings only exist where panes exist (web and tablet). */}
            {/* The pane rows exist on web and tablets only; on a phone the section answers for them. */}
            <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.display}>
            <ItemGroup title={t('settingsAppearance.display')}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.contentWidth}>
                    <SegmentedChoiceItem
                        title={t(APPEARANCE_SETTINGS.settings.contentWidth.titleKey)}
                        subtitle={t('settingsAppearance.contentWidthDescription')}
                        subtitleLines={0}
                        testIDPrefix="settings-appearance-contentWidth"
                        options={toChoices<'compact' | 'medium' | 'full'>(contentWidthMenuItems)}
                        value={uiContentWidthMode}
                        onChange={setUiContentWidthMode}
                    />
                </SettingAnchor>
                {panelsSupported ? (
                    <SettingRow
                        setting={APPEARANCE_SETTINGS.settings.rightPanels}
                        subtitleLines={0}
                        rightElement={<Switch value={uiMultiPanePanelsEnabled} onValueChange={setUiMultiPanePanelsEnabled} />}
                        showChevron={false}
                    />
                ) : null}
                {/* An arrangement only exists where panes sit side by side; a phone never shows it. */}
                {panelsSupported && deviceType !== 'phone' ? (
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.paneArrangement}>
                        <Item
                            title={t(APPEARANCE_SETTINGS.settings.paneArrangement.titleKey)}
                            subtitle={t('settingsAppearance.paneArrangementDescription')}
                            subtitleLines={0}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={
                                <SelectionTiles
                                    variant="visual"
                                    tileSizing="fill"
                                    accessibilityLabel={t(APPEARANCE_SETTINGS.settings.paneArrangement.titleKey)}
                                    testIdPrefix="settings-appearance-paneArrangement"
                                    value={paneArrangement}
                                    onChange={(next) => { if (next === 'session' || next === 'editor') setPaneArrangement(next); }}
                                    options={[
                                        { id: 'session', title: t('settingsAppearance.paneArrangementSession'), subtitle: t('settingsAppearance.paneArrangementSessionCaption'), preview: <PaneArrangementPreview arrangement="session" rightPanel={rightPanelPlacement} /> },
                                        { id: 'editor', title: t('settingsAppearance.paneArrangementEditor'), subtitle: t('settingsAppearance.paneArrangementEditorCaption'), preview: <PaneArrangementPreview arrangement="editor" /> },
                                    ]}
                                />
                            }
                        />
                    </SettingAnchor>
                ) : null}
                {/* Where the right panels stand, beside the arrangement it shapes (calm-shell R4-2). */}
                {panelsSupported && deviceType !== 'phone' ? (
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.rightPanelPlacement}>
                        <Item
                            title={t(APPEARANCE_SETTINGS.settings.rightPanelPlacement.titleKey)}
                            subtitle={t('settingsAppearance.rightPanelPlacementDescription')}
                            subtitleLines={0}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={
                                <SelectionTiles
                                    variant="visual"
                                    tileSizing="fill"
                                    accessibilityLabel={t(APPEARANCE_SETTINGS.settings.rightPanelPlacement.titleKey)}
                                    testIdPrefix="settings-appearance-rightPanelPlacement"
                                    value={rightPanelPlacement}
                                    onChange={(next) => { if (next === 'separate' || next === 'line' || next === 'shadow') setRightPanelPlacement(next); }}
                                    options={[
                                        { id: 'separate', title: t('settingsAppearance.rightPanelPlacementSeparate'), subtitle: t('settingsAppearance.rightPanelPlacementSeparateCaption'), preview: <PaneArrangementPreview arrangement="session" rightPanel="separate" /> },
                                        { id: 'line', title: t('settingsAppearance.rightPanelPlacementLine'), subtitle: t('settingsAppearance.rightPanelPlacementLineCaption'), preview: <PaneArrangementPreview arrangement="session" rightPanel="line" /> },
                                        { id: 'shadow', title: t('settingsAppearance.rightPanelPlacementShadow'), subtitle: t('settingsAppearance.rightPanelPlacementShadowCaption'), preview: <PaneArrangementPreview arrangement="session" rightPanel="shadow" /> },
                                    ]}
                                />
                            }
                        />
                    </SettingAnchor>
                ) : null}
                {panelsSupported ? (
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.editorTabs}>
                        <SegmentedChoiceItem
                            title={t(APPEARANCE_SETTINGS.settings.editorTabs.titleKey)}
                            subtitle={t('settingsAppearance.detailsPaneTabsBehaviorDescription')}
                            subtitleLines={0}
                            testIDPrefix="settings-appearance-detailsTabs"
                            options={toChoices<DetailsPaneTabsBehavior>(detailsTabsMenuItems)}
                            value={detailsPaneTabsBehavior}
                            onChange={setDetailsPaneTabsBehavior}
                        />
                    </SettingAnchor>
                ) : null}
                {panelsSupported ? (
                    <SettingRow
                        setting={APPEARANCE_SETTINGS.settings.settingsSidebar}
                        testID="settings-appearance-settings-nav-sidebar-enabled"
                        subtitleLines={0}
                        onPress={() => setSettingsNavSidebarEnabled(!settingsNavSidebarEnabled)}
                        rightElement={
                            <Switch
                                testID="settings-appearance-settings-nav-sidebar-enabled.switch"
                                value={settingsNavSidebarEnabled}
                                onValueChange={setSettingsNavSidebarEnabled}
                            />
                        }
                        showChevron={false}
                    />
                ) : null}
                {/* Home's sections are arranged on Home itself, by its own Customize. */}
                <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.home}>
                    <SettingRow
                        setting={APPEARANCE_SETTINGS.settings.homeSections}
                        testID="settings-appearance-customize-home"
                        icon={<Icon name="house" />}
                        subtitleLines={0}
                        onPress={() => {
                            requestHomeCustomize();
                            router.push('/home');
                        }}
                    />
                </SettingSection>
                {/* The Machine summary's look lives with the machines it summarizes. */}
                <Item
                    testID="settings-appearance-machine-summary"
                    title={t('machineSummary.settingTitle')}
                    icon={<Icon name="hard-drives" />}
                    detail={machineSummaryStyleTitle(machineSummaryStyle)}
                    onPress={() => router.push(buildSettingHref(SETTINGS_ROUTES.machineDefaults, APPEARANCE_SETTINGS.settings.machineSummaryStyle))}
                />
            </ItemGroup>
            </SettingSection>

            {/* How sessions look */}
            <ItemGroup title={t('tabs.sessions')}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.avatarStyle}>
                    <Item
                        title={t(APPEARANCE_SETTINGS.settings.avatarStyle.titleKey)}
                        subtitle={t('settingsAppearance.avatarStyleDescription')}
                        subtitleLines={0}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={
                            <SelectionTiles
                                variant="visual"
                                accessibilityLabel={t('settingsAppearance.avatarStyle')}
                                testIdPrefix="settings-appearance-avatarStyle"
                                value={displayStyle}
                                onChange={(next) => {
                                    if (next && isKnownAvatarStyle(next)) setAvatarStyle(next);
                                }}
                                options={[
                                    { id: 'pixelated', title: t('settingsAppearance.avatarOptions.pixelated'), preview: <AvatarStylePreview style="pixelated" /> },
                                    { id: 'gradient', title: t('settingsAppearance.avatarOptions.gradient'), preview: <AvatarStylePreview style="gradient" /> },
                                    { id: 'brutalist', title: t('settingsAppearance.avatarOptions.brutalist'), preview: <AvatarStylePreview style="brutalist" /> },
                                ]}
                            />
                        }
                    />
                </SettingAnchor>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.agentIcons}
                    subtitleLines={0}
                    rightElement={<Switch value={showFlavorIcons} onValueChange={setShowFlavorIcons} />}
                    showChevron={false}
                />
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.contextGaugeStyle}>
                <SegmentedChoiceItem
                    title={t(APPEARANCE_SETTINGS.settings.contextGaugeStyle.titleKey)}
                    subtitle={t('settingsAppearance.visualEffects.contextGaugeDescription')}
                    subtitleLines={0}
                    testID="settings-appearance-contextGaugeStyle-select"
                    testIDPrefix="settings-appearance-contextGaugeStyle"
                    options={toChoices<'gauge' | 'text' | 'hidden'>(contextGaugeMenuItems)}
                    value={contextGaugeStyle}
                    onChange={setContextGaugeStyle}
                />
                </SettingAnchor>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.alwaysShowContextSize}
                    subtitleLines={0}
                    rightElement={
                        <Switch
                            testID="settings-appearance-alwaysShowContextSize-switch"
                            value={alwaysShowContextSize}
                            onValueChange={setAlwaysShowContextSize}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Rarely changed families, each on its own page; the row says what is chosen now. */}
            <ItemGroup title={t('settingsAppearance.materialsAndMotion')}>
                <Item
                    testID="settings-appearance-glass"
                    title={t('settingsAppearance.glassControls.sectionTitle')}
                    icon={<Icon name="circle-half" />}
                    detail={glassSummary}
                    onPress={() => router.push(SETTINGS_ROUTES.appearanceGlass)}
                />
                <Item
                    testID="settings-appearance-moments"
                    title={t('settingsAppearance.glassControls.moments')}
                    icon={<Icon name="sparkle" />}
                    detail={momentsSummary}
                    onPress={() => router.push(SETTINGS_ROUTES.appearanceMoments)}
                />
                <Item
                    testID="settings-appearance-widgets"
                    title={t('settingsAppearance.widgetsAndSurfaces')}
                    icon={<Icon name="squares-four" />}
                    detail={widgetsSummary}
                    onPress={() => router.push(SETTINGS_ROUTES.appearanceWidgets)}
                />
                <Item
                    testID="settings-appearance-motion"
                    title={t('settingsAppearance.visualEffects.title')}
                    icon={<Icon name="play-circle" />}
                    detail={motionSummary}
                    onPress={() => router.push(SETTINGS_ROUTES.appearanceMotion)}
                />
            </ItemGroup>

            {/* Tab bar (phones and tablets) */}
            <ItemGroup title={t('settingsAppearance.tabBarAppearance.title')} description={t('settingsAppearance.tabBarAppearance.footer')}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.tabBarSize}>
                    <SegmentedChoiceItem
                        title={t(APPEARANCE_SETTINGS.settings.tabBarSize.titleKey)}
                        testID="settings-appearance-tabBarSize-select"
                        testIDPrefix="settings-appearance-tabBarSize"
                        options={toChoices<'compact' | 'regular' | 'large'>(tabBarSizeMenuItems)}
                        value={tabBarSize}
                        onChange={setTabBarSize}
                    />
                </SettingAnchor>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.tabBarLabels}
                    rightElement={
                        <Switch
                            testID="settings-appearance-tabBarShowLabels-switch"
                            value={tabBarShowLabels}
                            onValueChange={setTabBarShowLabels}
                        />
                    }
                    showChevron={false}
                />
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.tabBarBadges}>
                <ExpandableItem
                    expanded={badgesExpanded}
                    onExpandedChange={setBadgesExpanded}
                    reducedMotion={reduceMotion}
                    header={({ headerProps }) => (
                        <Item
                            {...headerProps}
                            testID="settings-appearance-badges-toggle"
                            title={t('settingsAppearance.tabBarBadges.title')}
                            subtitle={t('settingsAppearance.tabBarBadges.footer')}
                            subtitleLines={0}
                            detail={badgesExpanded ? undefined : badgesSummary}
                        />
                    )}
                >
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.tabBarGitBadge}>
                    <SegmentedChoiceItem
                        title={t('settingsAppearance.tabBarBadges.gitTitle')}
                        testID="settings-appearance-tabBarGitBadge-select"
                        testIDPrefix="settings-appearance-tabBarGitBadge"
                        options={toChoices<'changedFiles' | 'diffLines' | 'off'>(gitBadgeMenuItems)}
                        value={tabBarGitBadgeMode}
                        onChange={setTabBarGitBadgeMode}
                    />
                    </SettingAnchor>
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.tabBarFriendsBadge}>
                    <Item
                        title={t('tabs.friends')}
                        rightElement={<Switch testID="settings-appearance-tabBarFriendsBadge-switch" value={tabBarFriendsBadgeEnabled} onValueChange={setTabBarFriendsBadgeEnabled} />}
                        showChevron={false}
                    />
                    </SettingAnchor>
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.tabBarSessionsBadge}>
                    <Item
                        title={t('tabs.sessions')}
                        rightElement={<Switch testID="settings-appearance-tabBarSessionsBadge-switch" value={tabBarSessionsBadgeEnabled} onValueChange={setTabBarSessionsBadgeEnabled} />}
                        showChevron={false}
                    />
                    </SettingAnchor>
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.tabBarInboxBadge}>
                    <Item
                        title={t('tabs.inbox')}
                        rightElement={<Switch testID="settings-appearance-tabBarInboxBadge-switch" value={tabBarInboxBadgeEnabled} onValueChange={setTabBarInboxBadgeEnabled} />}
                        showChevron={false}
                    />
                    </SettingAnchor>
                    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.tabBarOpenTabsBadge}>
                    <Item
                        title={t('common.tabs')}
                        rightElement={<Switch testID="settings-appearance-tabBarOpenTabsBadge-switch" value={tabBarOpenTabsBadgeEnabled} onValueChange={setTabBarOpenTabsBadgeEnabled} />}
                        showChevron={false}
                    />
                    </SettingAnchor>
                </ExpandableItem>
                </SettingAnchor>
            </ItemGroup>

            {/* Privacy: one device-local setting, mirrored by the eye on Connected services and the Usage popover. */}
            <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.privacy}>
            <ItemGroup title={t('connectedServicesCollection.privacyTitle')}>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.hideAccountIdentities}
                    subtitleLines={0}
                    rightElement={(
                        <Switch
                            testID="settings-appearance-hideAccountIdentities-switch"
                            value={hideConnectedAccountIdentities}
                            onValueChange={setHideConnectedAccountIdentities}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>
            </SettingSection>

            {/* Replay comes after the choices it teaches, so Theme stays the page's first decision. It sits on
                a sheet like every other row: alone on the canvas it read as a stray line (fidelity review 1). */}
            <ItemGroup>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.personalize}
                    testID="settings-appearance-personalize"
                    subtitle={t('personalize.replaySubtitle')}
                    showChevron={false}
                    onPress={() => openPersonalize('look')}
                    rightElementOutsidePressable
                    rightElement={<RoundButton testID="settings-appearance-personalize.start"
                        display="inverted" title={t('personalize.replayAction')} onPress={() => openPersonalize('look')} />}
                />
            </ItemGroup>

            {/* Language */}
            <ItemGroup title={t('settingsLanguage.title')} description={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Icon name="translate" />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>
            </>)}
            </PageAsideColumns>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    themesSummary: {
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    themeName: Typography.default('semiBold'),
    resetText: {
        color: theme.colors.text.secondary,
    },
    // The small and large letter at the ends of the text size slider show what the scale does.
    textSizeGlyph: {
        color: theme.colors.text.secondary,
    },
    textSizeGlyphSmall: {
        fontSize: 11,
        lineHeight: 14,
    },
    textSizeGlyphLarge: {
        fontSize: 17,
        lineHeight: 20,
    },
}));
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
