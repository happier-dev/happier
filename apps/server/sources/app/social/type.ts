import { projectPublicImageRef, type ImageRef } from "@/storage/blob/files";
import type { RelationshipStatus } from "@/storage/prisma";
import * as privacyKit from "privacy-kit";
import { projectAccountNameToLegacyFieldsV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { type UserProfile } from '@happier-dev/protocol/social/friends';
import {
    describeLinkedIds,
    describeLinkedIdsInTx,
    type ProviderPresentation,
} from "@/app/auth/providers/identityProviderCatalog";
import { isAccountIdentityEligibleForGenericPresentation } from "@/app/auth/methods/registry";
import type { Tx } from "@/storage/inTx";

export type { UserProfile };

/**
 * Provider presentation leaves for the identities being projected, loaded once per request so
 * profile mapping stays synchronous and never fans out into a lookup per identity row.
 */
export type IdentityPresentationMap = ReadonlyMap<string, ProviderPresentation>;

export async function describeIdentityPresentation(
    identities: readonly SocialIdentity[],
    tx?: Tx,
): Promise<IdentityPresentationMap> {
    const input = {
        env: process.env,
        providerIds: identities.map((identity) => identity.provider),
    };
    // Relationship mutations already own their transaction. Resolve catalog
    // presentation through it rather than waiting for another SQLite writer.
    return tx ? await describeLinkedIdsInTx(tx, input) : await describeLinkedIds(input);
}

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
    return identities
        .filter((identity) => isAccountIdentityEligibleForGenericPresentation(process.env, identity.provider))
        .map((identity) => ({
            provider: identity.provider,
            providerLogin: identity.providerLogin ?? null,
            profile: identity.profile,
            showOnProfile: Boolean(identity.showOnProfile),
        }));
}

function resolveSocialProfileFromIdentities(
    identities: readonly SocialIdentity[],
    presentation: IdentityPresentationMap,
): { bio: string | null; suggestedUsername: string | null } {
    for (const identity of identities) {
        const provider = presentation.get(identity.provider.toString().trim().toLowerCase());
        if (!provider?.extractSocialProfile) continue;
        return provider.extractSocialProfile({ profile: identity.profile });
    }
    return { bio: null, suggestedUsername: null };
}

function resolveBadgesFromIdentities(
    identities: readonly SocialIdentity[],
    presentation: IdentityPresentationMap,
): NonNullable<UserProfile["badges"]> {
    const badges: NonNullable<UserProfile["badges"]> = [];
    const seen = new Set<string>();

    for (const identity of identities) {
        if (!identity.showOnProfile) continue;
        const provider = presentation.get(identity.provider.toString().trim().toLowerCase());
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
        name: string | null;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: ImageRef | null;
        publicKey: string | null;
        contentPublicKey: Uint8Array<ArrayBuffer> | null;
        contentPublicKeySig: Uint8Array<ArrayBuffer> | null;
    },
    status: RelationshipStatus,
    identities: readonly SocialIdentity[],
    presentation: IdentityPresentationMap,
): UserProfile {
    const avatar = projectPublicImageRef(account.avatar);

    const social = resolveSocialProfileFromIdentities(identities, presentation);
    const badges = resolveBadgesFromIdentities(identities, presentation);
    const name = account.name;
    const legacyName = projectAccountNameToLegacyFieldsV1(name);

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
        name,
        firstName: legacyName.firstName ?? '',
        lastName: legacyName.lastName,
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
