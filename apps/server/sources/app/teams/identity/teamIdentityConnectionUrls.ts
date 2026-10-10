import { resolveEffectiveWebappBaseUrl } from "@/app/serverUrls/effectiveServerUrls";

export function resolveTeamIdentityConnectionReturnUrl(input: Readonly<{
    env: NodeJS.ProcessEnv;
    homeServerIdentityId: string;
    teamId: string | null;
    connectionId: string;
    purpose?: 'workos_admin_portal';
}>): string | null {
    const url = new URL(resolveEffectiveWebappBaseUrl(input.env));
    if (url.protocol !== "https:") return null;
    const prefix = url.pathname.replace(/\/+$/, "");
    url.pathname = input.teamId === null
        ? `${prefix}/settings/home/${encodeURIComponent(input.homeServerIdentityId)}/sign-in-providers/connections/${encodeURIComponent(input.connectionId)}`
        : `${prefix}/settings/teams/${encodeURIComponent(input.homeServerIdentityId)}/${encodeURIComponent(input.teamId)}/authentication/${encodeURIComponent(input.connectionId)}`;
    url.search = "";
    if (input.purpose) url.searchParams.set('purpose', input.purpose);
    url.hash = "";
    return url.toString();
}
