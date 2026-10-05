import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Appearance, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { ThemePalettePreview } from '@/components/settings/appearance/ThemeModePreview';
import { useApplyThemeSelection } from '@/components/settings/appearance/useApplyThemeSelection';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { storage, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { createThemeProfileDraft, resetThemeProfileDraftMode, resetThemeProfileDraftToken, updateThemeProfileDraftColor } from '@/theme/profiles/createThemeProfileDraft';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import { sanitizeThemeProfileName } from '@/theme/profiles/themeProfileImportExport';
import { isThemeProfileAssetAppearance, resolveThemeProfileAssetAppearance } from '@/theme/profiles/themeProfileAssetAppearance';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import {
    clearActiveThemeProfileReferences,
    findActiveThemeProfileForMode,
    isThemeProfileActive,
    setActiveThemeProfileForMode,
} from '@/theme/profiles/themeProfilePersistence';
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
    find: 'settingsAppearance.themeProfiles.groups.find',
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
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams();
    const reduceMotion = useReducedMotionPreference();
    const [themePreference] = useLocalSettingMutable('themePreference');
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
            const activeProfile = findActiveThemeProfileForMode(themeProfiles, resolveInitialEditorMode(themePreference));
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
        await activateThemeProfileFromSettingsScreen({
            profileId: draft.id,
            profileMode: assetAppearance,
            readLocalSettings: () => storage.getState().localSettings,
            profile: draft,
            writeLocalSettings: delta => storage.getState().applyLocalSettings(delta),
            forceAnimate: true,
            reduceMotion,
        });
    }, [assetAppearance, draft, readonly, reduceMotion, saveDisabled]);

    const applyThemeSelection = useApplyThemeSelection();
    const deactivate = React.useCallback(async () => {
        committedRef.current = true;
        if (!draft) return;
        // Returning a mode to its default goes through the one theme-selection owner.
        await applyThemeSelection(themePreference, clearActiveThemeProfileReferences(themeProfiles, draft.id));
        router.back();
    }, [applyThemeSelection, draft, router, themePreference, themeProfiles]);

    const deleteProfile = React.useCallback(async () => {
        if (!draft || readonly) return;
        // A theme a mode uses says which mode loses it; that mode returns to its default theme.
        const assignedSlots = (['light', 'dark'] as const).filter((mode) => themeProfiles.activeProfileIds[mode] === draft.id);
        const slotNames = assignedSlots.map((mode) => t(mode === 'light'
            ? 'settingsAppearance.themeProfiles.lightModeSection'
            : 'settingsAppearance.themeProfiles.darkModeSection'));
        const confirmed = await Modal.confirm(
            t('settingsAppearance.themeProfiles.deleteProfile'),
            assignedSlots.length > 0
                ? t('settingsAppearance.themeProfiles.deleteAssignedThemeBody', { slots: slotNames.join(' · ') })
                : t('settingsAppearance.themeProfiles.deleteProfileSubtitle'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        committedRef.current = true;
        const nextThemeProfiles = removeThemeProfile(themeProfiles, draft.id);
        if (assignedSlots.length > 0) {
            // The canonical selection owner stores and applies the fallback (theme, status bar, transition).
            await applyThemeSelection(themePreference, nextThemeProfiles);
        } else {
            setThemeProfiles(nextThemeProfiles);
        }
        router.back();
    }, [applyThemeSelection, draft, readonly, router, setThemeProfiles, themePreference, themeProfiles]);

    React.useEffect(() => {
        if (!draft || readonly || hasInvalidColor || hasInvalidProfileName || hasProfileLimitReached) return;
        const timeout = setTimeout(() => {
            previewAppliedRef.current = true;
            applyThemeRuntimeSelection({
                themePreference: assetAppearance,
                themeProfiles: setActiveThemeProfileForMode(upsertThemeProfile(themeProfiles, draft), assetAppearance, draft.id),
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

    const inUse = persisted && draft !== null && isThemeProfileActive(themeProfiles, draft.id);
    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => [
        ...(!readonly ? [{ id: 'reset', title: t('settingsAppearance.themeProfiles.resetMode'), onSelect: resetMode }] : []),
        // Duplicating and exporting work on a saved or built-in theme, never an unsaved draft.
        ...(!isNewProfile ? [
            {
                id: 'duplicate',
                title: t('settingsAppearance.themeProfiles.duplicateTheme'),
                disabled: themeProfiles.profiles.length >= THEME_PROFILE_MAX_PROFILES,
                onSelect: cloneProfile,
            },
            { id: 'export', title: t('settingsAppearance.themeProfiles.exportProfile'), onSelect: exportProfile },
        ] : []),
        ...(inUse && !readonly ? [{ id: 'deactivate', title: t('settingsAppearance.themeProfiles.deactivateProfile'), onSelect: deactivate }] : []),
        ...(persisted && !readonly ? [{ id: 'delete', title: t('settingsAppearance.themeProfiles.deleteTheme'), onSelect: deleteProfile }] : []),
    ], [cloneProfile, deactivate, deleteProfile, exportProfile, inUse, isNewProfile, persisted, readonly, resetMode, themeProfiles.profiles.length]);
    const markPalette = React.useMemo(() => resolveThemeProfile({ mode: assetAppearance, profile: draft }), [assetAppearance, draft]);

    if (!draft) {
        return (
            <ItemList testID="settings-theme-profile-editor" style={{ paddingTop: 0 }}>
                <PageHeader
                    alwaysShowTitle
                    title={t('settingsAppearance.themeProfiles.missingProfile')}
                    description={t('settingsAppearance.themeProfiles.missingProfileDescription')}
                />
            </ItemList>
        );
    }

    const title = profileDisplayName?.trim() || t('settingsAppearance.themeProfiles.newTheme');
    const meta: PageHeaderMetaFact[] = [
        { key: 'mode', text: t(assetAppearance === 'dark' ? 'settingsAppearance.themeOptions.dark' : 'settingsAppearance.themeOptions.light') },
        { key: 'kind', text: t(readonly ? 'settingsAppearance.themeProfiles.builtInTheme' : 'settingsAppearance.themeProfiles.customTheme') },
        ...(inUse ? [{ key: 'inUse', text: t('settingsAppearance.themeProfiles.inUse') }] : []),
    ];

    return (
        <ItemList testID="settings-theme-profile-editor" style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="settings-theme-profile-header"
                alwaysShowTitle
                title={title}
                description={t(readonly
                    ? 'settingsAppearance.themeProfiles.builtInThemeDescription'
                    : 'settingsAppearance.themeProfiles.editorDescription')}
                meta={meta}
                details={hasProfileLimitReached ? (
                    <Text
                        testID="settings-theme-profile-limit-error"
                        accessibilityRole="alert"
                        style={styles.headerError}
                    >
                        {t('settingsAppearance.themeProfiles.themeLimitDescription', { count: THEME_PROFILE_MAX_PROFILES })}
                    </Text>
                ) : undefined}
                leading={(
                    <View style={styles.markPreview}>
                        <ThemePalettePreview palette={markPalette} />
                    </View>
                )}
                actions={(
                    <View style={styles.headerActions}>
                        {!readonly ? (
                            <RoundButton
                                testID="settings-theme-profile-save"
                                size="small"
                                title={t('settingsAppearance.themeProfiles.saveAndUse')}
                                disabled={saveDisabled}
                                onPress={() => { void saveAndActivate(); }}
                            />
                        ) : null}
                        <PageHeaderMenu testID="settings-theme-profile-menu" actions={menuActions} />
                    </View>
                )}
            />

            {!readonly ? (
                <ItemGroup
                    title={t('settingsAppearance.themeProfiles.detailsGroup')}
                    description={t('settingsAppearance.themeProfiles.detailsDescription')}
                >
                    <Item
                        title={t('settingsAppearance.themeProfiles.themeName')}
                        accessoryLayout="adaptive"
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput
                                testID="settings-theme-profile-name"
                                value={draft.name}
                                onChangeText={(name) => setDraft({ ...draft, name, updatedAt: nowThemeProfileTimestamp() })}
                                accessibilityLabel={t('settingsAppearance.themeProfiles.themeName')}
                                autoCapitalize="words"
                                autoFocus={isNewProfile}
                                error={hasInvalidProfileName ? t('settingsAppearance.themeProfiles.invalidProfileName') : null}
                            />
                        )}
                    />
                    <ThemeProfilePresetDropdown
                        open={presetMenuOpen}
                        onOpenChange={setPresetMenuOpen}
                        options={presetOptions}
                        selectedOption={selectedPreset}
                        onSelect={(presetId) => { void selectPreset(presetId); }}
                    />
                    <SegmentedChoiceItem<ThemeProfileMode>
                        testID="settings-theme-profile-asset-appearance"
                        testIDPrefix="settings-theme-profile-asset-appearance"
                        title={t('settingsAppearance.themeProfiles.themeAppearance')}
                        subtitle={t('settingsAppearance.themeProfiles.themeAppearanceDescription')}
                        subtitleLines={0}
                        options={[
                            { id: 'light', label: t('settingsAppearance.themeOptions.light') },
                            { id: 'dark', label: t('settingsAppearance.themeOptions.dark') },
                        ]}
                        value={assetAppearance}
                        onChange={updateAssetAppearance}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settingsAppearance.themeProfiles.previewSection')}>
                <SectionContentRow>
                    <ThemeProfilePreviewPane profile={draft} mode={mode} />
                </SectionContentRow>
            </ItemGroup>

            {groups.map((group, index) => (
                <ItemGroup
                    key={group.group}
                    title={t(groupTitleKeys[group.group as keyof typeof groupTitleKeys] ?? 'settingsAppearance.themeProfiles.groups.background')}
                    description={index === 0 ? t(readonly
                        ? 'settingsAppearance.themeProfiles.colorsReadOnlyDescription'
                        : 'settingsAppearance.themeProfiles.colorsDescription') : undefined}
                >
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
        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerError: {
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
        lineHeight: 18,
    },
    // The theme preview owns its shape; entity marks do not provide a backing tile.
    markPreview: {
        width: 44,
        height: 44,
        borderRadius: 11,
        overflow: 'hidden',
    },
}));
