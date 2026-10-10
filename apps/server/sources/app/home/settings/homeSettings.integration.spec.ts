import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccountStatusV1, HomeRoleV1 } from "@happier-dev/protocol";

import { listHomeAdministrationEventsInTx } from "@/app/home/audit/homeAdministrationEvents";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { resolveFeaturesFromEnv } from "@/app/features/registry";

import { loadStartupHomeEnv } from "./startupHomeEnv";
import {
    readHomeConfigEnv,
    readHomeSettingsInTx,
    readHomeSettingsProjectionInTx,
    readStoredHomeSettingsForStartup,
    setHomeSettings,
} from "./homeSettings";

let sequence = 0;
let harness: LightSqliteHarness;

const PASSWORD = "s3cret-smtp-password";

async function createAccount(homeRole: HomeRoleV1 = "member", status: AccountStatusV1 = "active"): Promise<string> {
    sequence += 1;
    const created = await db.account.create({
        data: { publicKey: `home-settings-${sequence}`, homeRole, status },
        select: { id: true },
    });
    return created.id;
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-settings-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
afterEach(async () => {
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeSettings.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home settings owner", () => {
    it("publishes an owner-set Home name to other devices without borrowing the Account Service name", async () => {
        const owner = await createAccount("owner");
        const applied = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { HAPPIER_HOME_DISPLAY_NAME: "Studio" } },
        });
        expect(applied.status).toBe("applied");
        const features = resolveFeaturesFromEnv(await readHomeConfigEnv({}));
        expect(features.homePresentation).toEqual({ v: 1, displayName: "Studio" });
        expect(features.accountServicePresentation).toBeUndefined();
    });

    it("rejects a Home name that its public presentation cannot carry", async () => {
        const owner = await createAccount("owner");
        const outcome = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { HAPPIER_HOME_DISPLAY_NAME: "Studio\nHidden" } },
        });
        expect(outcome.status).toBe("invalid");
        const tooLong = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { HAPPIER_HOME_DISPLAY_NAME: "é".repeat(65) } },
        });
        expect(tooLong.status).toBe("invalid");
    });

    it("stores values and a sealed password, projects presence only, and audits each key without the secret", async () => {
        const owner = await createAccount("owner");
        const result = await setHomeSettings({
            actorAccountId: owner,
            write: {
                expectedRevision: 0,
                values: { HAPPIER_AUTH_EMAIL_SMTP_HOST: "smtp.home.test", HAPPIER_AUTH_EMAIL_SMTP_PORT: 2525 },
                secrets: { HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { replace: PASSWORD } },
            },
        });
        expect(result.status).toBe("applied");
        if (result.status !== "applied") return;
        expect(result.projection.revision).toBe(1);
        const byKey = Object.fromEntries(result.projection.entries.map((entry) => [entry.key, entry]));
        expect(byKey.HAPPIER_AUTH_EMAIL_SMTP_HOST).toMatchObject({ value: "smtp.home.test", source: "home", fixed: false });
        expect(byKey.HAPPIER_AUTH_EMAIL_SMTP_PASSWORD).toMatchObject({ value: null, source: "home", secretSet: true });
        expect(byKey.HAPPIER_PUBLIC_SERVER_URL_INFERRED).toBeUndefined();
        expect(byKey.DATABASE_URL).toMatchObject({ editable: "bootstrap", readOnlyReason: expect.any(String) });
        expect(JSON.stringify(result.projection)).not.toContain(PASSWORD);

        const row = await db.homeSettings.findUniqueOrThrow({ where: { id: "home" } });
        expect(Buffer.from(row.encryptedSecrets!).toString("utf8")).not.toContain(PASSWORD);
        expect(JSON.stringify(row.values)).not.toContain(PASSWORD);

        const audit = await inTx(async (tx) => await listHomeAdministrationEventsInTx(tx, {}));
        expect(audit.status).toBe("ok");
        if (audit.status !== "ok") return;
        const summaries = audit.result.items.map((item) => item.summary);
        expect(summaries).toEqual(expect.arrayContaining([
            { secret: false, key: "HAPPIER_AUTH_EMAIL_SMTP_HOST", from: null, to: "smtp.home.test" },
            { secret: false, key: "HAPPIER_AUTH_EMAIL_SMTP_PORT", from: null, to: 2525 },
            { secret: true, key: "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD", from: "unset", to: "set" },
        ]));
        expect(audit.result.items.every((item) => item.actor.kind === "account" && item.actor.accountId === owner)).toBe(true);
        expect(JSON.stringify(audit.result)).not.toContain(PASSWORD);
    });

    it("feeds live values and the opened password to the request overlay, where an explicit env value still wins", async () => {
        const owner = await createAccount("owner");
        await setHomeSettings({
            actorAccountId: owner,
            write: {
                expectedRevision: 0,
                values: { HAPPIER_AUTH_EMAIL_SMTP_HOST: "smtp.home.test", HAPPIER_AUTH_EMAIL_FROM_ADDRESS: "home@home.test", METRICS_PORT: 9191 },
                secrets: { HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { replace: PASSWORD } },
            },
        });

        const overlay = await readHomeConfigEnv({});
        expect(overlay.HAPPIER_AUTH_EMAIL_SMTP_HOST).toBe("smtp.home.test");
        expect(overlay.HAPPIER_AUTH_EMAIL_SMTP_PASSWORD).toBe(PASSWORD);
        // Restart keys reach the process only through the startup overlay.
        expect(overlay.METRICS_PORT).toBeUndefined();

        const locked = await readHomeConfigEnv({ HAPPIER_AUTH_EMAIL_SMTP_HOST: "smtp.deployment.test" });
        expect(locked.HAPPIER_AUTH_EMAIL_SMTP_HOST).toBe("smtp.deployment.test");

        const stored = await readStoredHomeSettingsForStartup();
        expect(stored.values.METRICS_PORT).toBe(9191);
        // Live secrets are not opened for startup.
        expect(stored.secrets).toEqual({});
    });

    it("lets administrators read but only owners write, and refuses non-Home keys and stale revisions", async () => {
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");

        await expect(inTx(async (tx) => await readHomeSettingsProjectionInTx(tx, { actorAccountId: admin })))
            .resolves.toMatchObject({ status: "ok" });
        await expect(inTx(async (tx) => await readHomeSettingsProjectionInTx(tx, { actorAccountId: member })))
            .resolves.toEqual({ status: "forbidden" });
        await expect(setHomeSettings({ actorAccountId: admin, write: { expectedRevision: 0, values: { METRICS_PORT: 9191 } } }))
            .resolves.toEqual({ status: "forbidden" });

        const refused = async (values: Record<string, unknown>, secrets?: Record<string, { replace: string }>) =>
            await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values, ...(secrets ? { secrets } : {}) } });
        await expect(refused({}, { DATABASE_URL: { replace: "file:/tmp/x.db" } }))
            .resolves.toEqual({ status: "invalid", key: "DATABASE_URL", reason: "not_home_editable" });
        await expect(refused({ HAPPIER_CANONICAL_SERVER_URL: "https://home.example" }))
            .resolves.toEqual({ status: "invalid", key: "HAPPIER_CANONICAL_SERVER_URL", reason: "not_home_editable" });
        await expect(refused({ HAPPIER_BUILD_FEATURES_DENY: ["voice"] }))
            .resolves.toEqual({ status: "invalid", key: "HAPPIER_BUILD_FEATURES_DENY", reason: "not_home_editable" });
        // U2 retired the inferred-address marker and its registry entry (plan §3.14 r4).
        await expect(refused({ HAPPIER_PUBLIC_SERVER_URL_INFERRED: "1" }))
            .resolves.toEqual({ status: "invalid", key: "HAPPIER_PUBLIC_SERVER_URL_INFERRED", reason: "unknown_key" });
        await expect(refused({ AUTH_ANONYMOUS_SIGNUP_ENABLED: true }))
            .resolves.toEqual({ status: "invalid", key: "AUTH_ANONYMOUS_SIGNUP_ENABLED", reason: "not_home_editable" });
        await expect(refused({ NOT_A_KEY: "x" })).resolves.toEqual({ status: "invalid", key: "NOT_A_KEY", reason: "unknown_key" });
        await expect(refused({ METRICS_PORT: 70_000 })).resolves.toEqual({ status: "invalid", key: "METRICS_PORT", reason: "out_of_bounds" });
        await expect(db.homeSettings.count()).resolves.toBe(0);

        await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values: { METRICS_PORT: 9191 } } });
        await expect(setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values: { METRICS_PORT: 9292 } } }))
            .resolves.toEqual({ status: "revision_conflict" });
        const record = await inTx(async (tx) => await readHomeSettingsInTx(tx));
        expect(record.values).toEqual({ METRICS_PORT: 9191 });
    });

    it("clears a value and a secret, recording set to unset", async () => {
        const owner = await createAccount("owner");
        await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { METRICS_PORT: 9191 }, secrets: { HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { replace: PASSWORD } } },
        });
        const cleared = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 1, values: { METRICS_PORT: null }, secrets: { HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { clear: true } } },
        });
        expect(cleared.status).toBe("applied");
        const record = await inTx(async (tx) => await readHomeSettingsInTx(tx));
        expect(record).toEqual({ revision: 2, values: {}, sealedSecrets: {} });
        const audit = await inTx(async (tx) => await listHomeAdministrationEventsInTx(tx, { targetId: "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD" }));
        expect(audit.status === "ok" && audit.result.items.map((item) => item.summary)).toEqual([
            { secret: true, key: "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD", from: "set", to: "unset" },
            { secret: true, key: "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD", from: "unset", to: "set" },
        ]);
    });

    it("stores registry policy settings not owned by the governance document", async () => {
        const owner = await createAccount("owner");
        const result = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: {
                AUTH_SIGNUP_PROVIDERS: ["github"],
                HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            } },
        });
        expect(result.status).toBe("applied");
        const env = await readHomeConfigEnv({});
        expect(env.AUTH_SIGNUP_PROVIDERS).toBe("github");
        expect(env.HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE).toBe("plain");
    });

    it("applies stored restart values at the next start and ignores an out-of-bounds value or an unreadable secret with its reason", async () => {
        const owner = await createAccount("owner");
        await setHomeSettings({
            actorAccountId: owner,
            write: {
                expectedRevision: 0,
                values: { METRICS_PORT: 9191, HAPPIER_SERVER_LOG_LEVEL: "debug" },
                secrets: { S3_SECRET_KEY: { replace: "s3-secret" }, REDIS_URL: { replace: "redis://cache:6379" } },
            },
        });
        // A value stored under older bounds and a ciphertext the current master secret cannot open.
        const row = await db.homeSettings.findUniqueOrThrow({ where: { id: "home" } });
        const sealed = JSON.parse(Buffer.from(row.encryptedSecrets!).toString("utf8")) as Record<string, string>;
        sealed.REDIS_URL = Buffer.from("not a sealed value").toString("base64");
        await db.homeSettings.update({
            where: { id: "home" },
            data: {
                values: { ...(row.values as object), HAPPIER_SERVER_LOG_LEVEL: "loud" },
                encryptedSecrets: new TextEncoder().encode(JSON.stringify(sealed)),
            },
        });

        const lines: string[] = [];
        const startup = await loadStartupHomeEnv({
            env: { METRICS_PORT: "9300" },
            readStored: () => readStoredHomeSettingsForStartup(),
            log: (line) => lines.push(line),
        });
        // The deployment's explicit METRICS_PORT wins over the stored value.
        expect(startup.env.METRICS_PORT).toBe("9300");
        expect(startup.env.S3_SECRET_KEY).toBe("s3-secret");
        expect(startup.env.HAPPIER_SERVER_LOG_LEVEL).toBeUndefined();
        expect(startup.env.REDIS_URL).toBeUndefined();
        expect(startup.snapshot.applied).toEqual(["S3_SECRET_KEY"]);
        expect(startup.snapshot.ignored).toEqual({ HAPPIER_SERVER_LOG_LEVEL: "out_of_bounds", REDIS_URL: "secret_unreadable" });
        expect(lines.join("\n")).not.toContain("s3-secret");

        const projection = await inTx(async (tx) => await readHomeSettingsProjectionInTx(tx, { actorAccountId: owner }));
        expect(projection.status).toBe("ok");
        if (projection.status !== "ok") return;
        const byKey = Object.fromEntries(projection.projection.entries.map((entry) => [entry.key, entry]));
        expect(byKey.METRICS_PORT).toMatchObject({ value: 9300, source: "deployment", fixed: true });
        expect(byKey.HAPPIER_SERVER_LOG_LEVEL).toMatchObject({ applied: { ignoredReason: "out_of_bounds" } });
        expect(byKey.REDIS_URL).toMatchObject({ value: null, secretSet: true, applied: { ignoredReason: "secret_unreadable" } });
        expect(projection.projection.startedAt).toBe(startup.snapshot.appliedAt);
    });

    it("discards pending restart values back to what the running server started with, and records each as a discard", async () => {
        const owner = await createAccount("owner");
        const first = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { METRICS_PORT: 9191 }, secrets: { S3_SECRET_KEY: { replace: "running-secret" } } },
        });
        expect(first.status).toBe("applied");
        await loadStartupHomeEnv({ env: {}, readStored: () => readStoredHomeSettingsForStartup(), log: () => {} });

        // After the start: two restart values changed, one set that ran on its default, one live value.
        const edited = await setHomeSettings({
            actorAccountId: owner,
            write: {
                expectedRevision: 1,
                values: { METRICS_PORT: 9292, HAPPIER_SERVER_LOG_LEVEL: "debug", HAPPIER_AUTH_EMAIL_SMTP_HOST: "smtp.home.test" },
                secrets: { S3_SECRET_KEY: { replace: "replacement-secret" } },
            },
        });
        expect(edited.status).toBe("applied");
        if (edited.status !== "applied") return;
        const pendingBefore = edited.projection.entries.filter((entry) => entry.applied?.pending).map((entry) => entry.key).sort();
        expect(pendingBefore).toEqual(["HAPPIER_SERVER_LOG_LEVEL", "METRICS_PORT", "S3_SECRET_KEY"]);

        const discarded = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 2, values: {}, discardPendingRestart: true },
        });
        expect(discarded.status).toBe("applied");
        if (discarded.status !== "applied") return;
        const byKey = Object.fromEntries(discarded.projection.entries.map((entry) => [entry.key, entry]));
        expect(discarded.projection.entries.filter((entry) => entry.applied?.pending)).toEqual([]);
        expect(byKey.METRICS_PORT).toMatchObject({ value: 9191, source: "home" });
        // It ran on its default, so the stored value is cleared rather than pinned.
        expect(byKey.HAPPIER_SERVER_LOG_LEVEL).toMatchObject({ value: "info", source: "default" });
        expect(byKey.S3_SECRET_KEY).toMatchObject({ value: null, source: "home", secretSet: true });
        // A live value is never touched by a discard.
        expect(byKey.HAPPIER_AUTH_EMAIL_SMTP_HOST).toMatchObject({ value: "smtp.home.test", source: "home" });
        // The restored secret is the one the running server started with, sealed again.
        expect((await readStoredHomeSettingsForStartup()).secrets.S3_SECRET_KEY).toBe("running-secret");
        expect(JSON.stringify(discarded.projection)).not.toContain("running-secret");

        const audit = await inTx(async (tx) => await listHomeAdministrationEventsInTx(tx, {}));
        expect(audit.status).toBe("ok");
        if (audit.status !== "ok") return;
        const discards = audit.result.items.filter((item) => item.action === "home.settings.discard").map((item) => item.summary);
        expect(discards).toEqual(expect.arrayContaining([
            { secret: false, key: "METRICS_PORT", from: 9292, to: 9191 },
            { secret: false, key: "HAPPIER_SERVER_LOG_LEVEL", from: "debug", to: null },
            { secret: true, key: "S3_SECRET_KEY", from: "set", to: "set" },
        ]));
        expect(discards).toHaveLength(3);

        // Nothing pending: a second discard writes nothing.
        const again = await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 3, values: {}, discardPendingRestart: true } });
        expect(again.status === "applied" && again.projection.revision).toBe(3);
    });

    it("refuses a discard combined with values", async () => {
        const owner = await createAccount("owner");
        const mixed = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { METRICS_PORT: 9191 }, discardPendingRestart: true },
        });
        expect(mixed).toEqual({ status: "invalid_input" });
    });
});
