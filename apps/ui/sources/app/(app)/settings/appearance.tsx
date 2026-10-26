import React from 'react';
import { Appearance, Platform, View } from 'react-native';
import { setStatusBarStyle } from 'expo-status-bar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ThemeSelectionDropdown, type ThemeSelectionOption } from '@/components/settings/appearance/themeProfiles/ThemeSelectionDropdown';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useWindowFoldMetrics } from '@/utils/platform/useWindowFoldMetrics';
import {
    AVATAR_STYLE_OPTIONS,
    isAvatarStyleId,
    normalizeAvatarStyleId,
} from '@/components/ui/avatar/avatarStyleOptions';
import { getGeneratedAvatarComponentForStyle } from '@/components/ui/avatar/avatarComponentRegistry';
import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import { resolveStatusBarStyleForThemePreference } from '@/components/ui/layout/statusBarStyle';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { runThemePreferenceChange } from '@/components/settings/appearance/themePreferenceTransition';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
    findActiveThemeProfileForMode,
    setActiveThemeProfileForMode,
} from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { Icon } from '@/components/ui/icons/Icon';
import { isNativeBlurAvailable } from '@/components/ui/glass/blurMaterial';
import {
    LOADING_INDICATOR_STYLE_LABEL_KEYS,
    LoadingIndicatorStylePreview,
} from '@/components/settings/appearance/LoadingIndicatorStylePreview';
import { loadingIndicatorTimingControls } from '@/components/ui/feedback/activitySpinner/dotSpinnerStyles';
import {
    isLoadingIndicatorStyleId,
    LOADING_INDICATOR_PAUSE_IDS,
    LOADING_INDICATOR_SPEED_IDS,
    LOADING_INDICATOR_STYLE_IDS,
    LoadingIndicatorPauseIdSchema,
    LoadingIndicatorSpeedIdSchema,
    normalizeLoadingIndicatorStyleId,
} from '@/sync/domains/settings/registry/local/loadingIndicatorStyleSetting';

const UI_FONT_SCALE_PRESETS = {
    xxsmall: 0.8,
    xsmall: 0.85,
    small: 0.93,
    default: 1,
    large: 1.1,
    xlarge: 1.2,
    xxlarge: 1.3,
} as const;

type UiFontScalePresetId = keyof typeof UI_FONT_SCALE_PRESETS;
type UiItemDensity = LocalSettings['uiItemDensity'];
type DetailsPaneTabsBehavior = LocalSettings['detailsPaneTabsBehavior'];

const isUiFontScalePresetId = (value: string): value is UiFontScalePresetId => (
    Object.prototype.hasOwnProperty.call(UI_FONT_SCALE_PRESETS, value)
);

const isUiItemDensity = (value: string): value is UiItemDensity => (
    value === 'comfortable' || value === 'cozy' || value === 'compact'
);

const isDetailsPaneTabsBehavior = (value: string): value is DetailsPaneTabsBehavior => (
    value === 'preview' || value === 'persistent'
);

function AvatarStylePreviewIcon(props: Readonly<{ styleId: AvatarStyleId }>) {
    const AvatarStyleComponent = getGeneratedAvatarComponentForStyle(props.styleId);

    return (
        <View style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}>
            <AvatarStyleComponent
                id={`settings-avatar-style-preview-${props.styleId}`}
                styleId={props.styleId}
                size={28}
            />
        </View>
    );
}

