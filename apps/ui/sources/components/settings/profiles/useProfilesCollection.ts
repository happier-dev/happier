import { useAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { useProfileCatalog } from '@/sync/store/useProfileCatalog';
import { useProviderSettings } from '@/providers/hooks/useProviderSettings';
import * as React from 'react';
import type { AiLaunchProfile } from '@happier-dev/protocol';
import { isBuiltInAiLaunchProfileV1 } from '@happier-dev/protocol/profiles/read';
import type { Settings } from '@/sync/domains/settings/settings';

import { resolveProfileMigrationStatus } from '@/components/profiles/migration/status';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { Modal } from '@/modal';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { toggleFavoriteProfileId } from '@/sync/domains/profiles/profileGrouping';
import { projectAiLaunchProfileForLegacyUi } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { getRequiredSecretEnvVarNames } from '@/sync/domains/profiles/profileSecrets';
import {
    getBuiltInProfile,
    isProfileEnabled,
    readProfileEnabledById,
} from '@/sync/domains/profiles/profileUtils';
import {
    useCurrentSecretBindingsByProfileIdMutable,
    useSetting,
    useSettingMutable,
} from '@/sync/domains/state/storage';
import { requireUpdatedProfileOperation, useAccountSettingsScope, useDeleteAiLaunchProfile, useProfileOperations } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { getStorage } from '@/sync/domains/state/storageStore';

export type ProfileMigrationStatus = ReturnType<typeof resolveProfileMigrationStatus>;

export type ProfilesCollection = {
    useProfiles: Settings['useProfiles'];
    setUseProfiles: ReturnType<typeof useSettingMutable<'useProfiles'>>[1];
    catalog: ReturnType<typeof useProfileCatalog>;
    launchProfiles: ReturnType<typeof useAiLaunchProfiles>;
    profiles: ReturnType<typeof projectAiLaunchProfileForLegacyUi>[];
    favoriteProfileIds: Settings['favoriteProfiles'];
    setFavoriteProfileIds: ReturnType<typeof useSettingMutable<'favoriteProfiles'>>[1];
    profileEnabledById: ReturnType<typeof readProfileEnabledById>;
    providerSettings: ReturnType<typeof useProviderSettings>;
    secretBindingsByProfileId: ReturnType<typeof useCurrentSecretBindingsByProfileIdMutable>[0];
    administrationTargetSelection: ReturnType<typeof useMachineAdministrationTargetSelection>;
    executionTarget: ReturnType<ReturnType<typeof useMachineAdministrationTargetSelection>['resolveExecutionTarget']>;
    resolveProfile: (profileId: string) => AiLaunchProfile | null;
    isEnabled: (profile: AIBackendProfile) => boolean;
    setEnabled: (profile: AIBackendProfile, enabled: boolean) => Promise<void>;
    isFavorite: (profileId: string) => boolean;
    toggleFavorite: (profileId: string) => void;
    migrationStatusOf: (profileId: string) => ProfileMigrationStatus | null;
    describeStatus: (profile: AIBackendProfile) => string | null;
    requestDelete: (profile: Readonly<{ id: string; name: string }>) => Promise<boolean>;
    chooseDefaultSecret: (profile: AIBackendProfile) => void;
    isSecretOverrideReady: (profile: AIBackendProfile) => boolean;
};

/**
 * Settings › Profiles state shared by the collection's list, rail and detail: the saved profiles,
 * favorites, which profiles are offered, the machine the page manages, and the operations on a
 * profile. Entity edits use the canonical Profile operation; ordinary preferences retain their owner.
 */
export function useProfilesCollection(): ProfilesCollection {
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const launchProfiles = useAiLaunchProfiles();
    const scope = useAccountSettingsScope();
    const catalog = useProfileCatalog(scope);
    const operations = useProfileOperations();
    const profiles = React.useMemo(() => launchProfiles.map(projectAiLaunchProfileForLegacyUi), [launchProfiles]);
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const profileEnabledByIdRaw = useSetting('profileEnabledById');
    const settingsVersion = getStorage()(state => state.settingsVersion);
    const profileEnabledById = React.useMemo(
        () => readProfileEnabledById(profileEnabledByIdRaw),
        [profileEnabledByIdRaw],
    );
    const providerSettings = useProviderSettings(scope);
    const [secrets, setSecrets] = useSavedSecretsMutable();
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useCurrentSecretBindingsByProfileIdMutable();
    const deleteAiLaunchProfile = useDeleteAiLaunchProfile();

    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents,
    );
    // Only the exact selected machine is used to read a profile's machine-scoped details; a stale or
    // unavailable selection reads nothing rather than substituting another machine.
    const executionTarget = React.useMemo(() => {
        const selectedTarget = administrationTargetSelection.selectedTarget;
        const resolvedTarget = administrationTargetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [administrationTargetSelection]);

    /** The saved profile, or the built-in one, with this id. */
    const resolveProfile = React.useCallback((profileId: string): AiLaunchProfile | null => (
        launchProfiles.find((entry) => entry.id === profileId) ?? getBuiltInProfile(profileId)
    ), [launchProfiles]);

    const isEnabled = React.useCallback(
        (profile: AIBackendProfile) => isProfileEnabled(profile, profileEnabledById),
        [profileEnabledById],
    );
    const setEnabled = React.useCallback(async (profile: AIBackendProfile, enabled: boolean) => {
        const source = launchProfiles.find(entry => entry.id === profile.id);
        if (!operations) throw new Error('Profile Account is unavailable');
        if (isBuiltInAiLaunchProfileV1(source ?? profile) && source?.profileRecordRevision === undefined) {
            if (settingsVersion === null) throw new Error('Account settings version is unavailable');
            requireUpdatedProfileOperation(await operations.setEnabled({ subject: { kind: 'builtin', id: profile.id },
                enabled, expectedSettingsVersion: settingsVersion }));
            return;
        }
        requireUpdatedProfileOperation(await operations.setEnabled({ id: profile.id, enabled,
            expectedRevision: source?.profileRecordRevision }));
    }, [launchProfiles, operations, settingsVersion]);

    const isFavorite = React.useCallback(
        (profileId: string) => favoriteProfileIds.includes(profileId),
        [favoriteProfileIds],
    );
    const toggleFavorite = React.useCallback((profileId: string) => {
        setFavoriteProfileIds(toggleFavoriteProfileId(favoriteProfileIds, profileId));
    }, [favoriteProfileIds, setFavoriteProfileIds]);

    const migrationStatusOf = React.useCallback((profileId: string): ProfileMigrationStatus | null => {
        const actual = launchProfiles.find((entry) => entry.id === profileId);
        return actual ? resolveProfileMigrationStatus({ profile: actual, providerSettings }) : null;
    }, [launchProfiles, providerSettings]);

    /** What a row adds to its line: offered or not, and a pending provider migration. */
    const describeStatus = React.useCallback((profile: AIBackendProfile): string | null => {
        const migrationStatus = migrationStatusOf(profile.id);
        const parts = [
            ...(isProfileEnabled(profile, profileEnabledById) ? [] : [t('common.disabled')]),
            ...(migrationStatus === 'review' ? [t('settingsProviders.migration.reviewActionDescription')] : []),
            ...(migrationStatus === 'conflict' ? [t('settingsProviders.migration.conflictReviewActionDescription')] : []),
            ...(migrationStatus === 'retained' ? [t('settingsProviders.migration.retainedDescription')] : []),
        ];
        return parts.length > 0 ? parts.join(' · ') : null;
    }, [migrationStatusOf, profileEnabledById]);

    /** Deletes a saved profile after confirming; resolves `true` when it was deleted. */
    const requestDelete = React.useCallback(async (profile: Readonly<{ id: string; name: string }>): Promise<boolean> => {
        const expectedRevision = launchProfiles.find(entry => entry.id === profile.id)?.profileRecordRevision;
        const confirmed = await Modal.confirm(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            { cancelText: t('profiles.delete.cancel'), confirmText: t('profiles.delete.confirm'), destructive: true },
        );
        if (!confirmed) return false;
        try {
            const result = await deleteAiLaunchProfile(profile.id, expectedRevision);
            if (result.status === 'updated' && result.authoringMemoryCleanup) {
                Modal.alert(t('common.error'), result.authoringMemoryCleanup.reason);
            }
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
            return false;
        }
        return true;
    }, [deleteAiLaunchProfile, launchProfiles]);

    const openSecretModal = React.useCallback((profile: AIBackendProfile, envVarName?: string) => {
        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);
        const requiredSecretName = (envVarName ?? requiredSecretNames[0] ?? '').trim().toUpperCase();
        if (!requiredSecretName) return;

        const handleResolve = async (result: SecretRequirementModalResult) => {
            if (result.action !== 'selectSaved') return;
            try { await setSecretBindingsByProfileId({
                ...secretBindingsByProfileId,
                [profile.id]: {
                    ...(secretBindingsByProfileId[profile.id] ?? {}),
                    [requiredSecretName]: result.secretId,
                },
            }); } catch (error) {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
            }
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
    }, [secrets, secretBindingsByProfileId, setSecretBindingsByProfileId, setSecrets]);

    /** Choose the saved secret a profile uses by default; with several required, ask which one first. */
    const chooseDefaultSecret = React.useCallback((profile: AIBackendProfile) => {
        const required = getRequiredSecretEnvVarNames(profile);
        if (required.length <= 1) {
            openSecretModal(profile, required[0]);
            return;
        }
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
    }, [openSecretModal]);

    const isSecretOverrideReady = React.useCallback((profile: AIBackendProfile) => {
        const satisfaction = getSecretSatisfaction({
            profile,
            secrets,
            defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
            // This predicate only recognizes Account-managed saved secrets. Machine-env
            // readiness remains the exact target-scoped preflight rendered by the badge.
            machineEnvReadyByName: null,
        });
        return satisfaction.isSatisfied && satisfaction.items.some((i) => i.required && i.satisfiedBy !== 'machineEnv');
    }, [secretBindingsByProfileId, secrets]);

    return {
        useProfiles,
        setUseProfiles,
        catalog,
        launchProfiles,
        profiles,
        favoriteProfileIds,
        setFavoriteProfileIds,
        profileEnabledById,
        providerSettings,
        secretBindingsByProfileId,
        administrationTargetSelection,
        executionTarget,
        resolveProfile,
        isEnabled,
        setEnabled,
        isFavorite,
        toggleFavorite,
        migrationStatusOf,
        describeStatus,
        requestDelete,
        chooseDefaultSecret,
        isSecretOverrideReady,
    };
}
