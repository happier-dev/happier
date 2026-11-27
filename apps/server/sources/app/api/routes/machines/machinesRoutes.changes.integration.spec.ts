import { MACHINE_PRESENCE_EVENTS_PROJECTION_V1 } from '@happier-dev/protocol/machines/machinePresenceTransitionsV1';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { machinesRoutes } from "./machinesRoutes";

describe("machinesRoutes (AccountChange integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-route-changes-", initAuth: false }); }, 120_000);
    afterEach(async () => { vi.restoreAllMocks(); await db.machine.deleteMany(); await db.accountChange.deleteMany(); await db.account.deleteMany(); });
    afterAll(async () => { if (harness) await harness.close(); });

    it("conditionally reads durable census content across a heartbeat", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const headers = { "x-test-user-id": account.id, accept: MACHINE_PRESENCE_EVENTS_PROJECTION_V1 };
            const url = "/v1/machines";
            const created = await app.inject({ method: "POST", url, headers,
                payload: { id: "m1", metadata: "before", daemonState: "state", dataEncryptionKey: null } });
            expect(created.statusCode).toBe(200);

            const full = await app.inject({ method: "GET", url, headers });
            expect(full.statusCode).toBe(200);
            expect(full.json()).toMatchObject([{ id: "m1", metadata: "before" }]);
            expect(full.headers.etag).toEqual(expect.any(String));
            const conditional = () => app.inject({ method: "GET", url,
                headers: { ...headers, "if-none-match": full.headers.etag! } });
            const unchanged = await conditional();
            expect(unchanged.statusCode).toBe(304);
            expect(unchanged.body).toBe("");

            const machine = await db.machine.findUniqueOrThrow({ where: { id: "m1" } });
            await db.machine.update({ where: { id: "m1" }, data: {
                lastActiveAt: new Date(machine.lastActiveAt.getTime() + 60_000), updatedAt: machine.updatedAt,
            } });
            expect((await conditional()).statusCode).toBe(304);
            const legacy = await app.inject({ method: "GET", url, headers });
            expect(legacy.statusCode).toBe(200);
            expect(legacy.json()).toMatchObject([{ id: "m1", activeAt: machine.lastActiveAt.getTime() + 60_000 }]);

            await db.machine.update({ where: { id: "m1" }, data: { metadata: "after", metadataVersion: { increment: 1 } } });
            const changed = await conditional();
            expect(changed.statusCode).toBe(200);
            expect(changed.headers.etag).not.toBe(full.headers.etag);
            expect(changed.json()).toMatchObject([{ id: "m1", metadata: "after" }]);
        });
    });

    it("marks machine create once and emits new-machine + update-machine using the same cursor", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        // Observe transport publication without replacing cursor allocation or event builders.
        const emitted = vi.spyOn(eventRouter, "emitUpdate");
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: "POST", url: "/v1/machines", headers: { "x-test-user-id": account.id },
                payload: { id: "m1", metadata: "meta", daemonState: "state", dataEncryptionKey: null } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machine).toMatchObject({ id: "m1", metadata: "meta", metadataVersion: 1, daemonState: "state", daemonStateVersion: 1 });
        });
        const changes = await db.accountChange.findMany({ where: { accountId: account.id, kind: "machine", entityId: "m1" } });
        expect(changes).toHaveLength(1);
        const updates = emitted.mock.calls.map(([event]) => event.payload).filter(payload => payload.body.t === "new-machine" || payload.body.t === "update-machine");
        expect(updates.map(update => update.body.t)).toEqual(["new-machine", "update-machine"]);
        expect(updates.map(update => update.seq)).toEqual([changes[0].cursor, changes[0].cursor]);
        expect(new Set(updates.map(update => update.id)).size).toBe(2);
    });
});
