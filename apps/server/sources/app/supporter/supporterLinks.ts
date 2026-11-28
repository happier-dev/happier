import { z } from "zod";

import { createExternalAuthorizeUrl } from "@/app/api/routes/connect/oauthExternal/createExternalAuthorizeUrl";
import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readPolarConfig } from "@/app/billing/polarClient";
import { readRevenueCatConfig } from "@/app/billing/revenueCatClient";
import { applySupporterPurchaseFactsInTx } from "@/app/billing/supporterRecords";
import { githubOAuthProvider } from "@/app/oauth/providers/github";
import { markAccountChangedForPlanInTx } from "@/app/plans/accountPlanState";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import { findPerkRecord, readSupporterProof, supporterProofSchema, type SupporterProof } from "./supporterPerks";

const startRequest = supporterProofSchema.extend({ publishGitHubLogin: z.boolean().default(false) }).strict();
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
const githubResponse = z.object({
    data: z.object({
        viewer: z.object({
            login: z.string().regex(/^[a-zA-Z\d-]{1,39}$/),
            sponsorshipsAsSponsor: z.object({
                nodes: z.array(z.object({
                    isActive: z.boolean(),
                    isOneTimePayment: z.boolean(),
                    sponsorable: z.object({ login: z.string() }),
                }).nullable()),
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            }),
        }),
    }),
    errors: z.array(z.unknown()).optional(),
});

async function readGitHubSponsorship(accessToken: string): Promise<{ login: string; sponsoring: boolean }> {
    const signal = AbortSignal.timeout(10_000);
    let after: string | null = null;
    for (;;) {
        const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
            body: JSON.stringify({ query: sponsorshipQuery, variables: { maintainers: sponsorRecipients, after } }),
            signal,
        });
        if (!response.ok) throw new Error("GitHub sponsorship could not be read");
        const { data, errors } = githubResponse.parse(await response.json());
        if (errors?.length) throw new Error("GitHub sponsorship could not be read");
        const { login, sponsorshipsAsSponsor: { nodes, pageInfo } } = data.viewer;
        const sponsoring = nodes.some((node) => node && (node.isActive || node.isOneTimePayment)
            && sponsorRecipients.includes(node.sponsorable.login.toLowerCase()));
        if (sponsoring || !pageInfo.hasNextPage) return { login, sponsoring };
        if (!pageInfo.endCursor || pageInfo.endCursor === after) throw new Error("GitHub sponsorship pagination did not advance");
        after = pageInfo.endCursor;
    }
}

export function supporterPerksConfigured(env: NodeJS.ProcessEnv): boolean {
    return Boolean(readPolarConfig(env) || readRevenueCatConfig(env));
}

export function supporterGitHubResult(linked: "sponsor" | "supporter" | "none" | "error"): string {
    return `https://happier.dev/supporters?linked=${linked}`;
}

/** Only an authenticated account or possession of its detached code can begin the OAuth round trip. */
export function registerSupporterGitHubStart(app: Fastify, env: NodeJS.ProcessEnv): void {
    if (!githubOAuthProvider.isConfigured(env)) return;
    app.post("/v1/supporter/github/start", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "supporter.lookup") },
        schema: { body: startRequest, response: {
            200: z.object({ url: z.url() }),
            404: z.object({ error: z.literal("not_found") }),
            503: z.object({ error: z.literal("oauth_unavailable") }),
        } },
    }, async (request, reply) => {
        const { code, publishGitHubLogin } = request.body;
        const proof = await readSupporterProof(() => app.authenticate(request, reply), () => request.userId, code);
        if (!proof || reply.sent) return;
        const record = await findPerkRecord(db, proof);
        if (record?.revokedAt || (code && !record && await db.supporterRecord.findUnique({ where: { code }, select: { id: true } }))) {
            return reply.code(404).send({ error: "not_found" });
        }
        const url = await createExternalAuthorizeUrl({
            flow: "supporter", providerId: "github", provider: githubOAuthProvider, env,
            supporter: { ...proof, publishGitHubLogin },
        });
        return url ? reply.send({ url }) : reply.code(503).send({ error: "oauth_unavailable" });
    });
}

/** Read sponsorship as the authorized GitHub user, then settle the grant through SupporterRecord. */
export async function claimGitHubSupporter(
    proof: SupporterProof & { publishGitHubLogin: boolean },
    accessToken: string,
): Promise<"sponsor" | "supporter" | "none"> {
    const { login, sponsoring } = await readGitHubSponsorship(accessToken);
    const apply = () => inTx(async (tx) => {
        const record = await findPerkRecord(tx, proof);
        if (record?.revokedAt) return "none" as const;
        if (!record?.number && !sponsoring) return "none" as const;
        if (!record && proof.code && await tx.supporterRecord.findUnique({ where: { code: proof.code }, select: { id: true } })) {
            return "none" as const;
        }
        if (!record?.number) {
            const now = new Date();
            await applySupporterPurchaseFactsInTx(tx, {
                ...proof,
                facts: { earned: true, revoked: false, recurringActive: false, kind: "github_sponsor", firstPurchaseAt: now },
                now,
            });
            if (proof.accountId) await markAccountChangedForPlanInTx(tx, proof.accountId);
        }
        if (proof.publishGitHubLogin) {
            const granted = record?.number ? record : await findPerkRecord(tx, proof);
            const githubLogin = login.toLowerCase();
            if (granted && granted.githubLogin !== githubLogin) {
                await tx.supporterRecord.update({ where: { id: granted.id }, data: { githubLogin } });
            }
        }
        return sponsoring ? "sponsor" as const : "supporter" as const;
    });
    try {
        return await apply();
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        return await apply();
    }
}
