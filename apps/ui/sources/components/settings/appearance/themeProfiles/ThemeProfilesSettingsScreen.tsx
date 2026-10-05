import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ThemePalettePreview } from '@/components/settings/appearance/ThemeModePreview';
import { useApplyThemeSelection } from '@/components/settings/appearance/useApplyThemeSelection';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { THEMES_SETTINGS } from './themesSettings';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { setActiveThemeProfileForMode } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { buildThemePresetSourceOptions, type ThemePresetSourceOption } from './themeProfilePresetOptions';

const profileEditorRoute = (profileId: string) => ({
    pathname: '/settings/appearance/themes/[profileId]' as const,
    params: { profileId },
});

const THEME_MODES: readonly ThemeProfileMode[] = ['light', 'dark'];

/** A mode's tile value: the theme it uses, or the mode's own base theme when none is set. */
const activeTileId = (themeProfiles: ThemeProfilesLocalStateV1, mode: ThemeProfileMode): string => (
    themeProfiles.activeProfileIds[mode] ?? mode
);

/**
 * Themes: which theme light mode and dark mode use (a visual choice, so tiles showing each theme's own
 * colours), then the user's own themes, which open in the editor. Adding a theme starts in that
 * collection: a new theme (starting from any theme) or an import.
 */
