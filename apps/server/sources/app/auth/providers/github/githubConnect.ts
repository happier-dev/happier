import { prepareIdentityLink, preflightIdentityLink } from "../accountIdentityLifecycle";
import { Context } from "@/context";
import { encryptString } from "@/modules/encrypt";
import { prepareUploadedImage } from "@/storage/blob/uploadImage";
import { type GitHubProfile } from "@/app/auth/providers/github/types";
import { inTx } from "@/storage/inTx";
import { shouldStoreGithubAccessToken } from "@/app/auth/providers/github/restrictions";
import { fetchGitHubAvatar } from "@/app/auth/providers/github/endpoints";
import { OutboundIdentityEndpointError } from "@/app/net/outboundIdentityNetworkPolicy";
import { log } from "@/utils/logging/log";
import type { PreparedIdentityConnection } from "@/app/auth/providers/identityProviders/types";

export { ProviderAlreadyLinkedError } from "../accountIdentityLifecycle";

/** Only the failure class is logged: the avatar URL can carry signed query parameters. */
function reportAvatarImportFailure(reason: string): void {
    log({ module: "github-avatar", level: "warn", reason }, "GitHub avatar import failed; connecting without an avatar");
}

/**
 * Validates the GitHub link before external avatar preparation and supplies its
 * profile/token/presentation intent to the shared transaction lifecycle.
 * Same-subject reconnects remain no-ops, rechecked inside the final transaction.
 */
export async function prepareGithubConnect(
    ctx: Context,
    githubProfile: GitHubProfile,
    accessToken: string,
    opts?: { preferredUsername?: string | null; transferFromAccountId?: string; usernamePolicyEnv?: NodeJS.ProcessEnv }
): Promise<PreparedIdentityConnection> {
    const userId = ctx.uid;
    const githubUserId = githubProfile.id.toString();
    const githubLogin = githubProfile.login?.toString().trim();
    const githubLoginUsername = githubLogin ? githubLogin.toLowerCase() : null;

    const sameSubject = await preflightIdentityLink({
        accountId: userId, provider: 'github', providerUserId: githubUserId,
        transferFromAccountId: opts?.transferFromAccountId,
    });

    // Step 3: Upload avatar to S3 (outside transaction for performance)
    let preparedAvatar: Awaited<ReturnType<typeof prepareUploadedImage>> | null = null;
    try {
        const avatarUrl = githubProfile.avatar_url?.toString?.() ?? "";
        if (!sameSubject && avatarUrl.trim()) {
            const imageResponse = await fetchGitHubAvatar(process.env, avatarUrl);
            if (imageResponse.ok) {
                const imageBuffer = await imageResponse.arrayBuffer();
                preparedAvatar = await prepareUploadedImage(userId, "avatars", "github", avatarUrl, Buffer.from(imageBuffer));
            } else {
                reportAvatarImportFailure(`http_${imageResponse.status}`);
            }
        }
    } catch (error) {
        // The connection proceeds without an avatar; the failure is still reported.
        reportAvatarImportFailure(
            error instanceof OutboundIdentityEndpointError ? error.code : error instanceof Error ? error.name : "unknown",
        );
        preparedAvatar = null;
    }

    const identityConnection = await prepareIdentityLink({
        accountId: userId,
        provider: "github",
        providerUserId: githubUserId,
        providerLogin: githubLoginUsername,
        profile: {
            id: githubProfile.id, login: githubProfile.login,
            ...(githubProfile.name !== undefined ? { name: githubProfile.name } : {}),
            ...(githubProfile.avatar_url !== undefined ? { avatar_url: githubProfile.avatar_url } : {}),
            ...(typeof githubProfile.html_url === 'string' ? { html_url: githubProfile.html_url } : {}),
            ...(typeof githubProfile.bio === 'string' ? { bio: githubProfile.bio } : {}),
        },
        token: shouldStoreGithubAccessToken({ env: process.env })
            ? encryptString(['user', userId, 'github', 'token'], accessToken) : null,
        presentation: { username: opts?.preferredUsername ?? githubLoginUsername, name: githubProfile.name, ...(preparedAvatar ? { avatar: preparedAvatar.image } : {}) },
        usernamePolicyEnv: opts?.usernamePolicyEnv,
        sameSubject: 'unchanged',
        transferFromAccountId: opts?.transferFromAccountId,
    });
    return {
        connectInTx: async (tx) => {
            await preparedAvatar?.persist(tx);
            await identityConnection.connectInTx(tx);
        },
    };
}

export async function githubConnect(
    ctx: Context,
    githubProfile: GitHubProfile,
    accessToken: string,
    opts?: { preferredUsername?: string | null; transferFromAccountId?: string; usernamePolicyEnv?: NodeJS.ProcessEnv },
): Promise<void> {
    const prepared = await prepareGithubConnect(ctx, githubProfile, accessToken, opts);
    await inTx(prepared.connectInTx, { isolationLevel: "Serializable" /* Identity transfer and fill-if-empty Account presentation depend on the observed link and Account. */ });
}
