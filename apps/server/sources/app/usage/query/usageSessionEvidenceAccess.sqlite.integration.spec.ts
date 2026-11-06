import { randomUUID, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerAccountUsageRoutes } from '@/app/api/routes/account/registerAccountUsageRoutes';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { inReadSnapshot } from '@/storage/inTx';
import { readSessionStateEvidenceRowsInTx } from './readSessionStateEvidenceRows';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encodeSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

describe('Usage evidence component admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-evidence-access-',
        initAuth: true, initEncrypt: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('selects only changed candidate Sessions through the same window and access owner', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const make = (accountId: string, createdAt: number) => db.session.create({ data: { accountId,
            tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', originKind: 'session',
            createdAt: new Date(createdAt), updatedAt: new Date(createdAt), lastActiveAt: new Date(createdAt),
            usageTimingV1: { v: 1, metadata: { v: 1, minMs: null, maxMs: null }, agentState: { v: 1, minMs: null, maxMs: null } } } });
        const [inside, unrelated, outside, denied] = await Promise.all([
            make(owner.id, 250), make(owner.id, 250), make(owner.id, 10), make(foreign.id, 250),
        ]);
        let candidateRows = 0;
        const stop = observeSqliteRequests({ after(request, result) {
            if (request.model !== 'Session' || request.action !== 'findMany' || !Array.isArray(result)) return;
            if (result.every(row => row && typeof row === 'object' && Object.keys(row).length === 1 && 'id' in row))
                candidateRows += result.length;
        } });
        try { await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 },
                    includeWorkEvidence: false, includeTranscriptEvidence: false }),
                    candidateSessionIds: [inside.id, outside.id, denied.id] }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds).toEqual([inside.id]);
            expect(response.json().results.map((row: { sessionId: string }) => row.sessionId)).toEqual([inside.id]);
            expect(response.json().results.some((row: { sessionId: string }) => row.sessionId === unrelated.id)).toBe(false);
            expect(candidateRows, 'Named candidates must not read the unrelated accessible Session census').toBe(2);
        }); } finally { stop(); }
    });

    it('keeps transcript denial unknown after detail admission instead of inventing empty opened evidence', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        // Genuine persistence boundary: the later transcript row is absent
        // (as after deletion/revocation), while detail admission remains real.
        let unavailableReads = 0;
        const restore = observeSqliteRequests({ after(request, result) {
            if (request.model !== 'Session' || !Array.isArray(result)) return;
            const row: unknown = result[0];
            if (!row || typeof row !== 'object' || !('latestTurnId' in row) || 'metadataVersion' in row) return;
            result.splice(0); unavailableReads++;
        } });
        try {
            await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
                const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                    headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { nowMs: 400, requests: [{ query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 },
                        includeWorkEvidence: false }), sessionIds: [session.id] }] } });
                expect(response.statusCode).toBe(200);
                const row = response.json().results[0];
                expect(row.detail.status).toBe(200);
                expect(row.messages.status).toBe(404);
                expect(row.messagesComplete).toBe(false);
                expect(row).not.toHaveProperty('messageEvidence');
                expect(unavailableReads).toBeGreaterThan(0);
            });
        } finally { restore(); }
    });
    it('retains opaque subjects whose hidden state may contain in-window permission or relationship facts', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            createdAt: new Date(10), encryptionMode: 'e2ee', metadata: 'sealed-relationship', agentState: 'sealed-permission' } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 },
                    includeWorkEvidence: false }) }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds).toEqual([session.id]);
        });
    });
    it('retains encrypted owner facts independently of a plain Session content mode and Machine filter', async () => {
        const content = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(content.publicKey) } });
        const envelope = sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: { v: 1, workspace: { machineId: 'requested-machine' },
            history: { forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 0, createdAtMs: 250, strategy: 'native' } } },
            material: { type: 'dataKey', machineKey: content.secretKey }, randomBytes });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            createdAt: new Date(10), encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: JSON.stringify({ v: 1 }), ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(envelope) } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, machines: ['requested-machine'],
                includeWorkEvidence: false, includeTranscriptEvidence: false });
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds).toEqual([session.id]);
            expect(response.json().results[0].detail.status).toBe(200);
        });
    });

    it('reads permission leaves without transporting private arguments and keeps their canonical facts', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const state = (padding: string) => JSON.stringify({ completedRequests: { permission: { tool: 'Read',
            createdAt: 100, completedAt: 250, status: 'approved', turnId: 'permission-turn', arguments: { body: padding } } } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine' }), agentState: state('small') } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'permission-turn', agentId: 'codex',
            status: 'completed', startedAt: 50, terminalAt: 300, updatedAt: 300 } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const read = () => app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 },
                    includeWorkEvidence: false }), sessionIds: [session.id] }] } });
            const before = await read();
            expect(before.statusCode).toBe(200);
            expect(before.json().results[0].stateEvidence).toMatchObject({ permissions: [{ requestId: 'permission',
                requestedAtMs: 100, decidedAtMs: 250, toolId: 'Read' }], waits: [{ startMs: 100, endMs: 250, machineId: 'machine' }] });
            const storageRead = () => inReadSnapshot(tx => readSessionStateEvidenceRowsInTx(tx, [{ id: session.id, privateState: true }]));
            const storedBefore = await storageRead();
            await db.session.update({ where: { id: session.id }, data: { agentState: state('private-permission-body'.repeat(100_000)), updatedAt: session.updatedAt } });
            const after = await read();
            expect(after.json()).toEqual(before.json());
            expect(after.rawPayload.byteLength).toBe(before.rawPayload.byteLength);
            expect(after.body).not.toContain('private-permission-body');
            expect(await storageRead()).toEqual(storedBefore);
            const storageJson = JSON.stringify(storedBefore, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
            expect(storageJson).not.toContain('arguments');
            console.info(JSON.stringify({ phase: 'permission-padding-cost', projectedSqlRowJsonBytes: Buffer.byteLength(storageJson),
                responseBytes: before.rawPayload.byteLength, argumentPaddingBytes: Buffer.byteLength('private-permission-body'.repeat(100_000)) }));
            await db.session.update({ where: { id: session.id }, data: { updatedAt: session.updatedAt,
                agentState: JSON.stringify({ requests: { bad: { tool: 'Read', createdAt: 'invalid-requested-time' } } }) } });
            const malformed = await read();
            expect(malformed.json().results[0]).not.toHaveProperty('stateEvidence');
            expect(malformed.json().results[0].turns.status).toBe(200);
        });
    });
    it('selects layout-one relationship-only Sessions from their canonical owner partitions', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        // Producer timing selects relationship facts; recent unknown activity must not mask the predicate.
        const make = (document: object) => {
            const metadata = { v: 1, ...document };
            return db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                createdAt: new Date(10), updatedAt: new Date(10), lastActiveAt: new Date(10),
                encryptionMode: 'plain', metadataLayoutVersion: 1,
                usageTimingV1: projectUsageSessionTimingV1({ metadata: projectSessionOwnerCompatibilityViewV1({
                    sharedMetadata: { v: 1 }, ownerMetadata: metadata }), agentState: {} }),
                metadata: JSON.stringify({ v: 1 }), ownerMetadata: JSON.stringify({ t: 'plain', v: metadata }) } });
        };
        const fork = await make({ history: { forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 0,
            createdAtMs: 250, strategy: 'native' } } });
        const replay = await make({ history: { replaySeedV1: { v: 1, sourceSessionId: 'source', sourceCutoffSeqInclusive: 0,
            createdAtMs: 250, seedText: 'private seed' } } });
        const handoff = await make({ handoff: { handoffV1: { v: 1, sourceMachineId: 'source', targetMachineId: 'target',
            agentId: 'codex', sessionStorageBefore: 'direct', sessionStorageAfter: 'persisted',
            transportStrategy: 'direct_peer', completedAtMs: 250 } } });
        await make({ history: { forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 0,
            createdAtMs: 100, strategy: 'native' } } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 },
                    includeWorkEvidence: false }) }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds.sort()).toEqual([fork.id, replay.id, handoff.id].sort());
        });
    });

    it('retains admitted intervals when every requested message witness is malformed', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'busy', status: 'completed',
            startedAt: 200, terminalAt: 300, updatedAt: 300 } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, createdAt: new Date(250),
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: {
                type: 'context-compaction', phase: 'malformed-requested-phase' } } } } } });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 },
                    includeWorkEvidence: false }) }] } });
            expect(response.statusCode).toBe(200);
            const row = response.json().results[0];
            expect(row.turns.status).toBe(200);
            expect(row.turns.body.turns[0].turnId).toBe('busy');
            expect(row.messageEvidence).toEqual({});
            expect(row.messagesComplete).toBe(false);
        });
    });

});
