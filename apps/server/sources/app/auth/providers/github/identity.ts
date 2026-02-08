import type { Context } from "@/context";
import type { GitHubProfile } from "@/app/auth/providers/github/types";

export async function connectGitHubIdentity(params: {
    ctx: Context;
    profile: unknown;
    accessToken: string;
    preferredUsername?: string | null;
}): Promise<void> {
    // Lazy import to avoid provider-registry import cycles during server startup/tests.
    const { githubConnect } = await import("./githubConnect");
    await githubConnect(
        params.ctx,
        params.profile as GitHubProfile,
        params.accessToken,
        params.preferredUsername ? { preferredUsername: params.preferredUsername } : undefined,
    );
}

export async function disconnectGitHubIdentity(ctx: Context): Promise<void> {
    // Lazy import to avoid provider-registry import cycles during server startup/tests.
    const { githubDisconnect } = await import("./githubDisconnect");
    await githubDisconnect(ctx);
}
