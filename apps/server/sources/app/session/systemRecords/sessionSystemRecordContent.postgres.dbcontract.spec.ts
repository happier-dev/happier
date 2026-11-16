import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import {
    getLatestSessionSystemRecord, getSessionSystemRecord, listSessionSystemRecords,
    listSessionSystemRecordsV1, readSessionSystemRecordV1, upsertSessionSystemRecord,
    upsertSessionSystemRecordV1, writePermissionMediationRecord, readPermissionMediationRecord,
    listPermissionMediationRecords,
} from './sessionSystemRecordService';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from './sessionSystemRecordProtocolContract';

const disposablePostgres = process.env.HAPPIER_DB_PROVIDER === 'postgres'
    && /^[a-f0-9]{64}$/.test(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ?? '');

describe.skipIf(!disposablePostgres)('SessionSystemRecord lossless byte storage', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    const authentication = createPresentUserSessionAccessAuthentication();
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'system-record-bytes-', initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        // The lane's additive migration is a draft until integration. This suite
        // is restricted above to the canonical disposable PostgreSQL container.
        expect(await initializeSessionSystemRecordsProtocolV1Activation(db)).toBe(true);
    });
    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await harness?.close();
    });

    async function fixture(encryptionMode: 'plain' | 'e2ee' = 'e2ee') {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode }, select: { id: true } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode }, select: { id: true } });
        return { actorUserId: owner.id, sessionId: session.id, authentication };
    }

    async function expectBytes(id: string, bytes: number) {
        expect((await db.sessionSystemRecord.findUniqueOrThrow({ where: { id }, select: { content: true } })).content).toBeNull();
        const physical = await db.$queryRaw<Array<{ sqlNull: boolean; jsonNull: boolean; type: string; bytes: number; legacyJsonBytes: number; storedLogicalBytes: number }>>`
            SELECT "content" IS NULL AS "sqlNull", "content" = 'null'::jsonb AS "jsonNull",
                pg_typeof("contentBytes")::text AS type, octet_length("contentBytes") AS bytes,
                octet_length(jsonb_build_object('t', 'encrypted', 'c', encode("contentBytes", 'base64'))::text) AS "legacyJsonBytes",
                octet_length("content"::text) + octet_length("contentBytes") AS "storedLogicalBytes"
            FROM "SessionSystemRecord" WHERE "id" = ${id}`;
        expect(physical).toMatchObject([{ sqlNull: false, jsonNull: true, type: 'bytea', bytes }]);
        console.info(JSON.stringify({ storage: 'SessionSystemRecord', ciphertextBytes: bytes,
            legacyJsonBytes: physical[0].legacyJsonBytes, storedLogicalBytes: physical[0].storedLogicalBytes }));
    }

    it('round-trips plugin create/CAS/replay and exact/list reads, including retained JSON rows', async () => {
        const params = { ...await fixture(), pluginId: 'acme.notes',
            address: { owner: 'plugin' as const, namespace: 'notes', kind: 'entry.v1', localId: 'note' } };
        const content = { t: 'encrypted' as const, c: 'AAECAwQFBgcICQ==' };
        const created = await upsertSessionSystemRecordV1({ ...params, content, expectedRevision: null });
        expect(created).toMatchObject({ ok: true, record: { content } });
        if (!created.ok) throw new Error(created.code);
        await expectBytes(created.record.id, 10);
        const corrected = { t: 'encrypted' as const, c: 'CgsMDQ4P' };
        const updated = await upsertSessionSystemRecordV1({ ...params, content: corrected, expectedRevision: created.record.revision });
        expect(updated).toMatchObject({ ok: true, record: { content: corrected } });
        if (!updated.ok) throw new Error(updated.code);
        await expectBytes(updated.record.id, 6);
        expect(await upsertSessionSystemRecordV1({ ...params, content: corrected, expectedRevision: created.record.revision })).toEqual(updated);
        expect(await readSessionSystemRecordV1(params)).toEqual(updated);
        expect(await listSessionSystemRecordsV1({ ...params, query: { owner: 'plugin', namespace: 'notes', kind: 'entry.v1', limit: 100 } }))
            .toMatchObject({ ok: true, page: { records: [{ content: corrected }] } });
        // A retained JSON envelope remains readable without rewriting the row.
        await db.$executeRaw`UPDATE "SessionSystemRecord" SET "content" = ${JSON.stringify(content)}::jsonb, "contentBytes" = NULL WHERE "id" = ${updated.record.id}`;
        expect(await readSessionSystemRecordV1(params)).toMatchObject({ ok: true, record: { content } });
    });

    it('routes legacy host writes and exact/latest/list readers through the same byte representation', async () => {
        const params = { ...await fixture(), namespace: 'activity' as const, kind: 'workflow_run.v1' as const,
            localId: 'activity:workflow_run:v1:byte-fixture' };
        const content = { t: 'encrypted' as const, c: 'AAECAwQF' };
        const created = await upsertSessionSystemRecord({ ...params, content });
        expect(created).toMatchObject({ ok: true, record: { content } });
        if (!created.ok) throw new Error(created.error);
        await expectBytes(created.record.id, 6);
        expect(await getSessionSystemRecord(params)).toMatchObject({ ok: true, record: { content } });
        expect(await getLatestSessionSystemRecord(params)).toMatchObject({ ok: true, record: { content } });
        expect(await listSessionSystemRecords(params)).toMatchObject({ ok: true, records: [{ content }] });
        const corrected = { t: 'encrypted' as const, c: 'CgsMDQ==' };
        expect(await upsertSessionSystemRecord({ ...params, content: corrected })).toMatchObject({ ok: true, didUpdate: true, record: { content: corrected } });
        await expectBytes(created.record.id, 4);
    });

    it('round-trips the permission mediation create/update and exact/list readers', async () => {
        const params = await fixture();
        const identity = { sessionId: params.sessionId, turnId: randomUUID(), requestId: randomUUID() };
        const content = { t: 'encrypted' as const, c: 'AAECAw==' };
        const created = await writePermissionMediationRecord({ ...params, identity,
            request: { kind: 'remote_settlement.v1', content, expectedRevision: null } });
        expect(created).toMatchObject({ ok: true, record: { content } });
        if (!created.ok) throw new Error(created.code);
        const row = await db.sessionSystemRecord.findFirstOrThrow({ where: { sessionId: params.sessionId }, select: { id: true } });
        await expectBytes(row.id, 4);
        const corrected = { t: 'encrypted' as const, c: 'BAUGBwg=' };
        const updated = await writePermissionMediationRecord({ ...params, identity,
            request: { kind: 'remote_settlement.v1', content: corrected, expectedRevision: created.record.revision } });
        expect(updated).toMatchObject({ ok: true, record: { content: corrected } });
        await expectBytes(row.id, 5);
        expect(await readPermissionMediationRecord({ ...params, identity })).toEqual(updated);
        expect(await listPermissionMediationRecords({ ...params, query: { limit: 100 } })).toMatchObject({ ok: true, page: { records: [{ content: corrected }] } });
    });

    it('preserves plain and noncanonical encrypted envelopes exactly and clears bytes on replacement', async () => {
        for (const encryptionMode of ['plain', 'e2ee'] as const) {
            const params = { ...await fixture(encryptionMode), pluginId: 'acme.notes',
                address: { owner: 'plugin' as const, namespace: 'notes', kind: 'entry.v1', localId: 'exact' } };
            const content = encryptionMode === 'plain' ? { t: 'plain' as const, v: { exact: ['value', 1] } }
                : { t: 'encrypted' as const, c: 'historical-noncanonical-ciphertext' };
            if (encryptionMode === 'e2ee') {
                const canonical = await upsertSessionSystemRecordV1({ ...params, content: { t: 'encrypted', c: 'AAEC' } });
                if (!canonical.ok) throw new Error(canonical.code);
            }
            const result = await upsertSessionSystemRecordV1({ ...params, content });
            expect(result).toMatchObject({ ok: true, record: { content } });
            if (!result.ok) throw new Error(result.code);
            const [stored] = await db.$queryRaw<Array<{ content: unknown; bytesAbsent: boolean }>>`
                SELECT "content", "contentBytes" IS NULL AS "bytesAbsent" FROM "SessionSystemRecord" WHERE "id" = ${result.record.id}`;
            expect(stored).toEqual({ content, bytesAbsent: true });
            expect(await readSessionSystemRecordV1(params)).toEqual(result);
        }
    });
});
