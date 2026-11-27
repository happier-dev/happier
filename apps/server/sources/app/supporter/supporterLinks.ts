import { z } from "zod/mini";

import { consumeValidOAuthStateAttempt } from "@/app/api/routes/connect/connectRoutes.oauthStateAttempt";
import { createExternalAuthorizeUrl } from "@/app/api/routes/connect/oauthExternal/createExternalAuthorizeUrl";
import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { isActiveHomeAccountStatus } from "@happier-dev/protocol/home/governance";
import { auth } from "@/app/auth/auth";
import { createSha256SecretDigest, sha256SecretDigestMatches } from "@/app/auth/secretDigest";
import { fetchGitHubEndpoint, resolveGitHubApiGraphQLEndpoint } from "@/app/auth/providers/github/endpoints";
import { readBillingConfig } from "@/app/billing/readBillingConfig";
import { applySupporterPurchaseFactsInTx, isActiveSupporterRecord } from "@/app/billing/supporterRecords";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { githubOAuthProvider } from "@/app/oauth/providers/github";
import { markAccountChangedForPlanInTx } from "@/app/plans/accountPlanState";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import { createSupporterDiscordClient, readSupporterDiscordConfig, SUPPORTER_DISCORD_CALLBACK_PATH } from "./supporterDiscordClient";
import { supporterDiscordRecordBindingSchema, supporterProofSchema, type SupporterGitHubAttempt } from "./supporterLinkBindings";
import { readProvenSupporterRecord, readSupporterProof } from "./supporterPerks";

const startRequestSchema = z.safeExtend(supporterProofSchema, { publishGitHubLogin: z._default(z.boolean(), false) });
const sponsorRecipients = ["happier-dev", "leeroybrun"];
const sponsorshipQuery = `
    query HappierSponsorships($maintainers: [String!]!, $after: String) {
        viewer {
            login
            sponsorshipsAsSponsor(activeOnly: false, maintainerLogins: $maintainers, first: 100, after: $after) {
                nodes {
                    isActive
                    isOneTimePayment
                    sponsorable {
                        ... on Organization { login }
                        ... on User { login }
                    }
                }
                pageInfo { hasNextPage endCursor }
            }
        }
    }
`;
const githubResponseSchema = z.object({
    data: z.object({
        viewer: z.object({
            login: z.string().check(z.regex(/^[a-zA-Z\d-]{1,39}$/)),
            sponsorshipsAsSponsor: z.object({
                nodes: z.array(z.nullable(z.object({
                    isActive: z.boolean(),
                    isOneTimePayment: z.boolean(),
                    sponsorable: z.object({ login: z.string() }),
                }))),
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.nullable(z.string()) }),
            }),
        }),
    }),
    errors: z.optional(z.array(z.unknown())),
});

async function readGitHubSponsorship(env: NodeJS.ProcessEnv, accessToken: string) {
    let after: string | null = null;
    for (;;) {
        const response = await fetchGitHubEndpoint(env, resolveGitHubApiGraphQLEndpoint(), {
            method: "POST",
            headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
            body: JSON.stringify({ query: sponsorshipQuery, variables: { maintainers: sponsorRecipients, after } }),
        });
        if (!response.ok) throw new Error("GitHub sponsorship could not be read");
        const { data, errors } = githubResponseSchema.parse(await response.json());
        if (errors?.length) throw new Error("GitHub sponsorship could not be read");
        const { login, sponsorshipsAsSponsor: { nodes, pageInfo } } = data.viewer;
        const sponsoring = nodes.some((node) => node
            && (node.isActive || node.isOneTimePayment)
            && sponsorRecipients.includes(node.sponsorable.login.toLowerCase()));
        if (sponsoring || !pageInfo.hasNextPage) return { login: login.toLowerCase(), sponsoring };
        if (!pageInfo.endCursor || pageInfo.endCursor === after) throw new Error("GitHub sponsorship pagination did not advance");
        after = pageInfo.endCursor;
    }
}

/** Only a session or a detached record's body code can begin the supporter OAuth journey. */
export function registerSupporterGitHubStart(app: Fastify, env: NodeJS.ProcessEnv): void {
    if (!githubOAuthProvider.isConfigured(env)) return;
    app.post("/v1/supporter/github/start", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "supporter.lookup") },
        schema: { body: startRequestSchema, response: {
            200: z.strictObject({ url: z.url() }),
            404: z.strictObject({ error: z.literal("not_found") }),
            503: z.strictObject({ error: z.literal("oauth_unavailable") }),
        } },
    }, async (request, reply) => {
        const { code, publishGitHubLogin } = request.body as z.infer<typeof startRequestSchema>;
        const proof = await readSupporterProof(() => app.authenticate(request, reply), () => request.userId, code);
        if (!proof || reply.sent) return;
        const result = await readProvenSupporterRecord(db, proof);
        if (result.status === "refused" || result.record?.revokedAt != null) {
            return reply.code(404).send({ error: "not_found" });
        }
        const url = await createExternalAuthorizeUrl({
            flow: "connect", purpose: "supporter_github", providerId: "github", provider: githubOAuthProvider, env,
            supporterGitHub: { proof, recordId: result.record?.id ?? null, publishGitHubLogin },
        });
        return url ? reply.send({ url }) : reply.code(503).send({ error: "oauth_unavailable" });
    });
}

