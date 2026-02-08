import { db } from "@/storage/db";
import { Context } from "@/context";
import { encryptString } from "@/modules/encrypt";
import { uploadImage } from "@/storage/uploadImage";
import { separateName } from "@/utils/separateName";
import { type GitHubProfile } from "@/app/auth/providers/github/types";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { resolveGitHubAuthRestrictionsFromEnv } from "@/app/auth/providers/github/restrictions";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";

function parseExplicitGithubStoreTokenSetting(env: NodeJS.ProcessEnv): boolean | null {
    const raw = (env.GITHUB_STORE_ACCESS_TOKEN ?? '').toString().trim().toLowerCase();
    if (!raw) return null;

    if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
    return null;
}

function shouldStoreGithubAccessToken(params: { env: NodeJS.ProcessEnv }): boolean {
    const explicit = parseExplicitGithubStoreTokenSetting(params.env);
    if (explicit !== null) return explicit;

    const restrictions = resolveGitHubAuthRestrictionsFromEnv(params.env);
    // If org membership enforcement relies on user tokens, storing the access token is required
    // for periodic eligibility checks. Default to enabled in this mode.
    return restrictions.orgMembershipSource === "oauth_user_token" && restrictions.allowedOrgs.length > 0;
}

export class ProviderAlreadyLinkedError extends Error {
    constructor() {
        super("provider-already-linked");
        this.name = "ProviderAlreadyLinkedError";
    }
}

/**
 * Connects a GitHub account to a user profile.
 *
 * Flow:
 * 1. Check if already connected to same account - early exit if yes
 * 2. If GitHub account is connected to another user - throw error
 * 3. Upload avatar to S3 (non-transactional operation)
 * 4. In transaction: persist GitHub account and link to user with GitHub username
 * 5. Send socket update after transaction completes
 *
 * @param ctx - Request context containing user ID
 * @param githubProfile - GitHub profile data from OAuth
 * @param accessToken - GitHub access token for API access
 */
export async function githubConnect(
    ctx: Context,
    githubProfile: GitHubProfile,
    accessToken: string,
    opts?: { preferredUsername?: string | null }
): Promise<void> {
    const userId = ctx.uid;
    const githubUserId = githubProfile.id.toString();
    const githubLogin = githubProfile.login?.toString().trim();
    const githubLoginUsername = githubLogin ? githubLogin.toLowerCase() : null;
    const preferredUsername = opts?.preferredUsername?.toString().trim().toLowerCase() || null;

    // Step 1: Check if user is already connected to this exact GitHub account
    const existingIdentity = await db.accountIdentity.findFirst({
        where: { accountId: userId, provider: "github" },
        select: { providerUserId: true },
    });
    if (existingIdentity?.providerUserId?.toString?.() === githubUserId) {
        return;
    }

    // Step 2: Check if GitHub account is connected to another user
    const existingConnection = await db.accountIdentity.findFirst({
        where: {
            provider: "github",
            providerUserId: githubUserId,
            NOT: { accountId: userId },
        },
        select: { id: true },
    });
    if (existingConnection) {
        throw new ProviderAlreadyLinkedError();
    }

    // Step 3: Upload avatar to S3 (outside transaction for performance)
    let avatar: any | null = null;
    try {
        const avatarUrl = githubProfile.avatar_url?.toString?.() ?? "";
        if (avatarUrl.trim()) {
            const imageResponse = await fetch(avatarUrl);
            if (imageResponse.ok) {
                const imageBuffer = await imageResponse.arrayBuffer();
                avatar = await uploadImage(userId, "avatars", "github", avatarUrl, Buffer.from(imageBuffer));
            }
        }
    } catch {
        avatar = null;
    }

    // Extract name from GitHub profile
    const name = separateName(githubProfile.name);

    // Step 4: Start transaction for atomic database operations
    await inTx(async (tx) => {
        const currentUser = await tx.account.findUnique({
            where: { id: userId },
            select: { username: true },
        });
        if (!currentUser) {
            throw new Error('account-not-found');
        }
        const existingUsername = currentUser.username?.toString().trim() || null;

        const shouldPersistToken = shouldStoreGithubAccessToken({ env: process.env });
        let usernameToSet: string | null = null;
        if (!existingUsername) {
            const candidate = preferredUsername ?? githubLoginUsername;
            if (candidate) {
                const taken = await tx.account.findFirst({
                    where: {
                        username: candidate,
                        NOT: { id: userId },
                    },
                    select: { id: true },
                });
                if (!taken) {
                    usernameToSet = candidate;
                }
            }
        }

        await tx.accountIdentity.upsert({
            where: { accountId_provider: { accountId: userId, provider: "github" } },
            update: {
                providerUserId: githubUserId,
                providerLogin: githubLoginUsername,
                profile: githubProfile as any,
                token: shouldPersistToken ? (encryptString(['user', userId, 'github', 'token'], accessToken) as any) : null,
            },
            create: {
                accountId: userId,
                provider: "github",
                providerUserId: githubUserId,
                providerLogin: githubLoginUsername,
                profile: githubProfile as any,
                token: shouldPersistToken ? (encryptString(['user', userId, 'github', 'token'], accessToken) as any) : null,
            },
        });

        // Link GitHub account to user
        const finalUsername = existingUsername ?? usernameToSet;
        await tx.account.update({
            where: { id: userId },
            data: {
                firstName: name.firstName,
                lastName: name.lastName,
                ...(avatar ? { avatar } : {}),
                ...(usernameToSet ? { username: usernameToSet } : {}),
            }
        });

        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: tx as any, accountId: userId });
        const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'account', entityId: 'self', hint: { linkedProviders: true } });

        afterTx(tx, () => {
            const updatePayload = buildUpdateAccountUpdate(userId, {
                linkedProviders,
                username: finalUsername,
                firstName: name.firstName,
                lastName: name.lastName,
                ...(avatar ? { avatar } : {}),
            }, cursor, randomKeyNaked(12));

            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });
    });
}
