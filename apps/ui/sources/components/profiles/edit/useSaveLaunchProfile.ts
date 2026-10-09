import * as React from 'react';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { ProfileLegacyCloneSourceV1, ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';

import { Modal } from '@/modal';
import { DEFAULT_PROFILES, getBuiltInProfileNameKey } from '@/sync/domains/profiles/profileUtils';
import { useAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { useApplyProfileSave } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { promptUnsavedChangesAlert, type UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

import { isBuiltInLaunchProfile, resolveLaunchProfileSave } from './launchProfileSave';

function readBuiltInProfileNames(): string[] {
    return DEFAULT_PROFILES
        .map((builtIn) => {
            const key = getBuiltInProfileNameKey(builtIn.id);
            return key ? t(key).trim() : null;
        })
        .filter((name): name is string => Boolean(name));
}

export type SavedLaunchProfile = Readonly<{ profile: AiLaunchProfile; created: boolean }>;

/**
 * Saves a launch profile through the canonical entity operation and its acknowledged row writer. A refusal
 * is explained to the user and returns `null`, so the editor stays open with its changes.
 */
export function useSaveLaunchProfile(): (
    profile: AiLaunchProfile,
    secretBindings?: Readonly<ProfileRecordV1['secretBindings']>,
    legacyCloneSource?: ProfileLegacyCloneSourceV1,
) => Promise<SavedLaunchProfile | null> {
    const profiles = useAiLaunchProfiles();
    const applyProfileSave = useApplyProfileSave();
    return React.useCallback(async (profile, secretBindings, legacyCloneSource) => {
        const currentProfile = profiles.find(entry => entry.id === profile.id);
        const exists = currentProfile !== undefined;
        const resolution = resolveLaunchProfileSave({
            profile,
            currentProfile: profile.artifactId && currentProfile?.artifactId === profile.artifactId ? currentProfile : undefined,
            exists,
            now: Date.now,
        });
        if (resolution.status === 'error') {
            Modal.alert(
                t('common.error'),
                t('profiles.nameRequired'),
            );
            return null;
        }
        try {
            if (!resolution.created && profile.profileRecordRevision === undefined && !profile.artifactId) throw new Error('profile_editor_revision_unavailable');
            const result = await applyProfileSave({ profile: resolution.profile, secretBindings, legacyCloneSource,
                expectedRevision: resolution.created || profile.profileRecordRevision === undefined ? 'absent' : profile.profileRecordRevision,
                builtinNames: readBuiltInProfileNames() });
            if (result.status !== 'updated') {
                Modal.alert(t('common.error'), result.status === 'invalid' && result.reason === 'duplicate-name'
                    ? t('profiles.duplicateName') : result.status === 'conflict' ? 'profile_revision_conflict' : result.reason);
                return null;
            }
            return { profile: { ...resolution.profile, profileRecordRevision: result.revision }, created: resolution.created };
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
            return null;
        }
    }, [applyProfileSave, profiles]);
}

/** Leaving a profile editor with unsaved changes: a built-in profile offers "Save as" and says why. */
export function promptLaunchProfileUnsavedChanges(profile: AiLaunchProfile | null): Promise<UnsavedChangesDecision> {
    const builtIn = profile !== null && isBuiltInLaunchProfile(profile);
    return promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons),
        {
            title: t('common.discardChanges'),
            message: builtIn
                ? `${t('common.unsavedChangesWarning')}\n\n${t('profiles.builtInSaveAsHint')}`
                : t('common.unsavedChangesWarning'),
            discardText: t('common.discard'),
            saveText: builtIn ? t('common.saveAs') : t('common.save'),
            keepEditingText: t('common.keepEditing'),
        },
    );
}
