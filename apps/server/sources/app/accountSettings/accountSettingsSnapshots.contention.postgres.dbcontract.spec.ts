import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { registerAccountSettingsRoutes } from "@/app/api/routes/account/registerAccountSettingsRoutes";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { currentAccountStoredContentCompatibilityHeaders } from "@/app/api/testkit/accountStoredContentCompatibility";
import { eventRouter } from "@/app/events/eventRouter";
import { observeLazyPrismaQuery } from "@/app/changes/accountPublicationContention.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { AccountSettingsV2UpdateResponseSchema } from "@happier-dev/protocol/account/settings/accountSettingsApiV2";
import { AccountSettingsPublicationConflict, writeAccountSettingsInTx } from "./writeAccountSettingsInTx";

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account Settings snapshot contention", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use only the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST", "none");
    });
    afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });

    it("keeps the terminal CAS authoritative for different candidates when history is disabled", async () => {
        const originalLimit = process.env.HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT;
        vi.stubEnv("HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT", "0");
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const staged = latch();
        let stagedCount = 0;
        try {
            const outcomes = await Promise.all(["de", "fr"].map(language => inTx(async tx => {
                const result = await writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 0,
                    next: { kind: "v2", content: { t: "plain", v: { preferredLanguage: language } } } });
                if (++stagedCount === 2) staged.release();
                await staged.promise;
                return result;
            }).catch((error: unknown) => {
                if (error instanceof AccountSettingsPublicationConflict) return error.result;
                throw error;
            })));
            expect(outcomes.map(outcome => outcome.status).sort()).toEqual(["success", "version_mismatch"]);
            const winner = outcomes.findIndex(outcome => outcome.status === "success");
            expect(outcomes[1 - winner]).toMatchObject({ status: "version_mismatch", currentVersion: 1,
                currentContent: { t: "plain", v: { preferredLanguage: ["de", "fr"][winner] } } });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { settingsVersion: true, seq: true } }))
                .toEqual({ settingsVersion: 1, seq: 1 });
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally {
            staged.release();
            vi.stubEnv("HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT", originalLimit);
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each([0, 1])("returns the typed CAS conflict when snapshot version %i is inserted concurrently", async contestedVersion => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        if (contestedVersion === 1) await db.accountSettingsSnapshot.create({ data: {
            accountId: account.id, version: 0, encryptionMode: "plain", contentKind: "empty", settingsDbValue: null,
        } });
        const inserted = latch(), release = latch();
        const transaction = db.$transaction;
        const pids: number[] = [];
        const isolationLevels: string[] = [];
        const settingsVersionsAtSnapshotInsert: number[] = [];
        let held = false;
        let secondSettled = false;
        const emitted = vi.spyOn(eventRouter, "emitUpdate");
        // Pause the real Prisma persistence boundary after the first INSERT.
        // The peer must wait at the unique key or terminal Account fence.
        // Account admission, repository, terminal CAS and HTTP stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let observedWriter = false;
                const observeWriter = async () => {
                    if (observedWriter) return;
                    observedWriter = true;
                    const [{ pid, isolation }] = await tx.$queryRaw<Array<{ pid: number; isolation: string }>>`
                        SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation
                    `;
                    pids.push(pid);
                    isolationLevels.push(isolation);
                };
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property === "$queryRawUnsafe") {
                        return (...queryArgs: unknown[]) => {
                            const query = Reflect.apply(inner.$queryRawUnsafe, inner, queryArgs);
                            return typeof queryArgs[0] === "string" && queryArgs[0].includes("FOR NO KEY UPDATE")
                                ? observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), observeWriter)
                                : query;
                        };
                    }
                    if (property !== "accountSettingsSnapshot") return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.accountSettingsSnapshot, { get(model, method, modelReceiver) {
                        const original = Reflect.get(model, method, modelReceiver);
                        if (method !== "upsert" && method !== "createMany") return original;
                        return (...queryArgs: unknown[]) => observeLazyPrismaQuery(Reflect.apply(original, model, queryArgs),
                            () => ({ started() {}, settled() {} }), async () => {
                                await observeWriter();
                                const current = await tx.account.findUniqueOrThrow({ where: { id: account.id },
                                    select: { settingsVersion: true } });
                                settingsVersionsAtSnapshotInsert.push(current.settingsVersion);
                            }, async consume => {
                            const result = await consume();
                            const row = await tx.accountSettingsSnapshot.findUnique({ where: {
                                accountId_version: { accountId: account.id, version: contestedVersion },
                            } });
                            if (!held && row) {
                                held = true;
                                inserted.release();
                                await release.promise;
                            }
                            return result;
                        });
                    } });
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(registerAccountSettingsRoutes, async app => {
                const write = (language: string) => app.inject({ method: "POST", url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { expectedVersion: 0, content: { t: "plain", v: { preferredLanguage: language } } } });
                const first = write("de");
                const firstOutcome = Promise.allSettled([first]);
                let secondOutcome: Promise<unknown> | undefined;
                let second: ReturnType<typeof write> | undefined;
                try {
                    await Promise.race([inserted.promise, first.then(() => { throw new Error("Writer never inserted the contested snapshot"); })]);
                    second = write("fr");
                    secondOutcome = Promise.allSettled([second]).then(outcomes => { secondSettled = true; return outcomes; });
                    let blocked = false;
                    while (!secondSettled) {
                        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
                            SELECT pid FROM pg_stat_activity
                            WHERE ${pids[0]}::int = ANY(pg_blocking_pids(pid))
                        `;
                        if (pids[1] !== undefined && waiting.some(row => row.pid === pids[1])) { blocked = true; break; }
                    }
                    expect(blocked, "Peer must reach a real PostgreSQL contention wait").toBe(true);
                    expect(isolationLevels).toEqual(["read committed", "read committed"]);
                } finally {
                    release.release();
                    await firstOutcome;
                    await secondOutcome;
                }
                const responses = await Promise.all([first, second!]);
                expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
                // Both snapshot attempts belong to the CAS winner, after its
                // Account version advances. The loser never attempts history.
                expect(settingsVersionsAtSnapshotInsert).toEqual([1, 1]);
                expect(AccountSettingsV2UpdateResponseSchema.parse(responses[0].json())).toEqual({ success: true, version: 1 });
                expect(AccountSettingsV2UpdateResponseSchema.parse(responses[1].json())).toEqual({
                    success: false, error: "version-mismatch", currentVersion: 1,
                    currentContent: { t: "plain", v: { preferredLanguage: "de" } },
                });
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { settings: true, settingsVersion: true } }))
                    .toEqual({ settings: JSON.stringify({ t: "plain", v: { preferredLanguage: "de" } }), settingsVersion: 1 });
                expect(await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id }, orderBy: { version: "asc" },
                    select: { version: true, settingsDbValue: true } })).toEqual([
                    { version: 0, settingsDbValue: null },
                    { version: 1, settingsDbValue: JSON.stringify({ t: "plain", v: { preferredLanguage: "de" } }) },
                ]);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 1 });
                expect(emitted.mock.calls.filter(([event]) => event.payload.body.t === "account-settings-changed")).toHaveLength(1);
            });
        } finally {
            release.release();
            db.$transaction = transaction;
            emitted.mockRestore();
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
