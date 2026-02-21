import { z } from "zod";

import type { Fastify } from "@/app/api/types";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { readAuthMtlsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveMtlsIdentityFromForwardedHeaders } from "@/app/auth/providers/mtls/mtlsIdentity";
import { resolveKeylessAutoProvisionEligibility } from "@/app/auth/keyless/resolveKeylessAutoProvisionEligibility";
import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

type ForwardedMtlsIdentity = NonNullable<ReturnType<typeof resolveMtlsIdentityFromForwardedHeaders>>;

function isMtlsLoginEnabled(env: NodeJS.ProcessEnv): boolean {
    const mtlsEnv = readAuthMtlsFeatureEnv(env);
    if (!mtlsEnv.enabled) return false;
    if (mtlsEnv.mode !== "forwarded") return false;
    if (!mtlsEnv.trustForwardedHeaders) return false;
    if (!resolveKeylessAccountsEnabled(env)) return false;
    return true;
}

async function resolveOrProvisionMtlsAccount(params: {
    identity: ForwardedMtlsIdentity;
}): Promise<{ accountId: string } | { error: "not-eligible" | "e2ee-required" }> {
    const mtlsEnv = readAuthMtlsFeatureEnv(process.env);

    const existing = await db.accountIdentity.findFirst({
        where: { provider: "mtls", providerUserId: params.identity.providerUserId },
        select: { accountId: true },
    });
    if (existing) {
        return { accountId: existing.accountId };
    }

    if (!mtlsEnv.autoProvision) {
        return { error: "not-eligible" };
    }

    const eligibility = resolveKeylessAutoProvisionEligibility(process.env);
    if (!eligibility.ok) {
        return { error: eligibility.error };
    }

    const created = await db.account.create({
        data: {
            publicKey: null,
            encryptionMode: eligibility.encryptionMode,
        },
        select: { id: true },
    });
    const accountId = created.id;

    await db.accountIdentity.create({
        data: {
            accountId,
            provider: "mtls",
            providerUserId: params.identity.providerUserId,
            providerLogin: params.identity.providerLogin,
            profile: params.identity.profile as any,
            showOnProfile: false,
        },
    });

    return { accountId };
}

function effectivePort(url: URL): string {
    if (url.port) return url.port;
    const protocol = url.protocol.toLowerCase();
    if (protocol === "https:") return "443";
    if (protocol === "http:") return "80";
    return "";
}

function normalizePathPrefix(pathname: string): string {
    const raw = pathname || "/";
    const stripped = raw.replace(/\/+$/, "");
    return stripped && stripped !== "/" ? stripped : "";
}

function isPathPrefixMatch(params: { allowedPrefix: string; pathname: string }): boolean {
    const allowed = normalizePathPrefix(params.allowedPrefix);
    if (!allowed) return true;
    const path = params.pathname || "/";
    if (path === allowed) return true;
    if (path.startsWith(`${allowed}/`)) return true;
    return false;
}

function isAllowedReturnTo(params: { returnTo: string; allowPrefixes: readonly string[] }): boolean {
    const raw = params.returnTo.toString().trim();
    if (!raw) return false;

    let returnUrl: URL;
    try {
        returnUrl = new URL(raw);
    } catch {
        return false;
    }

    for (const allow of params.allowPrefixes) {
        const entry = allow.toString().trim();
        if (!entry) continue;

        // Allow custom-scheme prefixes like "happier://".
        const schemeOnlyMatch = entry.match(/^([a-z][a-z0-9+.-]*)\:\/\/$/i);
        if (schemeOnlyMatch) {
            const scheme = schemeOnlyMatch[1]!.toLowerCase();
            const actual = returnUrl.protocol.replace(/:$/, "").toLowerCase();
            if (actual === scheme) return true;
            continue;
        }

        // Allow prefix matching for non-http(s) deep link URLs (e.g. "happier:///mtls").
        // For http(s), prefix matching is unsafe (origin confusion), so those entries are parsed below.
        const looksLikeUrlPrefix = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry);
        const isHttpPrefix = /^https?:\/\//i.test(entry);
        if (looksLikeUrlPrefix && !isHttpPrefix) {
            if (raw.toLowerCase().startsWith(entry.toLowerCase())) return true;
            continue;
        }

        let allowedUrl: URL;
        try {
            allowedUrl = new URL(entry);
        } catch {
            // Fail closed on invalid allowlist entries.
            continue;
        }

        const allowedProtocol = allowedUrl.protocol.toLowerCase();
        if (allowedProtocol !== "https:" && allowedProtocol !== "http:") {
            // Only http/https allowlist entries are supported here; other schemes should use the scheme-only form above.
            continue;
        }

        if (returnUrl.protocol.toLowerCase() !== allowedProtocol) continue;
        if (returnUrl.hostname.toLowerCase() !== allowedUrl.hostname.toLowerCase()) continue;
        if (effectivePort(returnUrl) !== effectivePort(allowedUrl)) continue;

        if (!isPathPrefixMatch({ allowedPrefix: allowedUrl.pathname, pathname: returnUrl.pathname })) continue;
        return true;
    }

    return false;
}

