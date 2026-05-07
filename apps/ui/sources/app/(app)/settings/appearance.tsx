import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Appearance, Platform, View } from 'react-native';
import { setStatusBarStyle } from 'expo-status-bar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import {
    AVATAR_STYLE_OPTIONS,
    isAvatarStyleId,
    normalizeAvatarStyleId,
} from '@/components/ui/avatar/avatarStyleOptions';
import { getGeneratedAvatarComponentForStyle } from '@/components/ui/avatar/avatarComponentRegistry';
import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import { resolveStatusBarStyleForThemePreference } from '@/components/ui/layout/statusBarStyle';

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
    const panelsSupported = Platform.OS === 'web' || deviceType === 'tablet';
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const [uiItemDensity, setUiItemDensity] = useLocalSettingMutable('uiItemDensity');
    const [uiMultiPanePanelsEnabled, setUiMultiPanePanelsEnabled] = useLocalSettingMutable('uiMultiPanePanelsEnabled');
    const [detailsPaneTabsBehavior, setDetailsPaneTabsBehavior] = useLocalSettingMutable('detailsPaneTabsBehavior');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [openTextSizeMenu, setOpenTextSizeMenu] = React.useState(false);
    const [openItemDensityMenu, setOpenItemDensityMenu] = React.useState(false);
    const [openDetailsTabsMenu, setOpenDetailsTabsMenu] = React.useState(false);
    const [openAvatarStyleMenu, setOpenAvatarStyleMenu] = React.useState(false);

    const uiFontScalePresets = React.useMemo(() => {
        return {
            xxsmall: 0.8,
            xsmall: 0.85,
            small: 0.93,
            default: 1,
            large: 1.1,
            xlarge: 1.2,
            xxlarge: 1.3,
        } as const;
    }, []);

    const textSizeMenuItems = React.useMemo(() => {
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

    const selectedTextSizeId = React.useMemo(() => {
        const entries = Object.entries(uiFontScalePresets) as Array<[keyof typeof uiFontScalePresets, number]>;
        let best: keyof typeof uiFontScalePresets = 'default';
        let bestDist = Number.POSITIVE_INFINITY;
        for (const [id, scale] of entries) {
            const dist = Math.abs((uiFontScale ?? 1) - scale);
            if (dist < bestDist) {
                bestDist = dist;
                best = id;
            }
        }
        return best;
    }, [uiFontScale, uiFontScalePresets]);

    const selectUiFontSize = React.useCallback((itemId: string) => {
        const next = (uiFontScalePresets as any)[itemId];
        if (typeof next !== 'number') return;
        setUiFontScale(next as any);
    }, [setUiFontScale, uiFontScalePresets]);

    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle = normalizeAvatarStyleId(avatarStyle);
    
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
                <Item
                    testID="settings-appearance-themePreference-cycle"
                    title={t('settings.appearance')}
                    subtitle={themePreference === 'adaptive' ? t('settingsAppearance.themeDescriptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeDescriptions.light') : t('settingsAppearance.themeDescriptions.dark')}
                    icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                    detail={themePreference === 'adaptive' ? t('settingsAppearance.themeOptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeOptions.light') : t('settingsAppearance.themeOptions.dark')}
                    onPress={() => {
                        const currentIndex = themePreference === 'adaptive' ? 0 : themePreference === 'light' ? 1 : 2;
                        const nextIndex = (currentIndex + 1) % 3;
                        const nextTheme = nextIndex === 0 ? 'adaptive' : nextIndex === 1 ? 'light' : 'dark';
                        
                        // Update the setting
                        setThemePreference(nextTheme);
                        
                        // Apply the theme change immediately
                        const systemTheme = Appearance.getColorScheme();
                        if (nextTheme === 'adaptive') {
                            // Enable adaptive themes and set to system theme
                            UnistylesRuntime.setAdaptiveThemes(true);
                            const color = systemTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        } else {
                            // Disable adaptive themes and set explicit theme
                            UnistylesRuntime.setAdaptiveThemes(false);
                            UnistylesRuntime.setTheme(nextTheme);
                            const color = nextTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        }
                        setStatusBarStyle(resolveStatusBarStyleForThemePreference(nextTheme, systemTheme), true);
                    }}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Ionicons name="language-outline" size={29} color={theme.colors.accent.blue} />}
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
                    selectedId={selectedTextSizeId as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.textSize'),
                        subtitle: t('settingsAppearance.textSizeDescription'),
                        icon: <Ionicons name="text-outline" size={29} color={theme.colors.accent.orange} />,
                        showSelectedSubtitle: false,
                    }}
                    items={textSizeMenuItems as any}
                    onSelect={selectUiFontSize}
                />
                <DropdownMenu
                    open={openItemDensityMenu}
                    onOpenChange={setOpenItemDensityMenu}
                    variant="selectable"
                    search={false}
                    selectedId={uiItemDensity as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.itemDensity'),
                        subtitle: t('settingsAppearance.itemDensityDescription'),
                        icon: <Ionicons name="list-outline" size={29} color={theme.colors.accent.orange} />,
                        showSelectedSubtitle: false,
                    }}
                    items={itemDensityMenuItems as any}
                    onSelect={(itemId) => {
                        if (itemId !== 'comfortable' && itemId !== 'cozy' && itemId !== 'compact') return;
                        setUiItemDensity(itemId as any);
                    }}
                />
            </ItemGroup>

            {/* Text Settings */}
            {/* <ItemGroup title="Text" footer="Adjust text size and font preferences">
                <Item
                    title="Text Size"
                    subtitle="Make text larger or smaller"
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.accent.orange} />}
                    detail="Default"
                    onPress={() => { }}
                    disabled
                />
                <Item
                    title="Font"
                    subtitle="Choose your preferred font"
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.accent.orange} />}
                    detail="System"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}

            {/* Layout */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.multiPanePanels')}
                    subtitle={t('settingsAppearance.multiPanePanelsDescription')}
                    icon={<Ionicons name="browsers-outline" size={29} color={theme.colors.accent.blue} />}
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
                <DropdownMenu
                    open={openDetailsTabsMenu}
                    onOpenChange={setOpenDetailsTabsMenu}
                    variant="selectable"
                    search={false}
                    selectedId={detailsPaneTabsBehavior as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.detailsPaneTabsBehavior'),
                        subtitle: t('settingsAppearance.detailsPaneTabsBehaviorDescription'),
                        icon: <Ionicons name="albums-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { disabled: !panelsSupported },
                    }}
                    items={detailsTabsMenuItems as any}
                    onSelect={(itemId) => {
                        if (itemId !== 'preview' && itemId !== 'persistent') return;
                        setDetailsPaneTabsBehavior(itemId as any);
                    }}
                />
            </ItemGroup>

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
                    icon={<Ionicons name="apps-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
                {/* <Item
                    title="Compact Mode"
                    subtitle="Reduce spacing between elements"
                    icon={<Ionicons name="contract-outline" size={29} color={theme.colors.accent.indigo} />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                        />
                    }
                />
                <Item
                    title="Show Avatars"
                    subtitle="Display user and assistant avatars"
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.accent.indigo} />}
                    disabled
                    rightElement={
                        <Switch
                            value={true}
                            disabled
                        />
                    }
                /> */}
            </ItemGroup>

            {/* Colors */}
            {/* <ItemGroup title="Colors" footer="Customize accent colors and highlights">
                <Item
                    title="Accent Color"
                    subtitle="Choose your accent color"
                    icon={<Ionicons name="color-palette-outline" size={29} color={theme.colors.warningCritical} />}
                    detail="Blue"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}
        </ItemList>
    );
});
