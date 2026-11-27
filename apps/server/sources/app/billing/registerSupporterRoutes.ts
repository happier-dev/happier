import {
    AccountSupporterPutRequestV1Schema,
    AccountSupporterResponseV1Schema,
    SupporterLookupRequestV1Schema,
    SupporterLookupResponseV1Schema,
} from "@happier-dev/protocol";
import { z } from "zod/mini";

import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { markAccountChangedForPlanInTx, writeAccountPlanStateInTx } from "@/app/plans/accountPlanState";
import { readProvenSupporterRecord, SUPPORTER_PROFILE_SELECT, toSupporterProfile } from "@/app/supporter/supporterPerks";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import { isActiveSupporterRecord, SUPPORTER_RECORD_SELECT, toSupporterFactsV1, writeAccountSupporterRecordInTx } from "./supporterRecords";

/**
 * Supporter identity routes (plan 03 M9, M10). Proof rule: a session for the Account's own record,
 * or the random code in a request body (never a URL, since request URLs are logged).
 */
export function registerSupporterRoutes(app: Fastify, params: Readonly<{ billingConfigured: boolean }>): void {
    const gated = createServerFeatureGatedRouteApp(app, "supporter");

    // The session's own record, with its code (the app carries it to another server). Not an Action.
    gated.get("/v1/account/supporter", {
        preHandler: app.authenticate,
        schema: { response: { 200: AccountSupporterResponseV1Schema } },
    }, async (request, reply) => {
        const record = await db.supporterRecord.findUnique({
            where: { accountId: request.userId },
            select: { ...SUPPORTER_RECORD_SELECT, ...SUPPORTER_PROFILE_SELECT },
        });
        return reply.send({ record: record ? {
            ...toSupporterFactsV1(record),
            code: record.code,
            ...(params.billingConfigured ? toSupporterProfile(record) : {}),
        } : null });
    });

    // Self-hosted only: the app stores a minted code, then the facts Happier Cloud's lookup returned.
    // Refused where billing is configured, so nobody can claim a number on Cloud.
    gated.put("/v1/account/supporter", {
        preHandler: app.authenticate,
        schema: {
            body: AccountSupporterPutRequestV1Schema,
            response: {
                200: AccountSupporterResponseV1Schema,
                403: z.object({ error: z.literal("billing_configured") }),
                409: z.object({ error: z.literal("supporter_record_conflict") }),
            },
        },
    }, async (request, reply) => {
        if (params.billingConfigured) return reply.code(403).send({ error: "billing_configured" });
        const body = request.body as z.infer<typeof AccountSupporterPutRequestV1Schema>;
        try {
            await inTx(async (tx) => {
                const { changed } = await writeAccountSupporterRecordInTx(tx, {
                    accountId: request.userId,
                    code: body.code,
                    facts: body.facts ?? null,
                });
                if (changed) await markAccountChangedForPlanInTx(tx, request.userId);
            });
        } catch (error) {
            // Another Account on this server already holds this code or number.
            if (isPrismaErrorCode(error, "P2002")) return reply.code(409).send({ error: "supporter_record_conflict" });
            throw error;
        }
        const record = await db.supporterRecord.findUnique({ where: { accountId: request.userId }, select: SUPPORTER_RECORD_SELECT });
        return reply.send({ record: record ? { ...toSupporterFactsV1(record), code: record.code } : null });
    });

    // `supporter.ring.set`: the person's own consent to show the ring to others. Only their own
    // session writes true (a purchase never does, so a gift marks nobody), and only while a supporter.
    gated.put("/v1/account/supporter/ring", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({ visible: z.boolean() }),
            response: {
                200: z.object({ visible: z.boolean() }),
                409: z.object({ error: z.literal("not_a_supporter") }),
            },
        },
    }, async (request, reply) => {
        const { visible } = request.body as { visible: boolean };
        const result = await inTx(async (tx) => {
            if (visible) {
                const record = await tx.supporterRecord.findUnique({ where: { accountId: request.userId }, select: { number: true, revokedAt: true } });
                if (!isActiveSupporterRecord(record)) return "not_a_supporter" as const;
            }
            await writeAccountPlanStateInTx(tx, request.userId, { supporterRing: visible });
            return "ok" as const;
        });
        if (result === "not_a_supporter") return reply.code(409).send({ error: "not_a_supporter" });
        return reply.send({ visible });
    });

    if (!params.billingConfigured) return;

    // Happier Cloud: a detached record's code is its bearer. Attached records use the session GET.
    app.post("/v1/supporter/lookup", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "supporter.lookup") },
        schema: {
            body: SupporterLookupRequestV1Schema,
            response: {
                200: SupporterLookupResponseV1Schema,
                404: z.object({ error: z.literal("not_found") }),
            },
        },
    }, async (request, reply) => {
        const { code } = request.body as z.infer<typeof SupporterLookupRequestV1Schema>;
        const result = await readProvenSupporterRecord(db, { kind: "code", code });
        if (result.status === "refused" || !result.record) return reply.code(404).send({ error: "not_found" });
        return reply.send({ ...toSupporterFactsV1(result.record), ...toSupporterProfile(result.record) });
    });
}
