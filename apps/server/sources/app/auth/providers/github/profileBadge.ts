import { extractGitHubLinkedProvider } from "./linkedProvider";
import { resolveProfileLogin } from "./resolveProfileLogin";

export function extractGitHubProfileBadge(params: {
    profile: unknown;
    providerLogin: string | null;
}): { label: string; url: string } | null {
    const login = resolveProfileLogin(params);
    if (!login) return null;

    const linked = extractGitHubLinkedProvider({ profile: params.profile, providerLogin: params.providerLogin });
    if (!linked.profileUrl) return null;

    return { label: `@${login}`, url: linked.profileUrl };
}
