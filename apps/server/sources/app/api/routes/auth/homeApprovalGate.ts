import { randomBytes } from "node:crypto";
import { HOME_LOGIN_APPROVALS_HTTP_PATH_V1, HOME_LOGIN_APPROVAL_DECISION_HTTP_PATH_V1, HomeDeviceApprovalDecisionRequestV1Schema, HomeDeviceApprovalDecisionResponseV1Schema, HomeDeviceApprovalListV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { resolveHomeDeviceApprovalRequiredFromEnv } from "@happier-dev/cli-common/firstPartyRuntime/personalHome/configuration";
import { z } from "zod/mini";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { assertAccountActive, InactiveAccountError } from "@/app/auth/accountStatus";
import { acquireAccountSessionOwnerMetadataFenceInTx, AccountSessionOwnerMetadataFenceAccountNotFoundError } from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Fastify } from "../../types";
import { requirePresentUser, PresentUserRequiredResponseSchema } from "@/app/api/utils/requirePresentUser";
import { resolvePairingAuthPolicyFromEnv } from "./pairingAuthPolicy";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { recordAuthEnrollmentOutcome } from "@/app/monitoring/metrics/authMetrics";
import { cleanupExpiredAuthPairingSessions } from "@/app/retention/rules/authPairingSessionRetentionRule";
import type { HomeApprovalGate } from "@/app/auth/homeApprovalGateContract";

export type { HomeApprovalGate } from "@/app/auth/homeApprovalGateContract";

/** Home-local approval gate. It stores pending state in the existing pairing-session owner. */
export function createHomeApprovalGate(env: NodeJS.ProcessEnv = process.env): HomeApprovalGate {
    const policy = resolvePairingAuthPolicyFromEnv(env);
    return {
        async evaluate(input) {
            if (!resolveHomeDeviceApprovalRequiredFromEnv(env)) return { kind: "allowed" };
            const now = new Date();
            const assertionExpiresAtMs = input.assertionExpiresAtMs ?? Number.MAX_SAFE_INTEGER;
            if (!Number.isSafeInteger(assertionExpiresAtMs) || assertionExpiresAtMs <= now.getTime()) {
                return { kind: "expired" };
            }
            if (input.approvalId) {
                const row = await db.authPairingSession.findUnique({ where: { id: input.approvalId } });
                if (!row) {
                    recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "wrong_target" });
                    return { kind: "invalid" };
                }
                if (row.accountId !== input.accountId) {
                    recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "wrong_target" });
                    return { kind: "invalid" };
                }
                if (row.flow !== "account_assertion") {
                    recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "wrong_binding" });
                    return { kind: "invalid" };
                }
                if (
                    row.requestedPublicKey !== input.requesterBoxPublicKeyBase64
                    || row.requestedBindingProof !== input.approvalBindingProof
                    || row.requesterIssuerServerIdentityId !== input.issuerServerIdentityId
                    || row.requesterIssuerSubjectId !== input.issuerSubjectId
                ) {
                    recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "wrong_binding" });
                    return { kind: "invalid" };
                }
                if (row.expiresAt <= now || assertionExpiresAtMs <= now.getTime()) {
                    recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "expired" });
                    return { kind: "expired" };
                }
                if (row.approvalStatus === "pending") {
                    return {
                        kind: "approval_required",
                        request: {
                            approvalId: row.id,
                            deviceLabel: row.requestedDeviceLabel ?? null,
                            expiresAtMs: row.expiresAt.getTime(),
                        },
                    };
                }
                if (row.approvalStatus === "rejected") {
                    recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "rejected" });
                    return { kind: "rejected" };
                }
                if (row.approvalStatus !== "approved") {
                    recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "wrong_binding" });
                    return { kind: "invalid" };
                }
                return {
                    kind: "allowed",
                    approvedRequest: {
                        approvalId: row.id,
                        bindingProof: input.approvalBindingProof,
                    },
                };
            }

            await cleanupExpiredAuthPairingSessions({
                now,
                accountId: input.accountId,
                flow: "account_assertion",
            }).catch(() => {});
            return inTx(async (tx) => {
                const existing = await tx.authPairingSession.findFirst({
                    where: {
                        accountId: input.accountId,
                        flow: "account_assertion",
                        approvalStatus: "pending",
                        expiresAt: { gt: now },
                        requestedPublicKey: input.requesterBoxPublicKeyBase64,
                        requestedBindingProof: input.approvalBindingProof,
                        requesterIssuerServerIdentityId: input.issuerServerIdentityId,
                        requesterIssuerSubjectId: input.issuerSubjectId,
                    },
                    orderBy: { createdAt: "desc" },
                });
                if (existing) {
                    const effectiveExpiresAtMs = Math.min(existing.expiresAt.getTime(), assertionExpiresAtMs);
                    if (effectiveExpiresAtMs < existing.expiresAt.getTime()) {
                        const shortened = await tx.authPairingSession.updateMany({
                            where: { id: existing.id, approvalStatus: "pending", expiresAt: existing.expiresAt },
                            data: { expiresAt: new Date(effectiveExpiresAtMs) },
                        });
                        if (shortened.count > 0) await markAccountChanged(tx, {
                            accountId: input.accountId, kind: 'account', entityId: HOME_LOGIN_APPROVALS_HTTP_PATH_V1,
                        });
                    }
                    return {
                        kind: "approval_required" as const,
                        request: {
                            approvalId: existing.id,
                            deviceLabel: existing.requestedDeviceLabel ?? null,
                            expiresAtMs: effectiveExpiresAtMs,
                        },
                    };
                }

                const expiresAt = new Date(Math.min(
                    now.getTime() + policy.ttlMs,
                    assertionExpiresAtMs,
                ));
                const row = await tx.authPairingSession.create({
                    data: {
                        accountId: input.accountId,
                        secretHash: randomBytes(32).toString("base64url"),
                        requestedPublicKey: input.requesterBoxPublicKeyBase64,
                        requestedBindingProof: input.approvalBindingProof,
                        requestedDeviceLabel: input.deviceLabel,
                        requestedAt: now,
                        expiresAt,
                        flow: "account_assertion",
                        requesterIssuerServerIdentityId: input.issuerServerIdentityId,
                        requesterIssuerSubjectId: input.issuerSubjectId,
                        approvalStatus: "pending",
                    },
                    select: { id: true, expiresAt: true, requestedDeviceLabel: true },
                });
                // Invalidate the exact Account's reconstructible approval list after commit.
                // The wake carries no requester key, device label, or approval binding.
                await markAccountChanged(tx, {
                    accountId: input.accountId, kind: 'account', entityId: HOME_LOGIN_APPROVALS_HTTP_PATH_V1,
                });
                return {
                    kind: "approval_required" as const,
                    request: {
                        approvalId: row.id,
                        deviceLabel: row.requestedDeviceLabel ?? null,
                        expiresAtMs: row.expiresAt.getTime(),
                    },
                };
            }, { isolationLevel: "Serializable" /* Matching approval binding lookup and random pairing-row creation must deduplicate together. */ });
        },
    };
}

