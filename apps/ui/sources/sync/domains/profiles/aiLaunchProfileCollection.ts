import { AIBackendProfileSchema, type AIBackendProfile } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { isLaunchProfileV2, readAiLaunchProfileCollection, readAiLaunchProfileRecords, readAiLaunchProfileEnabledV1, removeProfilePreferenceReferencesV1, type AiLaunchProfile, type AiLaunchProfileSourceV1, type AiLaunchProfileCollectionReadResult } from '@happier-dev/protocol/profiles/read';
import type { ProfileCatalogRecordV1, ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveVisibleBuiltInAiLaunchProfilesV1 } from '@happier-dev/protocol/profiles/visibilityV1';
import { readProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { projectCurrentSecretBindingsByProfileId } from '@/sync/domains/settings/secretBindings';

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
        ...(profile.revision ? { revision: profile.revision } : {}),
        ...(profile.enabled === undefined ? {} : { enabled: profile.enabled }),
        ...(profile.promptStack === undefined ? {} : { promptStack: profile.promptStack }),
        ...(profile.profileRecordRevision === undefined ? {} : { profileRecordRevision: profile.profileRecordRevision }) };
}

export type UiAiLaunchProfileSnapshot = Readonly<{
    profiles: readonly AiLaunchProfile[];
    unreadableCount: number;
}>;

/** One entity projection for mounted readers and captured Home Actions. */
export function readUiProfileCatalogSnapshot(input: Readonly<{
    catalog: ProfileCatalogSnapshotV1;
    artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
    data?: readonly ProfileCatalogRecordV1[] | null;
    source?: 'destination' | 'legacy' | null;
    legacyProfiles?: readonly AiLaunchProfile[];
    legacyDiagnostics?: readonly unknown[];
}>): UiAiLaunchProfileSnapshot & Readonly<{ available: boolean }> {
    const catalog = input.catalog;
    const source = input.source ?? (catalog.status === 'ready' || catalog.status === 'partial' ? catalog.source : null);
    const rows = input.data ?? (catalog.status === 'ready' || catalog.status === 'partial' ? catalog.records : []);
    const projected = projectUiAiLaunchProfileSnapshot(readAiLaunchProfileRecords(rows.map(row => row.record), {
        artifactsById: input.artifactsById, includeShared: true,
        recordRevisionsById: new Map(rows.map(row => [row.record.id, row.revision])),
    }));
    const unreadableCount = projected.unreadableCount + (catalog.status === 'ready' || catalog.status === 'partial' ? catalog.diagnostics.length : 0);
    const legacyProfiles = source !== 'destination' ? input.legacyProfiles : undefined;
    return { profiles: legacyProfiles ?? (source === 'legacy' ? [] : projected.profiles),
        unreadableCount: legacyProfiles ? input.legacyDiagnostics?.length ?? 0 : unreadableCount,
        available: catalog.status === 'ready' && (source === 'destination' || (source === 'legacy' && legacyProfiles !== undefined)) };
}

/** Shared admitted visibility: retained evidence admits built-ins; real rows shadow them. */
export function readUiVisibleProfileCatalogSnapshot(
    snapshot: Parameters<typeof readUiProfileCatalogSnapshot>[0],
    rawSettings: Readonly<Record<string, unknown>>,
    memory: Readonly<{ lastUsedProfile: string | null }>,
): ReturnType<typeof readUiProfileCatalogSnapshot> {
    const projected = readUiProfileCatalogSnapshot(snapshot);
    if (!projected.available) return projected;
    const settings = accountSettingsParse(rawSettings);
    const builtinProfiles = resolveVisibleBuiltInAiLaunchProfilesV1({ evidence: {
        lastUsedProfile: memory.lastUsedProfile,
        favoriteProfileIds: settings.favoriteProfiles,
        profileEnabledById: readProfileEnabledById(settings.profileEnabledById),
        secretBindingsByProfileId: projectCurrentSecretBindingsByProfileId(projected.profiles),
        persistedProfileIds: snapshot.catalog.status === 'ready' ? snapshot.catalog.records.map(row => row.record.id) : [],
    } });
    return { ...projected, profiles: [...new Map([...builtinProfiles, ...projected.profiles].map(profile => [profile.id, profile])).values()] };
}

/** Selection requires complete admitted visibility and the Profile owner's enablement policy. */
export function readUiSelectedProfileCatalogProfile(
    snapshot: ReturnType<typeof readUiVisibleProfileCatalogSnapshot>,
    rawSettings: Readonly<Record<string, unknown>>,
    profileId: string | null | undefined,
): AiLaunchProfile | null {
    if (!profileId || !snapshot.available || snapshot.unreadableCount > 0) return null;
    const profile = snapshot.profiles.find(candidate => candidate.id === profileId);
    return profile && readAiLaunchProfileEnabledV1(profile, readProfileEnabledById(rawSettings.profileEnabledById)) ? profile : null;
}

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
 * Predecessor Settings adapter only. Active Profile deletion belongs to the row
 * transport's atomic preference cleanup; source importers retain opaque siblings.
 */
export function removeAiLaunchProfileFromAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    profileId: string,
): Record<string, unknown> {
    return {
        ...removeProfilePreferenceReferencesV1(raw, profileId, undefined),
        profiles: removeAiLaunchProfile(raw.profiles, profileId),
        ...(Object.prototype.hasOwnProperty.call(raw, 'secretBindingsByProfileId')
            ? { secretBindingsByProfileId: removeRecordKey(raw.secretBindingsByProfileId, profileId) }
            : {}),
    };
}