async function applyGitHubSupporterClaim(
    input: SupporterGitHubAttempt,
    github: Readonly<{ login: string; sponsoring: boolean }>,
): Promise<"sponsor" | "supporter" | "none"> {
    const proof = input.proof;
    const apply = () => inTx(async (tx) => {
        if (proof.kind === "account") {
            // Account erasure uses the same Account fence before withdrawing public data. Do
            // not create a new grant for a retired Account from an outstanding consent window.
            await acquireAccountChangePublicationLocksInTx(tx, [proof.accountId], { includeSingleAccount: true });
            const account = await tx.account.findUnique({ where: { id: proof.accountId }, select: { status: true } });
            if (!account || !isActiveHomeAccountStatus(account.status)) return "none" as const;
        }
        const result = await readProvenSupporterRecord(tx, proof);
        if (result.status === "refused" || result.record?.revokedAt != null) return "none" as const;
        const record = result.record;
        if (input.recordId !== null && record?.id !== input.recordId) return "none" as const;
        if (!isActiveSupporterRecord(record)) {
            if (!github.sponsoring) return "none" as const;
            const now = new Date();
            await applySupporterPurchaseFactsInTx(tx, {
                accountId: proof.kind === "account" ? proof.accountId : null,
                code: proof.kind === "code" ? proof.code : null,
                facts: { earned: true, revoked: false, recurringActive: false, kind: "github_sponsor", firstPurchaseAt: now },
                now,
            });
            if (proof.kind === "account") await markAccountChangedForPlanInTx(tx, proof.accountId);
        }
        if (input.publishGitHubLogin && record?.githubLogin !== github.login) {
            await tx.supporterRecord.updateMany({
                where: proof.kind === "account"
                    ? { accountId: proof.accountId, revokedAt: null }
                    : { code: proof.code, accountId: null, revokedAt: null },
                data: { githubLogin: github.login },
            });
        }
        return github.sponsoring ? "sponsor" as const : "supporter" as const;
    });
    try {
        return await apply();
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        return await apply();
    }
}

/** The token is used only as the viewer's sponsorship proof and is discarded after this callback. */
export async function completeSupporterGitHubLink(params: Readonly<{
    attempt: SupporterGitHubAttempt;
    env: NodeJS.ProcessEnv;
    code: string | undefined;
    pkceCodeVerifier: string;
}>): Promise<string> {
    const resultUrl = (result: "sponsor" | "supporter" | "none" | "error") => `https://happier.dev/supporters?linked=${result}`;
    const { env, code, pkceCodeVerifier, attempt } = params;
    if (!code || readBillingConfig(env).billingReference !== "account" || !githubOAuthProvider.isConfigured(env)) {
        return resultUrl("error");
    }
    try {
        const { accessToken } = await githubOAuthProvider.exchangeCodeForAccessToken({ env, code, pkceCodeVerifier });
        const github = await readGitHubSponsorship(env, accessToken);
        return resultUrl(await applyGitHubSupporterClaim(attempt, github));
    } catch {
        return resultUrl("error");
    }
}

const discordAttemptSchema = z.object({
    provider: z.literal("discord"),
    purpose: z.literal("supporter_discord"),
    supporterDiscord: z.nullable(supporterDiscordRecordBindingSchema),
    pkceCodeVerifier: z.string().check(z.minLength(1)),
});
const discordCallbackQuerySchema = z.object({
    state: z.string(),
    code: z.optional(z.string()),
    error: z.optional(z.string()),
});
const githubSearchResultSchema = z.object({ total_count: z.int().check(z.nonnegative()) });

async function hasMergedHappierPullRequest(env: NodeJS.ProcessEnv, login: string) {
    const url = new URL("https://api.github.com/search/issues");
    url.search = new URLSearchParams({ q: `repo:happier-dev/happier is:pr is:merged author:${login}`, per_page: "1" }).toString();
    try {
        const response = await fetchGitHubEndpoint(env, { url: url.href, operatorConfigured: false }, {
            headers: { accept: "application/vnd.github+json", "user-agent": "Happier" },
        });
        if (!response.ok) return false;
        return githubSearchResultSchema.parse(await response.json()).total_count > 0;
    } catch {
        return false;
    }
}

