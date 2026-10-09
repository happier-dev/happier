import { randomUUID } from '@/platform/randomUUID';
import { type LaunchProfileV2 } from '@happier-dev/protocol/profiles/v2/schema';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import { createProfileDuplicateDraftV1 } from '@happier-dev/protocol/profiles/profileOperations';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

export function createEmptyCustomProfile(): LaunchProfileV2 {
    return {
        v: 2,
        id: randomUUID(),
        name: '',
        extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByTargetKey: {},
        compatibilityByTargetKey: {
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' })]: true,
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' })]: true,
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' })]: true,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

type ProfileDuplicateDraftOptions = Readonly<{
    copySuffix?: string;
    sourceRow?: Readonly<{ record: ProfileRecordV1; revision: number }>;
    artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>;
}>;

/** Detached body and private attachments remain separate authoring values. */
export function duplicateProfileDraftForEdit(profile: AiLaunchProfile, opts?: ProfileDuplicateDraftOptions) {
    const suffix = opts?.copySuffix ?? '(Copy)';
    const separator = profile.name.trim().length > 0 ? ' ' : '';
    return createProfileDuplicateDraftV1({ profile, newProfileId: randomUUID(),
        name: `${profile.name}${separator}${suffix}`, now: Date.now(), sourceRow: opts?.sourceRow, artifactsById: opts?.artifactsById });
}

export function duplicateProfileForEdit(profile: AiLaunchProfile, opts?: ProfileDuplicateDraftOptions): LaunchProfileV2 {
    const result = duplicateProfileDraftForEdit(profile, opts);
    if (result.status !== 'draft') throw new Error(result.reason);
    if (!isLaunchProfileV2(result.profile)) throw new Error('invalid-definition');
    return result.profile;
}

export function convertBuiltInProfileToCustom(profile: AIBackendProfile): LaunchProfileV2 {
    return duplicateProfileForEdit(profile);
}
