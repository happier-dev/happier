import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";

describe("session message reads over authenticated HTTP and SQLite", () => {
    let harness: LightSqliteHarness;
    let origin: string;
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-turn-projection-",
            initAuth: true,
        });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerSessionMessageRoutes(app);
        origin = await app.listen({ host: "127.0.0.1", port: 0 });
    }, 180_000);

    afterAll(async () => {
        await app.close();
        await harness?.close();
    });

    it("hydrates only the selected rows and pages by prompts without losing tool or legacy turns", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: randomUUID(), metadata: "{}" },
        });
        const roles = [null, "agent", "event", "user", "tool", "agent", "user", "agent"];
        await db.sessionMessage.createMany({
            data: roles.map((messageRole, index) => ({
                id: randomUUID(), sessionId: session.id, seq: index + 1, messageRole,
                content: { t: "encrypted", c: `ciphertext-${index + 1}` },
            })),
        });
        const token = await auth.createToken(account.id);
        const page = async (beforeSeq?: number) => {
            const response = await fetch(`${origin}/v1/sessions/${session.id}/messages?scope=main&projection=turns&limit=1${beforeSeq === undefined ? "" : `&beforeSeq=${beforeSeq}`}`, {
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.status).toBe(200);
            return response.json() as Promise<{
                messages: Array<{ seq: number; content: unknown; messageRole?: string }>;
                hasMore: boolean;
                nextBeforeSeq: number | null;
                nextAfterSeq: number | null;
            }>;
        };
        const newest = await page();
        expect(newest.messages.map((row) => row.seq)).toEqual([8, 7]);
        expect(newest).toMatchObject({ hasMore: true, nextBeforeSeq: 7, nextAfterSeq: null });
        const middle = await page(7);
        expect(middle.messages.map((row) => row.seq)).toEqual([6, 5, 4]);
        expect(middle).toMatchObject({ hasMore: true, nextBeforeSeq: 4 });
        const oldest = await page(4);
        expect(oldest.messages.map((row) => row.seq)).toEqual([2, 1]);
        expect(oldest).toMatchObject({ hasMore: false, nextBeforeSeq: null });
        expect(oldest.messages[1]).not.toHaveProperty("messageRole");
        expect(oldest.messages[0].content).toEqual({ t: "encrypted", c: "ciphertext-2" });
    });

    it("looks up exact presence across the SQLite bind limit without exposing another session", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const otherAccount = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: randomUUID(), metadata: "{}" },
        });
        const otherSession = await db.session.create({
            data: { accountId: otherAccount.id, tag: randomUUID(), metadata: "{}" },
        });
        await db.sessionMessage.createMany({
            data: [
                { sessionId: session.id, localId: "present-first" },
                { sessionId: session.id, localId: "present-last" },
                { sessionId: otherSession.id, localId: "elsewhere" },
            ].map((row, index) => ({
                ...row, id: randomUUID(), seq: index + 1,
                content: { t: "encrypted", c: "ciphertext" },
            })),
        });
        const absentLocalIds = ["elsewhere", ...Array.from({ length: 1_000 }, (_, index) => `absent-${index}`)];
        const token = await auth.createToken(account.id);
        const otherToken = await auth.createToken(otherAccount.id);
        const lookup = (requestToken: string, localIds: string[]) => fetch(
            `${origin}/v2/sessions/${session.id}/messages/by-local-id`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${requestToken}`, "content-type": "application/json" },
                body: JSON.stringify({ localIds }),
            },
        );

        const response = await lookup(token, ["present-first", ...absentLocalIds, "present-last"]);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ absentLocalIds });

        const inaccessible = await lookup(otherToken, ["present-first"]);
        expect(inaccessible.status).toBe(404);
        await expect(inaccessible.json()).resolves.toEqual({ error: "Session not found" });
    });
});
