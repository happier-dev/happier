import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Appearance, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { createThemeProfileDraft, resetThemeProfileDraftMode, resetThemeProfileDraftToken, updateThemeProfileDraftColor } from '@/theme/profiles/createThemeProfileDraft';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import { sanitizeThemeProfileName } from '@/theme/profiles/themeProfileImportExport';
import { isThemeProfileAssetAppearance, resolveThemeProfileAssetAppearance } from '@/theme/profiles/themeProfileAssetAppearance';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { findThemeProfileById } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { ThemeColorTokenRow } from './ThemeColorTokenRow';
import { ThemeProfilePresetDropdown } from './ThemeProfilePresetDropdown';
import { ThemeProfilePreviewPane } from './ThemeProfilePreviewPane';
import { buildThemeProfileTokenGroups, getThemeProfileRecentColors } from './themeProfileEditorModel';
import {
    buildThemePresetSourceOptions,
    replaceThemeProfileDraftFromPresetSource,
    resolveThemePresetSourcePreferredMode,
    themeProfileDraftMatchesPresetSource,
} from './themeProfilePresetOptions';
import {
    activateThemeProfileFromSettingsScreen,
    createThemeProfileId,
    nowThemeProfileTimestamp,
    removeThemeProfile,
    upsertThemeProfile,
} from './themeProfileScreenUtils';

const groupTitleKeys = {
    background: 'settingsAppearance.themeProfiles.groups.background',
    surface: 'settingsAppearance.themeProfiles.groups.surface',
    border: 'settingsAppearance.themeProfiles.groups.border',
    effect: 'settingsAppearance.themeProfiles.groups.effect',
    chrome: 'settingsAppearance.themeProfiles.groups.chrome',
    text: 'settingsAppearance.themeProfiles.groups.text',
    state: 'settingsAppearance.themeProfiles.groups.state',
    control: 'settingsAppearance.themeProfiles.groups.control',
    composer: 'settingsAppearance.themeProfiles.groups.composer',
    message: 'settingsAppearance.themeProfiles.groups.message',
    syntax: 'settingsAppearance.themeProfiles.groups.syntax',
    versionControl: 'settingsAppearance.themeProfiles.groups.versionControl',
    diff: 'settingsAppearance.themeProfiles.groups.diff',
    permission: 'settingsAppearance.themeProfiles.groups.permission',
    overlay: 'settingsAppearance.themeProfiles.groups.overlay',
} as const;

const getProfileIdParam = (value: string | string[] | undefined): string | null => {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
};

