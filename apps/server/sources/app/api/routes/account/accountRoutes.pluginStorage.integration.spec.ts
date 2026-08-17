import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { buildPluginAccountStoragePhysicalKey } from "@/app/kv/accountScopedKv";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

const DATA_PROTOCOL_HEADERS = {
    "x-happier-account-stored-content-protocol":
        String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION),
} as const;

describe("accountRoutes (plugin Account-KV record)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-account-kv-route-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("admits only V3 peers and moves one authenticated plugin row through the shared CAS owner", async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const other = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const pluginId = "example.tasks";
        const content = {
            t: "plain" as const,
            v: {
                v: 1 as const,
                values: {
                    "selected-project": {
                        version: 0,
                        value: { id: "project-1" },
                    },
                },
            },
        };

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const legacy = await app.inject({
                    method: "GET",
                    url: `/v1/account/plugin-storage/${pluginId}`,
                    headers: { "x-test-user-id": owner.id },
                });
                expect(legacy.json()).toEqual({
                    error: "plugin_account_storage_unavailable",
                });
                expect(legacy.statusCode).toBe(503);

                const absent = await app.inject({
                    method: "GET",
                    url: `/v1/account/plugin-storage/${pluginId}`,
                    headers: {
                        "x-test-user-id": owner.id,
                        ...DATA_PROTOCOL_HEADERS,
                    },
                });
                expect(absent.statusCode).toBe(200);
                expect(absent.json()).toEqual({ status: "absent" });

                const write = await app.inject({
                    method: "POST",
                    url: `/v1/account/plugin-storage/${pluginId}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        ...DATA_PROTOCOL_HEADERS,
                    },
                    payload: { expectedRevision: "absent", content },
                });
                expect(write.statusCode).toBe(200);
                expect(write.json()).toEqual({ status: "updated", revision: 0 });

                const read = await app.inject({
                    method: "GET",
                    url: `/v1/account/plugin-storage/${pluginId}`,
                    headers: {
                        "x-test-user-id": owner.id,
                        ...DATA_PROTOCOL_HEADERS,
                    },
                });
                expect(read.statusCode).toBe(200);
                expect(read.json()).toEqual({
                    status: "present",
                    revision: 0,
                    content,
                });
                expect(read.body).not.toContain(buildPluginAccountStoragePhysicalKey(pluginId));

                const crossAccount = await app.inject({
                    method: "GET",
                    url: `/v1/account/plugin-storage/${pluginId}`,
                    headers: {
                        "x-test-user-id": other.id,
                        ...DATA_PROTOCOL_HEADERS,
                    },
                });
                expect(crossAccount.statusCode).toBe(200);
                expect(crossAccount.json()).toEqual({ status: "absent" });
            },
        );

        await expect(db.userKVStore.findUniqueOrThrow({
            where: {
                accountId_key: {
                    accountId: owner.id,
                    key: buildPluginAccountStoragePhysicalKey(pluginId),
                },
            },
            select: { version: true },
        })).resolves.toEqual({ version: 0 });
    });
});
