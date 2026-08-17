import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

describe("v1 session list finite-publication recency (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-v1-list-publication-privacy-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("does not let an above-ceiling private updatedAt change the retained owned 150", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: `pk-v1-owned-publication-ceiling-${crypto.randomUUID()}`,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const base = 1_700_000_000_000;
        const sessionIds = Array.from(
            { length: 151 },
            (_, index) => `v1-owned-publication-${crypto.randomUUID()}-${index}`,
        );
        const publishedRecencyAt = (index: number) => base - (index * 1_000);
        await db.session.createMany({
            data: sessionIds.map((id, index) => ({
                id,
                tag: `v1-owned-publication-tag-${index}`,
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: "{}",
                agentState: null,
                currentStorageState: "machine_only",
                createdAt: new Date(publishedRecencyAt(index)),
                updatedAt: new Date(publishedRecencyAt(index)),
            })),
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as never),
            async (app) => {
                const readIds = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: "/v1/sessions",
                        headers: { "x-test-user-id": owner.id },
                    });
                    expect(response.statusCode, response.body).toBe(200);
                    return (response.json().sessions as Array<{ id: string }>).map((session) => session.id);
                };

                const beforePrivateCatchup = await readIds();
                expect(beforePrivateCatchup).toEqual(sessionIds.slice(0, 150));

                await db.session.update({
                    where: { id: sessionIds[150]! },
                    data: { updatedAt: new Date(base + 10_000) },
                });

                expect(await readIds()).toEqual(beforePrivateCatchup);
            },
        );
    });
});