const MTLS_CLAIM_CODE_PREFIX = "mtls_claim_";

async function createMtlsClaimCode(params: { userId: string; ttlMs: number }): Promise<string> {
    const ttlMs = Number.isFinite(params.ttlMs) && params.ttlMs > 0 ? params.ttlMs : 60_000;
    for (let i = 0; i < 3; i++) {
        const code = randomKeyNaked(32);
        const key = `${MTLS_CLAIM_CODE_PREFIX}${code}`;
        try {
            await db.repeatKey.create({
                data: {
                    key,
                    value: JSON.stringify({ userId: params.userId }),
                    expiresAt: new Date(Date.now() + ttlMs),
                },
            });
            return code;
        } catch {
            // retry on rare collisions
        }
    }
    // Extremely unlikely; treat as hard failure.
    throw new Error("mtls-claim-code-unavailable");
}

async function consumeMtlsClaimCode(code: string): Promise<{ userId: string } | null> {
    const raw = code.toString().trim();
    if (!raw) return null;
    const key = `${MTLS_CLAIM_CODE_PREFIX}${raw}`;

    return await db.$transaction(async (tx) => {
        const row = await tx.repeatKey.findUnique({
            where: { key },
            select: { value: true, expiresAt: true },
        });
        if (!row) return null;
        const now = new Date();

        // Consume via a conditional delete to ensure single-use semantics under concurrency.
        const deleted = await tx.repeatKey.deleteMany({
            where: {
                key,
                expiresAt: { gt: now },
            },
        });
        if (deleted.count !== 1) {
            // Best-effort cleanup of expired/invalid rows.
            await tx.repeatKey.deleteMany({ where: { key } }).catch(() => undefined);
            return null;
        }
        try {
            const parsed = JSON.parse(row.value) as any;
            const userId = typeof parsed?.userId === "string" ? parsed.userId.trim() : "";
            if (!userId) return null;
            return { userId };
        } catch {
            return null;
        }
    });
}

function isAllowedEmailIdentity(params: { providerUserId: string; allowedDomains: readonly string[] }): boolean {
    if (params.allowedDomains.length === 0) return true;
    const atIndex = params.providerUserId.lastIndexOf("@");
    const domain = atIndex >= 0 ? params.providerUserId.slice(atIndex + 1).trim().toLowerCase() : "";
    return Boolean(domain) && params.allowedDomains.includes(domain);
}

function isAllowedIssuer(params: { issuer: string | null; allowedIssuers: readonly string[] }): boolean {
    if (params.allowedIssuers.length === 0) return true;
    if (!params.issuer) return false;
    const normalizedDnLower = params.issuer.trim().replace(/\s+/g, " ").toLowerCase();
    if (!normalizedDnLower) return false;

    const cn = (() => {
        if (!normalizedDnLower.includes("=")) return normalizedDnLower;
        const match = normalizedDnLower.match(/(?:^|,|\/)\s*cn\s*=\s*([^,\/]+)\s*(?:,|\/|$)/i);
        const value = match?.[1]?.trim() ?? "";
        return value || null;
    })();

    const dnEntry = `dn=${normalizedDnLower}`;
    const cnEntry = cn ? `cn=${cn}` : null;

    // Allowed list entries are already normalized (via normalizeAuthMtlsIssuerValue at env read time).
    if (params.allowedIssuers.includes(dnEntry)) return true;
    if (cnEntry && params.allowedIssuers.includes(cnEntry)) return true;
    return false;
}

