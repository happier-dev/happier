import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
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

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
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
            await expect(upsertSessionSystemRecord({
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                kind: "synopsis.v1",
                localId,
                content: synopsisContent("one"),
            })).resolves.toMatchObject({ ok: true, didCreate: true, didUpdate: false });

            await expect(upsertSessionSystemRecord({
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
            const first = await upsertSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "One" } },
                expectedRevision: null,
            });
            expect(first).toMatchObject({ ok: true, record: { revision: expect.stringMatching(/^ssr1\./) } });
            if (!first.ok) throw new Error("Expected first plugin record write to succeed");

            const secondPlugin = await upsertSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.other",
                address,
                content: { t: "plain", v: { title: "Other" } },
                expectedRevision: null,
            });
            expect(secondPlugin).toMatchObject({ ok: true });

            const updated = await upsertSessionSystemRecordV1({
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

            await expect(deleteSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: first.record.revision,
            })).resolves.toMatchObject({ ok: false, code: "plugin_session_record_revision_conflict" });
            await expect(deleteSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: updated.record.revision,
            })).resolves.toEqual({ ok: true });
            await expect(deleteSessionSystemRecordV1({
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
            const created = await upsertSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Created" } },
                expectedRevision: null,
            });
            if (!created.ok) throw new Error("Expected create-only plugin record write to succeed");

            const settled = await upsertSessionSystemRecordV1({
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

            await expect(upsertSessionSystemRecordV1({
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
            await expect(upsertSessionSystemRecordV1({
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

            await expect(deleteSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
            })).resolves.toEqual({ ok: true });
            const recreated = await upsertSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Recreated" } },
                expectedRevision: null,
            });
            expect(recreated).toMatchObject({ ok: true });
            await expect(deleteSessionSystemRecordV1({
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
