import { db } from "@/storage/db";
import { Context } from "@/context";
import { log } from "@/utils/log";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";

/**
 * Disconnects a GitHub account from a user profile.
 *
 * Flow:
 * 1. Check if user has GitHub connected - early exit if not
 * 2. In transaction: clear GitHub link and username from account (keeps avatar) and delete GitHub user record
 * 3. Send socket update after transaction completes
 *
 * @param ctx - Request context containing user ID
 */
export async function githubDisconnect(ctx: Context): Promise<void> {
    const userId = ctx.uid;

    // Step 1: Check if user has GitHub connection
    const user = await db.account.findUnique({
        where: { id: userId },
        select: { username: true },
    });
    const identity = await db.accountIdentity.findFirst({
        where: { accountId: userId, provider: "github" },
        select: { providerUserId: true, profile: true },
    });

    // Early exit if no GitHub connection
    if (!user || !identity) {
        log({ module: 'github-disconnect' }, `User ${userId} has no GitHub account connected`);
        return;
    }

    const currentUsername = user.username?.toString().trim() || null;
    const githubLogin = (identity.profile as any)?.login?.toString?.().trim?.() || null;
    const normalize = (v: string | null) => (v ?? '').trim().toLowerCase();
    const shouldClearUsername = Boolean(currentUsername) && Boolean(githubLogin) && normalize(currentUsername) === normalize(githubLogin);

    log({ module: 'github-disconnect' }, `Disconnecting GitHub account ${identity.providerUserId} from user ${userId}`);

    // Step 2: Transaction for atomic database operations
    await inTx(async (tx) => {
        await tx.accountIdentity.deleteMany({
            where: { accountId: userId, provider: "github" },
        });

        // Preserve username unless it matches the GitHub login (we treat matching usernames as "GitHub-derived").
        if (shouldClearUsername) {
            await tx.account.update({
                where: { id: userId },
                data: { username: null },
            });
        }

        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: tx as any, accountId: userId });
        const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'account', entityId: 'self', hint: { linkedProviders: true } });

        afterTx(tx, () => {
            const updatePayload = buildUpdateAccountUpdate(userId, {
                linkedProviders,
                username: shouldClearUsername ? null : currentUsername
            }, cursor, randomKeyNaked(12));

            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });
    });

    log({ module: 'github-disconnect' }, `GitHub account ${identity.providerUserId} disconnected successfully from user ${userId}`);
}
