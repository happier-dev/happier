import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
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

const address = { ownerKind: 'host', pluginId: null, namespace: 'usage', localId: 'how_you_work' } as const;

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
    const record = (accountId: string, sessionId: string, content: Prisma.InputJsonValue) => db.sessionSystemRecord.create({ data: {
        accountId, sessionId, ...address, kind: 'work_facts.v1', ...deriveSessionSystemRecordAddressKeys(address), content, version: 1,
    } });

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

    it('reads saved compact facts without duplicate turns, Session bodies or transcripts', async () => {
        const owner = await account();
        const subjects = await Promise.all(Array.from({ length: 12 }, () => session(owner.id)));
        await db.sessionDataKeyEnvelope.create({ data: { sessionId: subjects[0].id, recipientAccountId: owner.id,
            encryptedDataKey: new Uint8Array([1, 2, 3]) } });
        await Promise.all(subjects.map((subject, index) => record(owner.id, subject.id, { t: 'encrypted', c: `sealed-${index}` })));
        await db.sessionTurn.create({ data: { sessionId: subjects[0].id, turnId: 'busy', status: 'completed',
            startedAt: 100, terminalAt: 200, updatedAt: 200 } });
        let recordReads = 0;
        let messageReads = 0;
        let turnReads = 0;
        const sessionSelections: unknown[] = [];
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'SessionSystemRecord' && request.action.startsWith('find')) recordReads++;
            if (request.model === 'SessionMessage') messageReads++;
            if (request.model === 'SessionTurn') turnReads++;
            if (request.model === 'Session' && request.action.startsWith('find')) sessionSelections.push(request.args);
        } });
        try { await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, requests: [{ query: normalizeUsageQuery({
                    period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }), sessionIds: subjects.map(row => row.id) }] } });
            expect(response.statusCode, response.body).toBe(200);
            const rows = response.json().results;
            expect(rows).toHaveLength(subjects.length);
            expect(rows[0]).toMatchObject({ sessionId: subjects[0].id, workFacts: {
                session: { id: subjects[0].id, seq: 3, encryptionMode: 'e2ee', dataEncryptionKey: 'AQID', viewerRole: 'owner' },
                content: { t: 'encrypted', c: 'sealed-0' },
            } });
            expect(rows.every((row: object) => !('turns' in row))).toBe(true);
            expect(rows.every((row: object) => !('detail' in row) && !('messages' in row))).toBe(true);
            expect(rows[0].workFacts.session.access.capabilities.submitAgentInput).toBe(true);
            expect(response.body).not.toContain('private-');
            expect(recordReads, 'Cohort facts must use a set read, not one record query per Session').toBe(1);
            expect(messageReads).toBe(0);
            expect(turnReads).toBe(0);
            expect(sessionSelections.length).toBeLessThan(subjects.length);
            for (const args of sessionSelections) {
                const select = args && typeof args === 'object' && 'select' in args ? args.select : undefined;
                expect(select).toBeDefined();
                for (const field of ['metadata', 'ownerMetadata', 'agentState', 'ownerState']) expect(select).not.toHaveProperty(field);
            }
            console.info(JSON.stringify({ phase: 'compact-usage-cohort', sessions: subjects.length,
                responseBytes: response.rawPayload.byteLength, omittedMetadataBytes: subjects.reduce((sum, row) => sum + Buffer.byteLength(row.metadata), 0),
                recordReads, messageReads }));
        }); } finally { stop(); }
    });

    it('uses actor scope for shared Sessions and fails closed for forbidden, malformed or wrong-mode records', async () => {
        const [owner, actor, stranger] = await Promise.all([account(), account(), account()]);
        const [shared, missing, malformed, mismatch, denied] = await Promise.all(Array.from({ length: 5 }, () => session(owner.id)));
        await Promise.all([shared, missing, malformed, mismatch].map(subject => db.sessionShare.create({ data: {
            sessionId: subject.id, sharedWithUserId: actor.id, accessLevel: 'view', sharedByUserId: owner.id,
        } })));
        await record(owner.id, shared.id, { t: 'encrypted', c: 'owner-secret' });
        await record(actor.id, shared.id, { t: 'encrypted', c: 'actor-facts' });
        await record(stranger.id, missing.id, { t: 'encrypted', c: 'stranger-secret' });
        await record(actor.id, malformed.id, { t: 'encrypted', c: 17 });
        await db.session.update({ where: { id: mismatch.id }, data: { encryptionMode: 'plain' } });
        await record(actor.id, mismatch.id, { t: 'encrypted', c: 'must-not-leak' });
        await record(actor.id, denied.id, { t: 'encrypted', c: 'denied-secret' });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': actor.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, requests: [{ query: normalizeUsageQuery({
                    period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }),
                    sessionIds: [shared.id, missing.id, malformed.id, mismatch.id, denied.id] }] } });
            expect(response.statusCode, response.body).toBe(200);
            const rows = response.json().results;
            expect(rows[0]).toMatchObject({ workFacts: { session: { viewerRole: 'recipient', dataEncryptionKey: null },
                content: { t: 'encrypted', c: 'actor-facts' } } });
            expect(rows[0].workFacts.session.access.capabilities.submitAgentInput).toBe(false);
            expect(rows[1]).toMatchObject({ workFacts: { content: null } });
            expect(rows[2]).toMatchObject({ detail: { status: 500, body: { code: 'plugin_session_record_internal' } } });
            expect(rows[3]).toMatchObject({ detail: { status: 409, body: { code: 'plugin_session_record_storage_mode_mismatch' } } });
            expect(rows[4]).toMatchObject({ detail: { status: 404 } });
            for (const row of rows.slice(2)) expect(row).not.toHaveProperty('workFacts');
            for (const secret of ['owner-secret', 'stranger-secret', 'must-not-leak', 'denied-secret']) expect(response.body).not.toContain(secret);
        });
    });

    it('returns plain Session facts without requiring or projecting Account encryption material', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const subject = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, readWorkFacts: true, requests: [{ query: normalizeUsageQuery({
                    period: { startMs: 0, endMs: 400 }, includeWorkEvidence: false }), sessionIds: [subject.id] }] } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().results[0]).toMatchObject({ workFacts: { session: {
                id: subject.id, encryptionMode: 'plain', dataEncryptionKey: null, viewerRole: 'owner',
            }, content: null }, turns: { status: 200, body: { sessionId: subject.id, turns: [] } } });
        });
    });
});
