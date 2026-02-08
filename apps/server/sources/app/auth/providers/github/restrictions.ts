export type GitHubOrgMatch = "any" | "all";
export type GitHubOrgMembershipSource = "github_app" | "oauth_user_token";

export type GitHubAuthRestrictions = Readonly<{
    allowedUsers: readonly string[];
    allowedOrgs: readonly string[];
    orgMatch: GitHubOrgMatch;
    orgMembershipSource: GitHubOrgMembershipSource;
}>;

function parseCsvList(raw: string | undefined): string[] {
    if (typeof raw !== "string") return [];
    return raw
        .split(/[,\s]+/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeIdList(raw: string | undefined): string[] {
    return parseCsvList(raw).map((s) => s.toLowerCase());
}

function parseOrgMatch(raw: string | undefined): GitHubOrgMatch {
    const v = raw?.toString().trim().toLowerCase();
    return v === "all" ? "all" : "any";
}

function parseOrgMembershipSource(raw: string | undefined, fallback: GitHubOrgMembershipSource): GitHubOrgMembershipSource {
    const v = raw?.toString().trim().toLowerCase();
    if (v === "oauth_user_token") return "oauth_user_token";
    if (v === "github_app") return "github_app";
    return fallback;
}

export function resolveGitHubAuthRestrictionsFromEnv(env: NodeJS.ProcessEnv): GitHubAuthRestrictions {
    const allowedUsers = Object.freeze(normalizeIdList(env.AUTH_GITHUB_ALLOWED_USERS));
    const allowedOrgs = Object.freeze(normalizeIdList(env.AUTH_GITHUB_ALLOWED_ORGS));
    const orgMatch = parseOrgMatch(env.AUTH_GITHUB_ORG_MATCH);

    const defaultMembershipSource: GitHubOrgMembershipSource = allowedOrgs.length > 0 ? "github_app" : "oauth_user_token";
    const orgMembershipSource = parseOrgMembershipSource(env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE, defaultMembershipSource);

    return Object.freeze({
        allowedUsers,
        allowedOrgs,
        orgMatch,
        orgMembershipSource,
    });
}

export function shouldRequestReadOrgScopeForGitHub(env: NodeJS.ProcessEnv): boolean {
    const restrictions = resolveGitHubAuthRestrictionsFromEnv(env);
    return restrictions.allowedOrgs.length > 0 && restrictions.orgMembershipSource === "oauth_user_token";
}
