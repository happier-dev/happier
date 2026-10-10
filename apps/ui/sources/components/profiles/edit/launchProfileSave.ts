import { isBuiltInAiLaunchProfileV1, isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import { PublishableLaunchProfileV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { randomUUID } from '@/platform/randomUUID';

/**
 * A built-in profile is never edited in place: saving it creates a custom copy ("Save as").
 */
export function isBuiltInLaunchProfile(profile: AiLaunchProfile): boolean {
    return isBuiltInAiLaunchProfileV1(profile);
}

export type LaunchProfileSaveResolution =
    | Readonly<{ status: 'ok'; profile: AiLaunchProfile; created: boolean }>
    | Readonly<{ status: 'error'; reason: 'nameRequired' }>;

/**
 * Prepare editor identity and timestamps only. The canonical Profile operation owns
 * inventory completeness, uniqueness, supported creation shapes and persistence.
 */
export function resolveLaunchProfileSave(params: Readonly<{
    profile: AiLaunchProfile;
    currentProfile?: AiLaunchProfile;
    exists: boolean;
    now: () => number;
}>): LaunchProfileSaveResolution {
    const name = params.profile.name?.trim() ?? '';
    if (!name) return { status: 'error', reason: 'nameRequired' };

    const builtIn = isBuiltInLaunchProfile(params.profile);
    const timestamp = params.now();
    // Historical definitions retain their routing/auth requirements. The row owner
    // refuses unsupported legacy creation instead of guessing a V2 conversion.
    const candidate: AiLaunchProfile = builtIn ? { ...params.profile, id: randomUUID(),
        ...(!isLaunchProfileV2(params.profile) ? { isBuiltIn: false } : {}),
        profileRecordRevision: undefined, artifactId: undefined, revision: undefined,
        shared: undefined, viewOnly: undefined, createdAt: timestamp } : params.profile;
    let updatedAt = timestamp;
    const current = params.currentProfile;
    // Forms stamp even unchanged saves; reference membership must not become a body edit.
    if (candidate.artifactId && current?.artifactId === candidate.artifactId && current.id === candidate.id) {
        const bodySchema = createStoredReadSchema(PublishableLaunchProfileV1Schema);
        const previous = bodySchema.safeParse(current);
        const next = bodySchema.safeParse({ ...candidate, name });
        if (previous.success && next.success && sameStrictJsonValue(
            projectNativeJsonValueForTransport(previous.data),
            projectNativeJsonValueForTransport({ ...next.data, updatedAt: previous.data.updatedAt }),
        )) updatedAt = previous.data.updatedAt;
    }
    const profile = { ...candidate, name, updatedAt };
    return {
        status: 'ok',
        profile,
        created: builtIn || !params.exists,
    };
}
