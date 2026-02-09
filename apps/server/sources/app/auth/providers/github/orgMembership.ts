import { App } from "octokit";

type GithubAppConfig = Readonly<{
    appId: string;
    privateKey: string;
    installationsByOrg: ReadonlyMap<string, number>;
}>;

let cachedApp: App | null = null;
let cachedConfigKey: string | null = null;

function parseInstallationMap(raw: string | undefined): Map<string, number> {
    const out = new Map<string, number>();
    if (typeof raw !== "string") return out;
    for (const part of raw.split(/[,\s]+/g)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [orgRaw, idRaw] = trimmed.split("=");
        const org = (orgRaw ?? "").trim().toLowerCase();
        const id = Number.parseInt((idRaw ?? "").trim(), 10);
        if (!org || !Number.isFinite(id) || id <= 0) continue;
        out.set(org, id);
    }
    return out;
}

function resolveGithubAppConfigFromEnv(env: NodeJS.ProcessEnv): GithubAppConfig | null {
    const appId = (env.AUTH_GITHUB_APP_ID ?? env.GITHUB_APP_ID ?? "").toString().trim();
    const privateKey = (env.AUTH_GITHUB_APP_PRIVATE_KEY ?? env.GITHUB_PRIVATE_KEY ?? "").toString();
    const mapRaw = (env.AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG ?? "").toString().trim();
    if (!appId || !privateKey || !mapRaw) return null;

    const installationsByOrg = parseInstallationMap(mapRaw);
    if (installationsByOrg.size === 0) return null;

    return Object.freeze({
        appId,
        privateKey,
        installationsByOrg,
    });
}

async function getGithubAppFromEnv(env: NodeJS.ProcessEnv): Promise<{ app: App; config: GithubAppConfig } | null> {
    const config = resolveGithubAppConfigFromEnv(env);
    if (!config) return null;

    const configKey = `${config.appId}\n${config.privateKey}`;
    if (!cachedApp || cachedConfigKey !== configKey) {
        cachedConfigKey = configKey;
        cachedApp = new App({
            appId: config.appId,
            privateKey: config.privateKey,
        });
    }

    return { app: cachedApp, config };
}

export async function isGithubOrgMemberViaApp(params: {
    org: string;
    username: string;
    env: NodeJS.ProcessEnv;
}): Promise<boolean> {
    const org = params.org.toString().trim().toLowerCase();
    const username = params.username.toString().trim();
    const resolved = await getGithubAppFromEnv(params.env);
    if (!resolved) {
        return false;
    }

    const installationId = resolved.config.installationsByOrg.get(org);
    if (!installationId) {
        return false;
    }

    const octokit = await resolved.app.getInstallationOctokit(installationId);

    try {
        // https://docs.github.com/en/rest/orgs/members#check-organization-membership-for-a-user
        await (octokit as any).request("GET /orgs/{org}/members/{username}", { org, username });
        return true;
    } catch (error: any) {
        const status = error?.status;
        if (status === 404) return false;
        throw error;
    }
}

export async function isGithubOrgMemberViaUserToken(params: {
    org: string;
    username: string;
    accessToken: string;
    timeoutMs?: number;
}): Promise<boolean> {
    const org = params.org.toString().trim().toLowerCase();
    const username = params.username.toString().trim();
    const accessToken = params.accessToken.toString();
    const timeoutMs =
        Number.isFinite(params.timeoutMs as any) && (params.timeoutMs as any) > 0
            ? Number(params.timeoutMs)
            : undefined;

    const controller = typeof timeoutMs === "number" ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response: Response;
    try {
        response = await fetch(
            `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                },
                ...(controller ? { signal: controller.signal } : {}),
            },
        );
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    if (response.status === 204) return true;
    if (response.status === 404) return false;
    if (response.status === 302) return false;

    if (!response.ok) {
        throw new Error(`GitHub membership check failed (status=${response.status})`);
    }

    // Some proxy layers can convert 204->200; treat any 2xx as member if ok.
    return true;
}
