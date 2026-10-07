import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionArchiveRoutes } from "@/app/api/routes/session/registerSessionArchiveRoutes";
import { registerPublicShareOwnerRoutes } from "@/app/api/routes/share/registerPublicShareOwnerRoutes";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { enqueuePendingMessage, markPendingActivationFailed } from "./pendingMessageService";

const authentication = createPresentUserSessionAccessAuthentication();

describe("Session mutation transaction authority (SQLite)", () => {
    let harness: LightSqliteHarness;
    let restoreTransaction: (() => void) | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-session-mutation-authority-" });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    afterEach(() => { restoreTransaction?.(); restoreTransaction = undefined; });

    // Interpose only at the real database transaction boundary; the transaction,
    // authorization, domain logic, and persisted rows all remain real.
    function beforeNextTransaction(change: () => Promise<unknown>) {
        const original = db.$transaction;
        restoreTransaction = () => { db.$transaction = original; };
        db.$transaction = new Proxy(original, {
            async apply(target, thisArg, args) {
                restoreTransaction?.();
                await change();
                return Reflect.apply(target, thisArg, args);
            },
        });
    }

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const editor = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", active: false, currentStorageState: "hosted" },
        });
        const share = await db.sessionShare.create({
            data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: editor.id, accessLevel: "admin" },
        });
        return { owner, editor, session, share };
    }

    it.each(["archive", "unarchive"] as const)("denies %s after the admin grant is revoked before transaction entry", async (operation) => {
        const { editor, session, share } = await fixture();
        const archivedAt = operation === "unarchive" ? new Date(1000) : null;
        await db.session.update({ where: { id: session.id }, data: { archivedAt } });
        beforeNextTransaction(() => db.sessionShare.delete({ where: { id: share.id } }));
        await withAuthenticatedTestApp(registerSessionArchiveRoutes, async (app) => {
            // Match the JSON object sent by the canonical archive HTTP caller.
            const response = await app.inject({ method: "POST", url: `/v2/sessions/${session.id}/${operation}`, headers: { "x-test-user-id": editor.id }, payload: {} });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "Forbidden" });
        });
        expect(await db.sessionShare.count({ where: { id: share.id } })).toBe(0);
        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).archivedAt).toEqual(archivedAt);
    });

    it("denies pending enqueue after the editor grant is revoked before transaction entry", async () => {
        const { editor, session, share } = await fixture();
        beforeNextTransaction(() => db.sessionShare.delete({ where: { id: share.id } }));
        expect(await enqueuePendingMessage({ actorUserId: editor.id, sessionId: session.id, localId: randomUUID(), ciphertext: "cipher", requestedAction: { v: 1, kind: "enqueue" }, authentication })).toEqual({ ok: false, error: "session-not-found" });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it("returns unavailable when owner activation settlement loses its Session before transaction entry", async () => {
        const { owner, session } = await fixture();
        beforeNextTransaction(() => db.session.delete({ where: { id: session.id } }));
        expect(await markPendingActivationFailed({ actorUserId: owner.id, sessionId: session.id, requestId: randomUUID(), requestedAt: 1000, failureCode: "runtime_start_failed" })).toEqual({ ok: false, error: "session-not-found" });
    });

    it.each(["create", "update", "delete"] as const)("denies public-link %s when the owner Session disappears before transaction entry", async (operation) => {
        const { owner, session } = await fixture();
        if (operation !== "create") {
            await db.publicSessionShare.create({
                data: { sessionId: session.id, createdByUserId: owner.id, tokenHash: createHash("sha256").update(randomUUID()).digest(), keyDerivation: "fragment_v1" },
            });
        }
        beforeNextTransaction(() => db.session.delete({ where: { id: session.id } }));
        await withAuthenticatedTestApp(registerPublicShareOwnerRoutes, async (app) => {
            const response = await app.inject({
                method: operation === "delete" ? "DELETE" : "POST",
                url: `/v1/sessions/${session.id}/public-share`,
                headers: { "x-test-user-id": owner.id },
                ...(operation === "delete" ? {} : { payload: {
                    lookupId: randomUUID(),
                    keyDerivation: "fragment_v1",
                    encryptedDataKey: Buffer.from([0, ...new Array(80).fill(1)]).toString("base64"),
                } }),
            });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "session_access_forbidden" });
        });
        expect(await db.session.count({ where: { id: session.id } })).toBe(0);
        expect(await db.publicSessionShare.count({ where: { sessionId: session.id } })).toBe(0);
    });
});
