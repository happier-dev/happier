import { Context } from "@/context";
import { buildUserProfile, toSocialIdentities, UserProfile } from "./type";
import { inTx } from "@/storage/inTx";
import { relationshipSet } from "./relationshipSet";
import { relationshipGet } from "./relationshipGet";
import { sendFriendRequestNotification, sendFriendshipEstablishedNotification } from "./friendNotification";
import { RelationshipStatus } from "@/storage/prisma";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { resolveFriendsPolicyFromServerFeatures } from "./resolveFriendsPolicyFromServerFeatures";

export class FriendsIdentityProviderRequiredError extends Error {
    readonly provider: string;
    constructor(provider: string) {
        super("provider-required");
        this.name = "FriendsIdentityProviderRequiredError";
        this.provider = provider.toString().trim().toLowerCase();
    }
}

export class FriendsUsernameRequiredError extends Error {
    constructor() {
        super('username-required');
        this.name = 'FriendsUsernameRequiredError';
    }
}

export class FriendsDisabledError extends Error {
    constructor() {
        super('friends-disabled');
        this.name = 'FriendsDisabledError';
    }
}

/**
 * Add a friend or accept a friend request.
 * Handles:
 * - Accepting incoming friend requests (both users become friends)
 * - Sending new friend requests
 * - Sending appropriate notifications with 24-hour cooldown
 */
export async function friendAdd(ctx: Context, uid: string): Promise<UserProfile | null> {
    // Prevent self-friendship
    if (ctx.uid === uid) {
        return null;
    }

    const friendsPolicy = resolveFriendsPolicyFromServerFeatures(process.env);
    if (!friendsPolicy.enabled) {
        throw new FriendsDisabledError();
    }

    // Update relationship status
    return await inTx(async (tx) => {

        // Read current user objects
        const currentUser = await tx.account.findUnique({
            where: { id: ctx.uid },
            include: {
                AccountIdentity: {
                    select: { provider: true, providerLogin: true, profile: true, showOnProfile: true },
                    orderBy: { provider: "asc" },
                },
            }
        });
        const targetUser = await tx.account.findUnique({
            where: { id: uid },
            include: {
                AccountIdentity: {
                    select: { provider: true, providerLogin: true, profile: true, showOnProfile: true },
                    orderBy: { provider: "asc" },
                },
            }
        });
        if (!currentUser || !targetUser) {
            return null;
        }

        if (friendsPolicy.allowUsername) {
            if (!currentUser.username || !targetUser.username) {
                throw new FriendsUsernameRequiredError();
            }
        } else {
            const requiredProviderId = friendsPolicy.requiredIdentityProviderId;
            if (!requiredProviderId) {
                throw new Error(
                    "Friends policy misconfigured: requiredIdentityProviderId must be set when allowUsername is false",
                );
            }
            const currentHasProvider = currentUser.AccountIdentity.some((i) => i.provider === requiredProviderId);
            const targetHasProvider = targetUser.AccountIdentity.some((i) => i.provider === requiredProviderId);
            if (!currentHasProvider || !targetHasProvider) {
                throw new FriendsIdentityProviderRequiredError(requiredProviderId);
            }
        }

        // Read relationship status
        const currentUserRelationship = await relationshipGet(tx, currentUser.id, targetUser.id);
        const targetUserRelationship = await relationshipGet(tx, targetUser.id, currentUser.id);

        // Handle cases

        // Case 1: There's a pending request from the target user - accept it
        if (targetUserRelationship === RelationshipStatus.requested) {

            // Accept the friend request - update both to friends
            await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.friend);
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.friend);

            // Send friendship established notifications to both users
            await sendFriendshipEstablishedNotification(tx, currentUser.id, targetUser.id);

            await markAccountChanged(tx, { accountId: currentUser.id, kind: 'friends', entityId: 'self' });
            await markAccountChanged(tx, { accountId: targetUser.id, kind: 'friends', entityId: 'self' });

            // Return the target user profile
            const identities = toSocialIdentities(targetUser.AccountIdentity);
            return buildUserProfile(targetUser as any, RelationshipStatus.friend, identities);
        }

        // Case 2: If status is none or rejected, create a new request (since other side is not in requested state)
        if (currentUserRelationship === RelationshipStatus.none
            || currentUserRelationship === RelationshipStatus.rejected) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.requested);

            // If other side is in none state, set it to pending, ignore for other states
            if (targetUserRelationship === RelationshipStatus.none) {
                await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.pending);
            }

            // Send friend request notification to the receiver
            await sendFriendRequestNotification(tx, targetUser.id, currentUser.id);

            await markAccountChanged(tx, { accountId: currentUser.id, kind: 'friends', entityId: 'self' });
            await markAccountChanged(tx, { accountId: targetUser.id, kind: 'friends', entityId: 'self' });

            // Return the target user profile
            const identities = toSocialIdentities(targetUser.AccountIdentity);
            return buildUserProfile(targetUser as any, RelationshipStatus.requested, identities);
        }

        // Do not change anything and return the target user profile
        const identities = toSocialIdentities(targetUser.AccountIdentity);
        return buildUserProfile(targetUser as any, currentUserRelationship, identities);
    });
}
