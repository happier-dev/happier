import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { registerSessionArchiveRoutes } from "../session/registerSessionArchiveRoutes";
import { registerPublicShareOwnerRoutes } from "./registerPublicShareOwnerRoutes";
import { discardPendingMessage } from "@/app/session/pending/pendingMessageService";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";

const authentication = createPresentUserSessionAccessAuthentication();

describe("Session mutations current transaction authority", () => {
    let harness: LightSqliteHarness;
    let stopObservation: (() => void) | undefined;
    let intercepted = false;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-session-mutation-access-", initAuth: false });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    afterEach(async () => {
        stopObservation?.();
        stopObservation = undefined;
        expect(intercepted).toBe(true);
        intercepted = false;
        await db.accountChange.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    // Revoke after the real admission query captured its row, before the mutation
    // rechecks authority. Only SQLite IO is observed; inTx and its retry path stay real.
    function beforeTransaction(run: () => Promise<void>) {
        expect(stopObservation).toBeUndefined();
        stopObservation = observeSqliteRequests({ after: async request => {
            if (intercepted || request.model !== "Session" || request.action !== "findUnique") return;
            intercepted = true;
            await run();
        } });
    }

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const admin = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted", active: false,
        } });
        const share = await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: admin.id, accessLevel: "admin",
        } });
        return { owner, admin, session, share };
    }

    it.each(["archive", "unarchive"])("denies %s when the administrator grant is revoked before transaction entry", async (operation) => {
        const f = await fixture();
        const archivedAt = operation === "unarchive" ? new Date(1000) : null;
        await db.session.update({ where: { id: f.session.id }, data: { archivedAt } });
        beforeTransaction(async () => { await db.sessionGrant.delete({ where: { principalKind: 'account', id: f.share.id } }); });
        await withAuthenticatedTestApp(registerSessionArchiveRoutes, async (app) => {
            const response = await app.inject({ method: "POST", url: `/v2/sessions/${f.session.id}/${operation}`, headers: { "x-test-user-id": f.admin.id } });
            expect(response.statusCode).toBe(403);
        });
        expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).archivedAt).toEqual(archivedAt);
    });

    it("does not discard pending input after the editor loses access", async () => {
        const f = await fixture();
        await db.sessionPendingMessage.create({ data: {
            sessionId: f.session.id,
            localId: "pending-race",
            content: { t: "plain", v: {} },
            requestedAction: { v: 1, kind: "enqueue" },
            position: 1,
            status: "queued",
        } });
        beforeTransaction(async () => { await db.sessionGrant.delete({ where: { principalKind: 'account', id: f.share.id } }); });
        expect(await discardPendingMessage({ actorUserId: f.admin.id, sessionId: f.session.id, localId: "pending-race", authentication })).toEqual({ ok: false, error: "session-not-found" });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: f.session.id, localId: "pending-race" } } })).status).toBe("queued");
    });

    it("does not delete a public link after its Session disappears before transaction entry", async () => {
        const f = await fixture();
        await db.publicSessionShare.create({ data: { sessionId: f.session.id, createdByUserId: f.owner.id, tokenHash: new Uint8Array(32) } });
        beforeTransaction(async () => { await db.session.delete({ where: { id: f.session.id } }); });
        await withAuthenticatedTestApp(registerPublicShareOwnerRoutes, async (app) => {
            const response = await app.inject({ method: "DELETE", url: `/v1/sessions/${f.session.id}/public-share`, headers: { "x-test-user-id": f.owner.id } });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "session_access_forbidden" });
        });
        expect(await db.accountChange.count()).toBe(0);
    });
});
