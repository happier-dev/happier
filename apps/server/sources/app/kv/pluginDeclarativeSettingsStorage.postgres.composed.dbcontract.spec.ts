import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountSettingsParse } from "@happier-dev/protocol/account/settings/accountSettings";

import { registerAccountEncryptionRoutes } from "@/app/api/routes/account/registerAccountEncryptionRoutes";
import { registerPluginAccountSettingsRoutes } from "@/app/api/routes/account/registerPluginAccountSettingsRoutes";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import {
    clearActiveAccountSettingsSnapshot,
    setActiveAccountSettingsSnapshot,
} from "../../../../cli/src/settings/accountSettings/activeAccountSettingsSnapshot";
import { createAccountPluginSettingsRecordStorage } from "../../../../cli/src/plugins/runtime/context/accountPluginSettingsRecordStorage";
import { createStablePluginEventsBroker } from "../../../../cli/src/plugins/runtime/invocation/services/events";
import {
    createAccountSettingsBackedSettingsRecordStore,
    createStablePluginSettingsModel,
    createStablePluginSettingsOwner,
} from "../../../../cli/src/plugins/runtime/invocation/services/settings";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account plugin Settings revisions", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
        setActiveAccountSettingsSnapshot({
            source: "network", settings: accountSettingsParse({}), settingsVersion: 1,
            loadedAtMs: 1, settingsSecretsReadKeys: [],
        });
    });
    afterAll(async () => {
        clearActiveAccountSettingsSnapshot();
        if (connected) await db.$disconnect();
    });

    it("advances from the default revision on the first conditional write and rejects a stale edit", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "happier.channels";
        const fieldId = "pr-watch-fix-attempt-limit";
        await withAuthenticatedTestApp(app => {
            registerAccountEncryptionRoutes(app);
            registerPluginAccountSettingsRoutes(app);
        }, async app => {
            let writes = 0;
            const headers = { "x-test-user-id": account.id };
            const inject = async (url: string, method: "GET" | "POST", payload?: unknown) => {
                const response = await app.inject({ method, url: new URL(url).pathname, headers, payload });
                return { status: response.statusCode, data: response.json() };
            };
            const storage = createAccountPluginSettingsRecordStorage({
                readCredentials: async () => ({ token: "fixture", encryption: null }),
                isCurrentAccount: () => true,
                resolveBaseUrl: () => "https://fixture.invalid",
                http: {
                    get: url => inject(url, "GET"),
                    post: (url, body) => {
                        writes += 1;
                        return inject(url, "POST", body);
                    },
                },
            });
            const model = createStablePluginSettingsModel({ pluginId, contribution: {
                id: "preferences", version: 1, title: "Preferences", target: { kind: "plugin" }, scope: "account",
                fields: [{ id: fieldId, title: "PR watch fix attempt limit", schema: { type: "integer" }, default: 3 }],
                presentation: { sections: [], subagentSections: [] },
            } });
            const owner = createStablePluginSettingsOwner({
                recordStore: createAccountSettingsBackedSettingsRecordStore(storage),
                broker: createStablePluginEventsBroker(),
            });
            const service = owner.bind({ model, seed: {
                plugin: { id: pluginId, version: "0.0.0" },
                contribution: { id: "preferences", qualifiedId: `${pluginId}/settings/preferences` },
                occurrenceId: "settings-contract", correlationId: "settings-contract",
                surface: "cli", signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            } });

            await expect(service.get(fieldId)).resolves.toBe(3);
            const baseline = await service.snapshot();
            expect(baseline.revision).toBe("0");
            const updated = await service.set(fieldId, 4, { expectedRevision: baseline.revision });
            expect(updated.revision).toBe("1");
            await expect(service.set(fieldId, 5, { expectedRevision: baseline.revision }))
                .rejects.toMatchObject({ code: "plugin_settings_revision_conflict" });
            expect(writes).toBe(1);
            await expect(service.snapshot()).resolves.toMatchObject({ revision: "1", values: { [fieldId]: 4 } });
        });
    });
});
