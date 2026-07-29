import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRouter } from 'expo-router';
import { useAllMachines, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Modal } from '@/modal';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { DEFAULT_PROFILES, getBuiltInProfileNameKey, isProfileEnabled, resolveProfileById, setProfileEnabledOverride } from '@/sync/domains/profiles/profileUtils';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { LaunchProfileEditForm } from '@/components/profiles/edit';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/domains/profiles/profileMutations';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { getRequiredSecretEnvVarNames } from '@/sync/domains/profiles/profileSecrets';
import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol';
import { LegacyProfileMigrationFlow } from '@/components/profiles/migration/LegacyProfileMigrationFlow';
import { LegacyProfileMigrationConflictFlow } from '@/components/profiles/migration/LegacyProfileMigrationConflictFlow';
import { resolveProfileMigrationConflict, resolveProfileMigrationStatus } from '@/components/profiles/migration/status';
import {
    type ActiveUnsavedChangesGuard,
    runUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import {
    appendAiLaunchProfile,
    projectAiLaunchProfileForLegacyUi,
    readUiAiLaunchProfiles,
    removeAiLaunchProfile,
    replaceAiLaunchProfile,
} from '@/sync/domains/profiles/aiLaunchProfileCollection';

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Profile utilities now imported from @/sync/profileUtils
const ProfileManager = React.memo(function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [rawProfiles, setRawProfiles] = useSettingMutable('profiles');
    const launchProfiles = React.useMemo(() => readUiAiLaunchProfiles(rawProfiles), [rawProfiles]);
    const profiles = React.useMemo(
        () => launchProfiles.map(projectAiLaunchProfileForLegacyUi),
        [launchProfiles],
    );
    const writeRawProfiles = React.useCallback((next: readonly unknown[]) => {
        setRawProfiles(next as AIBackendProfile[]);
    }, [setRawProfiles]);
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [profileEnabledById, setProfileEnabledById] = useSettingMutable('profileEnabledById');
    const [editingProfile, setEditingProfile] = React.useState<AiLaunchProfile | null>(null);
    const [migrationReviewProfile, setMigrationReviewProfile] = React.useState<AIBackendProfile | null>(null);
    const [migrationConflictProfile, setMigrationConflictProfile] = React.useState<AIBackendProfile | null>(null);
    const providerSettingsV1 = useSetting('providerSettingsV1');
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [isEditingDirty, setIsEditingDirty] = React.useState(false);
    const isEditingDirtyRef = React.useRef(false);
    const saveRef = React.useRef<(() => boolean) | null>(null);
    const [secrets, setSecrets] = useSavedSecretsMutable();
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const machines = useAllMachines();
    const profileValidationMachineId = React.useMemo(() => (
        machines.find((machine) => machine.active)?.id ?? machines[0]?.id ?? null
    ), [machines]);

    const openSecretModal = React.useCallback((profile: AIBackendProfile, envVarName?: string) => {
        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);
        const requiredSecretName = (envVarName ?? requiredSecretNames[0] ?? '').trim().toUpperCase();
        if (!requiredSecretName) return;

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action !== 'selectSaved') return;
            setSecretBindingsByProfileId({
                ...secretBindingsByProfileId,
                [profile.id]: {
                    ...(secretBindingsByProfileId[profile.id] ?? {}),
                    [requiredSecretName]: result.secretId,
                },
            });
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile,
                secretEnvVarName: requiredSecretName,
                secretEnvVarNames: requiredSecretNames,
                machineId: null,
                secrets,
                defaultSecretId: secretBindingsByProfileId[profile.id]?.[requiredSecretName] ?? null,
                defaultSecretIdByEnvVarName: secretBindingsByProfileId[profile.id] ?? null,
                onChangeSecrets: setSecrets,
                allowSessionOnly: false,
                onResolve: handleResolve,
            },
            onRequestClose: () => handleResolve({ action: 'cancel' } as SecretRequirementModalResult),
            closeOnBackdrop: true,
        });
    }, [secrets, secretBindingsByProfileId, setSecretBindingsByProfileId]);

    React.useEffect(() => {
        isEditingDirtyRef.current = isEditingDirty;
    }, [isEditingDirty]);

    const handleAddProfile = () => {
        if (Platform.OS !== 'web') {
            router.push({ pathname: '/new/pick/profile-edit', params: {} } as any);
            return;
        }
        setEditingProfile(createEmptyCustomProfile());
        setShowAddForm(true);
    };

    const handleEditProfile = (profile: AIBackendProfile) => {
        const editable = launchProfiles.find((entry) => entry.id === profile.id) ?? profile;
        if (Platform.OS !== 'web') {
            router.push({ pathname: '/new/pick/profile-edit', params: { profileId: profile.id } } as any);
            return;
        }
        setEditingProfile(editable);
        setShowAddForm(true);
    };

    const handleDuplicateProfile = (profile: AIBackendProfile) => {
        if (Platform.OS !== 'web') {
            router.push({ pathname: '/new/pick/profile-edit', params: { cloneFromProfileId: profile.id } } as any);
            return;
        }
        const source = launchProfiles.find((entry) => entry.id === profile.id) ?? profile;
        setEditingProfile(duplicateProfileForEdit(source, { copySuffix: t('profiles.copySuffix') }));
        setShowAddForm(true);
    };

    const closeEditor = React.useCallback(() => {
        setShowAddForm(false);
        setEditingProfile(null);
        setIsEditingDirty(false);
    }, []);

    const requestUnsavedChangesDecision = React.useCallback(() => {
        const isBuiltIn = !!editingProfile && DEFAULT_PROFILES.some((bp) => bp.id === editingProfile.id);
        const saveText = isBuiltIn ? t('common.saveAs') : t('common.save');
        const message = isBuiltIn
            ? `${t('common.unsavedChangesWarning')}\n\n${t('profiles.builtInSaveAsHint')}`
            : t('common.unsavedChangesWarning');
        return promptUnsavedChangesAlert(
            (title, message, buttons) => Modal.alert(title, message, buttons),
            {
                title: t('common.discardChanges'),
                message,
                discardText: t('common.discard'),
                saveText,
                keepEditingText: t('common.keepEditing'),
            },
        );
    }, [editingProfile]);
    const saveEditor = React.useCallback(() => saveRef.current?.() ?? false, []);
    const inlineEditorGuard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef: isEditingDirtyRef,
        requestDecision: requestUnsavedChangesDecision,
        onSave: saveEditor,
        tag: 'ProfilesScreen.inlineEditorGuard',
    }), [requestUnsavedChangesDecision, saveEditor]);
    const requestCloseEditor = React.useCallback(() => {
        void runUnsavedChangesGuard(inlineEditorGuard, closeEditor);
    }, [closeEditor, inlineEditorGuard]);
    const continueNavigation = React.useCallback((action: unknown) => {
        closeEditor();
        if (action) {
            (navigation as { dispatch?: (value: unknown) => void } | null)?.dispatch?.(action);
        }
    }, [closeEditor, navigation]);

    useUnsavedChangesBeforeRemoveGuard({
        enabled: Platform.OS === 'web' && showAddForm,
        isDirty: isEditingDirty,
        isDirtyRef: isEditingDirtyRef,
        requestDecision: requestUnsavedChangesDecision,
        onSave: saveEditor,
        onContinue: continueNavigation,
        tag: 'ProfilesScreen.beforeRemove',
    });

    const handleDeleteProfile = async (profile: AIBackendProfile) => {
        const confirmed = await Modal.confirm(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            { cancelText: t('profiles.delete.cancel'), confirmText: t('profiles.delete.confirm'), destructive: true }
        );
        if (!confirmed) return;

        writeRawProfiles(removeAiLaunchProfile(rawProfiles, profile.id));

        // Clear last used profile if it was deleted
        if (lastUsedProfile === profile.id) {
            setLastUsedProfile(null);
        }

        // Notify parent if this was the selected profile
        if (selectedProfileId === profile.id && onProfileSelect) {
            onProfileSelect(null);
        }
    };

    const handleSelectProfile = (profileId: string | null) => {
        let profile: AIBackendProfile | null = null;

        if (profileId) {
            profile = resolveProfileById(profileId, profiles);
        }

        if (onProfileSelect) {
            onProfileSelect(profile);
        }
        setLastUsedProfile(profileId);
    };

    const buildProfileEnablementActions = React.useCallback((profile: AIBackendProfile): ItemAction[] => {
        const enabled = isProfileEnabled(profile, profileEnabledById);
        const actual = launchProfiles.find((entry) => entry.id === profile.id);
        const migrationStatus = actual
            ? resolveProfileMigrationStatus({ profile: actual, providerSettings: providerSettingsV1 })
            : null;
        return [
            ...(migrationStatus === 'review' && actual && !isLaunchProfileV2(actual) ? [{
                id: 'reviewProviderMigration',
                title: t('settingsProviders.migration.reviewAction'),
                icon: 'git-compare-outline' as const,
                onPress: () => setMigrationReviewProfile(actual),
            }] : []),
            ...(migrationStatus === 'conflict' && actual && !isLaunchProfileV2(actual) ? [{
                id: 'reviewProviderMigrationConflict',
                title: t('settingsProviders.migration.conflictReviewAction'),
                icon: 'git-compare-outline' as const,
                onPress: () => setMigrationConflictProfile(actual),
            }] : []),
            {
                id: 'profileEnabled',
                title: enabled ? t('common.enabled') : t('common.disabled'),
                icon: enabled ? 'eye-outline' : 'eye-off-outline',
                onPress: () => {
                    setProfileEnabledById(setProfileEnabledOverride(profileEnabledById, profile, !enabled));
                },
            },
        ];
    }, [launchProfiles, profileEnabledById, providerSettingsV1, setProfileEnabledById]);

    const getProfileEnablementSubtitle = React.useCallback((profile: AIBackendProfile) => {
        const actual = launchProfiles.find((entry) => entry.id === profile.id);
        const migrationStatus = actual
            ? resolveProfileMigrationStatus({ profile: actual, providerSettings: providerSettingsV1 })
            : null;
        const parts = [
            ...(isProfileEnabled(profile, profileEnabledById) ? [] : [t('common.disabled')]),
            ...(migrationStatus === 'review' ? [t('settingsProviders.migration.reviewActionDescription')] : []),
            ...(migrationStatus === 'conflict' ? [t('settingsProviders.migration.conflictReviewActionDescription')] : []),
            ...(migrationStatus === 'retained' ? [t('settingsProviders.migration.retainedDescription')] : []),
        ];
        return parts.length > 0 ? parts.join(' · ') : null;
    }, [launchProfiles, profileEnabledById, providerSettingsV1]);

    function handleSaveProfile(profile: AiLaunchProfile): boolean {
        // Profile validation - ensure name is not empty
        if (!profile.name || profile.name.trim() === '') {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return false;
        }

        // Check if this is a built-in profile being edited
        const isBuiltIn = DEFAULT_PROFILES.some(bp => bp.id === profile.id);
        const builtInNames = DEFAULT_PROFILES
            .map((bp) => {
                const key = getBuiltInProfileNameKey(bp.id);
                return key ? t(key).trim() : null;
            })
            .filter((name): name is string => Boolean(name));

        // For built-in profiles, create a new custom profile instead of modifying the built-in
        if (isBuiltIn) {
            const newProfile = convertBuiltInProfileToCustom(profile as AIBackendProfile);
            const hasBuiltInNameConflict = builtInNames.includes(newProfile.name.trim());

            // Check for duplicate names (excluding the new profile)
            const isDuplicate = profiles.some((p: AIBackendProfile) =>
                p.name.trim() === newProfile.name.trim()
            );
            if (isDuplicate || hasBuiltInNameConflict) {
                Modal.alert(t('common.error'), t('profiles.duplicateName'));
                return false;
            }

            writeRawProfiles(appendAiLaunchProfile(rawProfiles, newProfile));
        } else {
            // Handle custom profile updates
            // Check for duplicate names (excluding current profile if editing)
            const isDuplicate = profiles.some((p: AIBackendProfile) =>
                p.id !== profile.id && p.name.trim() === profile.name.trim()
            );
            const hasBuiltInNameConflict = builtInNames.includes(profile.name.trim());
            if (isDuplicate || hasBuiltInNameConflict) {
                Modal.alert(t('common.error'), t('profiles.duplicateName'));
                return false;
            }

            const existing = launchProfiles.some((entry) => entry.id === profile.id);
            const updated = { ...profile, updatedAt: Date.now() } as AiLaunchProfile;
            writeRawProfiles(existing
                ? replaceAiLaunchProfile(rawProfiles, profile.id, updated)
                : appendAiLaunchProfile(rawProfiles, updated));
        }

        closeEditor();
        return true;
    }

    if (!useProfiles) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup
                    title={t('settingsFeatures.profiles')}
                    footer={t('settingsFeatures.profilesDisabled')}
                >
                    <Item
                        title={t('settingsFeatures.profiles')}
                        subtitle={t('settingsFeatures.profilesDisabled')}
                        icon={<Ionicons name="person-outline" size={29} color={theme.colors.accent.purple} />}
                        rightElement={
                            <Switch
                                value={useProfiles}
                                onValueChange={setUseProfiles}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <View style={{ flex: 1 }}>
            <ProfilesList
                customProfiles={profiles}
                favoriteProfileIds={favoriteProfileIds}
                onFavoriteProfileIdsChange={setFavoriteProfileIds}
                profileEnabledById={profileEnabledById}
                includeDisabledProfiles
                selectedProfileId={selectedProfileId ?? null}
                onPressProfile={(profile) => handleEditProfile(profile)}
                includeDefaultEnvironmentRow
                onPressDefaultEnvironment={() => handleSelectProfile(null)}
                machineId={null}
                includeAddProfileRow
                onAddProfilePress={handleAddProfile}
                onEditProfile={(profile) => handleEditProfile(profile)}
                onDuplicateProfile={(profile) => handleDuplicateProfile(profile)}
                onDeleteProfile={(profile) => { void handleDeleteProfile(profile); }}
                extraActions={buildProfileEnablementActions}
                getProfileSubtitleExtra={getProfileEnablementSubtitle}
                onSecretBadgePress={(profile) => {
                    const required = getRequiredSecretEnvVarNames(profile);
                    if (required.length <= 1) {
                        openSecretModal(profile, required[0]);
                        return;
                    }
                    // When multiple required secrets exist, prompt for which env var to configure.
                    Modal.alert(
                        t('secrets.defineDefaultForProfileTitle'),
                        required.join('\n'),
                        [
                            { text: t('common.cancel'), style: 'cancel' },
                            ...required.map((env) => ({
                                text: env,
                                onPress: () => openSecretModal(profile, env),
                            })),
                        ],
                    );
                }}
                getSecretOverrideReady={(profile) => {
                    const satisfaction = getSecretSatisfaction({
                        profile,
                        secrets,
                        defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
                        // No machine selected on this screen; explicitly treat machine env as unavailable.
                        machineEnvReadyByName: null,
                    });
                    return satisfaction.isSatisfied && satisfaction.items.some((i) => i.required && i.satisfiedBy !== 'machineEnv');
                }}
                // No machine selected on this screen, so machine-env preflight is intentionally omitted.
            />

            {/* Profile Add/Edit Modal */}
            {showAddForm && editingProfile && (
                <Pressable
                    style={profileManagerStyles.modalOverlay}
                    onPress={requestCloseEditor}
                >
                    <Pressable style={profileManagerStyles.modalContent} onPress={() => { }}>
                        <LaunchProfileEditForm
                            profile={editingProfile}
                            machineId={isLaunchProfileV2(editingProfile) ? profileValidationMachineId : null}
                            onSave={handleSaveProfile}
                            onCancel={requestCloseEditor}
                            onDirtyChange={setIsEditingDirty}
                            saveRef={saveRef}
                        />
                    </Pressable>
                </Pressable>
            )}

            {migrationReviewProfile ? (
                <Pressable
                    style={profileManagerStyles.modalOverlay}
                    onPress={() => setMigrationReviewProfile(null)}
                >
                    <Pressable style={profileManagerStyles.modalContent} onPress={() => {}}>
                        <LegacyProfileMigrationFlow
                            profile={migrationReviewProfile}
                            secretBindings={secretBindingsByProfileId[migrationReviewProfile.id] ?? {}}
                            onClose={() => setMigrationReviewProfile(null)}
                        />
                    </Pressable>
                </Pressable>
            ) : null}

            {migrationConflictProfile ? (() => {
                const conflict = resolveProfileMigrationConflict({
                    profileId: migrationConflictProfile.id,
                    providerSettings: providerSettingsV1,
                });
                if (!conflict) return null;
                return <Pressable
                    style={profileManagerStyles.modalOverlay}
                    onPress={() => setMigrationConflictProfile(null)}
                >
                    <Pressable style={profileManagerStyles.modalContent} onPress={() => {}}>
                        <LegacyProfileMigrationConflictFlow
                            profileName={migrationConflictProfile.name}
                            conflict={conflict}
                            onClose={() => setMigrationConflictProfile(null)}
                        />
                    </Pressable>
                </Pressable>;
            })() : null}
        </View>
    );
});

// ProfileEditForm now imported from @/components/profiles/edit

const profileManagerStyles = StyleSheet.create((theme) => ({
    modalOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    modalContent: {
        width: '100%',
        maxWidth: 600,
        maxHeight: '90%',
        flex: 1,
        minHeight: 0,
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: theme.colors.background.canvas,
    },
}));

export default ProfileManager;