const resolveInitialEditorMode = (themePreference: 'adaptive' | 'light' | 'dark'): ThemeProfileMode => {
    if (themePreference === 'adaptive') {
        return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
};

const profileHasAnyColorOverrides = (profile: ThemeProfileV1): boolean => (
    Object.keys(profile.overrides.light).length > 0 || Object.keys(profile.overrides.dark).length > 0
);

const profileEditorRoute = (profileId: string) => ({
    pathname: '/settings/appearance/themes/[profileId]' as const,
    params: { profileId },
});

const profileExportRoute = (profileId: string) => ({
    pathname: '/settings/appearance/themes/export' as const,
    params: { profileId },
});

const createProfileName = (count: number): string => t('settingsAppearance.themeProfiles.newProfileName', { count });

const createNewProfileRouteId = 'new';

export const ThemeProfileEditorScreen = React.memo(function ThemeProfileEditorScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams();
    const reduceMotion = useReducedMotionPreference();
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles, setThemeProfiles] = useLocalSettingMutable('themeProfiles');
    const profileId = getProfileIdParam(params.profileId);
    const isNewProfile = profileId === createNewProfileRouteId;
    const builtInDefinition = BUILT_IN_THEME_PROFILES.find((definition) => definition.profile.id === profileId);
    const storedProfile = themeProfiles.profiles.find((profile) => profile.id === profileId) ?? null;
    const sourceProfile = storedProfile ?? builtInDefinition?.profile ?? null;
    const readonly = builtInDefinition !== undefined && !isNewProfile;
    const persisted = storedProfile !== null;
    const presetOptions = React.useMemo(() => buildThemePresetSourceOptions(themeProfiles), [themeProfiles]);
    const resolveInitialPresetId = React.useCallback((): string => {
        if (isNewProfile) {
            const activeProfile = findThemeProfileById(themeProfiles, themeProfiles.activeProfileId);
            if (activeProfile) return activeProfile.id;
            return resolveInitialEditorMode(themePreference);
        }
        return sourceProfile?.id ?? resolveInitialEditorMode(themePreference);
    }, [isNewProfile, sourceProfile?.id, themePreference, themeProfiles]);
    const initialPresetIdRef = React.useRef<string | null>(null);
    if (initialPresetIdRef.current === null) {
        initialPresetIdRef.current = resolveInitialPresetId();
    }
    const resolveInitialMode = React.useCallback((): ThemeProfileMode => {
        const initialPreset = presetOptions.find((option) => option.id === initialPresetIdRef.current) ?? null;
        if (initialPreset?.profile && !profileHasAnyColorOverrides(initialPreset.profile)) {
            return resolveInitialEditorMode(themePreference);
        }
        if (initialPreset) return initialPreset.preferredMode;
        if (sourceProfile && profileHasAnyColorOverrides(sourceProfile)) return resolveThemePresetSourcePreferredMode(sourceProfile);
        return resolveInitialEditorMode(themePreference);
    }, [presetOptions, sourceProfile, themePreference]);
    const [selectedPresetId, setSelectedPresetId] = React.useState(initialPresetIdRef.current);
    const selectedPreset = React.useMemo(() => (
        presetOptions.find((option) => option.id === selectedPresetId) ?? presetOptions[0] ?? null
    ), [presetOptions, selectedPresetId]);
    const [mode, setMode] = React.useState<ThemeProfileMode>(() => resolveInitialMode());
    const [draft, setDraft] = React.useState<ThemeProfileV1 | null>(() => {
        if (!isNewProfile) return sourceProfile;
        const now = nowThemeProfileTimestamp();
        const initialPreset = presetOptions.find((option) => option.id === initialPresetIdRef.current) ?? null;
        return createThemeProfileDraft({
            id: createThemeProfileId(),
            name: createProfileName(themeProfiles.profiles.length + 1),
            now,
            sourceProfile: initialPreset?.profile ?? undefined,
        });
    });
    const [presetMenuOpen, setPresetMenuOpen] = React.useState(false);
    const [assetAppearanceMenuOpen, setAssetAppearanceMenuOpen] = React.useState(false);
    const [invalidByToken, setInvalidByToken] = React.useState<Readonly<Record<string, boolean>>>({});
    const previewAppliedRef = React.useRef(false);
    const committedRef = React.useRef(false);
    const stableSelectionRef = React.useRef({ themePreference, themeProfiles });

    React.useEffect(() => {
        if (isNewProfile) return;
        setDraft(sourceProfile);
    }, [isNewProfile, sourceProfile]);

    React.useEffect(() => {
        stableSelectionRef.current = { themePreference, themeProfiles };
    }, [themePreference, themeProfiles]);

    const profileDisplayName = builtInDefinition ? t(builtInDefinition.translationKey) : draft?.name;
    const assetAppearance = React.useMemo(() => (
        draft ? resolveThemeProfileAssetAppearance(draft) : mode
    ), [draft, mode]);
    const assetAppearanceItems = React.useMemo((): readonly DropdownMenuItem[] => ([
        {
            id: 'light',
            title: t('settingsAppearance.themeOptions.light'),
            subtitle: t('settingsAppearance.themeDescriptions.light'),
            icon: <Ionicons name="sunny-outline" size={22} color={theme.colors.accent.blue} />,
        },
        {
            id: 'dark',
            title: t('settingsAppearance.themeOptions.dark'),
            subtitle: t('settingsAppearance.themeDescriptions.dark'),
            icon: <Ionicons name="moon-outline" size={22} color={theme.colors.accent.blue} />,
        },
    ]), [theme.colors.accent.blue]);
    const groups = React.useMemo(() => buildThemeProfileTokenGroups(), []);
    const recentColors = React.useMemo(() => (draft ? getThemeProfileRecentColors(draft) : []), [draft]);
    const hasInvalidColor = Object.values(invalidByToken).some(Boolean);
    const hasInvalidProfileName = !readonly && draft ? sanitizeThemeProfileName(draft.name) === null : false;
    const hasProfileLimitReached = !readonly && isNewProfile && themeProfiles.profiles.length >= THEME_PROFILE_MAX_PROFILES;
    const saveDisabled = hasInvalidColor || hasInvalidProfileName || hasProfileLimitReached;

    const selectPreset = React.useCallback(async (presetId: string) => {
        if (!draft || readonly) return;
        const nextPreset = presetOptions.find((option) => option.id === presetId);
        if (!nextPreset) return;

        if (selectedPreset && !themeProfileDraftMatchesPresetSource(draft, selectedPreset)) {
            const confirmed = await Modal.confirm(
                t('settingsAppearance.themeProfiles.replacePresetTitle'),
                t('settingsAppearance.themeProfiles.replacePresetSubtitle'),
                { confirmText: t('common.continue'), destructive: true },
            );
            if (!confirmed) return;
        }

        setSelectedPresetId(nextPreset.id);
        setMode(nextPreset.preferredMode);
        setInvalidByToken({});
        setDraft(replaceThemeProfileDraftFromPresetSource(draft, nextPreset, nowThemeProfileTimestamp()));
    }, [draft, presetOptions, readonly, selectedPreset]);

    const cloneProfile = React.useCallback(() => {
        if (!draft || themeProfiles.profiles.length >= THEME_PROFILE_MAX_PROFILES) return;
        const id = createThemeProfileId();
        const now = nowThemeProfileTimestamp();
        const profile = createThemeProfileDraft({
            id,
            name: t('settingsAppearance.themeProfiles.cloneName', { name: profileDisplayName ?? draft.name }),
            now,
            sourceProfile: draft,
        });
        setThemeProfiles(upsertThemeProfile(themeProfiles, profile));
        router.push(profileEditorRoute(id));
    }, [draft, profileDisplayName, router, setThemeProfiles, themeProfiles]);

    const exportProfile = React.useCallback(() => {
        if (!draft) return;
        router.push(profileExportRoute(draft.id));
    }, [draft, router]);

    const updateColor = React.useCallback((tokenId: string, value: string) => {
        if (readonly) return;
        setDraft((current) => current ? updateThemeProfileDraftColor(current, mode, tokenId, value, nowThemeProfileTimestamp()) : current);
    }, [mode, readonly]);

    const updateInvalid = React.useCallback((tokenId: string, invalid: boolean) => {
        if (readonly) return;
        setInvalidByToken((current) => ({ ...current, [`${mode}:${tokenId}`]: invalid }));
    }, [mode, readonly]);

    const resetToken = React.useCallback((tokenId: string) => {
        if (readonly) return;
        setInvalidByToken((current) => ({ ...current, [`${mode}:${tokenId}`]: false }));
        setDraft((current) => current ? resetThemeProfileDraftToken(current, mode, tokenId, nowThemeProfileTimestamp()) : current);
    }, [mode, readonly]);

    const resetMode = React.useCallback(() => {
        if (readonly) return;
        setInvalidByToken((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${mode}:`))));
        setDraft((current) => current ? resetThemeProfileDraftMode(current, mode, nowThemeProfileTimestamp()) : current);
    }, [mode, readonly]);

    const updateAssetAppearance = React.useCallback((nextAssetAppearance: string) => {
        if (readonly || !isThemeProfileAssetAppearance(nextAssetAppearance)) return;
        setMode(nextAssetAppearance);
        setDraft((current) => current ? {
            ...current,
            assetAppearance: nextAssetAppearance,
            updatedAt: nowThemeProfileTimestamp(),
        } : current);
    }, [readonly]);

    const saveAndActivate = React.useCallback(async () => {
        if (!draft || readonly || saveDisabled) return;
        committedRef.current = true;
        const nextThemeProfiles = {
            ...upsertThemeProfile(themeProfiles, draft),
            activeProfileId: draft.id,
        };
        await activateThemeProfileFromSettingsScreen({
            profileId: draft.id,
            themePreference,
            nextThemePreference: assetAppearance,
            themeProfiles: nextThemeProfiles,
            setThemePreference,
            setThemeProfiles,
            forceAnimate: true,
            reduceMotion,
        });
    }, [assetAppearance, draft, readonly, reduceMotion, saveDisabled, setThemePreference, setThemeProfiles, themePreference, themeProfiles]);

    const deactivate = React.useCallback(async () => {
        committedRef.current = true;
        await activateThemeProfileFromSettingsScreen({
            profileId: null,
            themePreference,
            themeProfiles,
            setThemeProfiles,
            forceAnimate: true,
            reduceMotion,
        });
        router.back();
    }, [reduceMotion, router, setThemeProfiles, themePreference, themeProfiles]);

    const deleteProfile = React.useCallback(async () => {
        if (!draft || readonly) return;
        const confirmed = await Modal.confirm(
            t('settingsAppearance.themeProfiles.deleteProfile'),
            t('settingsAppearance.themeProfiles.deleteProfileSubtitle'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        committedRef.current = true;
        const nextThemeProfiles = removeThemeProfile(themeProfiles, draft.id);
        setThemeProfiles(nextThemeProfiles);
        applyThemeRuntimeSelection({
            themePreference,
            themeProfiles: nextThemeProfiles,
            systemTheme: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
        });
        router.back();
    }, [draft, readonly, router, setThemeProfiles, themePreference, themeProfiles]);

    React.useEffect(() => {
        if (!draft || readonly || hasInvalidColor || hasInvalidProfileName || hasProfileLimitReached) return;
        const timeout = setTimeout(() => {
            previewAppliedRef.current = true;
            applyThemeRuntimeSelection({
                themePreference: assetAppearance,
                themeProfiles: {
                    ...upsertThemeProfile(themeProfiles, draft),
                    activeProfileId: draft.id,
                },
                systemTheme: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
            });
        }, 150);

        return () => clearTimeout(timeout);
    }, [assetAppearance, draft, hasInvalidColor, hasInvalidProfileName, hasProfileLimitReached, readonly, themeProfiles]);

    React.useEffect(() => () => {
        if (!previewAppliedRef.current || committedRef.current) return;
        const stableSelection = stableSelectionRef.current;
        applyThemeRuntimeSelection({
            themePreference: stableSelection.themePreference,
            themeProfiles: stableSelection.themeProfiles,
            systemTheme: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
        });
    }, []);

    if (!draft) {
        return (
            <ItemList testID="settings-theme-profile-editor" style={{ paddingTop: 0 }}>
                <ItemGroup>
                    <Item title={t('settingsAppearance.themeProfiles.missingProfile')} mode="info" />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList testID="settings-theme-profile-editor" style={{ paddingTop: 0 }}>
            <ItemGroup title={readonly ? t('settingsAppearance.themeProfiles.presetGroup') : t('settingsAppearance.themeProfiles.detailsGroup')}>
                <Item
                    title={readonly ? t('settingsAppearance.themeProfiles.readOnlyPreset') : (
                        <View style={styles.profileNameRow}>
                            <Text style={styles.profileNameLabel}>{t('settingsAppearance.themeProfiles.profileName')}</Text>
                            <TextInput
                                testID="settings-theme-profile-name"
                                value={draft.name}
                                onChangeText={(name) => setDraft({ ...draft, name, updatedAt: nowThemeProfileTimestamp() })}
                                style={styles.profileNameInput}
                            />
                        </View>
                    )}
                    mode="info"
                    icon={<Ionicons name="color-palette-outline" size={28} color={theme.colors.accent.indigo} />}
                    detail={readonly ? profileDisplayName : undefined}
                />
                {hasInvalidProfileName ? (
                    <Text
                        testID="settings-theme-profile-name-error"
                        style={{
                            color: theme.colors.state.danger.foreground,
                            paddingHorizontal: 16,
                            paddingBottom: 8,
                        }}
                    >
                        {t('settingsAppearance.themeProfiles.invalidProfileName')}
                    </Text>
                ) : null}
                {hasProfileLimitReached ? (
                    <Text
                        testID="settings-theme-profile-limit-error"
                        style={{
                            color: theme.colors.state.danger.foreground,
                            paddingHorizontal: 16,
                            paddingBottom: 8,
                        }}
                    >
                        {t('settingsAppearance.themeProfiles.profileLimitReached')}
                    </Text>
                ) : null}
                {!readonly ? (
                    <ThemeProfilePresetDropdown
                        open={presetMenuOpen}
                        onOpenChange={setPresetMenuOpen}
                        options={presetOptions}
                        selectedOption={selectedPreset}
                        onSelect={(presetId) => { void selectPreset(presetId); }}
                    />
                ) : null}
                {!readonly ? (
                    <DropdownMenu
                        open={assetAppearanceMenuOpen}
                        onOpenChange={setAssetAppearanceMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={assetAppearance}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        itemTrigger={{
                            title: t('settingsAppearance.themeProfiles.assetAppearance'),
                            subtitle: t('settingsAppearance.themeProfiles.assetAppearanceSubtitle'),
                            icon: <Ionicons name="image-outline" size={28} color={theme.colors.accent.indigo} />,
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-theme-profile-asset-appearance' },
                        }}
                        items={assetAppearanceItems}
                        onSelect={updateAssetAppearance}
                    />
                ) : null}
                <Item
                    testID={`settings-theme-profile-clone-${draft.id}`}
                    title={t('settingsAppearance.themeProfiles.cloneProfile')}
                    subtitle={profileDisplayName ?? draft.name}
                    icon={<Ionicons name="copy-outline" size={28} color={theme.colors.accent.blue} />}
                    onPress={cloneProfile}
                    disabled={themeProfiles.profiles.length >= THEME_PROFILE_MAX_PROFILES}
                />
                <Item
                    testID={`settings-theme-profile-export-${draft.id}`}
                    title={t('settingsAppearance.themeProfiles.exportProfile')}
                    subtitle={t('settingsAppearance.themeProfiles.exportProfileSubtitle')}
                    icon={<Ionicons name="download-outline" size={28} color={theme.colors.accent.green} />}
                    onPress={exportProfile}
                />
            </ItemGroup>

            <ThemeProfilePreviewPane profile={draft} mode={mode} />

            {groups.map((group) => (
                <ItemGroup key={group.group} title={t(groupTitleKeys[group.group as keyof typeof groupTitleKeys] ?? 'settingsAppearance.themeProfiles.groups.background')}>
                    {group.tokens.map((token) => (
                        <ThemeColorTokenRow
                            key={token.id}
                            profile={draft}
                            mode={mode}
                            token={token}
                            invalid={invalidByToken[`${mode}:${token.id}`] === true}
                            readonly={readonly}
                            recentColors={recentColors}
                            onChange={updateColor}
                            onInvalidChange={updateInvalid}
                            onReset={resetToken}
                        />
                    ))}
                </ItemGroup>
            ))}

            {!readonly ? (
                <ItemGroup title={t('settingsAppearance.themeProfiles.resetGroup')}>
                    <Item
                        testID={`settings-theme-profile-reset-${mode}`}
                        title={t('settingsAppearance.themeProfiles.resetMode')}
                        icon={<Ionicons name="refresh-outline" size={28} color={theme.colors.accent.orange} />}
                        onPress={resetMode}
                    />
                    {persisted && themeProfiles.activeProfileId === draft.id ? (
                        <>
                            <Item
                                testID="settings-theme-profile-deactivate"
                                title={t('settingsAppearance.themeProfiles.deactivateProfile')}
                                subtitle={t('settingsAppearance.themeProfiles.deactivateProfileSubtitle')}
                                icon={<Ionicons name="contrast-outline" size={28} color={theme.colors.status.connecting} />}
                                onPress={() => { void deactivate(); }}
                            />
                            <Item
                                testID="settings-theme-profile-delete"
                                title={t('settingsAppearance.themeProfiles.deleteProfile')}
                                subtitle={t('settingsAppearance.themeProfiles.deleteProfileSubtitle')}
                                destructive
                                icon={<Ionicons name="trash-outline" size={28} color={theme.colors.state.danger.foreground} />}
                                onPress={() => { void deleteProfile(); }}
                            />
                        </>
                    ) : null}
                </ItemGroup>
            ) : null}

            {!readonly ? (
                <SettingsActionFooter
                    primaryLabel={t('settingsAppearance.themeProfiles.saveAndActivate')}
                    primaryTestID="settings-theme-profile-save"
                    primaryDisabled={saveDisabled}
                    onPrimaryPress={() => { void saveAndActivate(); }}
                />
            ) : null}
        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    profileNameRow: {
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
        width: '100%',
    },
    profileNameLabel: {
        color: theme.colors.text.primary,
        fontSize: 16,
        fontWeight: '700',
    },
    profileNameInput: {
        backgroundColor: 'transparent',
        borderWidth: 0,
        color: theme.colors.input.text,
        flex: 1,
        minWidth: 180,
        paddingHorizontal: 0,
        paddingVertical: 0,
        textAlign: 'left',
    },
}));
