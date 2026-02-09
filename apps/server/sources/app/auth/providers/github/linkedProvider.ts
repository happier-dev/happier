import { resolveProfileLogin } from "./resolveProfileLogin";

export function extractGitHubLinkedProvider(params: {
    profile: unknown;
    providerLogin: string | null;
}): { displayName: string | null; avatarUrl: string | null; profileUrl: string | null } {
    const raw: any = params.profile as any;
    const login = resolveProfileLogin(params);

    const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : null;
    const avatarUrl = typeof raw?.avatar_url === "string" && raw.avatar_url.trim() ? raw.avatar_url.trim() : null;
    const profileUrl = login ? `https://github.com/${encodeURIComponent(login)}` : null;

    return { displayName: name, avatarUrl, profileUrl };
}
