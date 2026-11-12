import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { registerAccountConnectedClientRoutes } from "./registerAccountConnectedClientRoutes";

describe("connected client presence routes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-connected-clients-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.connectedClientPresence.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(publicKey: string): Promise<string> {
        return (await db.account.create({ data: { publicKey }, select: { id: true } })).id;
    }

    async function seen(app: any, userId: string, clientId: string) {
        return await app.inject({
            method: "POST",
            url: "/v1/account/connected-clients/seen",
            headers: { "x-test-user-id": userId },
            payload: { clientId },
        });
    }

    async function list(app: any, userId: string) {
        return await app.inject({ method: "GET", url: "/v1/account/connected-clients", headers: { "x-test-user-id": userId } });
    }

    it("records when each client was last seen without publishing an account change", async () => {
        const userId = await createAccount("pk-connected-clients");
        const otherId = await createAccount("pk-connected-clients-other");
        await withAuthenticatedTestApp(registerAccountConnectedClientRoutes, async (app) => {
            const before = await db.account.findUniqueOrThrow({ where: { id: userId }, select: { seq: true } });

            expect((await seen(app, userId, "laptop")).statusCode).toBe(200);
            const first = list(app, userId);
            const firstSeen = (await first).json().clients[0].lastSeenAt;
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect((await seen(app, userId, "laptop")).statusCode).toBe(200);
            expect((await seen(app, otherId, "phone")).statusCode).toBe(200);

            const response = await list(app, userId);
            expect(response.statusCode).toBe(200);
            const clients = response.json().clients;
            expect(clients).toHaveLength(1);
            expect(clients[0].clientId).toBe("laptop");
            expect(clients[0].lastSeenAt).toBeGreaterThan(firstSeen);

            // Liveness only: no settings version, change row or cursor movement for other clients.
            const after = await db.account.findUniqueOrThrow({ where: { id: userId }, select: { seq: true } });
            expect(after.seq).toBe(before.seq);
            expect(await db.accountChange.count({ where: { accountId: userId } })).toBe(0);
        });
    });
});