/** App starts bind a proven record. Discord's verification URL starts a lookup-only attempt. */
export function registerSupporterDiscordLinks(app: Fastify, env: NodeJS.ProcessEnv): void {
    const config = readSupporterDiscordConfig(env);
    if (!config) return;
    const discord = createSupporterDiscordClient(config);
    const authorize = (supporterDiscord: z.infer<typeof supporterDiscordRecordBindingSchema> | null) =>
        createExternalAuthorizeUrl({ flow: "connect", purpose: "supporter_discord", providerId: "discord", provider: discord, env, supporterDiscord });
    const resultUrl = (result: "supporter" | "contributor" | "none") => `https://happier.dev/supporters?linked=${result}`;

    app.post("/v1/supporter/discord/start", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "supporter.lookup") },
        schema: { body: supporterProofSchema, response: {
            200: z.strictObject({ url: z.url() }),
            404: z.strictObject({ error: z.literal("not_found") }),
            503: z.strictObject({ error: z.literal("oauth_unavailable") }),
        } },
    }, async (request, reply) => {
        const { code } = request.body as z.infer<typeof supporterProofSchema>;
        const proof = await readSupporterProof(() => app.authenticate(request, reply), () => request.userId, code);
        if (!proof || reply.sent) return;
        const result = await readProvenSupporterRecord(db, proof);
        if (result.status === "refused" || !isActiveSupporterRecord(result.record)) {
            return reply.code(404).send({ error: "not_found" });
        }
        const { id } = result.record;
        const binding = proof.kind === "account"
            ? { id, accountId: proof.accountId }
            : { id, accountId: null, codeDigest: createSha256SecretDigest(proof.code).toString("base64url") };
        const url = await authorize(binding);
        return url ? reply.send({ url }) : reply.code(503).send({ error: "oauth_unavailable" });
    });

    app.get("/v1/supporter/discord/start", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "oauthExternal.authParams") },
    }, async (_request, reply) => reply.redirect(await authorize(null) ?? resultUrl("none")));

    app.get(SUPPORTER_DISCORD_CALLBACK_PATH, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "oauthExternal.callback") },
        schema: { querystring: discordCallbackQuerySchema, response: {
            400: z.strictObject({ error: z.literal("invalid_state") }),
        } },
    }, async (request, reply) => {
        const { state, code, error } = request.query;
        const token = await auth.verifyOauthStateToken(state);
        if (token?.purpose !== "supporter_discord" || !token.sid) {
            return reply.code(400).send({ error: "invalid_state" });
        }
        const stored = await consumeValidOAuthStateAttempt(token.sid);
        if (!stored) return reply.code(400).send({ error: "invalid_state" });
        let attempt: z.infer<typeof discordAttemptSchema>;
        try {
            attempt = discordAttemptSchema.parse(JSON.parse(stored.value));
        } catch {
            return reply.code(400).send({ error: "invalid_state" });
        }
        if (error || !code) return reply.redirect(resultUrl("none"));

        const identity = await discord.exchangeCode(code, attempt.pkceCodeVerifier)
            .then(async (accessToken) => ({ accessToken, ...await discord.readIdentity(accessToken) }))
            .catch(() => null);
        if (!identity) return reply.redirect(resultUrl("none"));

        const { accessToken, discordUserId, githubLogin } = identity;
        const contributor = githubLogin ? await hasMergedHappierPullRequest(env, githubLogin) : false;
        const binding = attempt.supporterDiscord;
        const record = await db.supporterRecord.findFirst({
            where: binding ? { id: binding.id, accountId: binding.accountId } : { discordUserId },
            select: { number: true, revokedAt: true, discordUserId: true, code: binding?.accountId === null },
        });
        const supporter = isActiveSupporterRecord(record)
            && (binding?.accountId !== null || sha256SecretDigestMatches(binding.codeDigest, record.code));
        if (binding) {
            if (!supporter) return reply.redirect(resultUrl("none"));
            // Once the binding is admitted, the menu can retry a failed or ambiguous Discord PUT.
            if (record.discordUserId !== discordUserId) {
                try {
                    const updated = await db.supporterRecord.updateMany({
                        where: {
                            id: binding.id, accountId: binding.accountId, number: record.number,
                            revokedAt: null, discordUserId: record.discordUserId,
                            ...(binding.accountId === null ? { code: record.code } : {}),
                        },
                        data: { discordUserId },
                    });
                    if (updated.count !== 1) return reply.redirect(resultUrl("none"));
                } catch (error) {
                    if (isPrismaErrorCode(error, "P2002")) return reply.redirect(resultUrl("none"));
                    throw error;
                }
            }
        }
        try {
            await discord.writeRoles(accessToken, {
                supporter, contributor, platformUsername: supporter ? `Supporter No. ${record.number}` : githubLogin,
            });
        } catch {
            return reply.redirect(resultUrl("none"));
        }
        return reply.redirect(resultUrl(supporter ? "supporter" : contributor ? "contributor" : "none"));
    });
}
