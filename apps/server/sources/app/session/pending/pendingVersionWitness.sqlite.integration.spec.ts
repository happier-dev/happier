import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { db } from "@/storage/db";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { sessionPendingRoutes } from "@/app/api/routes/session/pendingRoutes";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    blockPendingDelivery,
    deletePendingMessage,
    discardPendingMessage,
    reorderPendingMessages,
    restorePendingMessage,
} from "./pendingMessageService";

/**
 * T5 witness: every delivery-status writer moves `pendingVersion`, and the Pending list reports the
 * version its statuses are current at, so a host holding statuses at version V can skip a list read
 * for a push at V.
 */
describe("pendingVersion witness for Pending delivery statuses", () => {
    let harness: LightSqliteHarness;
    const authentication = createPresentUserSessionAccessAuthentication();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-pending-version-", initAuth: true });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("bumps the version on every delivery-status write and lists statuses with that version", async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "meta", metadataVersion: 0, agentState: null, agentStateVersion: 0,
        }, select: { id: true } });
        const version = async () => (await db.session.findUniqueOrThrow({ where: { id: session.id } })).pendingVersion;
        const base = { actorUserId: owner.id, sessionId: session.id, authentication };

        await withAuthenticatedTestApp(sessionPendingRoutes, async (app) => {
            for (const localId of ["a", "b", "c"]) {
                const enqueued = await app.inject({ method: "POST", url: `/v2/sessions/${session.id}/pending`,
                    headers: { "x-test-user-id": owner.id }, payload: { localId, ciphertext: `cipher-${localId}` } });
                expect(enqueued.json()).toMatchObject({ didWrite: true });
            }
            const writers: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
                ["block", () => blockPendingDelivery({ ...base, localId: "a", reason: "session_input_target_unavailable" })],
                ["discard", () => discardPendingMessage({ ...base, localId: "b", reason: "resume_failed" })],
                ["restore", () => restorePendingMessage({ ...base, localId: "b" })],
                ["reorder", () => reorderPendingMessages({ ...base, orderedLocalIds: ["c", "b", "a"] })],
                ["delete", () => deletePendingMessage({ ...base, localId: "c" })],
            ];
            const unchanged: string[] = [];
            for (const [name, write] of writers) {
                const before = await version();
                expect(await write(), name).toMatchObject({ ok: true });
                if (await version() <= before) unchanged.push(name);
            }
            expect(unchanged).toEqual([]);

            const listed = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/pending?includeDiscarded=true`,
                headers: { "x-test-user-id": owner.id } });
            expect(listed.json()).toMatchObject({ pendingVersion: await version() });
        });
    });
});
