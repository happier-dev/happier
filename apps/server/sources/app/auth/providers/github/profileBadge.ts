import { extractGitHubLinkedProvider } from "./linkedProvider";

export function extractGitHubProfileBadge(params: {
    profile: unknown;
    providerLogin: string | null;
}): { label: string; url: string } | null {
    const raw: any = params.profile as any;
    const login =
        typeof raw?.login === "string" && raw.login.trim()
            ? raw.login.trim()
            : params.providerLogin && params.providerLogin.trim()
                ? params.providerLogin.trim()
                : null;
    if (!login) return null;

    const linked = extractGitHubLinkedProvider({ profile: params.profile, providerLogin: params.providerLogin });
    if (!linked.profileUrl) return null;

    return { label: `@${login}`, url: linked.profileUrl };
}

