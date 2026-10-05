import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ThemeModePreview } from '@/components/settings/appearance/ThemeModePreview';
import { GlassAppearanceSection } from '@/components/settings/appearance/GlassAppearanceControls';
import { AvatarStylePreview } from '@/components/settings/appearance/AvatarStylePreview';
import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { HomeLayoutEditor } from '@/components/hub/layout/HomeLayoutEditor';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useOpenPersonalize } from '@/components/onboarding/personalize/useOpenPersonalize';
import * as Localization from 'expo-localization';
import { Switch } from '@/components/ui/forms/Switch';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Slider } from '@/components/ui/forms/Slider';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { ItemDensityChoiceRow } from '@/components/settings/appearance/ItemDensityPreview';
import { WidgetFrameAppearanceSection } from '@/components/settings/appearance/WidgetFrameAppearanceSection';
import { resolveAppearanceDefaults } from '@/components/settings/appearance/appearanceDefaults';
import { buildThemePresetSourceOptions } from '@/components/settings/appearance/themeProfiles/themeProfilePresetOptions';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveThemeMode, useApplyThemeSelection } from '@/components/settings/appearance/useApplyThemeSelection';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
    clearActiveThemeProfiles,
} from '@/theme/profiles/themeProfilePersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import {
    HAPPIER_SPINNER_PAUSE_IDS,
    HAPPIER_SPINNER_SPEED_IDS,
    HAPPIER_SPINNER_STYLE_IDS,
    happierSpinnerStyleTimingControls,
    isHappierSpinnerStyleId,
    normalizeHappierSpinnerStyleId,
    type HappierSpinnerPauseId,
    type HappierSpinnerSpeedId,
} from '@happier-dev/plugin-ui/presentation';
import {
    LOADING_INDICATOR_STYLE_LABEL_KEYS,
    LoadingIndicatorStylePreview,
} from '@/components/settings/appearance/LoadingIndicatorStylePreview';

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
    const applyLocalSettings = useApplyLocalSettings();
    const applySettings = useApplySettings();
    const deviceType = useDeviceType();
    const panelsSupported = Platform.OS === 'web' || deviceType === 'tablet';
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const [uiContentWidthMode, setUiContentWidthMode] = useLocalSettingMutable('uiContentWidthMode');
    const [uiItemDensity, setUiItemDensity] = useLocalSettingMutable('uiItemDensity');
    const [loadingIndicatorStyle, setLoadingIndicatorStyle] = useLocalSettingMutable('loadingIndicatorStyle');
    const [loadingIndicatorSpeed, setLoadingIndicatorSpeed] = useLocalSettingMutable('loadingIndicatorSpeed');
    const [loadingIndicatorPause, setLoadingIndicatorPause] = useLocalSettingMutable('loadingIndicatorPause');
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
    const [visualEffectsLevel, setVisualEffectsLevel] = useSettingMutable('visualEffectsLevel');
    const [contextGaugeStyle, setContextGaugeStyle] = useSettingMutable('contextGaugeStyle');
    const [animatedNumbers, setAnimatedNumbers] = useSettingMutable('animatedNumbers');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [badgesExpanded, setBadgesExpanded] = React.useState(false);
    const reduceMotion = useReducedMotionPreference();
    const safeThemeProfiles = themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE;
    // The Themes row summarizes the library: which theme each mode uses and how many there are. The
    // library screen owns choosing them.
    const themesSummary = React.useMemo(() => {
        const options = buildThemePresetSourceOptions(safeThemeProfiles);
        const nameFor = (profileId: string | null) => {
            const option = profileId ? options.find((candidate) => candidate.id === profileId) : null;
            return option?.title ?? t('settingsAppearance.themeProfiles.defaultTheme');
        };
        const custom = options.filter((option) => option.kind === 'custom').length;
        return {
            slots: t('settingsAppearance.themesSummary', {
                light: nameFor(safeThemeProfiles.activeProfileIds.light),
                dark: nameFor(safeThemeProfiles.activeProfileIds.dark),
            }),
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

    const visualEffectsLevelMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        return [
            {
                id: 'full',
                title: t('settingsAppearance.visualEffects.levelOptions.full'),
                subtitle: t('settingsAppearance.visualEffects.levelOptions.fullDescription'),
            },
            {
                id: 'subtle',
                title: t('settingsAppearance.visualEffects.levelOptions.subtle'),
                subtitle: t('settingsAppearance.visualEffects.levelOptions.subtleDescription'),
            },
            {
                id: 'minimal',
                title: t('settingsAppearance.visualEffects.levelOptions.minimal'),
                subtitle: t('settingsAppearance.visualEffects.levelOptions.minimalDescription'),
            },
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

    const loadingIndicatorOptions = React.useMemo(() => {
        return HAPPIER_SPINNER_STYLE_IDS.map((styleId) => ({
            id: styleId,
            title: t(LOADING_INDICATOR_STYLE_LABEL_KEYS[styleId]),
            preview: <LoadingIndicatorStylePreview styleId={styleId} />,
        }));
    }, []);

    const loadingIndicatorSpeedChoices = React.useMemo(() => HAPPIER_SPINNER_SPEED_IDS.map((id) => ({
        id,
        label: t(`settingsAppearance.loadingIndicatorSpeedOptions.${id}`),
    })), []);

    const loadingIndicatorPauseChoices = React.useMemo(() => HAPPIER_SPINNER_PAUSE_IDS.map((id) => ({
        id,
        label: t(`settingsAppearance.loadingIndicatorPauseOptions.${id}`),
    })), []);

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
        const confirmed = await Modal.confirm(
            t('settingsAppearance.resetConfirmTitle'),
            t('settingsAppearance.resetConfirmBody'),
            { confirmText: t('common.reset') },
        );
        if (!confirmed) return;
        const defaults = resolveAppearanceDefaults();
        // Custom themes are the user's own content; only which theme each mode uses goes back.
        await applyThemeSelection(defaults.themePreference, clearActiveThemeProfiles(safeThemeProfiles));
        applyLocalSettings(defaults.local);
        applySettings(defaults.account);
    }, [applyLocalSettings, applySettings, applyThemeSelection, safeThemeProfiles]);

    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';
    const displayLoadingIndicatorStyle = normalizeHappierSpinnerStyleId(loadingIndicatorStyle);
    // A timing choice the chosen style ignores stays visible but disabled, and says why once: the
    // Classic Ring's note on Speed also covers the Pause row beneath it.
    const loadingIndicatorTiming = happierSpinnerStyleTimingControls(displayLoadingIndicatorStyle);
    
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
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader
                description={t('settingsAppearance.pageDescription')}
                actions={
                    <RoundButton
                        testID="settings-appearance-reset"
                        size="small"
                        display="inverted"
                        title={t('common.reset')}
                        leading={<Icon name="arrow-arc-left" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                        textStyle={styles.resetText}
                        onPress={resetToDefaults}
                    />
                }
            />

            {/* Personalize Happier: the guided walk through the same choices, replayable here (lab R3). */}
            <ItemGroup>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.personalize}
                    testID="settings-appearance-personalize"
                    icon={<Icon name="palette" />}
                    subtitle={t('personalize.replaySubtitle')}
                    showChevron={false}
                    onPress={() => openPersonalize('look')}
                    rightElementOutsidePressable
                    rightElement={(
                        <RoundButton
                            testID="settings-appearance-personalize.start"
                            size="small"
                            display="secondary"
                            title={t('personalize.replayAction')}
                            onPress={() => openPersonalize('look')}
                        />
                    )}
                />
            </ItemGroup>

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
                    subtitle={narrowWindow ? `${themesSummary.slots}\n${themesSummary.count}` : themesSummary.slots}
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

            <GlassAppearanceSection />

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
            </ItemGroup>
            </SettingSection>

            {/* The home beside the session list: the same editor as the home's "Customize home". */}
            <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.home}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.homeSections}>
                    <HomeLayoutEditor title={t(APPEARANCE_SETTINGS.settings.homeSections.titleKey)} />
                </SettingAnchor>
            </SettingSection>

            {/* How widgets are framed on this device: Home, Board and Companion, Card | Plain. */}
            <WidgetFrameAppearanceSection />

            {/* Motion & depth: effects, animated numbers, and the blur behind layered surfaces. */}
            <ItemGroup
                title={t('settingsAppearance.visualEffects.title')}
                description={reduceMotion
                    ? t('settingsAppearance.visualEffects.reduceMotionActive')
                    : t('settingsAppearance.visualEffects.footer')}
            >
                <SegmentedChoiceItem
                    title={t('settingsAppearance.visualEffects.level')}
                    subtitle={t('settingsAppearance.visualEffects.levelDescription')}
                    subtitleLines={0}
                    testID="settings-appearance-visualEffectsLevel-select"
                    testIDPrefix="settings-appearance-visualEffectsLevel"
                    options={toChoices<'full' | 'subtle' | 'minimal'>(visualEffectsLevelMenuItems)}
                    value={visualEffectsLevel}
                    onChange={setVisualEffectsLevel}
                />
                <Item
                    title={t('settingsAppearance.visualEffects.animatedNumbers')}
                    subtitle={t('settingsAppearance.visualEffects.animatedNumbersDescription')}
                    subtitleLines={0}
                    rightElement={
                        <Switch
                            testID="settings-appearance-animatedNumbers-switch"
                            value={animatedNumbers}
                            onValueChange={setAnimatedNumbers}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

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
                <SegmentedChoiceItem
                    title={t('settingsAppearance.visualEffects.contextGauge')}
                    subtitle={t('settingsAppearance.visualEffects.contextGaugeDescription')}
                    subtitleLines={0}
                    testID="settings-appearance-contextGaugeStyle-select"
                    testIDPrefix="settings-appearance-contextGaugeStyle"
                    options={toChoices<'gauge' | 'text' | 'hidden'>(contextGaugeMenuItems)}
                    value={contextGaugeStyle}
                    onChange={setContextGaugeStyle}
                />
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

            <ItemGroup title={t('settingsAppearance.loadingIndicator')} description={t('settingsAppearance.loadingIndicatorFooter')}>
                <SettingRow
                    setting={APPEARANCE_SETTINGS.settings.loadingIndicatorStyle}
                    accessoryLayout="stacked"
                    rightElement={
                        <SelectionTiles
                            variant="visual"
                            accessibilityLabel={t(APPEARANCE_SETTINGS.settings.loadingIndicatorStyle.titleKey)}
                            testIdPrefix="settings-appearance-loadingIndicator"
                            value={displayLoadingIndicatorStyle}
                            options={loadingIndicatorOptions}
                            onChange={(next) => {
                                if (isHappierSpinnerStyleId(next)) setLoadingIndicatorStyle(next);
                            }}
                        />
                    }
                    showChevron={false}
                />
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.loadingIndicatorSpeed}>
                    <SegmentedChoiceItem<HappierSpinnerSpeedId>
                        title={t(APPEARANCE_SETTINGS.settings.loadingIndicatorSpeed.titleKey)}
                        subtitle={loadingIndicatorTiming.speed
                            ? t('settingsAppearance.loadingIndicatorSpeedDescription')
                            : t('settingsAppearance.loadingIndicatorSpeedUnavailable')}
                        subtitleLines={0}
                        testIDPrefix="settings-appearance-loadingIndicatorSpeed"
                        options={loadingIndicatorSpeedChoices}
                        value={loadingIndicatorSpeed}
                        onChange={setLoadingIndicatorSpeed}
                        disabled={!loadingIndicatorTiming.speed}
                    />
                </SettingAnchor>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.loadingIndicatorPause}>
                    <SegmentedChoiceItem<HappierSpinnerPauseId>
                        title={t(APPEARANCE_SETTINGS.settings.loadingIndicatorPause.titleKey)}
                        subtitle={loadingIndicatorTiming.pause || !loadingIndicatorTiming.speed
                            ? t('settingsAppearance.loadingIndicatorPauseDescription')
                            : t('settingsAppearance.loadingIndicatorPauseUnavailable')}
                        subtitleLines={0}
                        testIDPrefix="settings-appearance-loadingIndicatorPause"
                        options={loadingIndicatorPauseChoices}
                        value={loadingIndicatorPause}
                        onChange={setLoadingIndicatorPause}
                        disabled={!loadingIndicatorTiming.pause}
                    />
                </SettingAnchor>
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
                    <SegmentedChoiceItem
                        title={t('settingsAppearance.tabBarBadges.gitTitle')}
                        testID="settings-appearance-tabBarGitBadge-select"
                        testIDPrefix="settings-appearance-tabBarGitBadge"
                        options={toChoices<'changedFiles' | 'diffLines' | 'off'>(gitBadgeMenuItems)}
                        value={tabBarGitBadgeMode}
                        onChange={setTabBarGitBadgeMode}
                    />
                    <Item
                        title={t('tabs.friends')}
                        rightElement={<Switch testID="settings-appearance-tabBarFriendsBadge-switch" value={tabBarFriendsBadgeEnabled} onValueChange={setTabBarFriendsBadgeEnabled} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('tabs.sessions')}
                        rightElement={<Switch testID="settings-appearance-tabBarSessionsBadge-switch" value={tabBarSessionsBadgeEnabled} onValueChange={setTabBarSessionsBadgeEnabled} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('tabs.inbox')}
                        rightElement={<Switch testID="settings-appearance-tabBarInboxBadge-switch" value={tabBarInboxBadgeEnabled} onValueChange={setTabBarInboxBadgeEnabled} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('common.tabs')}
                        rightElement={<Switch testID="settings-appearance-tabBarOpenTabsBadge-switch" value={tabBarOpenTabsBadgeEnabled} onValueChange={setTabBarOpenTabsBadgeEnabled} />}
                        showChevron={false}
                    />
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

            {/* Language */}
            <ItemGroup title={t('settingsLanguage.title')} description={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Icon name="translate" />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
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
