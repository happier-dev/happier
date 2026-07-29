import { createHash, randomUUID } from 'node:crypto';

import {
    createSessionSubagentCustodyKeyV1,
    createSessionSubagentCustodyPlainContentFingerprintV1,
    type SessionSubagentCustodyScopeV1,
} from '@happier-dev/protocol';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registerSessionSubagentCustodyRoutes } from '@/app/api/routes/session/registerSessionSubagentCustodyRoutes';
import type { Fastify } from '@/app/api/types';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { createEnvPatcher } from '@/testkit/env';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import {
    listSessionSubagentCustody,
    mutateSessionSubagentCustody,
    retireSessionSubagentCustodyGeneration,
} from './sessionSubagentCustodyService';

describe('durable subagent custody on SQLite', () => {
    let harness: LightSqliteHarness;
    const storagePolicyEnv = createEnvPatcher(['HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY']);

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-subagent-custody-',
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
            env: { HAPPIER_SQLITE_CONNECTION_LIMIT: '2' },
        });
    }, 120_000);
    beforeEach(() => {
        harness.resetEnv();
        storagePolicyEnv.restore();
        storagePolicyEnv.set('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
    });
    afterAll(async () => {
        storagePolicyEnv.restore();
        await harness.close();
    });

    async function seed(encryptionMode: 'e2ee' | 'plain' = 'e2ee') {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `tag-${randomUUID()}`, metadata: '{}', encryptionMode },
        });
        return { account, session };
    }

    function custodyScope(overrides: Partial<SessionSubagentCustodyScopeV1> = {}): SessionSubagentCustodyScopeV1 {
        return {
            pluginId: 'acme.agent',
            contributionId: 'assistant',
            immutableGenerationId: `generation-${randomUUID()}`,
            ...overrides,
        };
    }

    function request(
        sessionId: string,
        overrides: Partial<Parameters<typeof mutateSessionSubagentCustody>[0]['request']> = {},
    ) {
        const content = overrides.content ?? { t: 'encrypted' as const, c: 'b3BhcXVlLWNpcGhlcnRleHQ=' };
        const scope = overrides.scope ?? custodyScope();
        return {
            operationId: `operation-${randomUUID()}`,
            scope,
            custodyKey: createSessionSubagentCustodyKeyV1({ ...scope, sessionId }),
            subagentId: `subagent-${randomUUID()}`,
            groupId: null,
            expectedRevision: null,
            status: 'running' as const,
            contentFingerprint: content.t === 'plain'
                ? createSessionSubagentCustodyPlainContentFingerprintV1(content.v)
                : `hmac-sha256:${'a'.repeat(64)}` as const,
            content,
            ...overrides,
        };
    }

    it('atomically persists one record and one replay receipt, preserves group identity, and cascades both', async () => {
        const { account, session } = await seed();
        const mutation = request(session.id, { groupId: `group-${randomUUID()}` });

        const created = await mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: mutation });
        expect(created).toMatchObject({ ok: true, replayed: false, record: { groupId: mutation.groupId, revision: 0 } });
        if (!created.ok) throw new Error(created.error);
        expect(created.record).not.toHaveProperty('content');
        expect(created.record).not.toHaveProperty('custodyKey');
        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: mutation }))
            .resolves.toEqual({ ...created, replayed: true });

        await expect(db.sessionSubagentCustody.findFirstOrThrow({
            where: { accountId: account.id, sessionId: session.id, custodyKey: mutation.custodyKey, subagentId: mutation.subagentId },
        })).resolves.toMatchObject({ groupId: mutation.groupId, content: mutation.content });
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: session.id } })).resolves.toBe(1);

        await db.session.delete({ where: { id: session.id } });
        await expect(db.sessionSubagentCustody.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    });

    it('linearizes concurrent retries of the same operation as one write plus one replay', async () => {
        const { account, session } = await seed();
        const mutation = request(session.id);
        const results = await Promise.all([
            mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: mutation }),
            mutateSessionSubagentCustody({
                actorUserId: account.id,
                sessionId: session.id,
                request: { ...mutation, content: { t: 'encrypted', c: 'c2FtZS1kZXRhaWwtZnJlc2gtY2lwaGVydGV4dA==' } },
            }),
        ]);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
        await expect(db.sessionSubagentCustody.count({ where: { sessionId: session.id } })).resolves.toBe(1);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: session.id } })).resolves.toBe(1);
    });

    it('replays equal encrypted semantics after database-client recreation and preserves the first committed envelope', async () => {
        const { account, session } = await seed();
        const first = request(session.id, { content: { t: 'encrypted', c: 'Y2lwaGVydGV4dC13aXRoLW5vbmNlLWE=' } });
        const retry = { ...first, content: { t: 'encrypted' as const, c: 'Y2lwaGVydGV4dC13aXRoLW5vbmNlLWI=' } };

        const created = await mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: first });
        await db.$disconnect();
        await db.$connect();
        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: retry }))
            .resolves.toEqual({ ...created, replayed: true });
        await expect(db.sessionSubagentCustody.findFirstOrThrow({ where: { sessionId: session.id } }))
            .resolves.toMatchObject({ content: first.content });
    });

    it('conflicts changed encrypted detail fingerprints and rejects spoofed plain fingerprints before writing', async () => {
        const { account: encryptedOwner, session: encryptedSession } = await seed();
        const first = request(encryptedSession.id);
        await expect(mutateSessionSubagentCustody({ actorUserId: encryptedOwner.id, sessionId: encryptedSession.id, request: first }))
            .resolves.toMatchObject({ ok: true, replayed: false });
        await expect(mutateSessionSubagentCustody({
            actorUserId: encryptedOwner.id,
            sessionId: encryptedSession.id,
            request: { ...first, content: { t: 'encrypted', c: 'ZGlmZmVyZW50' }, contentFingerprint: `hmac-sha256:${'b'.repeat(64)}` },
        })).resolves.toEqual({ ok: false, error: 'idempotency-conflict' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: encryptedOwner.id,
            sessionId: encryptedSession.id,
            request: { ...first, groupId: 'changed-non-content-field', content: { t: 'encrypted', c: 'ZnJlc2gtY2lwaGVydGV4dA==' } },
        })).resolves.toEqual({ ok: false, error: 'idempotency-conflict' });

        const { account: plainOwner, session: plainSession } = await seed('plain');
        const spoofed = request(plainSession.id, {
            content: { t: 'plain', v: { private: 'detail' } },
            contentFingerprint: `sha256:${'0'.repeat(64)}`,
        });
        await expect(mutateSessionSubagentCustody({ actorUserId: plainOwner.id, sessionId: plainSession.id, request: spoofed }))
            .resolves.toEqual({ ok: false, error: 'invalid-params' });
        await expect(db.sessionSubagentCustody.count({ where: { sessionId: plainSession.id } })).resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: plainSession.id } })).resolves.toBe(0);
    });

    it('replays the same operation across CAS retry state while conflicting semantic changes', async () => {
        const { account, session } = await seed();
        const first = request(session.id, { operationId: 'semantic-operation' });
        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: first }))
            .resolves.toMatchObject({ ok: true, replayed: false });
        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...first, expectedRevision: 0 },
        })).resolves.toMatchObject({ ok: true, replayed: true, record: { revision: 0 } });

        for (const changed of [
            { ...first, subagentId: `${first.subagentId}-other` },
            { ...first, groupId: 'other-group' },
            { ...first, status: 'completed' as const },
        ]) {
            await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: changed }))
                .resolves.toEqual({ ok: false, error: 'idempotency-conflict' });
        }

        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...first, operationId: 'independent-operation', subagentId: `${first.subagentId}-independent` },
        })).resolves.toMatchObject({ ok: true, replayed: false });
        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: request(session.id, { operationId: first.operationId, subagentId: first.subagentId }),
        })).resolves.toMatchObject({ ok: true, replayed: false });
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: session.id } })).resolves.toBe(3);
    });

    it('rejects a custody key that does not match the authenticated session and qualified generation before writing', async () => {
        const { account, session } = await seed();
        const mutation = request(session.id);
        const mismatchedKey = createSessionSubagentCustodyKeyV1({ ...mutation.scope, sessionId: 'different-session' });

        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...mutation, custodyKey: mismatchedKey },
        })).resolves.toEqual({ ok: false, error: 'invalid-params' });
        await expect(db.sessionSubagentCustody.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { accountId: account.id } })).resolves.toBe(0);
    });

    it('isolates owner and shared-participant custody while denying an outsider and revoked share', async () => {
        const { account: owner, session } = await seed();
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const outsider = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const share = await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: participant.id,
                accessLevel: 'view',
                canApprovePermissions: false,
            },
        });
        const scope = custodyScope();
        const sharedIdentity = `shared-id-${randomUUID()}`;
        const ownerWrite = request(session.id, { scope, subagentId: sharedIdentity, operationId: 'same-operation' });
        const participantWrite = request(session.id, { scope, subagentId: sharedIdentity, operationId: 'same-operation' });

        await expect(mutateSessionSubagentCustody({ actorUserId: owner.id, sessionId: session.id, request: ownerWrite }))
            .resolves.toMatchObject({ ok: true, replayed: false });
        await expect(mutateSessionSubagentCustody({ actorUserId: participant.id, sessionId: session.id, request: participantWrite }))
            .resolves.toMatchObject({ ok: true, replayed: false });
        await expect(listSessionSubagentCustody({ actorUserId: owner.id, sessionId: session.id, query: { ...scope, custodyKey: ownerWrite.custodyKey } }))
            .resolves.toMatchObject({ ok: true, records: [{ subagentId: sharedIdentity }] });
        await expect(listSessionSubagentCustody({ actorUserId: participant.id, sessionId: session.id, query: { ...scope, custodyKey: ownerWrite.custodyKey } }))
            .resolves.toMatchObject({ ok: true, records: [{ subagentId: sharedIdentity }] });
        await expect(mutateSessionSubagentCustody({ actorUserId: outsider.id, sessionId: session.id, request: request(session.id, { scope }) }))
            .resolves.toEqual({ ok: false, error: 'session-not-found' });
        await expect(db.sessionSubagentCustody.groupBy({ by: ['accountId'], where: { sessionId: session.id }, _count: true }))
            .resolves.toEqual(expect.arrayContaining([
                expect.objectContaining({ accountId: owner.id, _count: 1 }),
                expect.objectContaining({ accountId: participant.id, _count: 1 }),
            ]));

        await db.sessionShare.delete({ where: { id: share.id } });
        await expect(listSessionSubagentCustody({ actorUserId: participant.id, sessionId: session.id, query: { ...scope, custodyKey: ownerWrite.custodyKey } }))
            .resolves.toEqual({ ok: false, error: 'session-not-found' });
    });

    it('enforces storage-mode compatibility without persisting a record or receipt', async () => {
        const { account: encryptedOwner, session: encryptedSession } = await seed('e2ee');
        const { account: plainOwner, session: plainSession } = await seed('plain');

        await expect(mutateSessionSubagentCustody({
            actorUserId: encryptedOwner.id,
            sessionId: encryptedSession.id,
            request: request(encryptedSession.id, { content: { t: 'plain', v: { visible: true } } }),
        })).resolves.toEqual({ ok: false, error: 'invalid-params', code: 'session_encryption_mode_mismatch' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: plainOwner.id,
            sessionId: plainSession.id,
            request: request(plainSession.id, { content: { t: 'encrypted', c: 'Y2lwaGVydGV4dA==' } }),
        })).resolves.toEqual({ ok: false, error: 'invalid-params', code: 'session_encryption_mode_mismatch' });
        const sessionIds = [encryptedSession.id, plainSession.id];
        await expect(db.sessionSubagentCustody.count({ where: { sessionId: { in: sessionIds } } })).resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: { in: sessionIds } } })).resolves.toBe(0);
    });

    it('keeps long and case-distinct opaque identities exact while canonicalizing plain JSON fingerprints', async () => {
        const { account, session } = await seed('plain');
        const scope = custodyScope();
        const longId = ` Qualified-${'x'.repeat(1_000)} `;
        const first = request(session.id, {
            operationId: ' Operation ',
            scope,
            subagentId: longId,
            groupId: '',
            content: { t: 'plain', v: { z: 1, A: 2, 'é': 3 } },
        });
        const second = request(session.id, {
            operationId: ' Operation  ',
            scope,
            subagentId: longId.toLowerCase(),
            groupId: ' Group ',
            content: { t: 'plain', v: null },
        });

        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: first }))
            .resolves.toMatchObject({ ok: true, replayed: false, record: { subagentId: longId, groupId: '' } });
        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: second }))
            .resolves.toMatchObject({ ok: true, replayed: false, record: { subagentId: longId.toLowerCase(), groupId: ' Group ' } });
        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...first, content: { t: 'plain', v: { 'é': 3, A: 2, z: 1 } } },
        })).resolves.toMatchObject({ ok: true, replayed: true });

        const listed = await listSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, query: { ...scope, custodyKey: first.custodyKey } });
        expect(listed).toMatchObject({ ok: true });
        if (!listed.ok) throw new Error(listed.error);
        expect(listed.records.map((record) => record.subagentId)).toEqual(expect.arrayContaining([longId, longId.toLowerCase()]));
        expect(listed.records).toHaveLength(2);
    });

    it('rolls back the record when durable receipt insertion fails', async () => {
        const { account, session } = await seed();
        await db.$executeRawUnsafe(`
            CREATE TRIGGER force_subagent_receipt_failure
            BEFORE INSERT ON SessionSubagentCustodyReceipt
            BEGIN
                SELECT RAISE(ABORT, 'forced receipt failure');
            END
        `);
        try {
            await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: request(session.id) }))
                .resolves.toEqual({ ok: false, error: 'internal' });
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS force_subagent_receipt_failure');
        }
        await expect(db.sessionSubagentCustody.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    });

    it('linearizes competing operation ids for one new record as one success and one CAS conflict', async () => {
        const { account, session } = await seed();
        const base = request(session.id);
        const results = await Promise.all([
            mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: { ...base, operationId: 'race-a' } }),
            mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: { ...base, operationId: 'race-b' } }),
        ]);
        expect(results).toEqual(expect.arrayContaining([
            expect.objectContaining({ ok: true, replayed: false }),
            { ok: false, error: 'cas-conflict' },
        ]));
        await expect(db.sessionSubagentCustody.count({ where: { sessionId: session.id } })).resolves.toBe(1);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: session.id } })).resolves.toBe(1);
    });

    it('enforces real CAS and terminal monotonicity while preserving immutable replay summaries', async () => {
        const { account, session } = await seed();
        const initial = request(session.id);
        const created = await mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: initial });
        expect(created).toMatchObject({ ok: true, replayed: false, record: { revision: 0, status: 'running' } });

        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...initial, operationId: 'stale-cas', expectedRevision: 9 },
        })).resolves.toEqual({ ok: false, error: 'cas-conflict' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...initial, operationId: 'complete', expectedRevision: 0, status: 'completed' },
        })).resolves.toMatchObject({ ok: true, replayed: false, record: { revision: 1, status: 'completed' } });
        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...initial, operationId: 'terminal-regression', expectedRevision: 1, status: 'running' },
        })).resolves.toEqual({ ok: false, error: 'terminal-regression' });
        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: initial }))
            .resolves.toEqual({ ...created, replayed: true });
    });

    it('rejects the 257th record and 4097th active receipt before mutation', async () => {
        const { account, session } = await seed();
        const recordScope = custodyScope();
        const recordCustodyKey = createSessionSubagentCustodyKeyV1({ ...recordScope, sessionId: session.id });
        await db.sessionSubagentCustody.createMany({
            data: Array.from({ length: 256 }, (_, index) => ({
                accountId: account.id,
                sessionId: session.id,
                ...recordScope,
                custodyKey: recordCustodyKey,
                subagentId: `seeded-record-${index}`,
                subagentKey: index.toString(16).padStart(64, '0'),
                groupId: null,
                status: 'running',
                revision: 0,
                content: { t: 'encrypted', c: `ciphertext-${index}` },
            })),
        });
        const overRecordCap = request(session.id, { scope: recordScope, operationId: 'record-257' });
        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: overRecordCap }))
            .resolves.toEqual({ ok: false, error: 'capacity-exceeded' });
        await expect(db.sessionSubagentCustody.count({ where: { accountId: account.id, sessionId: session.id, custodyKey: recordCustodyKey } }))
            .resolves.toBe(256);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { accountId: account.id, sessionId: session.id, custodyKey: recordCustodyKey } }))
            .resolves.toBe(0);

        const receiptScope = custodyScope();
        const receiptCustodyKey = createSessionSubagentCustodyKeyV1({ ...receiptScope, sessionId: session.id });
        const resultUpdatedAt = new Date();
        const expiresAt = new Date(Date.now() + 60_000);
        await db.sessionSubagentCustodyReceipt.createMany({
            data: Array.from({ length: 4_096 }, (_, index) => ({
                accountId: account.id,
                sessionId: session.id,
                ...receiptScope,
                custodyKey: receiptCustodyKey,
                operationId: `seeded-operation-${index}`,
                requestDigest: index.toString(16).padStart(64, '0'),
                resultSubagentId: `seeded-subagent-${index}`,
                resultGroupId: null,
                resultStatus: 'running',
                resultRevision: 0,
                resultUpdatedAt,
                expiresAt,
            })),
        });
        const overReceiptCap = request(session.id, { scope: receiptScope, operationId: 'receipt-4097' });
        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: overReceiptCap }))
            .resolves.toEqual({ ok: false, error: 'capacity-exceeded' });
        await expect(db.sessionSubagentCustody.count({ where: { accountId: account.id, sessionId: session.id, custodyKey: receiptCustodyKey } }))
            .resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { accountId: account.id, sessionId: session.id, custodyKey: receiptCustodyKey } }))
            .resolves.toBe(4_096);
    });

    it('enforces exact actor-session record and active-receipt caps across custody scopes', async () => {
        const { account: recordOwner, session: recordSession } = await seed();
        const firstRecordScope = custodyScope();
        const firstRecordCustodyKey = createSessionSubagentCustodyKeyV1({ ...firstRecordScope, sessionId: recordSession.id });
        await db.sessionSubagentCustody.createMany({
            data: Array.from({ length: 255 }, (_, index) => {
                const subagentId = `aggregate-seeded-record-${index}`;
                return {
                    accountId: recordOwner.id,
                    sessionId: recordSession.id,
                    ...firstRecordScope,
                    custodyKey: firstRecordCustodyKey,
                    subagentId,
                    subagentKey: createHash('sha256').update(subagentId, 'utf8').digest('hex'),
                    groupId: null,
                    status: 'running',
                    revision: 0,
                    content: { t: 'encrypted', c: `seeded-${index}` },
                };
            }),
        });
        const exactRecordCap = request(recordSession.id, { operationId: 'aggregate-record-256' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: recordOwner.id,
            sessionId: recordSession.id,
            request: exactRecordCap,
        })).resolves.toMatchObject({ ok: true, replayed: false });
        const overRecordCap = request(recordSession.id, { operationId: 'aggregate-record-257' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: recordOwner.id,
            sessionId: recordSession.id,
            request: overRecordCap,
        })).resolves.toEqual({ ok: false, error: 'capacity-exceeded' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: recordOwner.id,
            sessionId: recordSession.id,
            request: request(recordSession.id, {
                scope: firstRecordScope,
                operationId: 'aggregate-record-update-at-cap',
                subagentId: 'aggregate-seeded-record-0',
                expectedRevision: 0,
                status: 'completed',
            }),
        })).resolves.toMatchObject({ ok: true, replayed: false, record: { revision: 1, status: 'completed' } });
        await expect(db.sessionSubagentCustody.count({
            where: { accountId: recordOwner.id, sessionId: recordSession.id },
        })).resolves.toBe(256);
        await expect(db.sessionSubagentCustodyReceipt.count({
            where: { accountId: recordOwner.id, sessionId: recordSession.id },
        })).resolves.toBe(2);

        const { account: receiptOwner, session: receiptSession } = await seed();
        const receiptScopes = [custodyScope(), custodyScope()];
        const receiptCustodyKeys = receiptScopes.map((scope) => createSessionSubagentCustodyKeyV1({ ...scope, sessionId: receiptSession.id }));
        const expiredScope = custodyScope();
        const expiredCustodyKey = createSessionSubagentCustodyKeyV1({ ...expiredScope, sessionId: receiptSession.id });
        const resultUpdatedAt = new Date();
        await db.sessionSubagentCustodyReceipt.createMany({
            data: [
                ...Array.from({ length: 4_095 }, (_, index) => ({
                    accountId: receiptOwner.id,
                    sessionId: receiptSession.id,
                    ...receiptScopes[index % receiptScopes.length]!,
                    custodyKey: receiptCustodyKeys[index % receiptCustodyKeys.length]!,
                    operationId: `aggregate-active-operation-${index}`,
                    requestDigest: index.toString(16).padStart(64, '0'),
                    resultSubagentId: `aggregate-active-subagent-${index}`,
                    resultGroupId: null,
                    resultStatus: 'running',
                    resultRevision: 0,
                    resultUpdatedAt,
                    expiresAt: new Date(Date.now() + 60_000),
                })),
                ...Array.from({ length: 256 }, (_, index) => ({
                    accountId: receiptOwner.id,
                    sessionId: receiptSession.id,
                    ...expiredScope,
                    custodyKey: expiredCustodyKey,
                    operationId: `aggregate-expired-operation-${index}`,
                    requestDigest: `expired-${index}`,
                    resultSubagentId: `aggregate-expired-subagent-${index}`,
                    resultGroupId: null,
                    resultStatus: 'completed',
                    resultRevision: 1,
                    resultUpdatedAt,
                    expiresAt: new Date(1_000),
                })),
            ],
        });
        const exactReceiptCap = request(receiptSession.id, { operationId: 'aggregate-receipt-4096' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: receiptOwner.id,
            sessionId: receiptSession.id,
            request: exactReceiptCap,
        })).resolves.toMatchObject({ ok: true, replayed: false });
        await expect(mutateSessionSubagentCustody({
            actorUserId: receiptOwner.id,
            sessionId: receiptSession.id,
            request: exactReceiptCap,
        })).resolves.toMatchObject({ ok: true, replayed: true });
        const overReceiptCap = request(receiptSession.id, { operationId: 'aggregate-receipt-4097' });
        await expect(mutateSessionSubagentCustody({
            actorUserId: receiptOwner.id,
            sessionId: receiptSession.id,
            request: overReceiptCap,
        })).resolves.toEqual({ ok: false, error: 'capacity-exceeded' });
        await expect(db.sessionSubagentCustodyReceipt.count({
            where: { accountId: receiptOwner.id, sessionId: receiptSession.id, expiresAt: { gt: new Date() } },
        })).resolves.toBe(4_096);
        await expect(db.sessionSubagentCustodyReceipt.count({
            where: { accountId: receiptOwner.id, sessionId: receiptSession.id, expiresAt: { lte: new Date() } },
        })).resolves.toBe(0);
        await expect(db.sessionSubagentCustody.count({
            where: { accountId: receiptOwner.id, sessionId: receiptSession.id },
        })).resolves.toBe(1);
    });

    it('retires one explicit obsolete generation across the authenticated actor, preserves current/rollback and other actors, and fences stale recreation', async () => {
        const { account: owner, session } = await seed();
        const secondSession = await db.session.create({
            data: { accountId: owner.id, tag: `tag-${randomUUID()}`, metadata: '{}', encryptionMode: 'e2ee' },
        });
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: participant.id,
                accessLevel: 'view',
                canApprovePermissions: false,
            },
        });
        const currentScope = custodyScope({ immutableGenerationId: 'generation-current' });
        const rollbackScope = custodyScope({ immutableGenerationId: 'generation-rollback' });
        const releasedScope = custodyScope({ immutableGenerationId: 'generation-released' });
        const currentWrite = request(session.id, { scope: currentScope, operationId: 'current-operation' });
        const rollbackWrite = request(session.id, { scope: rollbackScope, operationId: 'rollback-operation' });
        const releasedWrite = request(session.id, { scope: releasedScope, operationId: 'released-operation' });
        const releasedSecondSessionWrite = request(secondSession.id, { scope: releasedScope, operationId: 'released-second-session' });
        const participantWrite = request(session.id, {
            scope: releasedScope,
            operationId: 'participant-operation',
            subagentId: `participant-${randomUUID()}`,
        });

        for (const mutation of [currentWrite, rollbackWrite, releasedWrite]) {
            await expect(mutateSessionSubagentCustody({ actorUserId: owner.id, sessionId: session.id, request: mutation }))
                .resolves.toMatchObject({ ok: true, replayed: false });
        }
        await expect(mutateSessionSubagentCustody({ actorUserId: owner.id, sessionId: secondSession.id, request: releasedSecondSessionWrite }))
            .resolves.toMatchObject({ ok: true, replayed: false });
        await expect(mutateSessionSubagentCustody({ actorUserId: participant.id, sessionId: session.id, request: participantWrite }))
            .resolves.toMatchObject({ ok: true, replayed: false });

        await expect(retireSessionSubagentCustodyGeneration({
            actorUserId: owner.id,
            request: { pluginId: releasedScope.pluginId, immutableGenerationId: releasedScope.immutableGenerationId },
        })).resolves.toEqual({ ok: true });
        await expect(db.sessionSubagentCustody.count({
            where: { accountId: owner.id, pluginId: releasedScope.pluginId, immutableGenerationId: releasedScope.immutableGenerationId },
        })).resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({
            where: { accountId: owner.id, pluginId: releasedScope.pluginId, immutableGenerationId: releasedScope.immutableGenerationId },
        })).resolves.toBe(0);
        await expect(db.sessionSubagentCustody.count({
            where: { accountId: owner.id, immutableGenerationId: { in: [currentScope.immutableGenerationId, rollbackScope.immutableGenerationId] } },
        })).resolves.toBe(2);
        await expect(db.sessionSubagentCustodyReceipt.count({
            where: { accountId: owner.id, immutableGenerationId: { in: [currentScope.immutableGenerationId, rollbackScope.immutableGenerationId] } },
        })).resolves.toBe(2);
        await expect(db.sessionSubagentCustody.count({
            where: { accountId: participant.id, sessionId: session.id, immutableGenerationId: releasedScope.immutableGenerationId },
        })).resolves.toBe(1);

        await expect(retireSessionSubagentCustodyGeneration({
            actorUserId: owner.id,
            request: { pluginId: releasedScope.pluginId, immutableGenerationId: releasedScope.immutableGenerationId },
        })).resolves.toEqual({ ok: true });
        await db.$disconnect();
        await db.$connect();
        await expect(mutateSessionSubagentCustody({
            actorUserId: owner.id,
            sessionId: session.id,
            request: { ...releasedWrite, operationId: 'stale-handle-after-retirement' },
        })).resolves.toEqual({ ok: false, error: 'generation-retired' });
        await expect(mutateSessionSubagentCustody({ actorUserId: owner.id, sessionId: session.id, request: currentWrite }))
            .resolves.toMatchObject({ ok: true, replayed: true });
        await expect(mutateSessionSubagentCustody({ actorUserId: owner.id, sessionId: session.id, request: rollbackWrite }))
            .resolves.toMatchObject({ ok: true, replayed: true });

        await db.session.delete({ where: { id: session.id } });
        await expect(db.sessionSubagentCustodyRetiredGeneration.count({ where: { accountId: owner.id } })).resolves.toBe(1);
    });

    it('fails the 4097th actor generation tombstone visibly without eviction or deleting its live custody', async () => {
        const { account, session } = await seed();
        const retainedGenerationId = 'retained-generation';
        const target = request(session.id, { operationId: 'retirement-capacity-target' });
        await db.sessionSubagentCustodyRetiredGeneration.createMany({
            data: [
                { accountId: account.id, pluginId: 'acme.retained', immutableGenerationId: retainedGenerationId, capacitySlot: 0 },
                ...Array.from({ length: 4_095 }, (_, index) => ({
                    accountId: account.id,
                    pluginId: `acme.seed-${index}`,
                    immutableGenerationId: `generation-${index}`,
                    capacitySlot: index + 1,
                })),
            ],
        });
        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: target,
        })).resolves.toMatchObject({ ok: true, replayed: false });

        await expect(retireSessionSubagentCustodyGeneration({
            actorUserId: account.id,
            request: { pluginId: 'acme.retained', immutableGenerationId: retainedGenerationId },
        })).resolves.toEqual({ ok: true });
        await expect(retireSessionSubagentCustodyGeneration({
            actorUserId: account.id,
            request: { pluginId: target.scope.pluginId, immutableGenerationId: target.scope.immutableGenerationId },
        })).resolves.toEqual({ ok: false, error: 'retirement-capacity-exceeded' });
        await expect(db.sessionSubagentCustodyRetiredGeneration.count({
            where: { accountId: account.id },
        })).resolves.toBe(4_096);
        await expect(db.sessionSubagentCustody.count({
            where: { accountId: account.id, sessionId: session.id, custodyKey: target.custodyKey },
        })).resolves.toBe(1);
        await expect(db.sessionSubagentCustodyReceipt.count({
            where: { accountId: account.id, sessionId: session.id, custodyKey: target.custodyKey },
        })).resolves.toBe(1);
    });

    it('linearizes concurrent claims for the final retirement slot without oversubscription or eviction', async () => {
        const { account } = await seed();
        await db.sessionSubagentCustodyRetiredGeneration.createMany({
            data: Array.from({ length: 4_095 }, (_, index) => ({
                accountId: account.id,
                pluginId: `acme.seed-${index}`,
                immutableGenerationId: `generation-${index}`,
                capacitySlot: index,
            })),
        });

        const results = await Promise.all([
            retireSessionSubagentCustodyGeneration({
                actorUserId: account.id,
                request: { pluginId: 'acme.concurrent-a', immutableGenerationId: 'generation-a' },
            }),
            retireSessionSubagentCustodyGeneration({
                actorUserId: account.id,
                request: { pluginId: 'acme.concurrent-b', immutableGenerationId: 'generation-b' },
            }),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok && result.error === 'retirement-capacity-exceeded')).toHaveLength(1);
        await expect(db.sessionSubagentCustodyRetiredGeneration.count({ where: { accountId: account.id } }))
            .resolves.toBe(4_096);
        await expect(db.sessionSubagentCustodyRetiredGeneration.count({
            where: { accountId: account.id, pluginId: { in: ['acme.concurrent-a', 'acme.concurrent-b'] } },
        })).resolves.toBe(1);
    });

    it('leaves no stale custody after a mutation races exact-generation retirement', async () => {
        const { account, session } = await seed();
        const mutation = request(session.id, {
            scope: custodyScope({ pluginId: 'acme.race', immutableGenerationId: 'generation-race' }),
            operationId: 'generation-race-operation',
        });

        const [mutationResult, retirementResult] = await Promise.all([
            mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: mutation }),
            retireSessionSubagentCustodyGeneration({
                actorUserId: account.id,
                request: { pluginId: mutation.scope.pluginId, immutableGenerationId: mutation.scope.immutableGenerationId },
            }),
        ]);

        expect(retirementResult).toEqual({ ok: true });
        expect(mutationResult.ok || mutationResult.error === 'generation-retired').toBe(true);
        await expect(db.sessionSubagentCustody.count({
            where: { accountId: account.id, pluginId: mutation.scope.pluginId, immutableGenerationId: mutation.scope.immutableGenerationId },
        })).resolves.toBe(0);
        await expect(db.sessionSubagentCustodyReceipt.count({
            where: { accountId: account.id, pluginId: mutation.scope.pluginId, immutableGenerationId: mutation.scope.immutableGenerationId },
        })).resolves.toBe(0);
        await expect(mutateSessionSubagentCustody({
            actorUserId: account.id,
            sessionId: session.id,
            request: { ...mutation, operationId: 'generation-race-stale-retry' },
        })).resolves.toEqual({ ok: false, error: 'generation-retired' });
    });

    it('expires a target receipt outside the bounded cleanup batch before replay admission', async () => {
        const { account, session } = await seed();
        const mutation = request(session.id, { operationId: 'target-expired-operation' });
        const resultUpdatedAt = new Date(1_000);
        await db.sessionSubagentCustodyReceipt.createMany({
            data: [
                ...Array.from({ length: 256 }, (_, index) => ({
                    accountId: account.id,
                    sessionId: session.id,
                    ...mutation.scope,
                    custodyKey: mutation.custodyKey,
                    operationId: `older-expired-${index}`,
                    requestDigest: `digest-${index}`,
                    resultSubagentId: `old-subagent-${index}`,
                    resultGroupId: null,
                    resultStatus: 'completed',
                    resultRevision: 1,
                    resultUpdatedAt,
                    expiresAt: new Date(1_000),
                })),
                {
                    accountId: account.id,
                    sessionId: session.id,
                    ...mutation.scope,
                    custodyKey: mutation.custodyKey,
                    operationId: mutation.operationId,
                    requestDigest: 'stale-target-digest',
                    resultSubagentId: mutation.subagentId,
                    resultGroupId: null,
                    resultStatus: 'completed',
                    resultRevision: 9,
                    resultUpdatedAt,
                    expiresAt: new Date(2_000),
                },
            ],
        });

        await expect(mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, request: mutation }))
            .resolves.toMatchObject({ ok: true, replayed: false, record: { revision: 0 } });
        await expect(db.sessionSubagentCustodyReceipt.count({ where: { sessionId: session.id } })).resolves.toBe(1);
    });

    it('serves capability, mutation, and actor-private hydration through authenticated HTTP routes', async () => {
        const { account, session } = await seed();
        const outsider = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const mutation = request(session.id);

        await withAuthenticatedTestApp(
            (app) => registerSessionSubagentCustodyRoutes(app as unknown as Fastify),
            async (app) => {
                const capability = await app.inject({
                    method: 'GET',
                    url: `/v2/sessions/${session.id}/subagents/custody/capability`,
                    headers: { 'x-test-user-id': account.id },
                });
                expect(capability.statusCode).toBe(200);
                expect(capability.json()).toEqual({
                    capability: 'session.subagents.durable-custody.v1',
                    maxRecords: 256,
                    maxReceipts: 4096,
                    receiptRetentionMs: 86_400_000,
                });

                const mutated = await app.inject({
                    method: 'POST',
                    url: `/v2/sessions/${session.id}/subagents/custody/mutations`,
                    headers: { 'content-type': 'application/json', 'x-test-user-id': account.id },
                    payload: mutation,
                });
                expect(mutated.statusCode).toBe(200);
                expect(mutated.json()).toMatchObject({ replayed: false, record: { subagentId: mutation.subagentId } });
                expect(mutated.json().record).not.toHaveProperty('content');
                expect(mutated.json().record).not.toHaveProperty('custodyKey');

                const hydrated = await app.inject({
                    method: 'GET',
                    url: `/v2/sessions/${session.id}/subagents/custody?pluginId=${encodeURIComponent(mutation.scope.pluginId)}&contributionId=${encodeURIComponent(mutation.scope.contributionId)}&immutableGenerationId=${encodeURIComponent(mutation.scope.immutableGenerationId)}&custodyKey=${encodeURIComponent(mutation.custodyKey)}`,
                    headers: { 'x-test-user-id': account.id },
                });
                expect(hydrated.statusCode).toBe(200);
                expect(hydrated.json()).toMatchObject({ records: [{ subagentId: mutation.subagentId }] });

                const isolatedRetirement = await app.inject({
                    method: 'POST',
                    url: '/v2/session-subagents/custody/generation-retirements',
                    headers: { 'content-type': 'application/json', 'x-test-user-id': outsider.id },
                    payload: { pluginId: mutation.scope.pluginId, immutableGenerationId: mutation.scope.immutableGenerationId },
                });
                expect(isolatedRetirement.statusCode).toBe(200);
                await expect(db.sessionSubagentCustody.count({ where: { accountId: account.id } })).resolves.toBe(1);

                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const retired = await app.inject({
                        method: 'POST',
                        url: '/v2/session-subagents/custody/generation-retirements',
                        headers: { 'content-type': 'application/json', 'x-test-user-id': account.id },
                        payload: { pluginId: mutation.scope.pluginId, immutableGenerationId: mutation.scope.immutableGenerationId },
                    });
                    expect(retired.statusCode).toBe(200);
                    expect(retired.json()).toEqual({ retired: true });
                }

                const staleMutation = await app.inject({
                    method: 'POST',
                    url: `/v2/sessions/${session.id}/subagents/custody/mutations`,
                    headers: { 'content-type': 'application/json', 'x-test-user-id': account.id },
                    payload: { ...mutation, operationId: 'stale-after-retirement' },
                });
                expect(staleMutation.statusCode).toBe(409);
                expect(staleMutation.json()).toMatchObject({ error: 'generation-retired' });

                const denied = await app.inject({
                    method: 'GET',
                    url: `/v2/sessions/${session.id}/subagents/custody/capability`,
                    headers: { 'x-test-user-id': outsider.id },
                });
                expect(denied.statusCode).toBe(404);
            },
        );
    });
});
