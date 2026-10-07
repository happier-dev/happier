import * as React from 'react';
import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';

import { Modal } from '@/modal';
import { DEFAULT_PROFILES, getBuiltInProfileNameKey } from '@/sync/domains/profiles/profileUtils';
import { useSetting } from '@/sync/domains/state/storage';
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
 * Saves a launch profile through the one decision above and the account settings writer. A refusal
 * is explained to the user and returns `null`, so the editor stays open with its changes.
 */
export function useSaveLaunchProfile(): (
    profile: AiLaunchProfile,
    secretBindings?: Readonly<Record<string, string>>,
) => SavedLaunchProfile | null {
    const rawProfiles = useSetting('profiles');
    const applyProfileSave = useApplyProfileSave();
    return React.useCallback((profile, secretBindings) => {
        const resolution = resolveLaunchProfileSave({
            profile,
            rawProfiles,
            builtInNames: readBuiltInProfileNames(),
            now: Date.now,
        });
        if (resolution.status === 'error') {
            Modal.alert(
                t('common.error'),
                resolution.reason === 'nameRequired' ? t('profiles.nameRequired') : t('profiles.duplicateName'),
            );
            return null;
        }
        applyProfileSave({
            profiles: resolution.profiles as typeof rawProfiles,
            profileId: resolution.profile.id,
            ...(!isLaunchProfileV2(resolution.profile) && secretBindings !== undefined ? { secretBindings } : {}),
        });
        return { profile: resolution.profile, created: resolution.created };
    }, [applyProfileSave, rawProfiles]);
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
