import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { setSessionPin } from "./organizationMutations";
import { reorderSessionPins } from "./organizationOrdering";

const PLUS = {
    id: "plus",
    name: "Happier Plus",
    limits: { sessionRetentionDays: 365, subagentRetentionDays: 30, toolOutputRetentionDays: null, pinnedSessions: 3, artifactStorageBytes: null },
    prices: [],
};

describe("session pin limit follows the Account's plan", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-pin-limit-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    beforeEach(() => {
        harness.resetEnv();
        process.env.HAPPIER_SESSION_PINS__MAX = "2";
        process.env.HAPPIER_PLANS__CONFIG = JSON.stringify({ v: 1, graceDays: 90, plans: [PLUS], teams: null, supporter: null });
    });

    afterAll(async () => {
        await harness.close();
    });

    async function createAccountWithSessions(count: number, plan: string | null = null) {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, plan, planEndsAt: plan ? new Date(Date.now() + 86_400_000) : null },
            select: { id: true },
        });
        const sessions = [];
        for (let index = 0; index < count; index++) {
            sessions.push(await db.session.create({
                data: { accountId: account.id, tag: `s-${randomUUID()}`, metadata: "{}", metadataVersion: 0, agentState: null, agentStateVersion: 0 },
                select: { id: true },
            }));
        }
        return { accountId: account.id, sessionIds: sessions.map((session) => session.id) };
    }

    it("refuses a new pin past the base limit with the limit, keeps re-pins and unpins working", async () => {
        const { accountId, sessionIds } = await createAccountWithSessions(3);
        const pin = (sessionId: string, pinned = true) => setSessionPin({ accountId, sessionId, request: { pinned } });

        expect(await pin(sessionIds[0]!)).toHaveProperty("pin");
        expect(await pin(sessionIds[1]!)).toHaveProperty("pin");
        expect(await pin(sessionIds[2]!)).toEqual({ error: "session-pin-limit-exceeded", limit: 2 });
        // Re-pinning an already pinned session at the limit is not a new pin.
        expect(await pin(sessionIds[1]!)).toHaveProperty("pin");
        expect(await pin(sessionIds[0]!, false)).toEqual({ pin: null });
        expect(await pin(sessionIds[2]!)).toHaveProperty("pin");
    });

    it("a live plan raises the limit and its reorder path obeys the same limit", async () => {
        const { accountId, sessionIds } = await createAccountWithSessions(4, "plus");
        for (const sessionId of sessionIds.slice(0, 3)) {
            expect(await setSessionPin({ accountId, sessionId, request: { pinned: true } })).toHaveProperty("pin");
        }
        expect(await setSessionPin({ accountId, sessionId: sessionIds[3]!, request: { pinned: true } }))
            .toEqual({ error: "session-pin-limit-exceeded", limit: 3 });
        expect(await reorderSessionPins({
            accountId,
            request: {
                scopeKind: "pinned",
                scopeKey: "root",
                entries: sessionIds.map((sessionId, index) => ({ itemKind: "session" as const, itemKey: sessionId, sortKey: `a${index}` })),
            },
        })).toEqual({ error: "session-pin-limit-exceeded", limit: 3 });
    });

    it("existing pins above a lowered limit stay pinned", async () => {
        const { accountId, sessionIds } = await createAccountWithSessions(3);
        process.env.HAPPIER_SESSION_PINS__MAX = "5";
        for (const sessionId of sessionIds) {
            await setSessionPin({ accountId, sessionId, request: { pinned: true } });
        }
        process.env.HAPPIER_SESSION_PINS__MAX = "1";
        expect(await db.sessionPin.count({ where: { accountId } })).toBe(3);
        expect(await setSessionPin({ accountId, sessionId: sessionIds[0]!, request: { pinned: true } })).toHaveProperty("pin");
    });
});
