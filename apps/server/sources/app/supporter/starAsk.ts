import { z } from "zod";

import type { Fastify } from "@/app/api/types";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { mutateAccountScopedKvRowsInTx } from "@/app/kv/accountScopedKv";
import { ACCOUNT_SUPPORTER_ASKS_KV_KEY } from "@/app/kv/reservedAccountScopedKvRow";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

const askSchema = z.enum(["star", "supporter_prompt"]);
type Ask = z.infer<typeof askSchema>;
const closedSchema = z.array(askSchema);
const supporterPromptMinimumAgeMs = 10 * 86_400_000;

function readClosedAsks(row: { value: Uint8Array | null } | null): Ask[] {
    if (!row?.value) return [];
    return closedSchema.parse(JSON.parse(new TextDecoder().decode(row.value)));
}

async function readAskRow(tx: Tx, accountId: string) {
    return tx.userKVStore.findUnique({
        where: { accountId_key: { accountId, key: ACCOUNT_SUPPORTER_ASKS_KV_KEY } },
        select: { value: true, version: true },
    });
}

/** Eligibility is checked on demand after a quiet live turn. The two closes share one private row. */
async function readDueAsk(accountId: string, now: Date): Promise<Ask | null> {
    const closed = readClosedAsks(await readAskRow(db, accountId));
    if (closed.includes("supporter_prompt")) return null;
    if (!closed.includes("star")) {
        const completed = await db.sessionTurn.count({
            where: { status: "completed", session: { accountId } },
            take: 5,
        });
        return completed === 5 ? "star" : null;
    }
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: {
            createdAt: true,
            plan: true,
            planEndsAt: true,
            SupporterRecord: { select: { number: true, revokedAt: true } },
        },
    });
    if (!account || now.getTime() - account.createdAt.getTime() <= supporterPromptMinimumAgeMs) return null;
    if (account.plan && (!account.planEndsAt || account.planEndsAt > now)) return null;
    const record = account.SupporterRecord;
    if (record && (record.number !== null || record.revokedAt !== null)) return null;
    return "supporter_prompt";
}

/** Closes are monotonic. A retry or a repeat from another client does not publish a change. */
async function closeAsk(accountId: string, ask: Ask): Promise<void> {
    const write = () => inTx(async (tx) => {
        const row = await readAskRow(tx, accountId);
        const closed = readClosedAsks(row);
        if (closed.includes(ask)) return;
        // A prompt close always implies the prior star ask is closed.
        const value = new TextEncoder().encode(JSON.stringify(ask === "star" ? ["star"] : ["star", "supporter_prompt"]));
        const result = await mutateAccountScopedKvRowsInTx(tx, {
            accountId,
            mutations: [{ key: ACCOUNT_SUPPORTER_ASKS_KV_KEY, value, expectedVersion: row?.version ?? -1 }],
        });
        if (result.status !== "updated") throw new Error("Account ask close lost its transactional revision");
        await markAccountChanged(tx, { accountId, kind: "kv", entityId: "supporter-asks" });
    });
    try {
        await write();
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        await write();
    }
}

/** Both endpoints follow the Home's Supporter display setting, including on self-hosted Homes. */
export function registerStarAskRoutes(app: Fastify, env: NodeJS.ProcessEnv = process.env): void {
    const gated = createServerFeatureGatedRouteApp(app, "supporter", env);
    gated.get("/v1/account/asks", {
        preHandler: app.authenticate,
        schema: { response: { 200: z.object({ due: askSchema.nullable() }) } },
    }, async (request, reply) => reply.send({ due: await readDueAsk(request.userId, new Date()) }));
    gated.post("/v1/account/asks/close", {
        preHandler: app.authenticate,
        schema: { body: z.object({ ask: askSchema }), response: { 200: z.object({ ok: z.literal(true) }) } },
    }, async (request, reply) => {
        await closeAsk(request.userId, (request.body as { ask: Ask }).ask);
        return reply.send({ ok: true });
    });
}
