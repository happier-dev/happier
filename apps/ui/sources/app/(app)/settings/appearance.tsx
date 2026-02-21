import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

export default React.memo(function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [viewInline, setViewInline] = useSettingMutable('viewInline');
    const [expandTodos, setExpandTodos] = useSettingMutable('expandTodos');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [agentInputActionBarLayout, setAgentInputActionBarLayout] = useSettingMutable('agentInputActionBarLayout');
    const [agentInputChipDensity, setAgentInputChipDensity] = useSettingMutable('agentInputChipDensity');
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [compactSessionView, setCompactSessionView] = useSettingMutable('compactSessionView');
    const [compactSessionViewMinimal, setCompactSessionViewMinimal] = useSettingMutable('compactSessionViewMinimal');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [sessionListActiveGroupingV1, setSessionListActiveGroupingV1] = useSettingMutable('sessionListActiveGroupingV1');
    const [sessionListInactiveGroupingV1, setSessionListInactiveGroupingV1] = useSettingMutable('sessionListInactiveGroupingV1');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [openGroupingMenu, setOpenGroupingMenu] = React.useState<null | 'active' | 'inactive'>(null);
    const [openTextSizeMenu, setOpenTextSizeMenu] = React.useState(false);

    const groupingMenuItems = React.useMemo(() => {
        return [
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
        ];
    }, []);

    const selectGrouping = React.useCallback((itemId: string, section: 'active' | 'inactive') => {
        if (itemId !== 'project' && itemId !== 'date') return;
        if (section === 'active') {
            setSessionListActiveGroupingV1(itemId);
            return;
        }
        setSessionListInactiveGroupingV1(itemId);
    }, [setSessionListActiveGroupingV1, setSessionListInactiveGroupingV1]);

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
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t('settingsAppearance.themeDescription')}>
                <Item
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
                        if (nextTheme === 'adaptive') {
                            // Enable adaptive themes and set to system theme
                            UnistylesRuntime.setAdaptiveThemes(true);
                            const systemTheme = Appearance.getColorScheme();
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

            {/* Display Settings */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.compactSessionView')}
                    subtitle={t('settingsAppearance.compactSessionViewDescription')}
                    icon={<Ionicons name="albums-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={compactSessionView}
                            onValueChange={setCompactSessionView}
                        />
                    }
                />
                {compactSessionView ? (
                    <Item
                        title={t('settingsAppearance.compactSessionViewMinimal')}
                        subtitle={t('settingsAppearance.compactSessionViewMinimalDescription')}
                        icon={<Ionicons name="remove-outline" size={29} color={theme.colors.accent.indigo} />}
                        rightElement={
                            <Switch
                                value={compactSessionViewMinimal}
                                onValueChange={setCompactSessionViewMinimal}
                            />
                        }
                    />
                ) : null}
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color={theme.colors.accent.orange} />}
                    rightElement={
                        <Switch
                            value={hideInactiveSessions}
                            onValueChange={setHideInactiveSessions}
                        />
                    }
                    showChevron={false}
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
                    itemTrigger={{
                        title: t('settingsFeatures.sessionListInactiveGrouping'),
                        subtitle: t('settingsFeatures.sessionListInactiveGroupingSubtitle'),
                        icon: <Ionicons name="calendar-outline" size={29} color={theme.colors.success} />,
                        showSelectedSubtitle: false,
                    }}
                    items={groupingMenuItems}
                    onSelect={(itemId) => selectGrouping(itemId, 'inactive')}
                />
                <Item
                    title={t('settingsAppearance.inlineToolCalls')}
                    subtitle={t('settingsAppearance.inlineToolCallsDescription')}
                    icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={viewInline}
                            onValueChange={setViewInline}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.expandTodoLists')}
                    subtitle={t('settingsAppearance.expandTodoListsDescription')}
                    icon={<Ionicons name="checkmark-done-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={expandTodos}
                            onValueChange={setExpandTodos}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInDiffs')}
                    subtitle={t('settingsAppearance.showLineNumbersInDiffsDescription')}
                    icon={<Ionicons name="list-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={showLineNumbers}
                            onValueChange={setShowLineNumbers}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInToolViews')}
                    subtitle={t('settingsAppearance.showLineNumbersInToolViewsDescription')}
                    icon={<Ionicons name="code-working-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={showLineNumbersInToolViews}
                            onValueChange={setShowLineNumbersInToolViews}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.wrapLinesInDiffs')}
                    subtitle={t('settingsAppearance.wrapLinesInDiffsDescription')}
                    icon={<Ionicons name="return-down-forward-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={wrapLinesInDiffs}
                            onValueChange={setWrapLinesInDiffs}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.alwaysShowContextSize')}
                    subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                    icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={alwaysShowContextSize}
                            onValueChange={setAlwaysShowContextSize}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.agentInputActionBarLayout')}
                    subtitle={t('settingsAppearance.agentInputActionBarLayoutDescription')}
                    icon={<Ionicons name="menu-outline" size={29} color={theme.colors.accent.indigo} />}
                    detail={
                        agentInputActionBarLayout === 'auto'
                            ? t('settingsAppearance.agentInputActionBarLayoutOptions.auto')
                            : agentInputActionBarLayout === 'wrap'
                                ? t('settingsAppearance.agentInputActionBarLayoutOptions.wrap')
                                : agentInputActionBarLayout === 'scroll'
                                    ? t('settingsAppearance.agentInputActionBarLayoutOptions.scroll')
                                    : t('settingsAppearance.agentInputActionBarLayoutOptions.collapsed')
                    }
                    onPress={() => {
                        const order: Array<typeof agentInputActionBarLayout> = ['auto', 'wrap', 'scroll', 'collapsed'];
                        const idx = Math.max(0, order.indexOf(agentInputActionBarLayout));
                        const next = order[(idx + 1) % order.length]!;
                        setAgentInputActionBarLayout(next);
                    }}
                />
                <Item
                    title={t('settingsAppearance.agentInputChipDensity')}
                    subtitle={t('settingsAppearance.agentInputChipDensityDescription')}
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.accent.indigo} />}
                    detail={
                        agentInputChipDensity === 'auto'
                            ? t('settingsAppearance.agentInputChipDensityOptions.auto')
                            : agentInputChipDensity === 'labels'
                                ? t('settingsAppearance.agentInputChipDensityOptions.labels')
                                : t('settingsAppearance.agentInputChipDensityOptions.icons')
                    }
                    onPress={() => {
                        const order: Array<typeof agentInputChipDensity> = ['auto', 'labels', 'icons'];
                        const idx = Math.max(0, order.indexOf(agentInputChipDensity));
                        const next = order[(idx + 1) % order.length]!;
                        setAgentInputChipDensity(next);
                    }}
                />
                <Item
                    title={t('settingsAppearance.avatarStyle')}
                    subtitle={t('settingsAppearance.avatarStyleDescription')}
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.accent.indigo} />}
                    detail={displayStyle === 'pixelated' ? t('settingsAppearance.avatarOptions.pixelated') : displayStyle === 'brutalist' ? t('settingsAppearance.avatarOptions.brutalist') : t('settingsAppearance.avatarOptions.gradient')}
                    onPress={() => {
                        const currentIndex = displayStyle === 'pixelated' ? 0 : displayStyle === 'gradient' ? 1 : 2;
                        const nextIndex = (currentIndex + 1) % 3;
                        const nextStyle = nextIndex === 0 ? 'pixelated' : nextIndex === 1 ? 'gradient' : 'brutalist';
                        setAvatarStyle(nextStyle);
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
