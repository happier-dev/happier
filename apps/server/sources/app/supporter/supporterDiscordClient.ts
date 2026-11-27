import { z } from "zod/mini";

import { createOutboundFetch } from "@/app/net/outboundIdentityFetch";
import { vendorIdentityEndpointNetworkPolicy } from "@/app/net/outboundIdentityNetworkPolicy";

const discordApi = "https://discord.com/api/v10";
export const SUPPORTER_DISCORD_CALLBACK_PATH = "/v1/supporter/discord/callback";
export const DISCORD_LINKED_ROLE_METADATA = {
    supporter: { key: "supporter", type: 7, name: "Supporter", description: "Has an active Happier Supporter record" },
    contributor: { key: "contributor", type: 7, name: "Contributor", description: "Has a merged pull request in happier-dev/happier" },
} as const;

const redirectUrlSchema = z.url({ protocol: /^https$/ });
const discordTokenSchema = z.object({ access_token: z.string().check(z.minLength(1)) });
const discordUserSchema = z.object({ id: z.string().check(z.regex(/^\d+$/)) });
const discordConnectionsSchema = z.array(z.object({
    type: z.string(),
    name: z.string(),
    verified: z.boolean(),
}));

/** Discord Linked Roles is configured separately from Happier sign-in and billing. */
export function readSupporterDiscordConfig(env: NodeJS.ProcessEnv) {
    const clientId = env.DISCORD_CLIENT_ID?.trim();
    const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
    const redirect = env.DISCORD_REDIRECT_URL?.trim();
    const parsedRedirect = redirectUrlSchema.safeParse(redirect);
    if (!clientId || !/^\d+$/.test(clientId) || !clientSecret || !parsedRedirect.success) return null;
    const redirectUrl = new URL(parsedRedirect.data);
    if (redirectUrl.pathname !== SUPPORTER_DISCORD_CALLBACK_PATH || redirectUrl.search || redirectUrl.hash
        || redirectUrl.username || redirectUrl.password) return null;
    return { clientId, clientSecret, redirectUrl: redirectUrl.href };
}

type DiscordConfig = NonNullable<ReturnType<typeof readSupporterDiscordConfig>>;

/** One consent attempt borrows the user's Discord access token for identity and its role write. */
export function createSupporterDiscordClient(config: DiscordConfig) {
    const scope = "identify connections role_connections.write";
    const resolveAuthorizeUrl = async ({ state, codeChallenge }: { state: string; codeChallenge?: string }) => {
        const url = new URL("https://discord.com/oauth2/authorize");
        url.search = new URLSearchParams({
            client_id: config.clientId, redirect_uri: config.redirectUrl, response_type: "code", state,
            scope, prompt: "consent", code_challenge: codeChallenge ?? "", code_challenge_method: "S256",
        }).toString();
        return url.href;
    };

    async function fetch(path: string, init: RequestInit) {
        const outbound = createOutboundFetch({ policy: vendorIdentityEndpointNetworkPolicy(false) });
        try {
            const response = await outbound.fetch(`${discordApi}${path}`, init);
            if (!response.ok) throw new Error("Discord Linked Roles request failed");
            return response;
        } finally {
            await outbound.close();
        }
    }

    const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
    return {
        resolveScope: () => scope,
        resolveAuthorizeUrl,
        async exchangeCode(code: string, pkceCodeVerifier: string) {
            const response = await fetch("/oauth2/token", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                    grant_type: "authorization_code",
                    redirect_uri: config.redirectUrl,
                    code,
                    code_verifier: pkceCodeVerifier,
                }),
            });
            return discordTokenSchema.parse(await response.json()).access_token;
        },
        async readIdentity(accessToken: string) {
            const headers = bearer(accessToken);
            const [user, connections] = await Promise.all([
                fetch("/users/@me", { headers }).then(async (response) => discordUserSchema.parse(await response.json())),
                fetch("/users/@me/connections", { headers }).then(async (response) => discordConnectionsSchema.parse(await response.json())),
            ]);
            const githubLogin = connections.find(({ type, name, verified }) =>
                type === "github" && verified && /^[a-z\d-]{1,39}$/i.test(name))?.name;
            return { discordUserId: user.id, githubLogin };
        },
        async writeRoles(accessToken: string, roles: Readonly<{ supporter: boolean; contributor: boolean; platformUsername?: string }>) {
            await fetch(`/users/@me/applications/${config.clientId}/role-connection`, {
                method: "PUT",
                headers: { ...bearer(accessToken), "content-type": "application/json" },
                body: JSON.stringify({
                    platform_name: "Happier",
                    platform_username: roles.platformUsername,
                    metadata: {
                        [DISCORD_LINKED_ROLE_METADATA.supporter.key]: roles.supporter ? "1" : "0",
                        [DISCORD_LINKED_ROLE_METADATA.contributor.key]: roles.contributor ? "1" : "0",
                    },
                }),
            });
        },
    };
}