export default React.memo(function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const deviceType = useDeviceType();
    const foldMetrics = useWindowFoldMetrics();
    const [systemTabBarEnabled, setSystemTabBarEnabled] = useLocalSettingMutable('systemTabBarEnabled');
    const reduceMotion = useReducedMotionPreference();
    const panelsSupported = Platform.OS === 'web' || deviceType === 'tablet';
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [showChatCodeBlockWrapControls, setShowChatCodeBlockWrapControls] = useSettingMutable('showChatCodeBlockWrapControls');
    const [wrapChatCodeBlocks, setWrapChatCodeBlocks] = useSettingMutable('wrapChatCodeBlocks');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles, setThemeProfiles] = useLocalSettingMutable('themeProfiles');
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const [uiItemDensity, setUiItemDensity] = useLocalSettingMutable('uiItemDensity');
    const [loadingIndicatorStyle, setLoadingIndicatorStyle] = useLocalSettingMutable('loadingIndicatorStyle');
    const [loadingIndicatorSpeed, setLoadingIndicatorSpeed] = useLocalSettingMutable('loadingIndicatorSpeed');
    const [loadingIndicatorPause, setLoadingIndicatorPause] = useLocalSettingMutable('loadingIndicatorPause');
    const [uiContentWidthMode, setUiContentWidthMode] = useLocalSettingMutable('uiContentWidthMode');
    const [uiMultiPanePanelsEnabled, setUiMultiPanePanelsEnabled] = useLocalSettingMutable('uiMultiPanePanelsEnabled');
    const [uiBackdropBlurEnabled, setUiBackdropBlurEnabled] = useLocalSettingMutable('uiBackdropBlurEnabled');
    const [hapticsEnabled, setHapticsEnabled] = useLocalSettingMutable('hapticsEnabled');
    const [detailsPaneTabsBehavior, setDetailsPaneTabsBehavior] = useLocalSettingMutable('detailsPaneTabsBehavior');
    const [tabBarGitBadgeMode, setTabBarGitBadgeMode] = useSettingMutable('tabBarGitBadgeMode');
    const [tabBarFriendsBadgeEnabled, setTabBarFriendsBadgeEnabled] = useSettingMutable('tabBarFriendsBadgeEnabled');
    const [tabBarInboxBadgeEnabled, setTabBarInboxBadgeEnabled] = useSettingMutable('tabBarInboxBadgeEnabled');
    const [tabBarOpenTabsBadgeEnabled, setTabBarOpenTabsBadgeEnabled] = useSettingMutable('tabBarOpenTabsBadgeEnabled');
    const [tabBarShowLabels, setTabBarShowLabels] = useSettingMutable('tabBarShowLabels');
    const [tabBarSize, setTabBarSize] = useSettingMutable('tabBarSize');
    const [glassBlurEnabled, setGlassBlurEnabled] = useSettingMutable('glassBlurEnabled');
    const [glassBlurIntensity, setGlassBlurIntensity] = useSettingMutable('glassBlurIntensity');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [openTextSizeMenu, setOpenTextSizeMenu] = React.useState(false);
    const [openThemeMenu, setOpenThemeMenu] = React.useState(false);
    const [openLightThemeMenu, setOpenLightThemeMenu] = React.useState(false);
    const [openDarkThemeMenu, setOpenDarkThemeMenu] = React.useState(false);
    const [openItemDensityMenu, setOpenItemDensityMenu] = React.useState(false);
    const [openContentWidthMenu, setOpenContentWidthMenu] = React.useState(false);
    const [openDetailsTabsMenu, setOpenDetailsTabsMenu] = React.useState(false);
    const [openAvatarStyleMenu, setOpenAvatarStyleMenu] = React.useState(false);
    const [openLoadingIndicatorMenu, setOpenLoadingIndicatorMenu] = React.useState(false);
    const [openLoadingIndicatorSpeedMenu, setOpenLoadingIndicatorSpeedMenu] = React.useState(false);
    const [openLoadingIndicatorPauseMenu, setOpenLoadingIndicatorPauseMenu] = React.useState(false);
    const [openGitBadgeMenu, setOpenGitBadgeMenu] = React.useState(false);
    const [openTabBarSizeMenu, setOpenTabBarSizeMenu] = React.useState(false);
    const [openGlassBlurMenu, setOpenGlassBlurMenu] = React.useState(false);
    const safeThemeProfiles = themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE;
    const activeLightThemeProfile = React.useMemo(
        () => findActiveThemeProfileForMode(safeThemeProfiles, 'light'),
        [safeThemeProfiles],
    );
    const activeDarkThemeProfile = React.useMemo(
        () => findActiveThemeProfileForMode(safeThemeProfiles, 'dark'),
        [safeThemeProfiles],
    );
    const activeThemeProfilesSubtitle = React.useMemo(() => {
        const defaultTheme = t('settingsAppearance.themeProfiles.defaultTheme');
        return `${activeLightThemeProfile?.name ?? defaultTheme} / ${activeDarkThemeProfile?.name ?? defaultTheme}`;
    }, [activeDarkThemeProfile?.name, activeLightThemeProfile?.name]);
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

    const avatarStyleMenuItems = React.useMemo(() => {
        return AVATAR_STYLE_OPTIONS.map((option) => ({
            id: option.id,
            title: t(option.labelKey),
            icon: <AvatarStylePreviewIcon styleId={option.id} />,
        }));
    }, []);

    const loadingIndicatorMenuItems = React.useMemo(() => {
        return LOADING_INDICATOR_STYLE_IDS.map((styleId) => ({
            id: styleId,
            title: t(LOADING_INDICATOR_STYLE_LABEL_KEYS[styleId]),
            icon: <LoadingIndicatorStylePreview styleId={styleId} />,
        }));
    }, []);

    const loadingIndicatorSpeedMenuItems = React.useMemo(() => LOADING_INDICATOR_SPEED_IDS.map((id) => ({
        id,
        title: t(`settingsAppearance.loadingIndicatorSpeedOptions.${id}`),
    })), []);

    const loadingIndicatorPauseMenuItems = React.useMemo(() => LOADING_INDICATOR_PAUSE_IDS.map((id) => ({
        id,
        title: t(`settingsAppearance.loadingIndicatorPauseOptions.${id}`),
    })), []);

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

    const glassBlurIntensityMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        return [
            { id: 'light', title: t('settingsAppearance.glass.intensityLight') },
            { id: 'regular', title: t('settingsAppearance.glass.intensityRegular') },
            { id: 'strong', title: t('settingsAppearance.glass.intensityStrong') },
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

    const contentWidthMenuItems = React.useMemo(() => {
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

    const selectUiFontSize = React.useCallback((itemId: string) => {
        if (!isUiFontScalePresetId(itemId)) return;
        setUiFontScale(UI_FONT_SCALE_PRESETS[itemId]);
    }, [setUiFontScale]);

    const applyThemeSelection = React.useCallback((nextThemePreference: 'adaptive' | 'light' | 'dark', nextThemeProfiles: ThemeProfilesLocalStateV1) => {
        const systemTheme = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
        void runThemePreferenceChange({
            currentPreference: themePreference,
            nextPreference: nextThemePreference,
            platform: Platform.OS,
            reduceMotion,
            forceAnimate: true,
            systemTheme,
            mutation: () => {
                setThemePreference(nextThemePreference);
                setThemeProfiles(nextThemeProfiles);
                applyThemeRuntimeSelection({
                    themePreference: nextThemePreference,
                    themeProfiles: nextThemeProfiles,
                    systemTheme,
                });
                setStatusBarStyle(resolveStatusBarStyleForThemePreference(nextThemePreference, systemTheme), true);
            },
        });
    }, [reduceMotion, setThemePreference, setThemeProfiles, themePreference]);

    const selectCurrentTheme = React.useCallback((option: ThemeSelectionOption) => {
        if (option.kind === 'adaptive') {
            applyThemeSelection('adaptive', safeThemeProfiles);
            return;
        }

        applyThemeSelection(
            option.preferredMode,
            setActiveThemeProfileForMode(
                safeThemeProfiles,
                option.preferredMode,
                option.kind === 'base' ? null : option.id,
            ),
        );
    }, [applyThemeSelection, safeThemeProfiles]);

    const selectThemeProfileForMode = React.useCallback((mode: ThemeProfileMode, profileId: string | null) => {
        applyThemeSelection(themePreference, setActiveThemeProfileForMode(safeThemeProfiles, mode, profileId));
    }, [applyThemeSelection, safeThemeProfiles, themePreference]);

    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle = normalizeAvatarStyleId(avatarStyle);
    const displayLoadingIndicatorStyle = normalizeLoadingIndicatorStyleId(loadingIndicatorStyle);
    // A timing choice the chosen style ignores stays visible but disabled, and says why once: the
    // Classic Ring's note on Speed also covers the Pause row beneath it.
    const loadingIndicatorTiming = loadingIndicatorTimingControls(displayLoadingIndicatorStyle);
    
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
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t('settingsAppearance.themeDescription')}>
                <ThemeSelectionDropdown
                    open={openThemeMenu}
                    onOpenChange={setOpenThemeMenu}
                    variant="current"
                    themePreference={themePreference}
                    themeProfiles={safeThemeProfiles}
                    onSelectTheme={selectCurrentTheme}
                />
                {themePreference === 'adaptive' ? (
                    <>
                        <ThemeSelectionDropdown
                            open={openLightThemeMenu}
                            onOpenChange={setOpenLightThemeMenu}
                            variant="slot"
                            mode="light"
                            themeProfiles={safeThemeProfiles}
                            onSelectProfile={(profileId) => selectThemeProfileForMode('light', profileId)}
                        />
                        <ThemeSelectionDropdown
                            open={openDarkThemeMenu}
                            onOpenChange={setOpenDarkThemeMenu}
                            variant="slot"
                            mode="dark"
                            themeProfiles={safeThemeProfiles}
                            onSelectProfile={(profileId) => selectThemeProfileForMode('dark', profileId)}
                        />
                    </>
                ) : null}
                <Item
                    testID="settings-appearance-themeProfiles"
                    title={t('settingsAppearance.themeProfiles.title')}
                    subtitle={activeThemeProfilesSubtitle}
                    icon={<Icon name="palette" size={29} color={theme.colors.accent.indigo} />}
                    detail={activeLightThemeProfile || activeDarkThemeProfile
                        ? t('settingsAppearance.themeProfiles.active')
                        : t('settingsAppearance.themeProfiles.defaultTheme')}
                    onPress={() => router.push('/settings/appearance/themes')}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Icon name="translate" size={29} color={theme.colors.accent.blue} />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            {/* Text Settings */}
            <ItemGroup title={t('settingsAppearance.text')} footer={t('settingsAppearance.textDescription')}>
                <DropdownMenu
                    open={openTextSizeMenu}
                    onOpenChange={setOpenTextSizeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={selectedTextSizeId}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.textSize'),
                        subtitle: t('settingsAppearance.textSizeDescription'),
                        icon: <Icon name="text-aa" size={29} color={theme.colors.accent.orange} />,
                        showSelectedSubtitle: false,
                    }}
                    items={textSizeMenuItems}
                    onSelect={selectUiFontSize}
                />
                <DropdownMenu
                    open={openItemDensityMenu}
                    onOpenChange={setOpenItemDensityMenu}
                    variant="selectable"
                    search={false}
                    selectedId={uiItemDensity}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.itemDensity'),
                        subtitle: t('settingsAppearance.itemDensityDescription'),
                        icon: <Icon name="list" size={29} color={theme.colors.accent.orange} />,
                        showSelectedSubtitle: false,
                    }}
                    items={itemDensityMenuItems}
                    onSelect={(itemId) => {
                        if (!isUiItemDensity(itemId)) return;
                        setUiItemDensity(itemId);
                    }}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsAppearance.chatCodeBlocks.title')}>
                <Item
                    title={t('settingsAppearance.chatCodeBlocks.showWrapControls')}
                    subtitle={t('settingsAppearance.chatCodeBlocks.showWrapControlsDescription')}
                    rightElement={
                        <Switch
                            testID="settings-appearance-showChatCodeBlockWrapControls-switch"
                            accessibilityLabel={t('settingsAppearance.chatCodeBlocks.showWrapControls')}
                            value={showChatCodeBlockWrapControls}
                            onValueChange={setShowChatCodeBlockWrapControls}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsAppearance.chatCodeBlocks.wrapByDefault')}
                    subtitle={t('settingsAppearance.chatCodeBlocks.wrapByDefaultDescription')}
                    rightElement={
                        <Switch
                            testID="settings-appearance-wrapChatCodeBlocks-switch"
                            accessibilityLabel={t('settingsAppearance.chatCodeBlocks.wrapByDefault')}
                            value={wrapChatCodeBlocks}
                            onValueChange={setWrapChatCodeBlocks}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Layout */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <DropdownMenu
                    open={openContentWidthMenu}
                    onOpenChange={setOpenContentWidthMenu}
                    variant="selectable"
                    search={false}
                    selectedId={uiContentWidthMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.contentWidth'),
                        subtitle: t('settingsAppearance.contentWidthDescription'),
                        icon: <Icon name="resize" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                    }}
                    items={contentWidthMenuItems}
                    onSelect={(itemId) => {
                        if (itemId !== 'compact' && itemId !== 'medium' && itemId !== 'full') return;
                        setUiContentWidthMode(itemId);
                    }}
                />
                <Item
                    title={t('settingsAppearance.multiPanePanels')}
                    subtitle={t('settingsAppearance.multiPanePanelsDescription')}
                    icon={<Icon name="browsers" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={uiMultiPanePanelsEnabled}
                            onValueChange={setUiMultiPanePanelsEnabled}
                            disabled={!panelsSupported}
                        />
                    }
                    disabled={!panelsSupported}
                    showChevron={false}
                />
                <Item
                    title={t('settingsAppearance.backdropBlur')}
                    subtitle={t('settingsAppearance.backdropBlurDescription')}
                    icon={<Icon name="stack-simple" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={uiBackdropBlurEnabled !== false}
                            onValueChange={setUiBackdropBlurEnabled}
                        />
                    }
                    showChevron={false}
                />
                <DropdownMenu
                    open={openDetailsTabsMenu}
                    onOpenChange={setOpenDetailsTabsMenu}
                    variant="selectable"
                    search={false}
                    selectedId={detailsPaneTabsBehavior}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.detailsPaneTabsBehavior'),
                        subtitle: t('settingsAppearance.detailsPaneTabsBehaviorDescription'),
                        icon: <Icon name="stack" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { disabled: !panelsSupported },
                    }}
                    items={detailsTabsMenuItems}
                    onSelect={(itemId) => {
                        if (!isDetailsPaneTabsBehavior(itemId)) return;
                        setDetailsPaneTabsBehavior(itemId);
                    }}
                />
            </ItemGroup>

            {(Platform.OS === 'ios' || Platform.OS === 'android') && (
                <ItemGroup title={t('settingsAppearance.feedback')}>
                    <Item
                        testID="settings-appearance-haptics"
                        title={t('settingsAppearance.haptics')}
                        subtitle={t('settingsAppearance.hapticsDescription')}
                        icon={<Icon name="device-mobile" size={29} color={theme.colors.accent.blue} />}
                        rightElement={
                            <Switch
                                testID="settings-appearance-haptics-switch"
                                value={hapticsEnabled !== false}
                                onValueChange={setHapticsEnabled}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Style */}
            <ItemGroup title={t('settingsAppearance.avatarStyle')}>
                <DropdownMenu
                    open={openAvatarStyleMenu}
                    onOpenChange={setOpenAvatarStyleMenu}
                    variant="selectable"
                    search={false}
                    selectedId={displayStyle}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.avatarStyle'),
                        subtitle: t('settingsAppearance.avatarStyleDescription'),
                        icon: <AvatarStylePreviewIcon styleId={displayStyle} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-appearance-avatarStyle-select' },
                    }}
                    items={avatarStyleMenuItems}
                    onSelect={(itemId) => {
                        if (!isAvatarStyleId(itemId)) return;
                        setAvatarStyle(itemId);
                    }}
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Icon name="squares-four" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
            </ItemGroup>

            {/* Loading indicator */}
            <ItemGroup title={t('settingsAppearance.loadingIndicator')} footer={t('settingsAppearance.loadingIndicatorFooter')}>
                <DropdownMenu
                    open={openLoadingIndicatorMenu}
                    onOpenChange={setOpenLoadingIndicatorMenu}
                    variant="selectable"
                    search={false}
                    selectedId={displayLoadingIndicatorStyle}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.loadingIndicatorStyle'),
                        subtitle: t('settingsAppearance.loadingIndicatorDescription'),
                        icon: <LoadingIndicatorStylePreview styleId={displayLoadingIndicatorStyle} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-appearance-loadingIndicator-select' },
                    }}
                    items={loadingIndicatorMenuItems}
                    onSelect={(itemId) => {
                        if (!isLoadingIndicatorStyleId(itemId)) return;
                        setLoadingIndicatorStyle(itemId);
                    }}
                />
                <DropdownMenu
                    open={openLoadingIndicatorSpeedMenu && loadingIndicatorTiming.speed}
                    onOpenChange={setOpenLoadingIndicatorSpeedMenu}
                    variant="selectable"
                    search={false}
                    selectedId={loadingIndicatorSpeed}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.loadingIndicatorSpeed'),
                        subtitle: loadingIndicatorTiming.speed
                            ? t('settingsAppearance.loadingIndicatorSpeedDescription')
                            : t('settingsAppearance.loadingIndicatorSpeedUnavailable'),
                        icon: <Icon name="speedometer" size={29} color={theme.colors.accent.indigo} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-appearance-loadingIndicatorSpeed-select', disabled: !loadingIndicatorTiming.speed },
                    }}
                    items={loadingIndicatorSpeedMenuItems}
                    onSelect={(itemId) => setLoadingIndicatorSpeed(LoadingIndicatorSpeedIdSchema.parse(itemId))}
                />
                <DropdownMenu
                    open={openLoadingIndicatorPauseMenu && loadingIndicatorTiming.pause}
                    onOpenChange={setOpenLoadingIndicatorPauseMenu}
                    variant="selectable"
                    search={false}
                    selectedId={loadingIndicatorPause}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.loadingIndicatorPause'),
                        subtitle: loadingIndicatorTiming.pause || !loadingIndicatorTiming.speed
                            ? t('settingsAppearance.loadingIndicatorPauseDescription')
                            : t('settingsAppearance.loadingIndicatorPauseUnavailable'),
                        icon: <Icon name="hourglass" size={29} color={theme.colors.accent.purple} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-appearance-loadingIndicatorPause-select', disabled: !loadingIndicatorTiming.pause },
                    }}
                    items={loadingIndicatorPauseMenuItems}
                    onSelect={(itemId) => setLoadingIndicatorPause(LoadingIndicatorPauseIdSchema.parse(itemId))}
                />
            </ItemGroup>

            {/* Tab bar appearance */}
            <ItemGroup title={t('settingsAppearance.tabBarAppearance.title')} footer={t('settingsAppearance.tabBarAppearance.footer')}>
                {Platform.OS === 'ios' && foldMetrics?.verticalBarEdge != null ? (
                    <Item
                        title={t('settingsAppearance.tabBarAppearance.sideRailTitle')}
                        subtitle={t('settingsAppearance.tabBarAppearance.sideRailSubtitle')}
                        icon={<Icon name="stack" size={29} color={theme.colors.accent.blue} />}
                        rightElement={<Switch testID="settings-appearance-systemTabBar-switch" value={systemTabBarEnabled} onValueChange={setSystemTabBarEnabled} />}
                        showChevron={false}
                    />
                ) : null}
                <DropdownMenu
                    open={openTabBarSizeMenu}
                    onOpenChange={setOpenTabBarSizeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={tabBarSize}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.tabBarAppearance.size'),
                        icon: <Icon name="resize" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-appearance-tabBarSize-select' },
                    }}
                    items={tabBarSizeMenuItems}
                    onSelect={(itemId) => {
                        if (itemId !== 'compact' && itemId !== 'regular' && itemId !== 'large') return;
                        setTabBarSize(itemId);
                    }}
                />
                <Item
                    title={t('settingsAppearance.tabBarAppearance.showLabels')}
                    icon={<Icon name="text-aa" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            testID="settings-appearance-tabBarShowLabels-switch"
                            value={tabBarShowLabels}
                            onValueChange={setTabBarShowLabels}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Glass surfaces */}
            <ItemGroup title={t('settingsAppearance.glass.title')} footer={t('settingsAppearance.glass.footer')}>
                <Item
                    title={t('settingsAppearance.glass.enable')}
                    icon={<Icon name="circle-half" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            testID="settings-appearance-glassBlur-switch"
                            value={glassBlurEnabled}
                            onValueChange={setGlassBlurEnabled}
                        />
                    }
                    showChevron={false}
                />
                {/* Intensity only tunes a real blur; Android glass is an unblurred tint. */}
                {glassBlurEnabled && (Platform.OS === 'web' || isNativeBlurAvailable()) ? (
                    <DropdownMenu
                        open={openGlassBlurMenu}
                        onOpenChange={setOpenGlassBlurMenu}
                        variant="selectable"
                        search={false}
                        selectedId={glassBlurIntensity}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{
                            title: t('settingsAppearance.glass.intensity'),
                            icon: <Icon name="sliders-horizontal" size={29} color={theme.colors.accent.blue} />,
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-appearance-glassBlurIntensity-select' },
                        }}
                        items={glassBlurIntensityMenuItems}
                        onSelect={(itemId) => {
                            if (itemId !== 'light' && itemId !== 'regular' && itemId !== 'strong') return;
                            setGlassBlurIntensity(itemId);
                        }}
                    />
                ) : null}
            </ItemGroup>

            {/* Tab bar badges */}
            <ItemGroup title={t('settingsAppearance.tabBarBadges.title')} footer={t('settingsAppearance.tabBarBadges.footer')}>
                <DropdownMenu
                    open={openGitBadgeMenu}
                    onOpenChange={setOpenGitBadgeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={tabBarGitBadgeMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.tabBarBadges.gitTitle'),
                        icon: <Icon name="git-branch" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-appearance-tabBarGitBadge-select' },
                    }}
                    items={gitBadgeMenuItems}
                    onSelect={(itemId) => {
                        if (itemId !== 'changedFiles' && itemId !== 'diffLines' && itemId !== 'off') return;
                        setTabBarGitBadgeMode(itemId);
                    }}
                />
                <Item
                    title={t('tabs.friends')}
                    icon={<Icon name="users" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            testID="settings-appearance-tabBarFriendsBadge-switch"
                            value={tabBarFriendsBadgeEnabled}
                            onValueChange={setTabBarFriendsBadgeEnabled}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('tabs.inbox')}
                    icon={<Icon name="envelope" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            testID="settings-appearance-tabBarInboxBadge-switch"
                            value={tabBarInboxBadgeEnabled}
                            onValueChange={setTabBarInboxBadgeEnabled}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('workspaceCockpit.tabs')}
                    icon={<Icon name="stack" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            testID="settings-appearance-tabBarOpenTabsBadge-switch"
                            value={tabBarOpenTabsBadgeEnabled}
                            onValueChange={setTabBarOpenTabsBadgeEnabled}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
