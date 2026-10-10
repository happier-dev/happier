import { describe, expect, it } from 'vitest';
import type { AiLaunchProfile, LaunchProfileV2 } from '@happier-dev/protocol';

import { DEFAULT_PROFILES, getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';

import { resolveLaunchProfileSave } from './launchProfileSave';
import { buildSlimProfileSave } from './slimProfileDraft';

const saved: LaunchProfileV2 = {
    v: 2,
    id: 'profile-a',
    name: 'Profile A',
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {},
    createdAt: 1,
    updatedAt: 1,
};

function resolve(profile: AiLaunchProfile) {
    return resolveLaunchProfileSave({ profile, exists: profile.id === saved.id, now: () => 42 });
}

describe('resolveLaunchProfileSave', () => {
    it('replaces a saved profile in place and stamps the save time', () => {
        const result = resolve({ ...saved, name: 'Renamed' });
        expect(result).toMatchObject({ status: 'ok', created: false, profile: { id: 'profile-a', name: 'Renamed', updatedAt: 42 } });
        if (result.status !== 'ok') return;
        expect(result).not.toHaveProperty('profiles');
    });

    it('adds a profile whose id is not saved yet', () => {
        const result = resolve({ ...saved, id: 'profile-b', name: 'Profile B' });
        expect(result).toMatchObject({ status: 'ok', created: true, profile: { id: 'profile-b' } });
        if (result.status !== 'ok') return;
        expect(result).not.toHaveProperty('profiles');
    });

    it('keeps a Provider-converted inline Profile identity instead of treating its historical id as Save as', () => {
        const converted = { ...saved, id: 'deepseek', name: 'Converted DeepSeek', profileRecordRevision: 7 };
        const result = resolveLaunchProfileSave({ profile: converted, exists: true, now: () => 42 });
        expect(result).toMatchObject({ status: 'ok', created: false,
            profile: { id: converted.id, name: converted.name, profileRecordRevision: 7, updatedAt: 42 } });
    });

    it('keeps a shared Artifact identity even when its legacy definition was published from a preset', () => {
        const builtin = getBuiltInProfile(DEFAULT_PROFILES[0]!.id)!;
        const shared = { ...builtin, artifactId: 'published-preset', profileRecordRevision: 7,
            revision: { headerVersion: 2, bodyVersion: 3 } };
        const result = resolveLaunchProfileSave({ profile: shared, exists: true, now: () => 42 });
        expect(result).toMatchObject({ status: 'ok', created: false,
            profile: { id: shared.id, artifactId: shared.artifactId, profileRecordRevision: 7,
                revision: shared.revision } });
    });

    it.each(['direct', 'unchanged-editor', 'edited-editor'] as const)('preserves unchanged Artifact membership without masking an actual edit (%s)', state => {
        const source = { ...saved, artifactId: 'granted-profile', revision: { headerVersion: 2, bodyVersion: 3 } };
        const edited = state === 'edited-editor';
        const draft = buildSlimProfileSave(source, { name: edited ? 'Edited shared profile' : source.name,
            description: '', extraEnvironmentVariables: [] }, () => 41);
        if (draft.status !== 'success') throw new Error('Expected the canonical editor draft');
        const profile = state === 'direct' ? source : draft.profile;
        const input = { profile, currentProfile: source, exists: true, now: () => 42 };
        const result = resolveLaunchProfileSave(input);
        expect(result).toMatchObject({ status: 'ok', created: false, profile: {
            id: source.id, artifactId: source.artifactId, updatedAt: edited ? 42 : 1,
            name: edited ? 'Edited shared profile' : source.name,
        } });
    });

    it('saves any built-in profile as a new custom copy, including one only flagged built-in', () => {
        const builtIn = getBuiltInProfile(DEFAULT_PROFILES[0]!.id)!;
        const shipped = resolve({ ...builtIn, name: 'My copy' } as AiLaunchProfile);
        const flagged = resolve({ ...builtIn, id: 'retired-built-in', isBuiltIn: true, name: 'My other copy' } as AiLaunchProfile);
        for (const [result, sourceId] of [[shipped, builtIn.id], [flagged, 'retired-built-in']] as const) {
            expect(result.status).toBe('ok');
            if (result.status !== 'ok') continue;
            expect(result.created).toBe(true);
            expect(result.profile.id).not.toBe(sourceId);
            expect(result).not.toHaveProperty('profiles');
        }
    });

    it('refuses a missing name but leaves catalog uniqueness to the canonical row operation', () => {
        expect(resolve({ ...saved, name: '  ' })).toEqual({ status: 'error', reason: 'nameRequired' });
        expect(resolve({ ...saved, id: 'profile-b', name: ' Profile A ' })).toMatchObject({ status: 'ok' });
        expect(resolve({ ...saved, name: 'Anthropic' })).toMatchObject({ status: 'ok' });
    });
});
