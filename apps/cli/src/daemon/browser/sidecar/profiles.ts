import {
    BrowserProfileV1Schema,
    BrowserSidecarProfileBindingV1Schema,
    type BrowserProfileV1,
    type BrowserSidecarErrorCodeV1,
    type BrowserSidecarProfileBindingV1,
} from '@happier-dev/protocol';

export type SidecarProfileCleanupPlan = Readonly<{
    cleanupOnStop: boolean;
    profileDirectory: string;
}>;

export type SidecarProfileBindingResolution =
    | Readonly<{
        ok: true;
        binding: BrowserSidecarProfileBindingV1;
        cleanup: SidecarProfileCleanupPlan;
    }>
    | Readonly<{
        ok: false;
        errorCode: BrowserSidecarErrorCodeV1;
        disabledReason: string;
    }>;

function isPersistentProfile(profile: BrowserProfileV1): boolean {
    return profile.storageMode !== 'ephemeral';
}

export function resolveSidecarProfileBinding(params: Readonly<{
    profile: unknown;
    allowPersistentProfiles: boolean;
    profileDirectory: string;
}>): SidecarProfileBindingResolution {
    const parsed = BrowserProfileV1Schema.safeParse(params.profile);
    if (!parsed.success) {
        return {
            ok: false,
            errorCode: 'profile_policy_denied',
            disabledReason: 'Browser sidecar profile is invalid.',
        };
    }

    const profile = parsed.data;
    if (isPersistentProfile(profile) && !params.allowPersistentProfiles) {
        return {
            ok: false,
            errorCode: 'profile_policy_denied',
            disabledReason: 'Persistent browser sidecar profiles are disabled by policy.',
        };
    }

    const binding = BrowserSidecarProfileBindingV1Schema.parse({
        profileId: profile.profileId,
        storageMode: profile.storageMode,
        ownerKind: profile.owner.kind,
        ownerId: profile.owner.id,
    });

    return {
        ok: true,
        binding,
        cleanup: {
            cleanupOnStop: profile.storageMode === 'ephemeral' || profile.cleanupOnSessionClose,
            profileDirectory: params.profileDirectory,
        },
    };
}