export function registerMtlsAuthRoutes(app: Fastify): void {
    if (!isMtlsLoginEnabled(process.env)) {
        return;
    }

    app.get(
        "/v1/auth/mtls/start",
        {
            schema: {
                querystring: z.object({
                    returnTo: z.string(),
                }),
                response: {
                    302: z.any(),
                    400: z.object({ error: z.literal("invalid-returnTo") }),
                },
            },
        },
        async (request, reply) => {
            const mtlsEnv = readAuthMtlsFeatureEnv(process.env);
            const returnTo = String((request.query as any)?.returnTo ?? "");
            if (!isAllowedReturnTo({ returnTo, allowPrefixes: mtlsEnv.returnToAllowPrefixes })) {
                return reply.code(400).send({ error: "invalid-returnTo" });
            }

            const completeUrl = `/v1/auth/mtls/complete?returnTo=${encodeURIComponent(returnTo)}`;
            return reply.redirect(completeUrl);
        },
    );

    app.get(
        "/v1/auth/mtls/complete",
        {
            schema: {
                querystring: z.object({
                    returnTo: z.string(),
                }),
                response: {
                    302: z.any(),
                    400: z.object({ error: z.literal("invalid-returnTo") }),
                    401: z.object({ error: z.literal("mtls-required") }),
                    403: z.object({ error: z.union([z.literal("e2ee-required"), z.literal("not-eligible")]) }),
                },
            },
        },
        async (request, reply) => {
            const mtlsEnv = readAuthMtlsFeatureEnv(process.env);
            const returnTo = String((request.query as any)?.returnTo ?? "");
            if (!isAllowedReturnTo({ returnTo, allowPrefixes: mtlsEnv.returnToAllowPrefixes })) {
                return reply.code(400).send({ error: "invalid-returnTo" });
            }

            const identity =
                mtlsEnv.mode === "forwarded"
                    ? resolveMtlsIdentityFromForwardedHeaders({
                          env: process.env,
                          headers: request.headers as any,
                      })
                    : null;
            if (!identity) {
                return reply.code(401).send({ error: "mtls-required" });
            }
            if (!isAllowedIssuer({ issuer: identity.profile.issuer, allowedIssuers: mtlsEnv.allowedIssuers })) {
                return reply.code(403).send({ error: "not-eligible" });
            }
            if ((mtlsEnv.identitySource === "san_email" || mtlsEnv.identitySource === "san_upn") && !isAllowedEmailIdentity({ providerUserId: identity.providerUserId, allowedDomains: mtlsEnv.allowedEmailDomains })) {
                return reply.code(403).send({ error: "not-eligible" });
            }

            const account = await resolveOrProvisionMtlsAccount({ identity });
            if ("error" in account) {
                return reply.code(403).send({ error: account.error });
            }

            const ttlMs = mtlsEnv.claimTtlSeconds * 1000;
            const code = await createMtlsClaimCode({ userId: account.accountId, ttlMs });
            const url = new URL(returnTo);
            url.searchParams.set("code", code);
            return reply.redirect(url.toString());
        },
    );

    app.post(
        "/v1/auth/mtls",
        {
            schema: {
                response: {
                    200: z.object({ success: z.literal(true), token: z.string() }),
                    401: z.object({ error: z.literal("mtls-required") }),
                    403: z.object({ error: z.union([z.literal("e2ee-required"), z.literal("not-eligible")]) }),
                },
            },
        },
        async (request, reply) => {
            const mtlsEnv = readAuthMtlsFeatureEnv(process.env);
            const identity =
                mtlsEnv.mode === "forwarded"
                    ? resolveMtlsIdentityFromForwardedHeaders({
                          env: process.env,
                          headers: request.headers as any,
                      })
                    : null;
            if (!identity) {
                return reply.code(401).send({ error: "mtls-required" });
            }
            if (!isAllowedIssuer({ issuer: identity.profile.issuer, allowedIssuers: mtlsEnv.allowedIssuers })) {
                return reply.code(403).send({ error: "not-eligible" });
            }
            if ((mtlsEnv.identitySource === "san_email" || mtlsEnv.identitySource === "san_upn") && !isAllowedEmailIdentity({ providerUserId: identity.providerUserId, allowedDomains: mtlsEnv.allowedEmailDomains })) {
                return reply.code(403).send({ error: "not-eligible" });
            }

            const account = await resolveOrProvisionMtlsAccount({ identity });
            if ("error" in account) {
                return reply.code(403).send({ error: account.error });
            }

            const token = await auth.createToken(account.accountId);
            return reply.send({ success: true, token });
        },
    );

    app.post(
        "/v1/auth/mtls/claim",
        {
            schema: {
                body: z.object({ code: z.string() }),
                response: {
                    200: z.object({ success: z.literal(true), token: z.string() }),
                    401: z.object({ error: z.literal("invalid-code") }),
                },
            },
        },
        async (request, reply) => {
            const code = String((request.body as any)?.code ?? "");
            const verified = await consumeMtlsClaimCode(code);
            if (!verified?.userId) {
                return reply.code(401).send({ error: "invalid-code" });
            }
            const token = await auth.createToken(verified.userId);
            return reply.send({ success: true, token });
        },
    );
}
