import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerAccountUsageRoutes } from '@/app/api/routes/account/registerAccountUsageRoutes';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { USAGE_COLLABORATION_TOOL_LEAF_KEYS, projectUsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { writeLegacySessionTupleInTx } from '@/app/session/metadata/writeLegacySessionTuple';
import { readSessionMessageEvidenceRowsInTx } from './readSessionMessageEvidenceRows';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { readSessionMessagePages } from '@/app/api/routes/session/readSessionMessagePages';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { TransactionDeadlineExceededError } from '@/storage/transactionErrors';

describe('Usage-owned Session evidence demand', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-session-evidence-', initAuth: true,
            initEncrypt: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['messages', 'state'] as const)('captures plain evidence in the existing Session batches and keeps sibling batches after a %s timeout', async failurePhase => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const sessions = Array.from({ length: SESSION_ACCESS_SESSION_BATCH_SIZE + 1 }, () => ({ id: randomUUID(),
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' }));
        await db.session.createMany({ data: sessions });
        let evidenceReads = 0;
        let stateReads = 0;
        let failEvidence = false;
        const accessStatementSizes: number[] = [];
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'Session' && request.action === 'findMany') {
                const args = request.args as Prisma.SessionFindManyArgs;
                const ids = typeof args.where?.id === 'object' ? args.where.id.in : undefined;
                if (Array.isArray(ids)) accessStatementSizes.push(ids.length);
            }
            if (request.action === 'queryRaw' && JSON.stringify(request.args).includes('envelopeType')) {
                evidenceReads++;
                if (failEvidence && failurePhase === 'messages' && evidenceReads === 2) throw new TransactionDeadlineExceededError(undefined);
            }
            if (request.action === 'queryRaw' && JSON.stringify(request.args).includes('usage_state')) {
                stateReads++;
                if (failEvidence && failurePhase === 'state' && stateReads === 2) throw new TransactionDeadlineExceededError(undefined);
            }
        } });
        try {
            await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
                const read = () => app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                    headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { nowMs: Date.now(), requests: [{ sessionIds: sessions.map(row => row.id), query: normalizeUsageQuery({
                        period: { relative: '90days' }, includeTranscriptEvidence: true, includeWorkEvidence: false }) }] } });
                const response = await read();
                expect(response.statusCode).toBe(200);
                expect(response.json().results.every((row: { messagesComplete?: boolean }) => row.messagesComplete)).toBe(true);
                expect(Math.max(...accessStatementSizes)).toBeLessThanOrEqual(SESSION_ACCESS_SESSION_BATCH_SIZE);
                expect(evidenceReads).toBe(2);
                expect(stateReads).toBe(2);
                evidenceReads = 0;
                stateReads = 0;
                failEvidence = true;
                const partial = await read();
                expect(partial.statusCode).toBe(200);
                const rows = partial.json().results;
                expect(rows.slice(0, SESSION_ACCESS_SESSION_BATCH_SIZE).every((row: { messagesComplete?: boolean }) => row.messagesComplete)).toBe(true);
                expect(rows.at(-1)).toMatchObject(failurePhase === 'messages' ? { messagesComplete: false,
                    messages: { status: 503, body: { error: 'database_transaction_timeout' } } }
                    : { detail: { status: 503, body: { error: 'database_transaction_timeout' } } });
                failEvidence = false;
                const recovered = await read();
                expect(recovered.statusCode).toBe(200);
                expect(recovered.json().results.every((row: { detail: { status: number }; messagesComplete?: boolean }) =>
                    row.detail.status === 200 && row.messagesComplete)).toBe(true);
            });
        } finally { stop(); }
    });

    it('reads opaque Usage transcript evidence without unused Account profiles while ordinary pages retain actors', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'e2ee', metadata: 'opaque-metadata' } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, messageRole: 'user',
            authorAccountId: owner.id, content: { t: 'encrypted', c: 'opaque-user-input' },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: owner.id,
                sessionRelationship: 'owner' } } });
        let profileReads = 0;
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'Account' && request.action === 'findMany') profileReads++;
        } });
        try {
            const ordinary = (await readSessionMessagePages({ userId: owner.id, sessionIds: [session.id],
                authentication: readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user' }) })).get(session.id);
            if (ordinary?.status !== 'fulfilled' || ordinary.value.status !== 200) throw new Error('Expected ordinary transcript page');
            expect(profileReads, 'ordinary transcript still resolves its real historical author').toBe(1);
            expect(ordinary.value.body.messages[0]?.accountActor?.accountId).toBe(owner.id);
            profileReads = 0;
            await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
                const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                    headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { nowMs: Date.now(), requests: [{ sessionIds: [session.id], query: normalizeUsageQuery({
                        period: { relative: 'today' }, includeWorkEvidence: false, includeTranscriptEvidence: true }) }] } });
                expect(response.statusCode, response.body).toBe(200);
                expect(profileReads, 'Usage consumes encrypted evidence, not historical Account presentation').toBe(0);
                const page = response.json().results[0].messages.body;
                expect(page.messages[0].content).toEqual({ t: 'encrypted', c: 'opaque-user-input' });
                expect(page.messages[0]).not.toHaveProperty('accountActor');
                expect(page.hasMore).toBe(false);
                expect(page.nextBeforeSeq).toBe(null);
            });
        } finally { stop(); }
    });

    // New writers certify the same opened snapshot in its normal content CAS.
    // Fixtures that omit this remain the released-writer UNKNOWN controls below.
    const publishPlainTiming = async (sessionId: string) => {
        const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
        const metadata = { ...JSON.parse(session.metadata), path: '/work' };
        const agentState = session.agentState === null ? {} : JSON.parse(session.agentState);
        expect(await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId,
            metadata: { ciphertext: JSON.stringify(metadata), expectedVersion: session.metadataVersion },
            agentState: { ciphertext: JSON.stringify(agentState), expectedVersion: session.agentStateVersion },
            usageTimingV1: projectUsageSessionTimingV1({ metadata, agentState }) }))).toMatchObject({ ok: true });
    };

    it('streams the selected encrypted Session without one whole-response JSON string', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'e2ee', metadata: 'opaque-metadata' } });
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, session: session.id,
            includeWorkEvidence: false });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, accept: 'application/x-ndjson',
                    ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query }] } });
            expect(response.statusCode).toBe(200);
            expect(response.headers['content-type']).toContain('application/x-ndjson');
            const lines = response.body.trim().split('\n').map((line: string): unknown => JSON.parse(line));
            expect(lines).toHaveLength(2);
            expect(lines[0]).toEqual({ requests: [{ query, sessionIds: [session.id] }] });
            expect(lines[1]).toMatchObject({ sessionId: session.id, detail: { status: 200 } });
            expect(response.headers['cache-control']).toBe('no-store');
        });
    });

    it('reads only window subjects and returns the same evidence when ordinary transcript bodies grow', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/work' }) } });
        await publishPlainTiming(session.id);
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'overlap', agentId: 'codex',
            status: 'completed', startedAt: 100, updatedAt: 250, terminalAt: 250 } });
        const message = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1,
            createdAt: new Date(225), content: { t: 'plain', v: { role: 'agent', content: {
                type: 'codex', data: { type: 'tool-call', callId: 'read', name: 'Read', input: { path: '/private' } },
            } } } } });
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, includeWorkEvidence: false });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const bodyRows: string[] = [];
            const stopObserving = observeSqliteRequests({ after(request, rows) {
                if (request.model !== 'Session' || !Array.isArray(rows)) return;
                for (const row of rows) if (row && typeof row === 'object' && 'metadataVersion' in row
                    && 'agentStateVersion' in row && 'id' in row && typeof row.id === 'string') bodyRows.push(row.id);
            } });
            try {
            const read = () => app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { authorization: `Bearer ${token}`, 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query }] } });
            const before = await read();
            expect(bodyRows).toEqual([session.id]);
            bodyRows.length = 0;
            expect(before.statusCode).toBe(200);
            expect(before.json().requests[0].sessionIds).toEqual([session.id]);
            const storageRead = () => inReadSnapshot(tx => readSessionMessageEvidenceRowsInTx(tx,
                [{ id: session.id, maximumSeq: null }], USAGE_COLLABORATION_TOOL_LEAF_KEYS));
            const storedBefore = await storageRead();
            await db.sessionMessage.update({ where: { id: message.id }, data: { content: { t: 'plain', v: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'read', name: 'Read',
                    input: { path: '/private', body: 'ordinary-private-body'.repeat(100_000) } } },
            } } } });
            const outside = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                encryptionMode: 'plain', metadata: '{}' } });
            await publishPlainTiming(outside.id);
            await db.sessionTurn.create({ data: { sessionId: outside.id, turnId: 'outside', status: 'completed',
                startedAt: 10, updatedAt: 20, terminalAt: 20 } });
            const after = await read();
            expect(bodyRows).toEqual([session.id]);
            expect(after.statusCode).toBe(200);
            expect(after.json()).toEqual(before.json());
            expect(after.rawPayload.byteLength).toBe(before.rawPayload.byteLength);
            expect(after.body).not.toContain('ordinary-private-body');
            expect(after.json().results).toHaveLength(1);
            // This is the actual SQL return boundary, so fetching the body and
            // pruning only after transport cannot satisfy the cost contract.
            expect(await storageRead()).toEqual(storedBefore);
            expect(JSON.stringify(storedBefore)).not.toContain('/private');
            } finally { stopObserving(); }
        });
    });

    it('admits permission-only request OR decision timestamps and excludes known outside-window subjects', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const make = async (completedAt: number) => {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            createdAt: new Date(10), updatedAt: new Date(10), encryptionMode: 'plain', metadata: '{}',
            agentState: JSON.stringify({ completedRequests: { permission: { tool: 'Read', createdAt: 100,
                completedAt, status: 'approved', turnId: 'permission-only' } } }) } });
            await publishPlainTiming(session.id);
            return session;
        };
        const inside = await make(250);
        await make(150);
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, includeWorkEvidence: false });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds).toEqual([inside.id]);
            expect(response.json().results).toHaveLength(1);
            expect(response.json().results[0].detail.status).toBe(200);
        });
    });

    it('answers a named-Session window question with only that row, never the whole window', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const make = async (completedAt: number) => {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            createdAt: new Date(10), updatedAt: new Date(10), encryptionMode: 'plain', metadata: '{}',
            agentState: JSON.stringify({ completedRequests: { permission: { tool: 'Read', createdAt: 100,
                completedAt, status: 'approved', turnId: 'permission-only' } } }) } });
            await publishPlainTiming(session.id);
            return session;
        };
        const member = await make(250);
        const arriving = await make(300);
        const outside = await make(150);
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, includeWorkEvidence: false });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query, candidateSessionIds: [arriving.id, outside.id, randomUUID()] }] } });
            expect(response.statusCode).toBe(200);
            // A wake for one Session asks whether it joins the window; members stay as admitted.
            expect(response.json().requests[0].sessionIds).toEqual([arriving.id]);
            expect(response.json().results.map((row: { sessionId: string }) => row.sessionId)).toEqual([arriving.id]);
            expect(response.json().results.some((row: { sessionId: string }) => row.sessionId === member.id)).toBe(false);
        });
    });

    it('admits Session birth origin and native sidechain witnesses without fetching ordinary prose', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const origin = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), originKind: 'session',
            createdAt: new Date(250), encryptionMode: 'plain', metadata: '{}' } });
        const native = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            createdAt: new Date(10), encryptionMode: 'plain', metadata: '{}' } });
        await publishPlainTiming(origin.id);
        await publishPlainTiming(native.id);
        await db.sessionMessage.create({ data: { sessionId: native.id, seq: 1, createdAt: new Date(250),
            content: { t: 'plain', v: { role: 'agent', content: { type: 'output', data: {
                type: 'assistant', sidechainId: 'native', message: { content: [{ type: 'text', text: 'private-prose' }] },
            } } } } } });
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, includeWorkEvidence: false });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds.sort()).toEqual([origin.id, native.id].sort());
            expect(response.body).not.toContain('private-prose');
        });
    });

    it('retains opaque E2EE subjects until their encrypted timed facts can be opened by the client', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const make = async (createdAt: number) => {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                createdAt: new Date(10), updatedAt: new Date(10), encryptionMode: 'e2ee', metadata: 'sealed-metadata' } });
            await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, createdAt: new Date(createdAt),
                content: { t: 'encrypted', c: 'opaque-encrypted-native-record' } } });
            return session;
        };
        const inside = await make(250);
        const hidden = await make(150);
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, includeWorkEvidence: false });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { authorization: `Bearer ${token}`, 'x-test-user-id': owner.id,
                    ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds.sort()).toEqual([inside.id, hidden.id].sort());
            expect(response.json().results).toHaveLength(2);
            expect(response.json().results.find((part: {sessionId: string}) => part.sessionId === inside.id)).toMatchObject({ sessionId: inside.id, detail: { status: 200 },
                messages: { status: 200, body: { messages: [{ content: { t: 'encrypted', c: 'opaque-encrypted-native-record' } }] } } });
            expect(response.json().results[0]).not.toHaveProperty('messageEvidence');
        });
    });

    it('hydrates only matching plain Machine subjects while retaining opaque E2EE candidates', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const make = async (machineId: string | null) => {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                createdAt: new Date(10), encryptionMode: machineId === null ? 'e2ee' : 'plain',
                metadata: machineId === null ? 'sealed-metadata' : JSON.stringify({ machineId, path: '/work' }) } });
            await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'window-turn', status: 'completed',
                startedAt: 250, updatedAt: 300, terminalAt: 300 } });
            return session;
        };
        const matching = await make('requested-machine');
        const nonmatching = await make('other-machine');
        const opaque = await make(null);
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, machines: ['requested-machine'],
            includeWorkEvidence: false, includeTranscriptEvidence: false });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds.sort()).toEqual([matching.id, opaque.id].sort());
            const hydrated = response.json().results;
            expect(hydrated.map((part: { sessionId: string }) => part.sessionId).sort()).toEqual([matching.id, opaque.id].sort());
            expect(hydrated.every((part: { detail: { status: number } }) => part.detail.status === 200)).toBe(true);
            expect(hydrated.some((part: { sessionId: string }) => part.sessionId === nonmatching.id)).toBe(false);
        });
    });
});
