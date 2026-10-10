import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { mutateSessionBoard } from "@/app/session/board/service";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import { runSessionSystemRecordBackfillOperator } from "./sessionSystemRecordBackfillOperator";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from "./sessionSystemRecordProtocolContract";
import {
    deleteSessionSystemRecordV1,
    upsertSessionSystemRecord,
    upsertSessionSystemRecordV1,
} from "./sessionSystemRecordService";

const authentication = createPresentUserSessionAccessAuthentication();

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported SessionSystemRecord DB contract provider: ${raw}`);
}

function synopsisContent(value: string) {
    return {
        t: "plain" as const,
        v: { v: 1 as const, seqTo: 1, updatedAtMs: 1, synopsis: value },
    };
}

async function createAccountAndSession(suffix: string) {
    const account = await db.account.create({
        data: { publicKey: `ssr-contract-${suffix}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `ssr-contract-${suffix}`,
            encryptionMode: "plain",
            metadata: "{}",
        },
        select: { id: true },
    });
    return { account, session };
}

async function deleteAccountFixture(accountId: string): Promise<void> {
    await db.session.deleteMany({ where: { accountId } });
    await db.account.delete({ where: { id: accountId } });
}

describe("SessionSystemRecord native CONTRACT database behavior", () => {
    const provider = resolveContractProvider();

    it("settles concurrent exact Board creation and leaves no item from a losing aggregate", async () => {
        const exactFixture = await createAccountAndSession(`board-exact-race-${randomUUID()}`);
        const competingFixture = await createAccountAndSession(`board-competing-race-${randomUUID()}`);
        const content = (title: string) => ({ t: "plain", v: { v: 1, title, frame: "card",
            height: { mode: "auto", fallback: "regular" }, source: { kind: "declarative",
                document: { version: 1, root: { kind: "markdown", text: title } } } } });
        const mutation = (itemId: string) => ({ operation: "upsert_item", itemId, expectedItemRevision: null,
            itemContent: content(itemId), placement: { expectedLayoutRevision: null,
                layoutContent: { t: "plain", v: { v: 1, tabs: [{ id: "overview", title: "Overview", items: [{ itemId, width: "medium" }] }] } } } });
        const invoke = (fixture: typeof exactFixture, value: unknown) => mutateSessionBoard({ authentication,
            actorUserId: fixture.account.id, sessionId: fixture.session.id, mutation: value });
        const settle = async (attempts: ReturnType<typeof invoke>[]) => (await Promise.allSettled(attempts)).map(outcome => {
            if (outcome.status === "rejected") throw outcome.reason;
            return outcome.value;
        });
        let operationError: unknown;
        try {
            const exactCreates = await settle([
                invoke(exactFixture, mutation("same")),
                invoke(exactFixture, mutation("same")),
            ]);
            expect(exactCreates.every(result => result.ok)).toBe(true);
            if (!exactCreates[0]?.ok || !exactCreates[1]?.ok) throw new Error("Expected byte-identical create settlement");
            if (exactCreates[0].result.operation !== "upsert_item" || exactCreates[1].result.operation !== "upsert_item") {
                throw new Error("Expected upsert-item settlement");
            }
            expect(exactCreates[1].result.itemRevision).toBe(exactCreates[0].result.itemRevision);
            expect(exactCreates[1].result.layoutRevision).toBe(exactCreates[0].result.layoutRevision);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: exactFixture.session.id } })).toBe(2);

            const firstCreates = await settle([
                invoke(competingFixture, mutation("first")),
                invoke(competingFixture, mutation("second")),
            ]);
            expect(firstCreates.filter(result => result.ok)).toHaveLength(1);
            expect(firstCreates.find(result => !result.ok)).toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: competingFixture.session.id } })).toBe(2);
            const winner = firstCreates.find(result => result.ok);
            if (!winner?.ok || winner.result.operation !== "upsert_item") throw new Error("Expected an acknowledged first create");
            const winnerItemId = winner.result.itemId;
            const expectedLayoutRevision = winner.result.layoutRevision;
            const competing = await settle(["third", "fourth"].map(itemId => invoke(competingFixture, { ...mutation(itemId),
                placement: { expectedLayoutRevision, layoutContent: { t: "plain", v: { v: 1,
                    tabs: [{ id: "overview", title: "Overview", items: [{ itemId: winnerItemId, width: "medium" }, { itemId, width: "medium" }] }] } } } })));
            expect(competing.filter(result => result.ok)).toHaveLength(1);
            expect(competing.find(result => !result.ok)).toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: competingFixture.session.id } })).toBe(3);
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            try {
                await deleteAccountFixture(exactFixture.account.id);
                await deleteAccountFixture(competingFixture.account.id);
            } catch (cleanupError) {
                if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "Board operation and fixture cleanup failed");
                throw cleanupError;
            }
        }
    });

    it("preserves Board aggregate atomicity, source authority, placement deletion, and opaque replay", async () => {
        const plainFixture = await createAccountAndSession(`board-aggregate-${randomUUID()}`);
        const encryptedFixture = await createAccountAndSession(`board-encrypted-${randomUUID()}`);
        const itemContent = (title: string) => ({ t: "plain" as const, v: { v: 1 as const, title, frame: "card" as const,
            height: { mode: "auto" as const, fallback: "regular" as const }, source: { kind: "declarative" as const,
                document: { version: 1 as const, root: { kind: "markdown" as const, text: title } } } } });
        const layoutContent = (title: string, itemIds: readonly string[]) => ({ t: "plain" as const, v: { v: 1 as const,
            tabs: [{ id: "overview", title, items: itemIds.map(itemId => ({ itemId, width: "medium" as const })) }] } });
        const invoke = (fixture: typeof plainFixture, mutation: unknown) => mutateSessionBoard({ authentication,
            actorUserId: fixture.account.id, sessionId: fixture.session.id, mutation });
        let operationError: unknown;
        try {
            const initialItem = itemContent("Initial");
            const initialLayout = layoutContent("Overview", ["note"]);
            const created = await invoke(plainFixture, { operation: "upsert_item", itemId: "note",
                itemContent: initialItem, expectedItemRevision: null,
                placement: { layoutContent: initialLayout, expectedLayoutRevision: null } });
            expect(created).toMatchObject({ ok: true, result: { operation: "upsert_item", outcome: "created" } });
            if (!created.ok || created.result.operation !== "upsert_item") throw new Error("Expected initial Board item creation");

            const converted = await invoke(plainFixture, { operation: "upsert_item", itemId: "note",
                itemContent: { ...initialItem, v: { ...initialItem.v,
                    source: { kind: "widget", instance: { v: 1, id: "note",
                        definition: { kind: "installed", surface: { pluginId: "com.acme.test", localId: "dashboard" } },
                        bindings: {} } } } },
                expectedItemRevision: created.result.itemRevision });
            expect(converted).toEqual({ ok: false, result: { error: "session_board_source_conflict" } });

            const advancedLayout = layoutContent("Advanced", ["note"]);
            const advanced = await invoke(plainFixture, { operation: "update_layout", layoutContent: advancedLayout,
                expectedLayoutRevision: created.result.layoutRevision });
            expect(advanced).toMatchObject({ ok: true, result: { operation: "update_layout", outcome: "updated" } });
            if (!advanced.ok || advanced.result.operation !== "update_layout") throw new Error("Expected layout update");

            const rolledBack = await invoke(plainFixture, { operation: "upsert_item", itemId: "note",
                itemContent: itemContent("Must roll back"), expectedItemRevision: created.result.itemRevision,
                placement: { layoutContent: layoutContent("Stale", ["note"]), expectedLayoutRevision: created.result.layoutRevision } });
            expect(rolledBack).toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
            const afterRollback = await db.sessionSystemRecord.findMany({ where: { sessionId: plainFixture.session.id },
                orderBy: { localId: "asc" }, select: { localId: true, content: true } });
            expect(afterRollback).toEqual([
                { localId: "layout", content: advancedLayout },
                { localId: "note", content: initialItem },
            ]);

            const stillPlaced = await invoke(plainFixture, { operation: "remove_item", itemId: "note",
                expectedItemRevision: created.result.itemRevision, layoutContent: advancedLayout,
                expectedLayoutRevision: advanced.result.layoutRevision });
            expect(stillPlaced).toEqual({ ok: false, result: { error: "session_board_invalid" } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: plainFixture.session.id, localId: "note" } })).toBe(1);

            const removalLayout = layoutContent("Advanced", []);
            const removal = { operation: "remove_item", itemId: "note", expectedItemRevision: created.result.itemRevision,
                layoutContent: removalLayout, expectedLayoutRevision: advanced.result.layoutRevision };
            const removed = await invoke(plainFixture, removal);
            expect(removed).toMatchObject({ ok: true, result: { operation: "remove_item", outcome: "removed" } });
            await expect(invoke(plainFixture, removal)).resolves.toEqual(removed);
            expect(await db.sessionSystemRecord.findMany({ where: { sessionId: plainFixture.session.id },
                select: { localId: true, content: true } })).toEqual([{ localId: "layout", content: removalLayout }]);

            await db.session.update({ where: { id: encryptedFixture.session.id }, data: { encryptionMode: "e2ee" } });
            const encryptedMutation = { operation: "upsert_item", itemId: "sealed", expectedItemRevision: null,
                itemContent: { t: "encrypted", c: "sealed-item-bytes" },
                placement: { expectedLayoutRevision: null, layoutContent: { t: "encrypted", c: "sealed-layout-bytes" } } };
            const encrypted = await invoke(encryptedFixture, encryptedMutation);
            expect(encrypted).toMatchObject({ ok: true, result: { operation: "upsert_item", outcome: "created" } });
            if (!encrypted.ok || encrypted.result.operation !== "upsert_item") throw new Error("Expected encrypted Board item creation");
            await expect(invoke(encryptedFixture, encryptedMutation)).resolves.toEqual({
                ok: true,
                result: {
                    operation: "upsert_item",
                    outcome: "unchanged",
                    itemId: "sealed",
                    itemRevision: encrypted.result.itemRevision,
                    layoutRevision: encrypted.result.layoutRevision,
                },
            });
            expect(await db.sessionSystemRecord.findMany({ where: { sessionId: encryptedFixture.session.id },
                orderBy: { localId: "asc" }, select: { localId: true, content: true } })).toEqual([
                { localId: "layout", content: encryptedMutation.placement.layoutContent },
                { localId: "sealed", content: encryptedMutation.itemContent },
            ]);
            await expect(invoke(encryptedFixture, { ...encryptedMutation,
                itemContent: { t: "encrypted", c: "different-sealed-item-bytes" } })).resolves
                .toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            try {
                await deleteAccountFixture(plainFixture.account.id);
                await deleteAccountFixture(encryptedFixture.account.id);
            } catch (cleanupError) {
                if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "Board operation and fixture cleanup failed");
                throw cleanupError;
            }
        }
    });

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED = "1";
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    });

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await db.$disconnect();
    });

    it("exposes only the canonical address identity and list indexes after contraction", async () => {
        const columns = provider === "mysql"
            ? await db.$queryRaw<Array<{
                column_name: string;
                is_nullable: string;
                character_maximum_length: bigint | number | null;
            }>>`
                SELECT
                    COLUMN_NAME AS column_name,
                    IS_NULLABLE AS is_nullable,
                    CHARACTER_MAXIMUM_LENGTH AS character_maximum_length
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                AND table_name = 'SessionSystemRecord'
                AND column_name IN (
                    'namespace', 'kind', 'ownerKind', 'pluginId',
                    'namespaceAddressKey', 'recordAddressKey', 'version'
                )
            `
            : await db.$queryRaw<Array<{
                column_name: string;
                is_nullable: string;
                character_maximum_length: number | null;
            }>>`
                SELECT column_name, is_nullable, character_maximum_length
                FROM information_schema.columns
                WHERE table_schema = 'public'
                AND table_name = 'SessionSystemRecord'
                AND column_name IN (
                    'namespace', 'kind', 'ownerKind', 'pluginId',
                    'namespaceAddressKey', 'recordAddressKey', 'version'
                )
            `;
        const byName = new Map(columns.map((column) => [column.column_name, column]));

        expect(byName.get("ownerKind")?.is_nullable).toBe("NO");
        expect(byName.get("pluginId")?.is_nullable).toBe("YES");
        expect(byName.get("namespaceAddressKey")?.is_nullable).toBe("NO");
        expect(byName.get("recordAddressKey")?.is_nullable).toBe("NO");
        expect(byName.get("version")?.is_nullable).toBe("NO");
        if (provider === "mysql") {
            expect(Number(byName.get("namespace")?.character_maximum_length)).toBe(64);
            expect(Number(byName.get("kind")?.character_maximum_length)).toBe(64);
        }

        const indexes = provider === "mysql"
            ? await db.$queryRaw<Array<{ index_name: string }>>`
                SELECT DISTINCT INDEX_NAME AS index_name
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                AND table_name = 'SessionSystemRecord'
            `
            : await db.$queryRaw<Array<{ index_name: string }>>`
                SELECT indexname AS index_name
                FROM pg_indexes
                WHERE schemaname = 'public'
                AND tablename = 'SessionSystemRecord'
            `;
        const indexNames = indexes.map((index) => index.index_name);
        expect(indexNames).toContain("SessionSystemRecord_account_session_record_key");
        expect(indexNames).toContain("SessionSystemRecord_account_namespace_kind_updated_idx");
        expect(indexNames).not.toContain("SessionSystemRecord_accountId_sessionId_namespace_localId_key");
        expect(indexNames).not.toContain("SessionSystemRecord_account_kind_updated_idx");
    });

    it("persists canonical host records and makes a derived-key mismatch fail the final audit", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(suffix);
        const localId = `memory:synopsis:v1:${suffix}`;
        try {
            await expect(upsertSessionSystemRecord({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                kind: "synopsis.v1",
                localId,
                content: synopsisContent("one"),
            })).resolves.toMatchObject({ ok: true, didCreate: true, didUpdate: false });

            await expect(upsertSessionSystemRecord({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                kind: "synopsis.v1",
                localId,
                content: synopsisContent("two"),
            })).resolves.toMatchObject({ ok: true, didCreate: false, didUpdate: true });

            const expected = deriveSessionSystemRecordAddressKeys({
                ownerKind: "host",
                pluginId: null,
                namespace: "memory",
                localId,
            });
            const stored = await db.sessionSystemRecord.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    sessionId: session.id,
                    recordAddressKey: expected.recordAddressKey,
                },
            });
            expect(stored.ownerKind).toBe("host");
            expect(stored.pluginId).toBeNull();
            expect(stored.namespaceAddressKey).toHaveLength(32);
            expect(stored.recordAddressKey).toHaveLength(32);
            expect(stored.version).toBe(2);

            await expect(runSessionSystemRecordBackfillOperator({
                pageSize: 100,
                timeBudgetMs: 10_000,
            })).resolves.toMatchObject({
                outcome: "drained",
                processed: 0,
                updated: 0,
                audit: { nullRows: 0, mismatchedRows: 0 },
            });

            await db.sessionSystemRecord.update({
                where: { id: stored.id },
                data: { recordAddressKey: Buffer.alloc(32, 0xa5) },
            });
            await expect(runSessionSystemRecordBackfillOperator({
                pageSize: 100,
                timeBudgetMs: 10_000,
            })).resolves.toMatchObject({
                outcome: "verification_failed",
                audit: { nullRows: 0, mismatchedRows: 1 },
            });
        } finally {
            await deleteAccountFixture(account.id);
        }
    });

    it("keeps plugin-qualified revisions distinct and enforces conditional update and delete", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`plugin-${suffix}`);
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: `note:${suffix}`,
        };
        try {
            const first = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "One" } },
                expectedRevision: null,
            });
            expect(first).toMatchObject({ ok: true, record: { revision: expect.stringMatching(/^ssr1\./) } });
            if (!first.ok) throw new Error("Expected first plugin record write to succeed");

            const secondPlugin = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.other",
                address,
                content: { t: "plain", v: { title: "Other" } },
                expectedRevision: null,
            });
            expect(secondPlugin).toMatchObject({ ok: true });

            const updated = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Two" } },
                expectedRevision: first.record.revision,
            });
            expect(updated).toMatchObject({ ok: true, record: { revision: expect.stringMatching(/^ssr1\./) } });
            if (!updated.ok) throw new Error("Expected conditional plugin record update to succeed");
            expect(updated.record.revision).not.toBe(first.record.revision);

            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: first.record.revision,
            })).resolves.toMatchObject({ ok: false, code: "plugin_session_record_revision_conflict" });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: updated.record.revision,
            })).resolves.toEqual({ ok: true });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: updated.record.revision,
            })).resolves.toEqual({ ok: true });
        } finally {
            await deleteAccountFixture(account.id);
        }
    });

    it("distinguishes omitted settlement from create-only and caller-CAS revisions", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`settlement-${suffix}`);
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: `note:${suffix}`,
        };
        try {
            const created = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Created" } },
                expectedRevision: null,
            });
            if (!created.ok) throw new Error("Expected create-only plugin record write to succeed");

            const settled = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Settled" } },
            });
            expect(settled).toMatchObject({
                ok: true,
                record: { content: { t: "plain", v: { title: "Settled" } } },
            });
            if (!settled.ok) throw new Error("Expected omitted revision to settle the current plugin record");
            expect(settled.record.revision).not.toBe(created.record.revision);

            await expect(upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Create only" } },
                expectedRevision: null,
            })).resolves.toEqual({
                ok: false,
                code: "plugin_session_record_revision_conflict",
                currentRevision: settled.record.revision,
            });
            await expect(upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Stale CAS" } },
                expectedRevision: created.record.revision,
            })).resolves.toEqual({
                ok: false,
                code: "plugin_session_record_revision_conflict",
                currentRevision: settled.record.revision,
            });

            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
            })).resolves.toEqual({ ok: true });
            const recreated = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Recreated" } },
                expectedRevision: null,
            });
            expect(recreated).toMatchObject({ ok: true });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
            })).resolves.toEqual({ ok: true });
        } finally {
            await deleteAccountFixture(account.id);
        }
    });

    it("stores byte-distinct same-session identities for case Unicode and punctuation", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`identity-${suffix}`);
        const localIds = ["Case", "case", "é", "e\u0301", "punct:[]!._-"] as const;
        try {
            const storedKeys: Buffer[] = [];
            for (const localId of localIds) {
                const keys = deriveSessionSystemRecordAddressKeys({
                    ownerKind: "host",
                    pluginId: null,
                    namespace: "memory",
                    localId,
                });
                const stored = await db.sessionSystemRecord.create({
                    data: {
                        accountId: account.id,
                        sessionId: session.id,
                        namespace: "memory",
                        kind: "synopsis.v1",
                        localId,
                        content: synopsisContent(localId),
                        ownerKind: "host",
                        pluginId: null,
                        namespaceAddressKey: keys.namespaceAddressKey,
                        recordAddressKey: keys.recordAddressKey,
                        version: 1,
                    },
                });
                storedKeys.push(Buffer.from(stored.recordAddressKey ?? []));
            }

            expect(new Set(storedKeys.map((key) => key.toString("hex"))).size).toBe(localIds.length);
            expect(storedKeys[0]!.equals(storedKeys[1]!)).toBe(false);
            expect(storedKeys[2]!.equals(storedKeys[3]!)).toBe(false);
        } finally {
            await deleteAccountFixture(account.id);
        }
    });
});
