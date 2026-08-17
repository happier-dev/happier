import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import { runSessionSystemRecordBackfillOperator } from "./sessionSystemRecordBackfillOperator";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from "./sessionSystemRecordProtocolContract";
import {
    deleteSessionSystemRecordV1,
    getSessionSystemRecord,
    upsertSessionSystemRecord,
    upsertSessionSystemRecordV1,
} from "./sessionSystemRecordService";

async function createAccountAndSession(suffix: string) {
    const account = await db.account.create({
        data: { publicKey: `ssr-sqlite-${suffix}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `ssr-sqlite-${suffix}`,
            encryptionMode: "plain",
            metadata: "{}",
        },
        select: { id: true },
    });
    return { account, session };
}

describe("SessionSystemRecord CONTRACT on SQLite", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-system-record-contract-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    }, 300_000);

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await harness?.close();
    });

    it("materializes final required address columns and canonical indexes", async () => {
        const columns = await db.$queryRawUnsafe<Array<{ name: string; notnull: bigint | number }>>(
            'PRAGMA table_info("SessionSystemRecord")',
        );
        const byName = new Map(columns.map((column) => [column.name, Number(column.notnull)]));
        expect(byName.get("ownerKind")).toBe(1);
        expect(byName.get("pluginId")).toBe(0);
        expect(byName.get("namespaceAddressKey")).toBe(1);
        expect(byName.get("recordAddressKey")).toBe(1);
        expect(byName.get("version")).toBe(1);

        const indexes = await db.$queryRawUnsafe<Array<{ name: string }>>(
            'PRAGMA index_list("SessionSystemRecord")',
        );
        const names = indexes.map((index) => index.name);
        expect(names).toContain("SessionSystemRecord_account_session_record_key");
        expect(names).toContain("SessionSystemRecord_account_namespace_kind_updated_idx");
        expect(names).not.toContain("SessionSystemRecord_accountId_sessionId_namespace_localId_key");
        expect(names).not.toContain("SessionSystemRecord_account_kind_updated_idx");
    });

    it("reads a canonical stored host row whose local id predates the author-v1 bound", async () => {
        const suffix = randomUUID();
        const longLocalId = `legacy:${"x".repeat(300)}`;
        const { account, session } = await createAccountAndSession(`long-${suffix}`);
        try {
            const keys = deriveSessionSystemRecordAddressKeys({
                ownerKind: "host",
                pluginId: null,
                namespace: "memory",
                localId: longLocalId,
            });
            await db.sessionSystemRecord.create({
                data: {
                    accountId: account.id,
                    sessionId: session.id,
                    namespace: "memory",
                    kind: "synopsis.v1",
                    localId: longLocalId,
                    content: {
                        t: "plain",
                        v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "legacy long id" },
                    },
                    ownerKind: "host",
                    pluginId: null,
                    namespaceAddressKey: keys.namespaceAddressKey,
                    recordAddressKey: keys.recordAddressKey,
                    version: 1,
                },
            });

            await expect(getSessionSystemRecord({
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                localId: longLocalId,
            })).resolves.toMatchObject({
                ok: true,
                record: { localId: longLocalId },
            });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);

    it("audits canonical writes and fails closed on a derived-key mismatch", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`audit-${suffix}`);
        const localId = `memory:synopsis:v1:${suffix}`;
        try {
            const created = await upsertSessionSystemRecord({
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                kind: "synopsis.v1",
                localId,
                content: { t: "plain", v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "one" } },
            });
            expect(created).toMatchObject({ ok: true, didCreate: true });
            if (!created.ok) throw new Error("Expected canonical host record write to succeed");

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
                where: { id: created.record.id },
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
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);

    it("enforces plugin-qualified revision CAS and idempotent conditional delete", async () => {
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
            expect(first).toMatchObject({ ok: true });
            if (!first.ok) throw new Error("Expected plugin record write to succeed");

            const updated = await upsertSessionSystemRecordV1({
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Two" } },
                expectedRevision: first.record.revision,
            });
            expect(updated).toMatchObject({ ok: true });
            if (!updated.ok) throw new Error("Expected conditional plugin record update to succeed");

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
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);

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
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 120_000);
});
