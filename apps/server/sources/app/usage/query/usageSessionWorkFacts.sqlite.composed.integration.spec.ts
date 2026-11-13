import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { getUsageSessionFactRecordAddress, type UsageSessionFactKindV1 } from '@happier-dev/protocol/usage/usageSessionFactKinds';
import { createUsageSessionFactRecordsV1, createUsageSessionWorkFactsV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { openSessionStoredContent, sealSessionStoredContent } from '../../../../../../packages/sync-client/src/content/sessionStoredContent';
import { decryptWithDataKey, encryptWithDataKey } from '../../../../../cli/src/api/encryption';
import { LegacyHostSessionSystemRecordSchema, LegacyHostSessionSystemRecordPageResponseSchema,
    SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { deriveSessionSystemRecordAddressKeys } from '@/app/session/systemRecords/sessionSystemRecordAddressKeys';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { registerAccountUsageRoutes } from '@/app/api/routes/account/registerAccountUsageRoutes';
import { registerSessionSystemRecordRoutes } from '@/app/api/routes/session/registerSessionSystemRecordRoutes';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { upsertSessionSystemRecordV1 } from '@/app/session/systemRecords/sessionSystemRecordService';
import { TransactionDeadlineExceededError } from '@/storage/transactionErrors';

const persistedAddress = (kind: UsageSessionFactKindV1) => {
    const address = getUsageSessionFactRecordAddress(kind);
    return { ownerKind: address.owner, pluginId: null, namespace: address.namespace, localId: address.localId };
};
const address = persistedAddress('work');

describe('Usage compact work-facts evidence', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-work-facts-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    }, 120_000);
    afterAll(async () => { resetSessionSystemRecordsProtocolV1ActivationForTests(); await harness?.close(); });

    const account = () => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
    const session = (accountId: string) => db.session.create({ data: { accountId, tag: randomUUID(),
        encryptionMode: 'e2ee', seq: 3, metadata: 'private-metadata'.repeat(1_000), agentState: 'private-state',
        ownerMetadata: 'private-owner-metadata' } });
    const record = (accountId: string, sessionId: string, content: Prisma.InputJsonValue, kind: UsageSessionFactKindV1 = 'work') => {
        const address = persistedAddress(kind);
        return db.sessionSystemRecord.create({ data: { accountId, sessionId, ...address,
            kind: getUsageSessionFactRecordAddress(kind).kind, ...deriveSessionSystemRecordAddressKeys(address), content, version: 1 } });
    };

    it('retains database failures only for the covered fact batch and recovers on another read', async () => {
        const owner = await account();
        const subjects = Array.from({ length: SESSION_ACCESS_SESSION_BATCH_SIZE + 1 }, () => ({ id: randomUUID(),
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'e2ee', metadata: 'opaque' }));
        await db.session.createMany({ data: subjects });
        let recordReads = 0;
        let fail = true;
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'SessionSystemRecord' && request.action === 'findMany') {
                recordReads++;
                if (fail && recordReads === 2) throw new TransactionDeadlineExceededError(undefined);
            }
        } });
        try {
            await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
                const read = () => app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                    headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { nowMs: 400, readWorkFacts: true, requests: [{ sessionIds: subjects.map(row => row.id),
                        query: normalizeUsageQuery({ period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }) }] } });
                const partial = await read();
                expect(partial.statusCode).toBe(200);
                const rows = partial.json().results;
                expect(rows.slice(0, SESSION_ACCESS_SESSION_BATCH_SIZE).every((row: { workFacts?: unknown }) => row.workFacts)).toBe(true);
                expect(rows.at(-1)).toMatchObject({ sessionId: subjects.at(-1)!.id,
                    detail: { status: 503, body: { error: 'database_transaction_timeout' } } });
                fail = false;
                const recovered = await read();
                expect(recovered.statusCode).toBe(200);
                expect(recovered.json().results.every((row: { workFacts?: unknown }) => row.workFacts)).toBe(true);
            });
        } finally { stop(); }
    });

    it('preserves released unscoped legacy pages while the actor reads scoped v1 work facts', async () => {
        // 0.2 commit 1321319: sessionSystemRecords/{sessionSystemRecordNamespace,
        // sessionSystemRecordKind,sessionSystemRecordRoutes}.ts close these enums.
        // Other record/page fields retain the same existing transport contract.
        const releasedPage = z.safeExtend(LegacyHostSessionSystemRecordPageResponseSchema, {
            records: z.array(z.safeExtend(LegacyHostSessionSystemRecordSchema, {
                namespace: z.enum(['memory', 'activity']),
                kind: z.enum(['summary_shard.v1', 'synopsis.v1', 'workflow_run.v1', 'background_task.v1']),
            })),
        });
        const actor = await account();
        const subject = await session(actor.id);
        const memoryAddress = { ownerKind: 'host', pluginId: null, namespace: 'memory', localId: 'synopsis' } as const;
        const memory = await db.sessionSystemRecord.create({ data: { accountId: actor.id, sessionId: subject.id,
            ...memoryAddress, kind: 'synopsis.v1', ...deriveSessionSystemRecordAddressKeys(memoryAddress),
            content: { t: 'encrypted', c: 'legacy-memory' }, version: 1 } });
        await record(actor.id, subject.id, { t: 'encrypted', c: 'compact-private-fact' });
        await withAuthenticatedTestApp(registerSessionSystemRecordRoutes, async app => {
            const headers = { 'x-test-user-id': actor.id, ...currentAccountStoredContentCompatibilityHeaders };
            const scoped = await app.inject({ method: 'GET', url: `/v2/sessions/${subject.id}/system-records/record`,
                headers: { ...headers, [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE },
                query: { owner: 'host', namespace: 'usage', kind: 'work_facts.v1', localId: address.localId } });
            expect(scoped.statusCode, scoped.body).toBe(200);
            expect(scoped.json()).toMatchObject({ record: { content: { t: 'encrypted', c: 'compact-private-fact' } } });
            const legacy = await app.inject({ method: 'GET', url: `/v2/sessions/${subject.id}/system-records`, headers,
                query: { limit: '1' } });
            expect(legacy.statusCode, legacy.body).toBe(200);
            const parsed = releasedPage.safeParse(legacy.json());
            expect(parsed.success, 'Released readers must parse the entire unscoped page').toBe(true);
            expect(legacy.json()).toMatchObject({ records: [{ id: memory.id, namespace: 'memory', kind: 'synopsis.v1' }],
                hasNext: false, nextCursor: null });
            expect(legacy.body).not.toContain('compact-private-fact');
        });
    });

    it('reads only demanded fact bodies for the full 3368-Session census without multiplying record queries', async () => {
        const owner = await account();
        // The owner-approved 2026-11-09 census has 3,368 Sessions. Both
        // records exist for every Session so omission cannot pass by absence.
        const subjects = Array.from({ length: 3_368 }, () => ({ id: randomUUID(), accountId: owner.id,
            tag: randomUUID(), encryptionMode: 'e2ee' as const, seq: 3, metadata: 'private-metadata',
            agentState: 'private-state', ownerMetadata: 'private-owner-metadata' }));
        await db.session.createMany({ data: subjects });
        await db.sessionDataKeyEnvelope.create({ data: { sessionId: subjects[0].id, recipientAccountId: owner.id,
            encryptedDataKey: new Uint8Array([1, 2, 3]) } });
        const coachCiphertext = 'coach-only-private-ciphertext'.repeat(100);
        await db.sessionSystemRecord.createMany({ data: subjects.flatMap((subject, index) =>
            (['work', 'coach'] as const).map(kind => {
                const address = persistedAddress(kind);
                return { accountId: owner.id, sessionId: subject.id, ...address,
                    kind: getUsageSessionFactRecordAddress(kind).kind, ...deriveSessionSystemRecordAddressKeys(address),
                    content: { t: 'encrypted', c: kind === 'work' ? `sealed-${index}` : coachCiphertext }, version: 1 };
            })) });
        await db.sessionTurn.create({ data: { sessionId: subjects[0].id, turnId: 'busy', status: 'completed',
            startedAt: 100, terminalAt: 200, updatedAt: 200 } });
        let recordReads = 0;
        let messageReads = 0;
        let turnReads = 0;
        let coachRowsRead = 0;
        let coachBytesRead = 0;
        const sessionSelections: unknown[] = [];
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'SessionSystemRecord' && request.action.startsWith('find')) recordReads++;
            if (request.model === 'SessionMessage') messageReads++;
            if (request.model === 'SessionTurn') turnReads++;
            if (request.model === 'Session' && request.action.startsWith('find')) sessionSelections.push(request.args);
        }, after(request, result) {
            if (request.model !== 'SessionSystemRecord' || !request.action.startsWith('find') || !Array.isArray(result)) return;
            for (const row of result) {
                if (!row || typeof row !== 'object' || !('localId' in row) || row.localId !== getUsageSessionFactRecordAddress('coach').localId) continue;
                coachRowsRead++;
                if ('content' in row) coachBytesRead += Buffer.byteLength(JSON.stringify(row.content));
            }
        } });
        try { await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const read = (workFactKinds?: UsageSessionFactKindV1[]) => app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, ...(workFactKinds ? { workFactKinds } : {}), requests: [{ query: normalizeUsageQuery({
                    period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }), sessionIds: subjects.map(row => row.id) }] } });
            const response = await read();
            expect(response.statusCode, response.body).toBe(200);
            const rows = response.json().results;
            expect(rows).toHaveLength(subjects.length);
            expect(rows[0]).toMatchObject({ sessionId: subjects[0].id, workFacts: {
                session: { id: subjects[0].id, seq: 3, encryptionMode: 'e2ee', dataEncryptionKey: 'AQID', viewerRole: 'owner' },
                records: [{ kind: 'work', content: { t: 'encrypted', c: 'sealed-0' } }],
            } });
            expect(rows.every((row: { workFacts: { records: unknown[] } }) => row.workFacts.records.length === 1)).toBe(true);
            expect(rows.every((row: object) => !('turns' in row))).toBe(true);
            expect(rows.every((row: object) => !('detail' in row) && !('messages' in row))).toBe(true);
            expect(rows[0].workFacts.session.access.capabilities.submitAgentInput).toBe(true);
            expect(response.body).not.toContain('private-');
            const expectedBatches = Math.ceil(subjects.length / SESSION_ACCESS_SESSION_BATCH_SIZE);
            expect(recordReads, 'One record set query per Session access batch').toBe(expectedBatches);
            expect(coachRowsRead, 'Default work reads must not fetch coach rows').toBe(0);
            expect(coachBytesRead).toBe(0);
            expect(response.body).not.toContain(coachCiphertext);
            expect(messageReads).toBe(0);
            expect(turnReads).toBe(0);
            expect(sessionSelections.length).toBeLessThan(subjects.length);
            for (const args of sessionSelections) {
                const select = args && typeof args === 'object' && 'select' in args ? args.select : undefined;
                expect(select).toBeDefined();
                for (const field of ['metadata', 'ownerMetadata', 'agentState', 'ownerState']) expect(select).not.toHaveProperty(field);
            }
            const baseRecordReads = recordReads;
            recordReads = 0;
            const scoped = await read(['work', 'coach']);
            expect(scoped.statusCode).toBe(200);
            const scopedRows = scoped.json().results;
            expect(scopedRows).toHaveLength(subjects.length);
            expect(scopedRows.every((row: { workFacts: { records: Array<{ kind: string; content: unknown }> } }) =>
                row.workFacts.records.length === 2 && row.workFacts.records[1].kind === 'coach')).toBe(true);
            expect(scopedRows[0].workFacts.records).toEqual([
                { kind: 'work', content: { t: 'encrypted', c: 'sealed-0' } },
                { kind: 'coach', content: { t: 'encrypted', c: coachCiphertext } },
            ]);
            expect(recordReads, 'Requesting both kinds must not multiply record queries').toBe(expectedBatches);
            expect(coachRowsRead).toBe(subjects.length);
            expect(coachBytesRead).toBeGreaterThan(0);
            expect(turnReads).toBe(0);
            expect(messageReads).toBe(0);
            console.info(JSON.stringify({ phase: 'scoped-usage-cohort', sessions: subjects.length,
                records: subjects.length * 2, baseResponseBytes: response.rawPayload.byteLength,
                scopedResponseBytes: scoped.rawPayload.byteLength, baseRecordReads, scopedRecordReads: recordReads,
                baseCoachRows: 0, scopedCoachRows: coachRowsRead, scopedCoachBytes: coachBytesRead, messageReads, turnReads }));
        }); } finally { stop(); }
    });

    it('returns native turn provenance beside saved Work facts for Run length without dropping startup failures', async () => {
        const owner = await account();
        const subject = await session(owner.id);
        await record(owner.id, subject.id, { t: 'encrypted', c: 'saved-work' });
        await db.sessionTurn.createMany({ data: [
            { sessionId: subject.id, turnId: 'session-turn:startup', agentId: 'codex', status: 'failed', startedAt: 100, terminalAt: 100, updatedAt: 100 },
            { sessionId: subject.id, turnId: 'native', agentId: 'codex', agentTurnId: 'native', status: 'failed', startedAt: 100, terminalAt: 300, updatedAt: 300 },
        ] });
        let turnReads = 0;
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'SessionTurn' && request.action.startsWith('find')) turnReads++;
        } });
        try { await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, requests: [{ sessionIds: [subject.id],
                    query: normalizeUsageQuery({ period: { startMs: 0, endMs: 400 }, includeSessionEvidence: true }) }] } });
            expect(response.statusCode).toBe(200);
            const row = response.json().results[0];
            expect(row.turns).toMatchObject({ status: 200, body: { turns: [
                { turnId: 'session-turn:startup', status: 'failed', startedAt: 100, terminalAt: 100 },
                { turnId: 'native', status: 'failed', agentTurnId: 'native', startedAt: 100, terminalAt: 300 },
            ] } });
            expect(turnReads, 'Reuse the existing batched turn reader once').toBe(1);
            expect(await db.sessionTurn.count({ where: { sessionId: subject.id, status: 'failed' } })).toBe(2);
        }); } finally { stop(); }
    });

    it('uses actor scope for shared Sessions and fails closed for forbidden, malformed or wrong-mode records', async () => {
        const [owner, actor, stranger] = await Promise.all([account(), account(), account()]);
        const [shared, missing, malformed, mismatch, denied] = await Promise.all(Array.from({ length: 5 }, () => session(owner.id)));
        await Promise.all([shared, missing, malformed, mismatch].map(subject => db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: subject.id, accountId: actor.id, accessLevel: 'view', createdByAccountId: owner.id,
        } })));
        await record(owner.id, shared.id, { t: 'encrypted', c: 'owner-secret' });
        await record(actor.id, shared.id, { t: 'encrypted', c: 'actor-facts' });
        await record(owner.id, shared.id, { t: 'encrypted', c: 'owner-coach-secret' }, 'coach');
        await record(actor.id, shared.id, { t: 'encrypted', c: 'actor-coach-facts' }, 'coach');
        await record(stranger.id, missing.id, { t: 'encrypted', c: 'stranger-secret' });
        await record(stranger.id, missing.id, { t: 'encrypted', c: 'stranger-coach-secret' }, 'coach');
        await record(actor.id, malformed.id, { t: 'encrypted', c: 17 });
        await db.session.update({ where: { id: mismatch.id }, data: { encryptionMode: 'plain' } });
        await record(actor.id, mismatch.id, { t: 'encrypted', c: 'must-not-leak' });
        await record(actor.id, denied.id, { t: 'encrypted', c: 'denied-secret' });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': actor.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, workFactKinds: ['work', 'coach'], requests: [{ query: normalizeUsageQuery({
                    period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }),
                    sessionIds: [shared.id, missing.id, malformed.id, mismatch.id, denied.id] }] } });
            expect(response.statusCode, response.body).toBe(200);
            const rows = response.json().results;
            expect(rows[0]).toMatchObject({ workFacts: { session: { viewerRole: 'recipient', dataEncryptionKey: null },
                records: [{ kind: 'work', content: { t: 'encrypted', c: 'actor-facts' } },
                    { kind: 'coach', content: { t: 'encrypted', c: 'actor-coach-facts' } }] } });
            expect(rows[0].workFacts.session.access.capabilities.submitAgentInput).toBe(false);
            expect(rows[1]).toMatchObject({ workFacts: { records: [{ kind: 'work', content: null }, { kind: 'coach', content: null }] } });
            expect(rows[2]).toMatchObject({ detail: { status: 500, body: { code: 'plugin_session_record_internal' } } });
            expect(rows[3]).toMatchObject({ detail: { status: 409, body: { code: 'plugin_session_record_storage_mode_mismatch' } } });
            expect(rows[4]).toMatchObject({ detail: { status: 404 } });
            for (const row of rows.slice(2)) expect(row).not.toHaveProperty('workFacts');
            for (const secret of ['owner-secret', 'owner-coach-secret', 'stranger-secret', 'stranger-coach-secret', 'must-not-leak', 'denied-secret']) expect(response.body).not.toContain(secret);
        });
    });

    it('returns plain Session facts without requiring or projecting Account encryption material', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const subject = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const legacyAddress = { ...address, localId: 'how_you_work' };
        await db.sessionSystemRecord.create({ data: { accountId: owner.id, sessionId: subject.id, ...legacyAddress,
            kind: getUsageSessionFactRecordAddress('work').kind, ...deriveSessionSystemRecordAddressKeys(legacyAddress),
            content: { t: 'encrypted', c: 'unshipped-legacy-facts' }, version: 1 } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, requests: [{ query: normalizeUsageQuery({
                    period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }), sessionIds: [subject.id] }] } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().results[0]).toMatchObject({ workFacts: { session: {
                id: subject.id, encryptionMode: 'plain', dataEncryptionKey: null, viewerRole: 'owner',
            }, records: [{ kind: 'work', content: null }] }, turns: { status: 200, body: { sessionId: subject.id, turns: [] } } });
            expect(response.body).not.toContain('unshipped-legacy-facts');
        });
    });

    it('round-trips real sealed fact records and does not load turns for a missing coach record', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const plain = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const encryptedOwner = await account();
        const encrypted = await session(encryptedOwner.id);
        const facts = createUsageSessionWorkFactsV1({ id: plain.id, seq: plain.seq, metadata: null, agentState: null }, { status: 'available' });
        const authentication = { env: process.env, authority: 'present_user' as const, authenticationEvidence: undefined };
        const sealedPlain = await sealSessionStoredContent({ mode: 'plain' }, facts);
        if (sealedPlain.status !== 'ready') throw new Error('Plain facts must seal without encryption material');
        await expect(upsertSessionSystemRecordV1({ actorUserId: owner.id, sessionId: plain.id, authentication,
            address: getUsageSessionFactRecordAddress('work'), content: sealedPlain.content })).resolves.toMatchObject({ ok: true });
        const key = randomBytes(32);
        const encryptedContext = { mode: 'e2ee' as const, encryption: {
            encryptRaw: async (payload: unknown) => encodeBase64(encryptWithDataKey(payload, key)),
            decryptRaw: async (ciphertext: string): Promise<unknown> => decryptWithDataKey(decodeBase64(ciphertext), key),
        } };
        const encryptedFacts = createUsageSessionFactRecordsV1({ id: encrypted.id, seq: encrypted.seq,
            metadata: null, agentState: null }, { status: 'available', coach: { compositionCoverage: 'complete', composition: [],
                detail: { coverage: 'complete', compactions: [], modelRequests: [], mcpUsage: [] } } });
        const envelopes = [];
        for (const facts of encryptedFacts) {
            const sealed = await sealSessionStoredContent(encryptedContext, facts);
            if (sealed.status !== 'ready') throw new Error('Encrypted facts must seal with Session material');
            envelopes.push({ kind: facts.kind, content: sealed.content });
            await expect(upsertSessionSystemRecordV1({ actorUserId: encryptedOwner.id, sessionId: encrypted.id, authentication,
                address: getUsageSessionFactRecordAddress(facts.kind), content: sealed.content })).resolves.toMatchObject({ ok: true });
        }
        let turnReads = 0;
        const stop = observeSqliteRequests({ before(request) { if (request.model === 'SessionTurn') turnReads++; } });
        try { await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const read = (actorId: string, sessionId: string, workFactKinds: UsageSessionFactKindV1[]) => app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': actorId, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, workFactKinds, requests: [{ query: normalizeUsageQuery({
                    period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }), sessionIds: [sessionId] }] } });
            const response = await read(owner.id, plain.id, ['work', 'coach']);
            expect(response.statusCode).toBe(200);
            expect(response.json().results[0]).toMatchObject({ workFacts: { session: { encryptionMode: 'plain', dataEncryptionKey: null },
                records: [{ kind: 'work', content: { t: 'plain', v: facts } }, { kind: 'coach', content: null }] } });
            expect(response.json().results[0]).not.toHaveProperty('turns');
            expect(turnReads, 'A missing coach must not trigger the missing-work fallback').toBe(0);
            await expect(openSessionStoredContent({ mode: 'plain' }, response.json().results[0].workFacts.records[0].content))
                .resolves.toEqual({ status: 'ready', value: facts });
            const encryptedRead = await read(encryptedOwner.id, encrypted.id, ['work', 'coach']);
            expect(encryptedRead.statusCode).toBe(200);
            const stored = encryptedRead.json().results[0].workFacts.records;
            expect(stored).toEqual(envelopes);
            for (const [index, record] of stored.entries()) {
                await expect(openSessionStoredContent(encryptedContext, record.content))
                    .resolves.toEqual({ status: 'ready', value: encryptedFacts[index] });
            }
            expect(turnReads).toBe(0);
        }); } finally { stop(); }
    });
});
