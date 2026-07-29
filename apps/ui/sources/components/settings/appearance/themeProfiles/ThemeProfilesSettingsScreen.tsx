import * as React from 'react';
import { Appearance, Platform, View } from 'react-native';
import { setStatusBarStyle } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveStatusBarStyleForThemePreference, type ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { runThemePreferenceChange } from '@/components/settings/appearance/themePreferenceTransition';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { isThemeProfileActive, setActiveThemeProfileForMode } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { buildThemePresetSourceOptions, type ThemePresetSourceOption } from './themeProfilePresetOptions';
import {
    createThemeProfileId,
    nowThemeProfileTimestamp,
    removeThemeProfile,
    upsertThemeProfile,
} from './themeProfileScreenUtils';

const profileEditorRoute = (profileId: string) => ({
    pathname: '/settings/appearance/themes/[profileId]' as const,
    params: { profileId },
});

const createProfileName = (count: number): string => t('settingsAppearance.themeProfiles.newProfileName', { count });

export const ThemeProfilesSettingsScreen = React.memo(function ThemeProfilesSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const reduceMotion = useReducedMotionPreference();
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles, setThemeProfiles] = useLocalSettingMutable('themeProfiles');
    const [builtInDropdownOpen, setBuiltInDropdownOpen] = React.useState(false);
    const presetOptions = React.useMemo(() => buildThemePresetSourceOptions(themeProfiles), [themeProfiles]);
    const customPresetOptions = React.useMemo(() => presetOptions.filter((option) => option.kind === 'custom'), [presetOptions]);
    const builtInPresetOptions = React.useMemo(() => presetOptions.filter((option) => option.kind !== 'custom'), [presetOptions]);
    const profileLimitReached = themeProfiles.profiles.length >= THEME_PROFILE_MAX_PROFILES;

    const openImport = React.useCallback(() => {
        router.push('/settings/appearance/themes/import');
    }, [router]);

    const openCreate = React.useCallback(() => {
        router.push(profileEditorRoute('new'));
    }, [router]);

    const applyThemeSelection = React.useCallback((nextThemePreference: ThemePreference, nextThemeProfiles: ThemeProfilesLocalStateV1) => {
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

    const duplicateTheme = React.useCallback((option: ThemePresetSourceOption) => {
        if (profileLimitReached) return;
        const id = createThemeProfileId();
        const now = nowThemeProfileTimestamp();
        const profile = createThemeProfileDraft({
            id,
            name: t('settingsAppearance.themeProfiles.cloneName', { name: option.title || createProfileName(themeProfiles.profiles.length + 1) }),
            now,
            sourceProfile: option.profile ?? undefined,
        });
        setThemeProfiles(upsertThemeProfile(themeProfiles, profile));
        router.push(profileEditorRoute(id));
    }, [profileLimitReached, router, setThemeProfiles, themeProfiles]);

    const selectBaseTheme = React.useCallback((mode: ThemeProfileMode) => {
        applyThemeSelection(themePreference, setActiveThemeProfileForMode(themeProfiles, mode, null));
    }, [applyThemeSelection, themePreference, themeProfiles]);

    const selectProfile = React.useCallback((option: ThemePresetSourceOption) => {
        applyThemeSelection(themePreference, setActiveThemeProfileForMode(themeProfiles, option.preferredMode, option.id));
    }, [applyThemeSelection, themePreference, themeProfiles]);

    const activatePresetOption = React.useCallback((option: ThemePresetSourceOption) => {
        if (option.id === 'light' || option.id === 'dark') {
            selectBaseTheme(option.id);
            return;
        }
        selectProfile(option);
    }, [selectBaseTheme, selectProfile]);

    const deleteProfile = React.useCallback(async (profile: ThemeProfileV1) => {
        const confirmed = await Modal.confirm(
            t('settingsAppearance.themeProfiles.deleteProfile'),
            t('settingsAppearance.themeProfiles.deleteProfileSubtitle'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;

        const nextThemeProfiles = removeThemeProfile(themeProfiles, profile.id);
        if (isThemeProfileActive(themeProfiles, profile.id)) {
            applyThemeSelection(themePreference, nextThemeProfiles);
            return;
        }
        setThemeProfiles(nextThemeProfiles);
    }, [applyThemeSelection, setThemeProfiles, themePreference, themeProfiles]);

    const isPresetOptionActive = React.useCallback((option: ThemePresetSourceOption): boolean => {
        if (option.id === 'light') return themeProfiles.activeProfileIds.light === null;
        if (option.id === 'dark') return themeProfiles.activeProfileIds.dark === null;
        return themeProfiles.activeProfileIds.light === option.id || themeProfiles.activeProfileIds.dark === option.id;
    }, [themeProfiles.activeProfileIds]);

    const renderPresetActions = React.useCallback((option: ThemePresetSourceOption) => {
        const actions: ItemAction[] = [];

        if (!profileLimitReached) {
            actions.push({
                id: `duplicate-${option.id}`,
                title: t('settingsAppearance.themeProfiles.duplicateTheme'),
                subtitle: option.title,
                icon: 'copy-outline',
                color: theme.colors.accent.blue,
                inlineTestID: `settings-theme-duplicate-${option.id}`,
                onPress: () => duplicateTheme(option),
            });
        }

        if (option.kind === 'custom' && option.profile) {
            const profile = option.profile;
            actions.unshift({
                id: `edit-${option.id}`,
                title: t('settingsAppearance.themeProfiles.editProfile'),
                subtitle: option.title,
                icon: 'create-outline',
                color: theme.colors.accent.blue,
                inlineTestID: `settings-theme-edit-${option.id}`,
                onPress: () => router.push(profileEditorRoute(profile.id)),
            });
            actions.push({
                id: `delete-${option.id}`,
                title: t('settingsAppearance.themeProfiles.deleteProfile'),
                subtitle: option.title,
                icon: 'trash-outline',
                destructive: true,
                inlineTestID: `settings-theme-delete-${option.id}`,
                onPress: () => { void deleteProfile(profile); },
            });
        }

        return (
            <View testID={`settings-theme-profile-${option.kind === 'custom' ? 'custom' : 'built-in'}-actions-${option.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {isPresetOptionActive(option) ? (
                    <Ionicons name="checkmark-circle" size={20} color={theme.colors.status.connected} />
                ) : null}
                <ItemRowActions
                    title={option.title}
                    actions={actions}
                    compactActionIds={actions.map((action) => action.id)}
                    pinnedActionIds={actions.map((action) => action.id)}
                    overflowTriggerTestID={`settings-theme-actions-${option.id}`}
                    iconSize={18}
                    gap={12}
                />
            </View>
        );
    }, [deleteProfile, duplicateTheme, isPresetOptionActive, profileLimitReached, router, theme.colors.accent.blue, theme.colors.status.connected]);

    const renderPresetRow = React.useCallback((option: ThemePresetSourceOption) => {
        const builtIn = option.kind !== 'custom';
        const iconName = option.kind === 'builtIn' ? 'sparkles-outline' : option.id === 'dark' ? 'moon-outline' : 'sunny-outline';
        return (
            <Item
                key={option.id}
                testID={builtIn ? `settings-theme-profile-built-in-${option.id}` : `settings-theme-profile-custom-${option.id}`}
                title={option.title}
                subtitle={option.subtitle}
                selected={isPresetOptionActive(option)}
                icon={<Ionicons name={iconName} size={28} color={option.kind === 'builtIn' ? theme.colors.accent.indigo : theme.colors.status.connecting} />}
                rightElement={renderPresetActions(option)}
                onPress={() => activatePresetOption(option)}
            />
        );
    }, [activatePresetOption, isPresetOptionActive, renderPresetActions, theme.colors.accent.indigo, theme.colors.status.connecting]);

    const builtInDropdownItems = React.useMemo((): readonly DropdownMenuItem[] => (
        builtInPresetOptions.map((option) => {
            const iconName = option.kind === 'builtIn' ? 'sparkles-outline' : option.id === 'dark' ? 'moon-outline' : 'sunny-outline';
            return {
                id: option.id,
                testID: `settings-theme-profile-built-in-option-${option.id}`,
                title: option.title,
                subtitle: option.subtitle,
                icon: <Ionicons name={iconName} size={22} color={option.kind === 'builtIn' ? theme.colors.accent.indigo : theme.colors.status.connecting} />,
                rightElement: renderPresetActions(option),
            };
        })
    ), [builtInPresetOptions, renderPresetActions, theme.colors.accent.indigo, theme.colors.status.connecting]);

    return (
        <ItemList testID="settings-theme-profiles-screen" style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsAppearance.themeProfiles.builtInGroup')} footer={t('settingsAppearance.themeProfiles.builtInFooter')}>
                <DropdownMenu
                    open={builtInDropdownOpen}
                    onOpenChange={setBuiltInDropdownOpen}
                    variant="selectable"
                    search
                    selectedId={null}
                    showCategoryTitles={false}
                    matchTriggerWidth
                    connectToTrigger
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.themeProfiles.builtInGroup'),
                        subtitle: t('settingsAppearance.themeProfiles.builtInFooter'),
                        icon: <Ionicons name="sparkles-outline" size={28} color={theme.colors.accent.indigo} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-theme-profile-built-in-dropdown-trigger' },
                    }}
                    items={builtInDropdownItems}
                    onSelect={(itemId) => {
                        const option = builtInPresetOptions.find((entry) => entry.id === itemId);
                        if (option) activatePresetOption(option);
                    }}
                />
            </ItemGroup>

            {customPresetOptions.length > 0 ? (
                <ItemGroup title={t('settingsAppearance.themeProfiles.customGroup')} footer={t('settingsAppearance.themeProfiles.customFooter')}>
                    {customPresetOptions.map(renderPresetRow)}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settingsAppearance.themeProfiles.actionsGroup')}>
                <Item
                    testID="settings-theme-profile-create"
                    title={t('settingsAppearance.themeProfiles.createProfile')}
                    subtitle={t('settingsAppearance.themeProfiles.createProfileSubtitle')}
                    icon={<Ionicons name="add-circle-outline" size={28} color={theme.colors.accent.blue} />}
                    onPress={openCreate}
                    disabled={profileLimitReached}
                />
                <Item
                    testID="settings-theme-profile-import"
                    title={t('settingsAppearance.themeProfiles.importProfile')}
                    subtitle={t('settingsAppearance.themeProfiles.importProfileSubtitle')}
                    icon={<Ionicons name="code-download-outline" size={28} color={theme.colors.accent.green} />}
                    onPress={openImport}
                />
            </ItemGroup>
        </ItemList>
    );
});
