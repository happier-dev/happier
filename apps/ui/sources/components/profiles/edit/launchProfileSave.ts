import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';

import {
    appendAiLaunchProfile,
    readUiAiLaunchProfiles,
    replaceAiLaunchProfile,
} from '@/sync/domains/profiles/aiLaunchProfileCollection';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { convertBuiltInProfileToCustom } from '@/sync/domains/profiles/profileMutations';
import { DEFAULT_PROFILES, getBuiltInProfileNameKey } from '@/sync/domains/profiles/profileUtils';

/**
 * A built-in profile is never edited in place: saving it creates a custom copy ("Save as").
 */
export function isBuiltInLaunchProfile(profile: AiLaunchProfile): boolean {
    return (!isLaunchProfileV2(profile) && profile.isBuiltIn === true)
        || DEFAULT_PROFILES.some((builtIn) => builtIn.id === profile.id)
        || getBuiltInProfileNameKey(profile.id) !== null;
}

export type LaunchProfileSaveResolution =
    | Readonly<{ status: 'ok'; profile: AiLaunchProfile; profiles: readonly unknown[]; created: boolean }>
    | Readonly<{ status: 'error'; reason: 'nameRequired' | 'duplicateName' }>;

/**
 * The one decision for saving a launch profile, wherever it is edited (Settings › Profiles and the
 * new-session profile editor): a name is required, names are unique among saved profiles and never
 * reuse a built-in name, a built-in profile saves as a new custom copy, and an unknown id is added.
 */
export function resolveLaunchProfileSave(params: Readonly<{
    profile: AiLaunchProfile;
    rawProfiles: unknown;
    builtInNames: readonly string[];
    now: () => number;
}>): LaunchProfileSaveResolution {
    const name = params.profile.name?.trim() ?? '';
    if (!name) return { status: 'error', reason: 'nameRequired' };

    const builtIn = isBuiltInLaunchProfile(params.profile);
    const candidate: AiLaunchProfile = builtIn
        ? convertBuiltInProfileToCustom(params.profile as AIBackendProfile)
        : params.profile;
    const saved = readUiAiLaunchProfiles(params.rawProfiles);
    const takenByAnother = saved.some((entry) => entry.id !== candidate.id && entry.name.trim() === name);
    if (takenByAnother || params.builtInNames.includes(name)) {
        return { status: 'error', reason: 'duplicateName' };
    }

    const exists = saved.some((entry) => entry.id === candidate.id);
    const profile = { ...candidate, updatedAt: params.now() } as AiLaunchProfile;
    return {
        status: 'ok',
        profile,
        profiles: exists
            ? replaceAiLaunchProfile(params.rawProfiles, candidate.id, profile)
            : appendAiLaunchProfile(params.rawProfiles, profile),
        created: !exists,
    };
}
