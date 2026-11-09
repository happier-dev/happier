import { inTx } from "@/storage/inTx";
import { z } from "zod/mini";
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema } from '@happier-dev/protocol/account/encryptionMigrate';
import { PasswordCredentialMutationDigestV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { TeamInvitationAccountAdmissionV1Schema } from '@happier-dev/protocol/auth/accountAdmission';
import { type NativeAccountAdmissionV1 } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';

import type { Fastify } from "@/app/api/types";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { accountDirectoryAuthErrorHandler } from "@/app/accountDirectory/accountDirectoryErrors";
import { readAuthMtlsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isMtlsLoginEnabled, resolveMtlsIdentityFromForwardedHeaders } from "@/app/auth/providers/mtls/mtlsIdentity";
import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import {
    isTrulyKeylessPlainAccountRow,
} from "@/app/encryption/accountEncryptionMode";
import { normalizeHttpUrl, resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import {
    completeMtlsTeamHandoffInTx,
    acquireMtlsAuthenticationClaimInTx,
    beginMtlsTeamHandoff,
    createMtlsAuthenticationClaimCode,
    createMtlsClaimCode,
    createMtlsTeamHandoff,
} from "./mtlsClaimCode";
import { isEffectiveHomeAuthMethodActionEnabled } from "@/app/auth/methods/effectiveHomeAuthMethods";
import {
    resolveTeamInvitationFreshAccountAdmissionReferenceInTx,
    TeamInvitationFreshAccountAdmissionAbort,
} from "@/app/teams/invitations/freshAccountAdmission";
import { TeamInvitationPostAuthContinuationV1Schema } from '@happier-dev/protocol/teams/invitation';
import { isTeamMembershipAdmissionEnabled } from "@/app/teams/memberships/membershipService";
import {
    finalizeMtlsAuthenticationInTx,
    isMtlsAcceptedByCurrentTeamPolicyInTx,
    MtlsFinalizationAbort,
} from "./finalizeMtlsAuthentication";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

type ForwardedMtlsIdentity = NonNullable<ReturnType<typeof resolveMtlsIdentityFromForwardedHeaders>>;

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

async function completeMtlsTeamHandoff(params: {
    admissionReference: string;
    returnTo: string;
    identity: ForwardedMtlsIdentity;
}): Promise<{ code: string; teamId: string } | { error: "invalid-reference" }> {
    return await inTx(async (tx) => {
        const completed = await completeMtlsTeamHandoffInTx(tx, {
            admissionReference: params.admissionReference,
            returnTo: params.returnTo,
            identity: params.identity,
        });
        return completed ?? { error: "invalid-reference" as const };
    });
}

export function registerMtlsAuthRoutes(app: Fastify): void {
    if (!isMtlsLoginEnabled(process.env)) {
        return;
    }

    app.post(
        "/v1/auth/mtls/start",
        {
            schema: {
                body: z.strictObject({
                    returnTo: z.string(),
                    teamId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
                    admission: z.optional(TeamInvitationAccountAdmissionV1Schema),
                }),
                response: {
                    200: z.strictObject({
                        startUrl: z.string().check(z.minLength(1)),
                        admissionReference: z.string().check(z.minLength(1)),
                    }),
                    400: z.object({ error: z.literal("invalid-returnTo") }),
                    403: z.object({ error: z.literal("not-eligible") }),
                },
            },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const body = request.body as {
                returnTo: string;
                teamId: string;
                admission?: NativeAccountAdmissionV1;
            };
            const mtlsEnv = readAuthMtlsFeatureEnv(requestHomeEnv);
            if (!await isTeamMembershipAdmissionEnabled({ env: requestHomeEnv })) {
                return reply.code(403).send({ error: "not-eligible" });
            }
            if (!isAllowedReturnTo({ returnTo: body.returnTo, allowPrefixes: mtlsEnv.returnToAllowPrefixes })) {
                return reply.code(400).send({ error: "invalid-returnTo" });
            }
            const prepared = await inTx(async (tx) => {
                const invitation = body.admission?.kind === "team_invitation"
                    ? await resolveTeamInvitationFreshAccountAdmissionReferenceInTx(tx, body.admission)
                    : null;
                if (body.admission && !invitation) return null;
                if (invitation && invitation.teamId !== body.teamId) return null;
                const team = await tx.team.findUnique({
                    where: { id: body.teamId },
                    select: { id: true, archivedAt: true, admissionMode: true, authenticationPolicy: true },
                });
                if (!team || team.archivedAt !== null
                    || (invitation && team.admissionMode !== "invite_only")
                    || (!invitation && !await isMtlsAcceptedByCurrentTeamPolicyInTx(tx, team, false))) return null;
                return { teamId: team.id, invitation };
            });
            if (!prepared) return reply.code(403).send({ error: "not-eligible" });
            const admissionReference = await createMtlsTeamHandoff({
                returnTo: body.returnTo,
                teamId: prepared.teamId,
                ttlMs: mtlsEnv.claimTtlSeconds * 1000,
                ...(prepared.invitation ? { invitation: prepared.invitation } : {}),
            });
            const requestBaseUrl = normalizeHttpUrl(`${request.protocol}://${request.host}`);
            const publicBaseUrl = resolveConfiguredPublicServerUrl(requestHomeEnv) ?? requestBaseUrl;
            if (!publicBaseUrl) return reply.code(403).send({ error: "not-eligible" });
            const startUrl = new URL("/v1/auth/mtls/start", `${publicBaseUrl}/`);
            startUrl.searchParams.set("returnTo", body.returnTo);
            startUrl.searchParams.set("admissionReference", admissionReference);
            return reply.send({
                startUrl: startUrl.toString(),
                admissionReference,
            });
        },
    );

    app.get(
        "/v1/auth/mtls/start",
        {
            schema: {
                querystring: z.object({
                    returnTo: z.string(),
                    admissionReference: z.optional(z.string()),
                }),
                response: {
                    302: z.any(),
                    400: z.object({ error: z.literal("invalid-returnTo") }),
                },
            },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const mtlsEnv = readAuthMtlsFeatureEnv(requestHomeEnv);
            const returnTo = String((request.query as any)?.returnTo ?? "");
            if (!isAllowedReturnTo({ returnTo, allowPrefixes: mtlsEnv.returnToAllowPrefixes })) {
                return reply.code(400).send({ error: "invalid-returnTo" });
            }

            const admissionReference = String((request.query as { admissionReference?: unknown })?.admissionReference ?? "").trim();
            if (admissionReference && !await beginMtlsTeamHandoff({ admissionReference, returnTo })) {
                return reply.code(400).send({ error: "invalid-returnTo" });
            }

            const completeUrl = new URL("http://mtls.local/v1/auth/mtls/complete");
            completeUrl.searchParams.set("returnTo", returnTo);
            if (admissionReference) completeUrl.searchParams.set("admissionReference", admissionReference);
            return reply.redirect(`${completeUrl.pathname}${completeUrl.search}`);
        },
    );

    app.get(
        "/v1/auth/mtls/complete",
        {
            schema: {
                querystring: z.object({
                    returnTo: z.string(),
                    admissionReference: z.optional(z.string()),
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
            const requestHomeEnv = await readRequestHomeEnv(request);
            const mtlsEnv = readAuthMtlsFeatureEnv(requestHomeEnv);
            const returnTo = String((request.query as any)?.returnTo ?? "");
            if (!isAllowedReturnTo({ returnTo, allowPrefixes: mtlsEnv.returnToAllowPrefixes })) {
                return reply.code(400).send({ error: "invalid-returnTo" });
            }

            const identity =
                mtlsEnv.mode === "forwarded"
                    ? resolveMtlsIdentityFromForwardedHeaders({
                          env: requestHomeEnv,
                          headers: request.headers,
                          request: request.raw,
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

            const admissionReference = String((request.query as { admissionReference?: unknown })?.admissionReference ?? "").trim();
            if (admissionReference) {
                const completed = await completeMtlsTeamHandoff({
                    admissionReference,
                    returnTo,
                    identity,
                });
                if ("error" in completed) {
                    return reply.code(403).send({ error: "not-eligible" });
                }
                const url = new URL(returnTo);
                url.searchParams.set("code", completed.code);
                url.searchParams.set("admissionReference", admissionReference);
                return reply.redirect(url.toString());
            }

            const ttlMs = mtlsEnv.claimTtlSeconds * 1000;
            const code = await createMtlsAuthenticationClaimCode({ identity, ttlMs });
            const url = new URL(returnTo);
            url.searchParams.set("code", code);
            return reply.redirect(url.toString());
        },
    );

    app.post(
        "/v1/auth/mtls",
        {
            errorHandler: accountDirectoryAuthErrorHandler,
            preHandler: async (request, reply) => {
                if (["account_encryption_first_key", "account_password_enrollment"].includes(String(
                    (request.body as { purpose?: unknown } | undefined)?.purpose ?? "",
                ))) {
                    return await app.authenticate(request, reply);
                }
            },
            schema: {
                response: {
                    200: z.union([
                        z.object({
                            success: z.literal(true),
                            token: z.string(),
                        }),
                        z.object({
                            success: z.literal(true),
                            pending: z.string(),
                        }),
                    ]),
                    400: z.object({
                        error:
                            z.literal(
                                "invalid-step-up-request",
                            ),
                    }),
                    401: z.union([
                        z.object({
                            error: z.literal("mtls-required"),
                        }),
                        z.object({
                            error: z.string(),
                            code: z.optional(z.string()),
                        }),
                    ]),
                    403: z.object({ error: z.union([z.literal("e2ee-required"), z.literal("not-eligible"), z.literal("account-disabled")]) }),
                    409: z.object({ error: z.literal("restore-required") }),
                },
            },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const mtlsEnv = readAuthMtlsFeatureEnv(requestHomeEnv);
            const identity =
                mtlsEnv.mode === "forwarded"
                    ? resolveMtlsIdentityFromForwardedHeaders({
                          env: requestHomeEnv,
                          headers: request.headers,
                          request: request.raw,
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

            const isStepUpRequest = ["account_encryption_first_key", "account_password_enrollment"].includes(String(
                (request.body as { purpose?: unknown } | undefined)?.purpose ?? "",
            ));
            const stepUpCandidate = z.discriminatedUnion("purpose", [
                z.strictObject({
                    purpose: z.literal("account_encryption_first_key"),
                    proofHash:
                        z.string().check(z.regex(/^[0-9a-f]{64}$/)),
                    requestDigest:
                        AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
                }),
                z.strictObject({
                    purpose: z.literal("account_password_enrollment"),
                    proofHash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
                    requestDigest: PasswordCredentialMutationDigestV1Schema,
                }),
            ]).safeParse(request.body);
            if (
                isStepUpRequest
                && !stepUpCandidate.success
            ) {
                return reply.code(400).send({
                    error: "invalid-step-up-request",
                });
            }
            const stepUp = stepUpCandidate.success
                ? stepUpCandidate.data
                : null;
            const admissionCandidate = TeamInvitationAccountAdmissionV1Schema.safeParse(
                (request.body as { admission?: unknown } | undefined)?.admission,
            );
            const invitationAdmission = admissionCandidate.success
                ? admissionCandidate.data
                : undefined;
            if ((request.body as { admission?: unknown } | undefined)?.admission !== undefined
                && !invitationAdmission) {
                return reply.code(400).send({ error: "invalid-step-up-request" });
            }
            if (stepUp) {
                const [linkedIdentity, account] =
                    await Promise.all([
                        db.accountIdentity.findFirst({
                            where: {
                                accountId: request.userId,
                                provider: "mtls",
                                providerUserId:
                                    identity.providerUserId,
                            },
                            select: { id: true },
                        }),
                        db.account.findUnique({
                            where: { id: request.userId },
                            select: {
                                publicKey: true,
                                encryptionMode: true,
                                contentPublicKey: true,
                                contentPublicKeySig: true,
                            },
                        }),
                    ]);
                if (
                    !linkedIdentity
                    || !account
                    || !isTrulyKeylessPlainAccountRow(
                        account,
                    )
                    || !await isEffectiveHomeAuthMethodActionEnabled({
                        env: requestHomeEnv,
                        methodId: "mtls",
                        actionId: "login",
                        mode: "keyless",
                    })
                ) {
                    return reply
                        .code(403)
                        .send({ error: "not-eligible" });
                }
                const pending = await createMtlsClaimCode({
                    userId: request.userId,
                    ttlMs: mtlsEnv.claimTtlSeconds * 1000,
                    stepUp: {
                        purpose: stepUp.purpose,
                        providerUserId:
                            identity.providerUserId,
                        proofHash: stepUp.proofHash,
                        requestDigest:
                            stepUp.requestDigest,
                    },
                });
                return reply.send({
                    success: true,
                    pending,
                });
            }

            try {
                const finalized = await inTx(async (tx) => {
                    const invitation = invitationAdmission
                        ? await resolveTeamInvitationFreshAccountAdmissionReferenceInTx(tx, invitationAdmission)
                        : null;
                    if (invitationAdmission && !invitation) throw new MtlsFinalizationAbort("not-eligible");
                    return await finalizeMtlsAuthenticationInTx(tx, {
                        identity,
                        requestIp: request.ip,
                        ...(invitation ? { team: { teamId: invitation.teamId, invitation } } : {}),
                    });
                }, { isolationLevel: "Serializable" /* mTLS finalization composes Account creation/currentness with invitation and Team-policy admission. */ });
                return reply.send({
                    success: true,
                    token: finalized.token,
                });
            } catch (error) {
                if (error instanceof TeamInvitationFreshAccountAdmissionAbort) {
                    return reply.code(403).send({ error: "not-eligible" });
                }
                if (!(error instanceof MtlsFinalizationAbort)) throw error;
                if (error.code === "restore-required") return reply.code(409).send({ error: "restore-required" });
                if (error.code === "account-disabled") return reply.code(403).send({ error: "account-disabled" });
                if (error.code === "e2ee-required") return reply.code(403).send({ error: "e2ee-required" });
                return reply.code(403).send({ error: "not-eligible" });
            }
        },
    );

    app.post(
        "/v1/auth/mtls/claim",
        {
            errorHandler: accountDirectoryAuthErrorHandler,
            schema: {
                body: z.strictObject({ code: z.string(), admissionReference: z.optional(z.string()) }),
                response: {
                    200: z.strictObject({
                        success: z.literal(true),
                        token: z.string(),
                        teamId: z.optional(z.string()),
                        teamInvitationContinuation: z.optional(TeamInvitationPostAuthContinuationV1Schema),
                    }),
                    401: z.object({ error: z.literal("invalid-code") }),
                    403: z.object({ error: z.union([z.literal("account-disabled"), z.literal("e2ee-required")]) }),
                    409: z.object({ error: z.literal("restore-required") }),
                },
            },
        },
        async (request, reply) => {
            const body = request.body as { code?: unknown; admissionReference?: unknown } | undefined;
            const code = String(body?.code ?? "");
            const admissionReference = typeof body?.admissionReference === "string"
                ? body.admissionReference
                : undefined;
            try {
                const finalized = await inTx(async (tx) => {
                    const acquired = await acquireMtlsAuthenticationClaimInTx(tx, { code, admissionReference });
                    if (!acquired) throw new MtlsFinalizationAbort("invalid-code");
                    const team = acquired.claim.team;
                    return await finalizeMtlsAuthenticationInTx(tx, {
                        identity: acquired.claim.identity,
                        requestIp: request.ip,
                        claim: acquired,
                        ...(team ? {
                            team: {
                                teamId: team.teamId,
                                ...(team.invitation ? { invitation: team.invitation } : {}),
                            },
                        } : {}),
                    });
                }, { isolationLevel: "Serializable" /* mTLS claim consumption, Account currentness and Team admission form one finalization. */ });
                return reply.send({
                    success: true,
                    token: finalized.token,
                    ...(finalized.teamId ? { teamId: finalized.teamId } : {}),
                    ...(finalized.teamInvitationContinuation
                        ? { teamInvitationContinuation: finalized.teamInvitationContinuation }
                        : {}),
                });
            } catch (error) {
                if (error instanceof TeamInvitationFreshAccountAdmissionAbort) {
                    return reply.code(401).send({ error: "invalid-code" });
                }
                if (!(error instanceof MtlsFinalizationAbort)) throw error;
                if (error.code === "restore-required") return reply.code(409).send({ error: "restore-required" });
                if (error.code === "account-disabled") return reply.code(403).send({ error: "account-disabled" });
                if (error.code === "e2ee-required") return reply.code(403).send({ error: "e2ee-required" });
                return reply.code(401).send({ error: "invalid-code" });
            }
        },
    );
}