const ApprovalIdParamsSchema = z.strictObject({ approvalId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) });
const ApprovalNotFoundResponseSchema = z.strictObject({ error: z.literal("not_found") });
/** Authenticated Home-owner approval handlers for the existing pairing owner. */
export function registerHomeLoginApprovalRoutes(app: Fastify): void {
    app.get(HOME_LOGIN_APPROVALS_HTTP_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.homeApproval.list") },
        preHandler: [app.authenticate, requirePresentUser],
        schema: { response: { 200: HomeDeviceApprovalListV1Schema, 403: PresentUserRequiredResponseSchema } },
    }, async (request, reply) => {
        const now = new Date();
        const rows = await db.authPairingSession.findMany({
            where: {
                accountId: request.userId,
                flow: "account_assertion",
                approvalStatus: "pending",
                expiresAt: { gt: now },
                requestedPublicKey: { not: null },
                requestedBindingProof: { not: null },
                requesterIssuerServerIdentityId: { not: null },
                requesterIssuerSubjectId: { not: null },
            },
            orderBy: { createdAt: "asc" },
        });
        return reply.send(rows.flatMap((row) => {
            if (
                typeof row.requestedPublicKey !== "string"
                || typeof row.requesterIssuerServerIdentityId !== "string"
                || typeof row.requesterIssuerSubjectId !== "string"
            ) return [];
            return [{
                approvalId: row.id,
                accountId: row.accountId,
                flow: "account_assertion" as const,
                requesterBoxPublicKeyBase64: row.requestedPublicKey,
                issuerServerIdentityId: row.requesterIssuerServerIdentityId,
                issuerSubjectId: row.requesterIssuerSubjectId,
                deviceLabel: row.requestedDeviceLabel ?? null,
                status: "pending" as const,
                expiresAtMs: row.expiresAt.getTime(),
                decidedAtMs: null,
            }];
        }));
    });
    app.post(HOME_LOGIN_APPROVAL_DECISION_HTTP_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.homeApproval.decision") },
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: ApprovalIdParamsSchema,
            body: HomeDeviceApprovalDecisionRequestV1Schema,
            response: { 200: HomeDeviceApprovalDecisionResponseV1Schema, 403: PresentUserRequiredResponseSchema, 404: ApprovalNotFoundResponseSchema },
        },
    }, async (request, reply) => {
        const approvalId = request.params.approvalId;
        const status = request.body.decision === "approve" ? "approved" : "rejected";
        const outcome = await inTx(async (tx) => {
            try {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, request.userId, "content");
            } catch (error) {
                if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) throw new InactiveAccountError();
                throw error;
            }
            const account = await tx.account.findUnique({ where: { id: request.userId }, select: { status: true } });
            if (!account) throw new InactiveAccountError();
            assertAccountActive(account.status);
            const now = new Date();
            const transition = await tx.authPairingSession.updateMany({
                where: {
                    id: approvalId,
                    accountId: request.userId,
                    flow: "account_assertion",
                    approvalStatus: "pending",
                    expiresAt: { gt: now },
                },
                data: { approvalStatus: status, decidedAt: now },
            });
            if (transition.count === 1) {
                await markAccountChanged(tx, {
                    accountId: request.userId, kind: 'account', entityId: HOME_LOGIN_APPROVALS_HTTP_PATH_V1,
                });
                return status;
            }
            const existing = await tx.authPairingSession.findFirst({
                where: { id: approvalId, accountId: request.userId, flow: "account_assertion", expiresAt: { gt: now } },
                select: { approvalStatus: true },
            });
            return existing?.approvalStatus === "approved" || existing?.approvalStatus === "rejected"
                ? "already_decided" as const : "not_found" as const;
        });
        if (outcome !== "not_found") {
            if (outcome === "rejected") {
                recordAuthEnrollmentOutcome({ flow: "home_approval", outcome: "rejected" });
            }
            return reply.send({ status: outcome });
        }
        return reply.code(404).send({ error: "not_found" });
    });
}
