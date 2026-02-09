import { getPublicUrl, ImageRef } from "@/storage/blob/files";
import type { RelationshipStatus } from "@/storage/prisma";
import * as privacyKit from "privacy-kit";
import type { UserProfile } from "@happier-dev/protocol";
import { findIdentityProviderById } from "@/app/auth/providers/identityProviders/registry";

export type { UserProfile };

export type SocialIdentity = Readonly<{
    provider: string;
    providerLogin: string | null;
    profile: unknown;
    showOnProfile: boolean;
}>;

export function toSocialIdentities(
    identities: readonly {
        provider: string;
        providerLogin: string | null;
        profile: unknown;
        showOnProfile: boolean | null;
    }[],
): SocialIdentity[] {
    return identities.map((identity) => ({
        provider: identity.provider,
        providerLogin: identity.providerLogin ?? null,
        profile: identity.profile,
        showOnProfile: Boolean(identity.showOnProfile),
    }));
}

function resolveSocialProfileFromIdentities(identities: readonly SocialIdentity[]): { bio: string | null; suggestedUsername: string | null } {
    for (const identity of identities) {
        const provider = findIdentityProviderById(process.env, identity.provider);
        if (!provider?.extractSocialProfile) continue;
        return provider.extractSocialProfile({ profile: identity.profile });
    }
    return { bio: null, suggestedUsername: null };
}

function resolveBadgesFromIdentities(identities: readonly SocialIdentity[]): NonNullable<UserProfile["badges"]> {
    const badges: NonNullable<UserProfile["badges"]> = [];
    const seen = new Set<string>();

    for (const identity of identities) {
        if (!identity.showOnProfile) continue;
        const provider = findIdentityProviderById(process.env, identity.provider);
        if (!provider?.extractProfileBadge) continue;
        const badge = provider.extractProfileBadge({ profile: identity.profile, providerLogin: identity.providerLogin });
        if (!badge) continue;
        const id = provider.id.toString().trim().toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        badges.push({ id, label: badge.label, url: badge.url });
    }

    return badges;
}

export function buildUserProfile(
    account: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: ImageRef | null;
        publicKey: string;
        contentPublicKey: Uint8Array<ArrayBuffer> | null;
        contentPublicKeySig: Uint8Array<ArrayBuffer> | null;
    },
    status: RelationshipStatus,
    identities: readonly SocialIdentity[]
): UserProfile {
    const avatarJson = account.avatar;

    let avatar: UserProfile['avatar'] = null;
    if (avatarJson) {
        const avatarData = avatarJson;
        avatar = {
            path: avatarData.path,
            url: getPublicUrl(avatarData.path),
            width: avatarData.width,
            height: avatarData.height,
            thumbhash: avatarData.thumbhash
        };
    }

    const social = resolveSocialProfileFromIdentities(identities);
    const badges = resolveBadgesFromIdentities(identities);

    const profileStatus: UserProfile["status"] = (() => {
        const raw = status?.toString?.().trim?.() ?? "";
        if (
            raw === "none" ||
            raw === "pending" ||
            raw === "requested" ||
            raw === "rejected" ||
            raw === "friend"
        ) {
            return raw;
        }
        return "none";
    })();

    return {
        id: account.id,
        firstName: account.firstName || '',
        lastName: account.lastName,
        avatar,
        username: account.username || social.suggestedUsername || '',
        bio: social.bio,
        badges,
        status: profileStatus,
        publicKey: account.publicKey,
        contentPublicKey: account.contentPublicKey ? privacyKit.encodeBase64(account.contentPublicKey) : null,
        contentPublicKeySig: account.contentPublicKeySig ? privacyKit.encodeBase64(account.contentPublicKeySig) : null,
    };
}
