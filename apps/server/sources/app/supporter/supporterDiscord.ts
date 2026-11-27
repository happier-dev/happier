import { createHash } from "node:crypto";
import { z } from "zod";

import { loadValidOAuthStateAttempt } from "@/app/api/routes/connect/connectRoutes.oauthStateAttempt";
import { createExternalAuthorizeUrl } from "@/app/api/routes/connect/oauthExternal/createExternalAuthorizeUrl";
import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { auth } from "@/app/auth/auth";
import { db, isPrismaErrorCode } from "@/storage/db";

import { findPerkRecord, readSupporterProof, supporterProofSchema } from "./supporterPerks";

const startPath = "/v1/supporter/discord/start";
const callbackPath = "/v1/supporter/discord/callback";
const discordApi = "https://discord.com/api/v10";
const discordScope = "identify connections role_connections.write";

const attemptSchema = z.object({
    provider: z.literal("discord"),
    pkceCodeVerifier: z.string().min(1),
    supporterDiscord: z.object({ id: z.string(), accountId: z.string().nullable(), codeDigest: z.string().nullable() }).nullable(),
});

type Binding = NonNullable<z.infer<typeof attemptSchema>["supporterDiscord"]>;

function readDiscordConfig(env: NodeJS.ProcessEnv) {
    const clientId = env.DISCORD_CLIENT_ID?.trim();
    const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
    const redirect = z.url({ protocol: /^https$/ }).safeParse(env.DISCORD_REDIRECT_URL?.trim());
    if (!clientId || !/^\d+$/.test(clientId) || !clientSecret || !redirect.success) return null;
    const redirectUrl = new URL(redirect.data);
    if (redirectUrl.pathname !== callbackPath || redirectUrl.search || redirectUrl.hash ||
        redirectUrl.username || redirectUrl.password) return null;
    return { clientId, clientSecret, redirectUrl: redirectUrl.href };
}

function resultUrl(result: "supporter" | "contributor" | "none" | "error", retry = false): string {
    return `https://happier.dev/supporters?linked=${result}&via=discord${retry ? "&retry=1" : ""}`;
}

function digestProof(code: string): string {
    return createHash("sha256").update(code).digest("hex");
}

/** Persist only a verified, currently eligible binding. A second record cannot borrow the same Discord identity. */
async function bindDiscordSupporter(binding: Binding, discordUserId: string): Promise<number | null> {
    const where = { id: binding.id, accountId: binding.accountId, revokedAt: null, number: { not: null } };
    const record = await db.supporterRecord.findFirst({
        where,
        select: { number: true, discordUserId: true, code: true },
    });
    if (!record || (binding.accountId === null && digestProof(record.code) !== binding.codeDigest)) return null;
    if (record.discordUserId === discordUserId) return record.number;
    if (record.discordUserId !== null) return null;
    try {
        const updated = await db.supporterRecord.updateMany({
            where: { ...where, ...(binding.accountId === null ? { code: record.code } : null), discordUserId: null },
            data: { discordUserId },
        });
        return updated.count === 1 ? record.number : null;
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        return null;
    }
}

async function readAttempt(state: string) {
    const token = await auth.verifyOauthStateToken(state);
    if (token?.flow !== "supporter" || token.provider !== "discord" || !token.sid) return null;
    const stored = await loadValidOAuthStateAttempt(token.sid);
    if (!stored) return null;

    let attempt: z.infer<typeof attemptSchema>;
    try {
        attempt = attemptSchema.parse(JSON.parse(stored.value));
    } catch {
        return null;
    }
    if ((attempt.supporterDiscord?.accountId ?? null) !== token.userId) return null;

    const consumed = await db.repeatKey.deleteMany({
        where: { key: stored.key, value: stored.value, expiresAt: { gt: new Date() } },
    });
    return consumed.count === 1 ? attempt : null;
}

