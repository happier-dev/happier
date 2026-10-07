import { AIBackendProfileSchema, type AIBackendProfile } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { isLaunchProfileV2, readAiLaunchProfileCollection, type AiLaunchProfile, type AiLaunchProfileSourceV1, type AiLaunchProfileCollectionReadResult } from '@happier-dev/protocol/profiles/read';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

export function projectAiLaunchProfileForLegacyUi(profile: AiLaunchProfile): AIBackendProfile & AiLaunchProfileSourceV1 {
    if (!isLaunchProfileV2(profile)) return profile;
    const projected = AIBackendProfileSchema.parse({
        id: profile.id,
        name: profile.name,
        ...(profile.description !== undefined ? { description: profile.description } : {}),
        environmentVariables: profile.extraEnvironmentVariables,
        envVarRequirements: profile.envVarRequirements ?? [],
        defaultPermissionModeByTargetKey: profile.defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey: profile.defaultPersistenceModeByTargetKey,
        compatibilityByTargetKey: profile.compatibilityByTargetKey,
        compatibility: {},
        isBuiltIn: false,
        defaultEnabled: true,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        version: '2.0.0',
    });
    return { ...projected, ...(profile.artifactId ? { artifactId: profile.artifactId } : {}),
        ...(profile.secretBindings ? { secretBindings: profile.secretBindings } : {}),
        ...(profile.shared !== undefined ? { shared: profile.shared } : {}),
        ...(profile.viewOnly !== undefined ? { viewOnly: profile.viewOnly } : {}),
        ...(profile.revision ? { revision: profile.revision } : {}) };
}

export type UiAiLaunchProfileSnapshot = Readonly<{
    profiles: readonly AiLaunchProfile[];
    unreadableCount: number;
}>;

export function readUiAiLaunchProfileSnapshot(raw: unknown, artifacts: Readonly<Record<string, DecryptedArtifact>> = {}): UiAiLaunchProfileSnapshot {
    const artifactsById = new Map<string, ArtifactSharingResourceV1>();
    for (const artifact of Object.values(artifacts)) {
        if (!artifact.isDecrypted || artifact.header?.kind !== 'launch-profile.v1' || (artifact.body !== null && typeof artifact.body !== 'string')) continue;
        artifactsById.set(artifact.id, { artifactId: artifact.id, header: artifact.header, body: artifact.body,
            ...(artifact.access ? { access: artifact.access } : {}),
            ...(artifact.bodyVersion !== undefined ? { revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } } : {}) });
    }
    return projectUiAiLaunchProfileSnapshot(readAiLaunchProfileCollection(raw, { artifactsById, includeShared: true }));
}

export function projectUiAiLaunchProfileSnapshot(collection: AiLaunchProfileCollectionReadResult): UiAiLaunchProfileSnapshot {
    const profiles: AiLaunchProfile[] = [];
    let unreadableCount = 0;
    for (const entry of collection.entries) {
        if (entry.kind === 'opaque') {
            unreadableCount += 1;
        } else {
            profiles.push(entry.profile);
        }
    }
    return { profiles, unreadableCount };
}

export function readUiAiLaunchProfiles(raw: unknown, artifacts?: Readonly<Record<string, DecryptedArtifact>>): readonly AiLaunchProfile[] {
    return readUiAiLaunchProfileSnapshot(raw, artifacts).profiles;
}

/**
 * The existing profile UI still consumes the legacy compatibility shape. Keep
 * conversion beside the Protocol-owned collection reader so opaque retained
 * rows never reach a legacy UI consumer as executable profile data.
 */
export function readUiAiLaunchProfilesForLegacyUi(raw: unknown, artifacts?: Readonly<Record<string, DecryptedArtifact>>): (AIBackendProfile & AiLaunchProfileSourceV1)[] {
    return readUiAiLaunchProfiles(raw, artifacts).map(projectAiLaunchProfileForLegacyUi);
}

function asRawCollection(raw: unknown): readonly unknown[] {
    return Array.isArray(raw) ? raw : [];
}

export function appendAiLaunchProfile(raw: unknown, profile: AiLaunchProfile): readonly unknown[] {
    if (readUiAiLaunchProfiles(raw).some((entry) => entry.id === profile.id)) {
        throw new Error(`AI launch profile '${profile.id}' already exists`);
    }
    return [...asRawCollection(raw), profile];
}

export function replaceAiLaunchProfile(
    raw: unknown,
    profileId: string,
    replacement: AiLaunchProfile,
): readonly unknown[] {
    let replaced = false;
    const entries = readAiLaunchProfileCollection(raw).entries;
    const next = entries.map((entry) => {
        if (entry.kind === 'opaque' || entry.profile.id !== profileId) return entry.raw;
        replaced = true;
        return replacement;
    });
    if (!replaced) throw new Error(`AI launch profile '${profileId}' does not exist`);
    return next;
}

export function removeAiLaunchProfile(raw: unknown, profileId: string): readonly unknown[] {
    return readAiLaunchProfileCollection(raw).entries.flatMap((entry) => (
        entry.kind !== 'opaque' && entry.profile.id === profileId ? [] : [entry.raw]
    ));
}

function removeRecordKey(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return value;
    const next = { ...(value as Readonly<Record<string, unknown>>) };
    delete next[key];
    return next;
}

/**
 * The single Account Settings mutation for deleting a Launch Profile.
 *
 * Profile rows and their Account-owned preference/binding residue are removed
 * against the current CAS winner without overwriting siblings. The authoring
 * writer clears remembered profile state through its separate row CAS owner.
 */
export function removeAiLaunchProfileFromAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    profileId: string,
): Record<string, unknown> {
    return {
        ...raw,
        profiles: removeAiLaunchProfile(raw.profiles, profileId),
        ...(Array.isArray(raw.favoriteProfiles)
            ? { favoriteProfiles: raw.favoriteProfiles.filter((entry) => entry !== profileId) }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(raw, 'profileEnabledById')
            ? { profileEnabledById: removeRecordKey(raw.profileEnabledById, profileId) }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(raw, 'secretBindingsByProfileId')
            ? { secretBindingsByProfileId: removeRecordKey(raw.secretBindingsByProfileId, profileId) }
            : {}),
    };
}
