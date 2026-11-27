import { z } from "zod/mini";

import type { Fastify } from "@/app/api/types";
import { createServerFeatureGatedRouteApp, readHomeEffectiveEnv } from "@/app/features/catalog/serverFeatureGate";
import { decodeAccountScopedKvJson, encodeAccountScopedKvJson } from "@/app/kv/accountScopedKv";
import { applyUserKvMutationsInTx, UserKvMutationConflictError } from "@/app/kv/kvMutate";
import { resolveLimitTable } from "@/app/plans/accountLimits";
import { accountTierWhere } from "@/app/plans/accountPlanEntitlement";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

// Server-readable eligibility metadata under the Account KV reserved namespace.
const ACCOUNT_SUPPORTER_ASKS_KV_KEY = "@happier/account/supporter/asks/v1";
const askSchema = z.enum(["star", "supporter_prompt"]);
type Ask = z.infer<typeof askSchema>;
const closedSchema = z.array(askSchema);
const closeBodySchema = z.object({ ask: askSchema });
const supporterPromptMinimumAgeMs = 10 * 86_400_000;
const requiredCompletedTurns = 5;

function readClosedAsks(row: { value: Uint8Array | null } | null): Ask[] {
    return row?.value ? closedSchema.parse(decodeAccountScopedKvJson(row.value)) : [];
}

function readAskRow(tx: Tx, accountId: string) {
    return tx.userKVStore.findUnique({
        where: { accountId_key: { accountId, key: ACCOUNT_SUPPORTER_ASKS_KV_KEY } },
        select: { value: true, version: true },
    });
}

/** Only a live quiet moment requests eligibility. Once the last ask closes, the row settles the read. */
async function readDueAsk(accountId: string, now: Date, readEnv: () => Promise<NodeJS.ProcessEnv>): Promise<Ask | null> {
    const closed = readClosedAsks(await readAskRow(db, accountId));
    if (closed.includes("supporter_prompt")) return null;
    if (!closed.includes("star")) {
        const completed = await db.sessionTurn.count({
            where: { status: "completed", initiator: "user", session: { accountId } },
            take: requiredCompletedTurns,
        });
        return completed === requiredCompletedTurns ? "star" : null;
    }

    const table = resolveLimitTable(await readEnv());
    if (!table.ok) return null;
    const account = await db.account.findFirst({
        where: {
            ...accountTierWhere(null, table, now),
            id: accountId,
            createdAt: { lt: new Date(now.getTime() - supporterPromptMinimumAgeMs) },
        },
        select: { SupporterRecord: { select: { number: true, revokedAt: true } } },
    });
    if (!account) return null;
    const record = account.SupporterRecord;
    return record && (record.number !== null || record.revokedAt !== null) ? null : "supporter_prompt";
}

/** A close advances the shared row once. The prompt close also settles the star ask. */
async function closeAsk(accountId: string, ask: Ask): Promise<void> {
    const write = () => inTx(async (tx) => {
        const row = await readAskRow(tx, accountId);
        if (readClosedAsks(row).includes(ask)) return;

        const value = encodeAccountScopedKvJson(ask === "star" ? ["star"] : ["star", "supporter_prompt"]);
        if (value === null) throw new Error("Could not encode the account ask close");
        const result = await applyUserKvMutationsInTx(tx, { uid: accountId }, [{
            key: ACCOUNT_SUPPORTER_ASKS_KV_KEY,
            value,
            version: row?.version ?? -1,
        }]);
        if (!result.success) throw new UserKvMutationConflictError(accountId, ACCOUNT_SUPPORTER_ASKS_KV_KEY);
    });
    try {
        await write();
    } catch (error) {
        if (!(error instanceof UserKvMutationConflictError)) throw error;
        // Once the peer has closed an ask, only one monotonic transition can remain.
        await write();
    }
}

/** Both operations follow the authenticated Account's Home Supporter feature. */
export function registerStarAskRoutes(app: Fastify, env: NodeJS.ProcessEnv = process.env): void {
    const gated = createServerFeatureGatedRouteApp(app, "supporter", env);
    gated.get("/v1/account/asks", {
        preHandler: app.authenticate,
        schema: { response: { 200: z.object({ due: z.nullable(askSchema) }) } },
    }, async (request, reply) => {
        const due = await readDueAsk(request.userId, new Date(), () => readHomeEffectiveEnv({ env, request }));
        return reply.send({ due });
    });
    gated.post("/v1/account/asks/close", {
        preHandler: app.authenticate,
        schema: { body: closeBodySchema, response: { 200: z.object({ ok: z.literal(true) }) } },
    }, async (request, reply) => {
        await closeAsk(request.userId, (request.body as z.infer<typeof closeBodySchema>).ask);
        return reply.send({ ok: true });
    });
}
