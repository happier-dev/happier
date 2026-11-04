import { BrowserProfileV1Schema } from '@happier-dev/protocol/browser/profile/v1';
import { BrowserSidecarProfileBindingV1Schema } from '@happier-dev/protocol/browser/sidecar/v1';
import type { BrowserSidecarErrorCodeV1, BrowserSidecarProfileBindingV1 } from '@happier-dev/protocol';

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

export function resolveSidecarProfileBinding(params: Readonly<{
    profile: unknown;
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
