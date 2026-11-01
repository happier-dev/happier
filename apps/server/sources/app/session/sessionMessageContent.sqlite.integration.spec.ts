import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSessionMessage } from "./sessionWriteService";
import { enqueuePendingMessage, updatePendingMessage } from "./pending/pendingMessageService";

// Real ingress, transactions and DB: sanitization must precede local-id reconciliation,
// not just the final INSERT, or retrying an imported message will conflict forever.
describe("session message content storage", () => {
    let harness: LightSqliteHarness;
    const postgres = new PGlite();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-message-content-",
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" },
        });
    });
    afterAll(async () => { await harness?.close(); await postgres.close(); });

    async function seed() {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" },
        });
        return { actorUserId: owner.id, sessionId: session.id };
    }

    const content = {
        t: "plain",
        v: { role: "agent", content: [{ type: "tool_result", content: "before\u0000after\n\\u0000\t😀" }] },
    } satisfies PrismaJson.SessionMessageContent;
    const expected = {
        t: "plain",
        v: { role: "agent", content: [{ type: "tool_result", content: "beforeafter\n\\u0000\t😀" }] },
    };

    it("normalizes imported content before create, strict retry and replacement", async () => {
        await expect(postgres.query("SELECT $1::jsonb AS content", [JSON.stringify(content)]))
            .rejects.toMatchObject({ code: "22P05" });
        const session = await seed();
        const params = { ...session, localId: "imported-output", content, localIdConflictPolicy: "identical-or-conflict" as const };
        const created = await createSessionMessage(params);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        expect(created.message.content).toEqual(expected);
        const roundTrip = await postgres.query<{ content: unknown }>("SELECT $1::jsonb AS content", [JSON.stringify(created.message.content)]);
        expect(roundTrip.rows[0].content).toEqual(expected);
        const retry = await createSessionMessage(params);
        expect(retry).toMatchObject({ ok: true, didWrite: false, didUpdate: false });
        const updated = await createSessionMessage({ ...session, localId: params.localId, content: { t: "plain", v: "updated\u0000output" } });
        expect(updated).toMatchObject({ ok: true, didUpdate: true, message: { content: { t: "plain", v: "updatedoutput" } } });
        expect((await db.sessionMessage.findFirstOrThrow({ where: { sessionId: session.sessionId } })).content)
            .toEqual({ t: "plain", v: "updatedoutput" });
        expect(content.v.content[0].content).toContain("\u0000");
    });

    it("uses the same normalization for pending admission, retry and editing", async () => {
        const session = await seed();
        const params = { ...session, localId: "pending-output", content, requestedAction: { v: 1 as const, kind: "enqueue" as const } };
        expect(await enqueuePendingMessage(params)).toMatchObject({ ok: true });
        expect((await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: session.sessionId } })).content).toEqual(expected);
        expect(await enqueuePendingMessage(params)).toMatchObject({ ok: true, didWrite: false });
        expect(await updatePendingMessage({ ...session, localId: params.localId, content: { t: "plain", v: "edited\u0000output" } })).toMatchObject({ ok: true });
        expect((await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: session.sessionId } })).content).toEqual({ t: "plain", v: "editedoutput" });
    });

});
