import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    AccountEncryptionCurrentnessResponseSchema,
} from "@happier-dev/protocol";

import { createAccountPluginDataStorageHost } from "../../../../../../cli/src/plugins/runtime/context/accountPluginDataStorage";
import { administerTriageSavedView, readTriageSavedViewsForSurface } from "../../../../../../../packages/plugins/triage/src/actions/savedViews";
import { TriageAdministerSavedViewInputV1Schema, TriageAdministerSavedViewResultV1Schema, TriageReadSavedViewsResultV1Schema } from "../../../../../../../packages/plugins/triage/src/actions/savedViewsProtocol";
import { createTriageAccountKvCatalogStore } from "../../../../../../../packages/plugins/triage/src/settings/accountKvCatalogStore";
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from "../../../../../../../packages/plugins/triage/src/settings/savedViews";
import { TRIAGE_LIST_NO_FILTERS_V1 } from "../../../../../../../packages/plugins/triage/src/projection/listWindow";

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

    it("tolerates a legacy non-UUID saved-view record and preserves it across refused mutations", async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const pluginId = "happier.triage";
        const legacyView = {
            viewId: "legacy-view",
            label: "Retained legacy view",
            query: "",
            filters: TRIAGE_LIST_NO_FILTERS_V1,
            order: "newest",
            smartPolicy: { v: 1, precedence: ["attention", "activity"] },
            view: "list",
        };
        const content = { t: "plain", v: { v: 1, values: {
            [TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1]: {
                version: 7, value: { v: 1, views: [legacyView] },
            },
        } } };
        const persisted = () => db.userKVStore.findUniqueOrThrow({
            where: { accountId_key: {
                accountId: owner.id, key: buildPluginAccountStoragePhysicalKey(pluginId),
            } },
            select: { value: true, version: true },
        });

        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { "x-test-user-id": owner.id, ...DATA_PROTOCOL_HEADERS };
            const seed = await app.inject({
                method: "POST", url: `/v1/account/plugin-storage/${pluginId}`,
                headers, payload: { expectedRevision: "absent", content },
            });
            expect(seed.statusCode, seed.body).toBe(200);
            expect(seed.json()).toEqual({ status: "updated", revision: 0 });
            const before = await persisted();
            const changesBefore = await db.accountChange.count({ where: { accountId: owner.id } });

            const host = createAccountPluginDataStorageHost({
                contracts: [],
                readCredentials: async () => ({ token: "fixture-account-token", encryption: null }),
                isCurrentAccount: () => true,
                resolveAccountScopeKey: () => owner.id,
                resolveBaseUrl: () => "http://saved-views.test",
                resolveAccountEncryptionCurrentness: async () => {
                    const response = await app.inject({
                        method: "GET", url: "/v1/account/encryption/currentness", headers,
                    });
                    expect(response.statusCode, response.body).toBe(200);
                    return AccountEncryptionCurrentnessResponseSchema.parse(response.json());
                },
                // Substitute only HTTP: Account codecs, logical CAS, route handlers and SQLite stay real.
                http: {
                    get: async url => {
                        const response = await app.inject({ method: "GET", url: new URL(url).pathname, headers });
                        return { status: response.statusCode, data: response.json() };
                    },
                    post: async (url, body) => {
                        const response = await app.inject({
                            method: "POST", url: new URL(url).pathname,
                            headers: { ...headers, "content-type": "application/json" }, payload: body,
                        });
                        return { status: response.statusCode, data: response.json() };
                    },
                },
            });
            const account = host.bind({
                pluginId, occurrenceId: "legacy-saved-view-test",
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            });
            if (!account) throw new Error("Expected real Account KV binding");
            const deps = {
                catalog: createTriageAccountKvCatalogStore(account.kv, TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
                mintViewId: () => "00000001-0000-4000-8000-000000000000",
            };
            // Tolerance is a typed unavailable result, not acceptance or destructive repair of the legacy id.
            expect(TriageReadSavedViewsResultV1Schema.parse(await readTriageSavedViewsForSurface({ v: 1 }, deps)))
                .toEqual({ v: 1, availability: "unavailable", views: [], revision: "7" });
            const { viewId, ...draft } = legacyView;
            for (const command of [
                { ...draft, v: 1, kind: "create", expectedRevision: "7" },
                { ...legacyView, v: 1, kind: "update", expectedRevision: "7" },
                { v: 1, kind: "delete", viewId, expectedRevision: "7" },
            ]) {
                const result = await administerTriageSavedView(TriageAdministerSavedViewInputV1Schema.parse(command), deps);
                expect(TriageAdministerSavedViewResultV1Schema.parse(result)).toEqual({ v: 1, status: "unreadable" });
            }
            expect(await persisted()).toEqual(before);
            expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(changesBefore);
        });
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