/** App starts bind a proven Supporter record. Discord starts can only re-verify by Discord identity. */
export function registerSupporterDiscordLinks(app: Fastify, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): void {
    const config = readDiscordConfig(env);
    if (!config) return;
    const authorize = (supporterDiscord: Binding | null) => createExternalAuthorizeUrl({
        flow: "supporter",
        providerId: "discord",
        env,
        supporterDiscord,
        scope: discordScope,
        provider: {
            async resolveAuthorizeUrl({ state, scope, codeChallenge }) {
                const url = new URL("https://discord.com/oauth2/authorize");
                url.search = new URLSearchParams({
                    client_id: config.clientId, redirect_uri: config.redirectUrl,
                    response_type: "code", scope, state, prompt: "consent",
                    code_challenge: codeChallenge ?? "", code_challenge_method: "S256",
                }).toString();
                return url.href;
            },
        },
    });

    app.post(startPath, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "supporter.lookup") },
        schema: { response: {
            200: z.object({ url: z.url() }),
            400: z.object({ error: z.literal("invalid_payload") }),
            404: z.object({ error: z.literal("not_found") }),
            503: z.object({ error: z.literal("oauth_unavailable") }),
        } },
    }, async (request, reply) => {
        const payload = supporterProofSchema.strict().optional().safeParse(request.body);
        if (!payload.success) return reply.code(400).send({ error: "invalid_payload" });
        const proof = await readSupporterProof(() => app.authenticate(request, reply), () => request.userId, payload.data?.code);
        if (!proof || reply.sent) return;
        const record = await findPerkRecord(db, proof);
        if (!record || record.number === null || record.revokedAt !== null) {
            return reply.code(404).send({ error: "not_found" });
        }
        const url = await authorize({
            id: record.id,
            accountId: record.accountId,
            codeDigest: record.accountId === null ? digestProof(record.code) : null,
        });
        return url ? reply.send({ url }) : reply.code(503).send({ error: "oauth_unavailable" });
    });

    app.get(startPath, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "oauthExternal.authParams") },
    }, async (_request, reply) => reply.redirect(await authorize(null) ?? resultUrl("error")));

    app.get(callbackPath, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "oauthExternal.callback") },
        schema: { querystring: z.object({ state: z.string().min(1), code: z.string().min(1).optional(), error: z.string().optional() }) },
    }, async (request, reply) => {
        const { state, code, error } = request.query;
        const attempt = await readAttempt(state);
        if (!attempt || error || !code) return reply.redirect(resultUrl("error"));

        const callDiscord = async (path: string, init: RequestInit) => {
            const response = await fetchImpl(`${discordApi}${path}`, { ...init, redirect: "error" });
            if (!response.ok) throw new Error("Discord Linked Roles request failed");
            return response;
        };

        try {
            const token = await callDiscord("/oauth2/token", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: config.clientId, client_secret: config.clientSecret,
                    grant_type: "authorization_code", redirect_uri: config.redirectUrl, code,
                    code_verifier: attempt.pkceCodeVerifier,
                }),
            });
            const { access_token } = z.object({ access_token: z.string().min(1) }).parse(await token.json());
            const headers = { authorization: `Bearer ${access_token}` };
            const [userResponse, connectionsResponse] = await Promise.all([
                callDiscord("/users/@me", { headers }),
                callDiscord("/users/@me/connections", { headers }),
            ]);
            const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(await userResponse.json());
            const connections = z.array(z.object({ type: z.string(), name: z.string(), verified: z.boolean() }))
                .parse(await connectionsResponse.json());
            const githubLogin = connections.find((connection) =>
                connection.type === "github" && connection.verified && /^[a-z\d-]{1,39}$/i.test(connection.name))?.name;

            const [number, contribution] = await Promise.all([
                attempt.supporterDiscord
                    ? bindDiscordSupporter(attempt.supporterDiscord, id)
                    : db.supporterRecord.findUnique({ where: { discordUserId: id, revokedAt: null }, select: { number: true } })
                        .then((record) => record?.number ?? null),
                githubLogin ? readContributor(githubLogin, fetchImpl) : false,
            ]);
            const supporter = number !== null;
            if (attempt.supporterDiscord && !supporter) return reply.redirect(resultUrl("error"));
            const contributor = contribution === true;
            await callDiscord(`/users/@me/applications/${config.clientId}/role-connection`, {
                method: "PUT",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({
                    platform_name: "Happier",
                    platform_username: supporter ? `Supporter No. ${number}` : githubLogin,
                    metadata: { supporter: supporter ? "1" : "0", contributor: contributor ? "1" : "0" },
                }),
            });
            return reply.redirect(resultUrl(supporter ? "supporter" : contributor ? "contributor" : "none", contribution === null));
        } catch {
            return reply.redirect(resultUrl("error"));
        }
    });
}

/** A provider error remains distinguishable from a successful search with zero merged pull requests. */
async function readContributor(login: string, fetchImpl: typeof fetch): Promise<boolean | null> {
    const url = new URL("https://api.github.com/search/issues");
    url.search = new URLSearchParams({ q: `repo:happier-dev/happier is:pr is:merged author:${login}`, per_page: "1" }).toString();
    try {
        const response = await fetchImpl(url, {
            headers: { accept: "application/vnd.github+json", "user-agent": "Happier" },
            redirect: "error",
        });
        if (!response.ok) return null;
        return z.object({ total_count: z.number().int().nonnegative() }).parse(await response.json()).total_count > 0;
    } catch {
        return null;
    }
}
