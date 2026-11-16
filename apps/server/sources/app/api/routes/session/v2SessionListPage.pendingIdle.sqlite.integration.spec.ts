import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerSessionListingRoutes } from "./registerSessionListingRoutes";
import { findV2SessionListRowById, findV2SessionListRows, V2_SESSION_LIST_ORDER_BY } from "./v2SessionListPage";
import { mapV2SessionListRow } from "./v2SessionListRows";

describe("session detail pending idleness evidence (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-pending-idle-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterAll(async () => {
        await harness?.close();
    });

    it("separates proven no-effect blocks from uncertain delivery without widening lists", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() }, select: { id: true } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: randomUUID(), metadata: "{}", pendingCount: 8, pendingBlockedCount: 7, pendingVersion: 4 },
            select: { id: true },
        });
        const blockedReasons = [
            "runtime_disposed_before_delivery", "invalid_prompt_text", "ambiguous_terminal_delivery",
            "delivery_outcome_uncertain", "unknown", "future_unrecognized_reason", null,
        ];
        await db.sessionPendingMessage.createMany({
            data: [
                ...blockedReasons.map((reason, position) => ({
                    sessionId: session.id, localId: randomUUID(), position, content: { t: "plain" as const, v: "prompt" },
                    requestedAction: { v: 1 as const, kind: "enqueue" as const }, deliveryState: "blocked", deliveryBlockedReason: reason,
                })),
                { sessionId: session.id, localId: randomUUID(), position: 7, content: { t: "plain", v: "queued" }, requestedAction: { v: 1, kind: "enqueue" } },
                { sessionId: session.id, localId: randomUUID(), position: 8, content: { t: "plain", v: "discarded" }, requestedAction: { v: 1, kind: "enqueue" }, status: "discarded", deliveryState: "blocked", deliveryBlockedReason: "invalid_prompt_text" },
            ],
        });

        const row = await findV2SessionListRowById({ userId: account.id, sessionId: session.id });
        expect(row).not.toBeNull();
        const detail = mapV2SessionListRow({ row: row!, userId: account.id });
        expect(detail).toMatchObject({ pendingCount: 8, pendingBlockedCount: 7, pendingBlockedNoEffectCount: 2, pendingVersion: 4 });

        const { PrismaClient } = await import("../../../../../generated/sqlite-client/index.js");
        const queryClient = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        const statements: Array<{ query: string; params: string }> = [];
        queryClient.$on("query", (event) => statements.push({ query: event.query, params: event.params }));
        const findFirst = db.session.findFirst;
        // Provider boundary: the generic DB facade types PostgreSQL; this real SQLite client adds SQL logging.
        db.session.findFirst = queryClient.session.findFirst.bind(queryClient.session) as unknown as typeof db.session.findFirst;
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerSessionListingRoutes(app);
        try {
            const token = await auth.createToken(account.id);
            const response = await app.inject({
                method: "GET",
                url: `/v2/sessions/${session.id}`,
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ session: {
                pendingCount: 8, pendingBlockedCount: 7, pendingBlockedNoEffectCount: 2, pendingVersion: 4,
            } });
            const pendingStatements = statements.filter((statement) => statement.query.includes("SessionPendingMessage"));
            expect(pendingStatements).toHaveLength(1);
            const pendingStatement = pendingStatements[0];
            expect(pendingStatement.query).toContain("pendingCount");
            expect(pendingStatement.query).toMatch(/COUNT\(/i);
            const queryPlan = await queryClient.$queryRawUnsafe<Array<{ detail: string }>>(
                `EXPLAIN QUERY PLAN ${pendingStatement.query}`,
                ...JSON.parse(pendingStatement.params) as unknown[],
            );
            expect(queryPlan.filter((row) => /SCAN (?:main\.)?SessionPendingMessage\b/i.test(row.detail))).toEqual([]);
        } finally {
            db.session.findFirst = findFirst;
            await app.close();
            await queryClient.$disconnect();
        }

        const rows = await findV2SessionListRows({ userId: account.id, orderBy: V2_SESSION_LIST_ORDER_BY });
        expect(rows).toHaveLength(1);
        expect(mapV2SessionListRow({ row: rows[0], userId: account.id })).not.toHaveProperty("pendingBlockedNoEffectCount");
    });
});