export const ThemeProfilesSettingsScreen = React.memo(function ThemeProfilesSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [themePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const [addMenuOpen, setAddMenuOpen] = React.useState(false);
    const presetOptions = React.useMemo(() => buildThemePresetSourceOptions(themeProfiles), [themeProfiles]);
    const customOptions = React.useMemo(() => presetOptions.filter((option) => option.kind === 'custom'), [presetOptions]);
    const profileLimitReached = themeProfiles.profiles.length >= THEME_PROFILE_MAX_PROFILES;

    // The one theme-selection writer: stores, applies, sets the status bar and plays the transition.
    const applyThemeSelection = useApplyThemeSelection();

    const selectForMode = React.useCallback((mode: ThemeProfileMode, optionId: string) => {
        // The mode's own tile is its base theme: no profile.
        const profileId = optionId === mode ? null : optionId;
        if (themeProfiles.activeProfileIds[mode] === profileId) return;
        return applyThemeSelection(themePreference, setActiveThemeProfileForMode(themeProfiles, mode, profileId));
    }, [applyThemeSelection, themePreference, themeProfiles]);

    const openCreate = React.useCallback(() => {
        if (profileLimitReached) return;
        router.push(profileEditorRoute('new'));
    }, [profileLimitReached, router]);

    const addMenuItems = React.useMemo((): readonly DropdownMenuItem[] => [
        {
            id: 'create',
            testID: 'settings-theme-profile-create',
            title: t('settingsAppearance.themeProfiles.newTheme'),
            subtitle: profileLimitReached
                ? t('settingsAppearance.themeProfiles.themeLimitDescription', { count: THEME_PROFILE_MAX_PROFILES })
                : t('settingsAppearance.themeProfiles.newThemeDescription'),
            disabled: profileLimitReached,
        },
        {
            id: 'import',
            testID: 'settings-theme-profile-import',
            title: t('settingsAppearance.themeProfiles.importProfile'),
            subtitle: t('settingsAppearance.themeProfiles.importThemeDescription'),
        },
    ], [profileLimitReached]);

    return (
        <ItemList testID="settings-theme-profiles-screen" style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsAppearance.themeProfiles.pageDescription')} />

            {THEME_MODES.map((mode) => (
                <ThemeModeTilesSection
                    key={mode}
                    mode={mode}
                    options={presetOptions}
                    value={activeTileId(themeProfiles, mode)}
                    onSelect={selectForMode}
                />
            ))}

            <ItemGroup
                title={t('settingsAppearance.themeProfiles.yourThemes')}
                description={t('settingsAppearance.themeProfiles.yourThemesDescription')}
                action={(
                    <DropdownMenu
                        testID="settings-theme-profile-add-menu"
                        open={addMenuOpen}
                        onOpenChange={setAddMenuOpen}
                        items={addMenuItems}
                        onSelect={(id) => {
                            setAddMenuOpen(false);
                            if (id === 'create') openCreate();
                            if (id === 'import') router.push('/settings/appearance/themes/import');
                        }}
                        placement="bottom"
                        popoverAnchorAlign="end"
                        matchTriggerWidth={false}
                        maxWidthCap={320}
                        showCategoryTitles={false}
                        popoverPortalWebTarget="body"
                        trigger={({ toggle }) => (
                            <RoundButton
                                testID="settings-theme-profile-add"
                                size="small"
                                display="inverted"
                                title={t('settingsAppearance.themeProfiles.addTheme')}
                                leading={<Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                                textStyle={{ color: theme.colors.text.secondary }}
                                onPress={toggle}
                            />
                        )}
                    />
                )}
            >
                {customOptions.length === 0 ? (
                    <SettingAnchor setting={THEMES_SETTINGS.settings.yourThemes}>
                        <Item
                            testID="settings-theme-profile-custom-empty"
                            title={t('settingsAppearance.themeProfiles.noProfiles')}
                            subtitle={t('settingsAppearance.themeProfiles.noProfilesDescription')}
                            onPress={openCreate}
                        />
                    </SettingAnchor>
                ) : customOptions.map((option, index) => {
                    const row = (
                        <Item
                            key={option.id}
                            testID={`settings-theme-profile-custom-${option.id}`}
                            title={option.title}
                            subtitle={customThemeSummary(option, themeProfiles)}
                            onPress={() => router.push(profileEditorRoute(option.id))}
                        />
                    );
                    // Search lands on the first of your themes.
                    return index === 0
                        ? <SettingAnchor key={option.id} setting={THEMES_SETTINGS.settings.yourThemes}>{row}</SettingAnchor>
                        : row;
                })}
            </ItemGroup>
        </ItemList>
    );
});

function customThemeSummary(option: ThemePresetSourceOption, themeProfiles: ThemeProfilesLocalStateV1): string {
    const mode = t(option.preferredMode === 'dark' ? 'settingsAppearance.themeOptions.dark' : 'settingsAppearance.themeOptions.light');
    const inUse = themeProfiles.activeProfileIds.light === option.id || themeProfiles.activeProfileIds.dark === option.id;
    return inUse ? `${mode} · ${t('settingsAppearance.themeProfiles.inUse')}` : mode;
}

/**
 * The themes a mode can use, each shown in its own colours. Previews are resolved once per theme set
 * (static props, no runtime theme reads).
 */
const ThemeModeTilesSection = React.memo(function ThemeModeTilesSection(props: Readonly<{
    mode: ThemeProfileMode;
    options: readonly ThemePresetSourceOption[];
    value: string;
    onSelect: (mode: ThemeProfileMode, optionId: string) => void;
}>) {
    const { mode, onSelect } = props;
    const tiles = React.useMemo(() => props.options
        .filter((option) => option.preferredMode === mode)
        .map((option) => ({
            id: option.id,
            title: option.kind === 'base' ? t('settingsAppearance.themeProfiles.defaultTheme') : option.title,
            preview: <ThemePalettePreview palette={resolveThemeProfile({ mode, profile: option.profile })} />,
        })), [mode, props.options]);
    const title = t(mode === 'dark' ? 'settingsAppearance.themeProfiles.darkModeSection' : 'settingsAppearance.themeProfiles.lightModeSection');
    return (
        <ItemGroup
            title={title}
            description={t(mode === 'dark'
                ? 'settingsAppearance.themeProfiles.darkModeSectionDescription'
                : 'settingsAppearance.themeProfiles.lightModeSectionDescription')}
        >
            <SettingAnchor setting={mode === 'dark' ? THEMES_SETTINGS.settings.darkTheme : THEMES_SETTINGS.settings.lightTheme}>
                <SectionContentRow testID={`settings-theme-${mode}-tiles`}>
                    <SelectionTiles
                        variant="visual"
                        accessibilityLabel={title}
                        testIdPrefix={`settings-theme-${mode}`}
                        value={props.value}
                        onChange={(next) => { if (next) onSelect(mode, next); }}
                        options={tiles}
                    />
                </SectionContentRow>
            </SettingAnchor>
        </ItemGroup>
    );
});
