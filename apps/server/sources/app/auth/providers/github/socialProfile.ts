import type { GitHubProfile } from "@/app/auth/providers/github/types";

function asGitHubProfile(profile: unknown): GitHubProfile | null {
    if (!profile || typeof profile !== "object") return null;
    return profile as any;
}

export function extractGitHubSocialProfile(params: { profile: unknown }): { bio: string | null; suggestedUsername: string | null } {
    const profile = asGitHubProfile(params.profile);
    const login = profile?.login;
    const bio = (profile as any)?.bio;
    return {
        suggestedUsername: typeof login === "string" && login.trim() ? login.trim() : null,
        bio: typeof bio === "string" && bio.trim() ? bio.trim() : null,
    };
}
