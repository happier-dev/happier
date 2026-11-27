import axios from 'axios';
import { Readable } from 'node:stream';
import fastify from 'fastify';
import { io } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { SessionReadBatchResultV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT, SESSION_LIST_PAGE_MAX_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCompactSessionListRowFixture, createSessionRecordFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { encodeBase64, encrypt } from '@/api/encryption';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { readCliUsageDetail } from './readCliUsageDetail';

vi.mock('socket.io-client', async importOriginal => ({
    ...await importOriginal<typeof import('socket.io-client')>(),
    io: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function batchResponse(body: unknown, status = 200, request?: unknown) {
    const rows = body !== null && typeof body === 'object' && 'results' in body && Array.isArray(body.results) ? body.results : [];
    const value = request === undefined || status !== 200 ? body : {
        ...body as object,
        requests: UsageSessionEvidenceRequestSchema.parse(request).requests.map(row => ({ query: row.query,
            sessionIds: row.sessionIds ?? rows.map((part: SessionReadBatchResultV1) => part.sessionId) })),
    };
    return { status, headers: { 'content-type': 'application/json' }, data: Readable.from([Buffer.from(JSON.stringify(value), 'utf8')]) };
}

function twoSessionAccounting(sessionIds: string[]) {
    return UsageAnalyticsQueryResponseSchema.parse({ v: 1, sessionIds,
        sessionMembership: { turns: sessionIds.map(sessionId => ({ sessionId, turnId: 'turn', executions: ['happier'] })) },
        totals: { eventCount: 2, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
}

describe('CLI Usage Session evidence demand', () => {
    it.each([
        { name: 'mapped checkout', active: true, legacy: false },
        { name: 'Home offline', active: false, legacy: false },
        { name: 'host-only Session', active: true, legacy: true },
    ])('standalone Work uses the Home destination and presence: $name', async ({ active, legacy }) => {
        const sessionId = 'work-session';
        const machineId = 'work-machine';
        const agentPath = '/agent/archived-checkout';
        const cwd = '/home/test/archived-checkout';
        const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ ...(!legacy ? { machineId } : {}), path: agentPath, host: 'test',
                ...(legacy ? {} : { sessionWorkspaceLocationV1: { v: 1, machineId, agentPath, machinePath: cwd } }) }),
        });
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: [{
            sessionId, detail: { status: 200, body: { session } },
        }] }, 200, request));
        const machineReads = vi.spyOn(axios, 'get').mockResolvedValue({ data: { machine: {
            ...createAvailableSessionSpawnMachineSnapshot(machineId), storageMode: 'plain', active, presenceProtocolVersion: 1,
        } } });
        const emitWithAck = vi.fn(async () => ({ ok: true, result: { sessions: [{
            sessionId, status: 'partial', evidence: [], pullRequestsRead: true,
        }] } }));
        vi.mocked(io).mockReturnValue(createApiSessionSocketStub({ emitWithAck }) as unknown as ReturnType<typeof io>);
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: [sessionId],
            includeWorkEvidence: true, includeSessionEvidence: false });
        try {
            const result = await readCliUsageDetail({ queries: [query],
                accounting: [{ query, value: twoSessionAccounting([sessionId]), status: 'available' }],
                credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
                accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
                resolveHeaders: () => ({ Authorization: 'Bearer token' }),
            });
            expect(machineReads).toHaveBeenCalledTimes(legacy ? 0 : 1);
            expect(emitWithAck).toHaveBeenCalledTimes(active && !legacy ? 1 : 0);
            if (active && !legacy) {
                expect(emitWithAck.mock.calls[0]?.slice(0, 2)).toEqual([SOCKET_RPC_EVENTS.CALL, expect.objectContaining({
                    method: `${machineId}:${RPC_METHODS.SCM_WORK_EVIDENCE_READ}`, params: { sessions: [{ sessionId, cwd, turnIds: ['turn'] }] },
                })]);
                expect(result.work).toMatchObject([{ status: 'partial', pullRequestReadSessions: [sessionId] }]);
            } else {
                expect(result.work).toMatchObject([{ status: 'unknown', unreadSessions: { machine_unavailable: 1 },
                    ...(!active ? { errorCode: 'machine_offline' } : {}) }]);
            }
        } finally { vi.mocked(io).mockReset(); }
    });

    it.each([false, true])('dates completed standalone Work, with an unread sibling: %s', async mixed => {
        const ids = mixed ? ['linked', 'offline'] : ['linked'];
        const sessions = ids.map(id => createSessionRecordFixture({ id, encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: id, agent: 'claude' }) }));
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: sessions.map(session => ({
            sessionId: session.id, detail: { status: 200, body: { session } },
            turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } },
        })) }, 200, request));
        const clock = vi.spyOn(Date, 'now').mockReturnValue(200);
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async ({ machineId }) => {
            if (machineId === 'offline') throw new RpcError('Machine offline', 'machine_offline');
            clock.mockReturnValue(275);
            return { sessions: [{ sessionId: 'linked', status: 'partial', pullRequestsRead: true, evidence: [],
                branchEvidence: [{ sessionId: 'linked', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
                    checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
                    attributionScope: 'no_happier_checkpoint_overlap_observed',
                    branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } }] }] };
        });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: ids, includeWorkEvidence: true,
            includeSessionEvidence: false });
        const value = twoSessionAccounting(ids);
        const accounting = [{ query, value, status: 'available' as const }];
        const detail = await readCliUsageDetail({ queries: [query], accounting, credentials: { token: 'token', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test', accountEncryptionMode: 'plain', allowPrivateRead: true,
            nowMs: 200, assertCurrent: async () => {}, resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        const answer = UsageQueryBatchResultSchema.parse(resolveUsagePageAggregation({ queries: [query], accounting,
            work: detail.work, nowMs: 200 }, bundledUsageModelPriceCatalog)).results[0];
        expect(answer?.accounting?.totals).toEqual(value.totals);
        expect(answer?.sources).toContainEqual({ source: 'work', status: 'partial', asOfMs: 275,
            ...(mixed ? { errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 1 } } : {}) });
        expect(detail.work[0]?.branchEvidence).toHaveLength(1);
    });

    it.each([
        { name: 'setup only', overrideMs: undefined, elapsedMs: 60_000 },
        { name: 'explicit deadline', overrideMs: 20_000, elapsedMs: 20_000 },
    ])('settles Work through the Usage sender at $elapsedMs ms ($name)', async ({ overrideMs, elapsedMs }) => {
        const ids = ['read', 'unread'];
        const machineId = 'work-machine';
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: ids.map(id => ({
            sessionId: id, detail: { status: 200, body: { session: createSessionRecordFixture({
                id, encryptionMode: 'plain', share: null, metadata: JSON.stringify({ path: '/repo', machineId, agent: 'claude' }),
            }) } },
        })) }, 200, request));
        vi.spyOn(axios, 'get').mockResolvedValue({ data: { machine: {
            ...createAvailableSessionSpawnMachineSnapshot(machineId), storageMode: 'plain',
        } } });
        const reply = { sessions: [
            { sessionId: 'read', status: 'partial', evidence: [], pullRequestsRead: true },
            { sessionId: 'unread', status: 'error', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT },
        ] };
        const socket = createApiSessionSocketStub({ emitWithAck: (event, packet) => {
            expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
            expect(packet).toMatchObject({ method: `${machineId}:${RPC_METHODS.SCM_WORK_EVIDENCE_READ}` });
            return new Promise(resolve => setTimeout(() => resolve({ ok: true, result: reply }), 60_000));
        } });
        vi.mocked(io).mockReturnValue(socket as unknown as ReturnType<typeof io>);
        const callExactMachineRpc = machineRpc.callExactMachineRpc;
        const sender = vi.spyOn(machineRpc, 'callExactMachineRpc');
        if (overrideMs !== undefined) {
            // Exercise the explicit override at the real transport seam.
            sender.mockImplementation(params => callExactMachineRpc({ ...params, timeoutMs: overrideMs }));
        }

        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: ids,
            includeWorkEvidence: true, includeSessionEvidence: false });
        vi.useFakeTimers();
        try {
            const start = Date.now();
            const pending = readCliUsageDetail({ queries: [query],
                accounting: [{ query, value: twoSessionAccounting(ids), status: 'available' }],
                credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
                accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
                resolveHeaders: () => ({ Authorization: 'Bearer token' }),
            }).then(detail => ({ detail, elapsed: Date.now() - start }));
            await vi.advanceTimersByTimeAsync(60_000);
            const { detail, elapsed } = await pending;
            expect(elapsed).toBe(elapsedMs);
            expect(detail.work).toMatchObject(overrideMs === undefined
                ? [{ status: 'partial', asOfMs: start + 60_000, pullRequestReadSessions: ['read'], unreadSessions: { timed_out: 1 } }]
                : [{ status: 'error', unreadSessions: { timed_out: 2 } }]);
            expect(sender).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: null }));
        } finally {
            vi.mocked(io).mockReset();
            vi.useRealTimers();
        }
    });

    it.each(['request', 'detail'])('carries a failing Session evidence %s into Work instead of reporting unknown Work', async failed => {
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeSessionEvidence: false,
            includeWorkEvidence: true });
        const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            sessionMembership: { turns: [{ sessionId: 'work-session', turnId: 'turn', executions: ['happier'] }] },
            totals: { eventCount: 1, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => failed === 'request'
            ? batchResponse({ error: 'private server diagnostic', code: 'database_unavailable' }, 503)
            : batchResponse({ results: [{ sessionId: 'work-session', detail: {
                status: 503, body: { error: 'database_transaction_timeout' },
            } }] }, 200, request));
        const result = await readCliUsageDetail({ queries: [query], accounting: [{ query, value, status: 'available' }],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(post).toHaveBeenCalledTimes(1);
        expect(result.work).toMatchObject([{ status: 'error',
            errorCode: failed === 'request' ? 'database_unavailable' : 'database_transaction_timeout', unreadSessions: { failed: 1 } }]);
        expect(result.work[0]?.evidence).toBeUndefined();
    });

    it('keeps failed empty discovery records out of the accounting population consumed by Actions', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeTranscriptEvidence: false,
            includeWorkEvidence: false, includeCoach: true, includeQuota: false });
        const records = ['failed-empty', 'real-archived'].map(id => createSessionRecordFixture({ id,
            encryptionMode: 'plain', share: null, metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) }));
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => {
            const demand = UsageSessionEvidenceRequestSchema.parse(request);
            const ids = new Set(demand.requests.flatMap(row => row.sessionIds ?? records.map(row => row.id)));
            return batchResponse({ results: records.filter(row => ids.has(row.id)).map(session => ({
                sessionId: session.id, detail: { status: 200, body: { session } }, turns: { status: 200,
                    body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } },
            })) }, 200, request);
        });
        const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, sessionIds: ['real-archived'],
            sessionMembership: { turns: [] }, totals: { eventCount: 1,
                tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        const result = await readCliUsageDetail({ queries: [query], accounting: [{ query, value, status: 'available' }],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.sessions.map(row => row.id)).toEqual(['real-archived']);
    });

    it('reads split UTF-8 NDJSON over real HTTP without joining the aggregate response', async () => {
        const app = fastify();
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeTranscriptEvidence: false,
            includeWorkEvidence: false, includeCoach: true, includeQuota: false });
        const records = Array.from({ length: 80 }, (_, index) => createSessionRecordFixture({ id: `stream-🌍-${index}`,
            encryptionMode: 'plain', share: null, metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) }));
        app.post(USAGE_SESSION_EVIDENCE_PATH, async (request, reply) => {
            expect(request.headers.accept).toBe('application/x-ndjson');
            const lines = [JSON.stringify({ requests: [{ query, sessionIds: records.map(row => row.id) }] }),
                ...records.map(session => JSON.stringify({ sessionId: session.id, detail: { status: 200, body: { session } },
                    turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [{ turnId: 'turn',
                        status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] } } }))];
            async function* bytes() {
                for (const line of lines) {
                    const encoded = Buffer.from(line + '\n', 'utf8');
                    const emoji = encoded.indexOf(Buffer.from('🌍'));
                    const split = emoji === -1 ? Math.floor(encoded.length / 2) : emoji + 1;
                    yield encoded.subarray(0, split);
                    yield encoded.subarray(split);
                }
            }
            return reply.type('application/x-ndjson').send(Readable.from(bytes()));
        });
        const base = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const result = await readCliUsageDetail({ queries: [query], accounting: [], credentials: { token: 'token', encryption: null },
                serverId: 'home', serverHttpBaseUrl: base, accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200,
                assertCurrent: async () => {}, resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
            expect(result.howYouWork[0]?.errorCode).toBeUndefined();
            expect(result.sessions.map(row => row.id)).toEqual(records.map(row => row.id));
            expect(result.howYouWork[0]?.detail.facts).toHaveLength(80);
        } finally { await app.close(); }
    });

    it.each(['malformed', 'cancel'] as const)('does not publish a partial NDJSON result after %s', async mode => {
        const app = fastify();
        const controller = new AbortController();
        const session = createSessionRecordFixture({ id: 'partial-stream', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: session.id,
            includeTranscriptEvidence: false, includeWorkEvidence: false });
        app.post(USAGE_SESSION_EVIDENCE_PATH, async (_request, reply) => {
            async function* bytes() {
                yield Buffer.from(JSON.stringify({ requests: [{ query, sessionIds: [session.id] }] }) + '\n');
                yield Buffer.from(JSON.stringify({ sessionId: session.id, detail: { status: 200, body: { session } },
                    turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } } }) + '\n');
                if (mode === 'cancel') { controller.abort(); return; }
                yield Buffer.from('{"sessionId":');
            }
            return reply.type('application/x-ndjson').send(Readable.from(bytes()));
        });
        const base = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const result = await readCliUsageDetail({ queries: [query], accounting: [], credentials: { token: 'token', encryption: null },
                serverId: 'home', serverHttpBaseUrl: base, accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200,
                signal: controller.signal, assertCurrent: async () => {}, resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
            expect(result.sessions).toEqual([]);
            expect(result.howYouWork[0]?.errorCode).toBeDefined();
        } finally { await app.close(); }
    });

    it('does not substitute the installed bearer when batch authorization is refused', async () => {
        const session = createSessionRecordFixture({ id: 'refused-batch', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) });
        const post = vi.spyOn(axios, 'post').mockImplementation(async () => batchResponse({ results: [{ sessionId: session.id,
            detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } },
        }] }));
        const get = vi.spyOn(axios, 'get');
        const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: session.id, includeTranscriptEvidence: false, includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'installed-owner', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: request => request.path === USAGE_SESSION_EVIDENCE_PATH ? null : { 'requester-authorization': 'admitted' },
        });
        expect(result.sessions).toEqual([]);
        expect(post).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
    });

    it('settles an unsupported batch route without disclosing singleton Session detail', async () => {
        const session = createSessionRecordFixture({ id: 'old-home-session', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) });
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async () => batchResponse({ error: 'not_found' }, 404));
        const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: session.id, includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }),
        });
        expect(result.sessions).toEqual([]);
        expect(result.howYouWork).toMatchObject([{ errorCode: 'update_required', detail: { status: 'unknown' },
            updateRequired: { kind: 'update_required', operation: 'usage.query', component: 'server', reason: 'usage_session_evidence_unsupported' } }]);
        expect(post).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalled();
    });

    it.each([null, 'legacy-b'])('retains compact null-turn Session demand with explicit scope %s', async selected => {
        const ids = ['legacy-a', 'legacy-b', 'legacy-c'];
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: selected,
            projects: ['historical-project'], includeTranscriptEvidence: false, includeWorkEvidence: false });
        const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 3,
            tokens: { input: 3, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            sessionIds: ids, sessionMembership: { turns: [] } });
        const expectedIds = selected === null ? ids : [selected];
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({
            results: expectedIds.map(id => ({ sessionId: id, detail: { status: 200, body: {
                session: createSessionRecordFixture({ id, encryptionMode: 'plain', share: null,
                    metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) }),
            } }, turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 180, turns: [] } } })),
        }, 200, request));
        const result = await readCliUsageDetail({ queries: [query], accounting: [{ query, status: 'available', value }],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.sessions.map(row => row.id)).toEqual(expectedIds);
        expect(UsageSessionEvidenceRequestSchema.parse(post.mock.calls[0]![1]).requests)
            .toEqual([{ query, sessionIds: expectedIds }]);
    });

    it.each([
        { part: 'detail', status: 404, retained: false, cause: 'not_found' },
        { part: 'detail', status: 403, retained: false, cause: 'forbidden', workFailure: 'auth_failed' },
        { part: 'turns', status: 404, retained: true, cause: 'not_found' },
        { part: 'turns', status: 503, retained: false, cause: 'server_error', workFailure: 'server_error' },
        { part: 'messages', status: 503, retained: true, cause: 'server_error' },
        { part: 'messages', status: 403, retained: false, cause: 'forbidden' },
        { part: 'detail', status: 200, retained: false, cause: 'forbidden' },
        { part: 'detail', status: 403, retained: false, cause: 'team_authentication_required',
            bodyError: 'team_authentication_required', workFailure: 'team_authentication_required' },
        { part: 'messages', status: 503, retained: true, cause: 'team_authentication_unavailable',
            bodyError: 'team_authentication_unavailable' },
    ] as const)('preserves $part $status admission and Work independently ($cause)', async row => {
        const { part, status, retained, cause } = row;
        const sessions = ['failed', 'available'].map(id => createSessionRecordFixture({ id, encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) }));
        const parts: SessionReadBatchResultV1[] = sessions.map(session => ({ sessionId: session.id,
            detail: { status: 200, body: { session } },
            turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [
                { turnId: 'turn', agentId: 'claude', status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 },
            ] } }, messages: { status: 200, body: { messages: [], hasMore: false } },
        }));
        if (status === 200) {
            parts[0]!.detail = { status: 200, body: { session: { ...sessions[0]!, effectiveAccess: {
                v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'share' }],
                capabilities: { ...projectSessionAccessCapabilitiesV1({ owner: false, grants: [] }), readTranscript: false },
            } } } };
        } else {
            parts[0]![part] = { status, body: { error: 'bodyError' in row ? row.bodyError : 'unavailable' } };
        }
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: parts }, 200, request));
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new RpcError('Machine offline', 'machine_offline'));
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: ['available', 'failed'], includeWorkEvidence: true });
        const value = twoSessionAccounting(sessions.map(session => session.id));
        const accounting = [{ query, status: 'available' as const, value }];
        const result = await readCliUsageDetail({ queries: [query], accounting,
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }),
        });
        expect(result.sessions.map(row => row.id).sort()).toEqual(retained ? ['available', 'failed'] : ['available']);
        expect(result.howYouWork[0]?.detail.facts?.some(fact => fact.workId === JSON.stringify(['available', 'turn']))).toBe(true);
        expect(result.howYouWork[0]).not.toHaveProperty('updateRequired');
        const projected = UsageQueryBatchResultSchema.parse(resolveUsagePageAggregation({ queries: [query], nowMs: 200,
            accounting, work: result.work, howYouWork: result.howYouWork,
            howYouWorkProgress: result.howYouWorkProgress }, bundledUsageModelPriceCatalog)).results[0];
        expect.soft(projected?.accounting?.totals).toEqual(value.totals);
        expect.soft(projected?.sources.find(source => source.source === 'work')).toMatchObject('workFailure' in row
            ? { status: 'error', errorCode: row.workFailure, unreadSessions: { machine_unavailable: 1,
                ...(['auth_failed', 'team_authentication_required'].includes(row.workFailure) ? { not_entitled: 1 } : { failed: 1 }) } }
            : { status: 'unknown', errorCode: 'machine_offline',
                unreadSessions: retained ? { machine_unavailable: 2 } : { machine_unavailable: 1, failed: 1 } });
        expect.soft(projected?.workSummary?.mergedPrCount).toBeUndefined();
        expect(projected?.howYouWork?.intervals?.agentTimeMs).toBe(part === 'messages' && retained ? 120 : 60);
        expect(projected?.sources).toContainEqual(expect.objectContaining({
            source: part === 'messages' && retained ? 'how_you_work:transcripts' : 'how_you_work:sessions',
            status: 'partial', errorCode: cause,
        }));
    });

    it.each(['detail', 'turns', 'messages'] as const)('preserves a current server %s update requirement without discarding a healthy sibling', async part => {
        const sessions = ['requires-update', 'available'].map(id => createSessionRecordFixture({ id, encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) }));
        const updateRequired = { kind: 'update_required' as const, operation: 'session.detail', component: 'client' as const,
            reason: 'access_projection_version_unsupported' };
        const parts: SessionReadBatchResultV1[] = sessions.map(session => ({ sessionId: session.id,
            detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [{ turnId: 'turn', agentId: 'claude',
                    status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] } },
            messages: { status: 200, body: { messages: [], hasMore: false } },
        }));
        parts[0]![part] = { status: 426, body: updateRequired };
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: parts }, 200, request));
        const get = vi.spyOn(axios, 'get');
        const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: sessions.map(row => row.id), includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }),
        });
        expect(result.sessions.map(row => row.id)).toEqual(['available']);
        expect(result.howYouWork).toMatchObject([{ errorCode: 'update_required', updateRequired }]);
        expect(get).not.toHaveBeenCalled();
    });

    it.each(['credential_scope_denied', 'cancelled'] as const)('preserves a %s Session evidence batch outcome', async disposition => {
        const controller = new AbortController();
        const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
            if (disposition === 'cancelled') controller.abort();
            return batchResponse({ error: 'credential_scope_denied' }, 403);
        });
        const get = vi.spyOn(axios, 'get');
        const read = readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: 'protected', includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, signal: controller.signal,
            assertCurrent: async () => { controller.signal.throwIfAborted(); }, resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        if (disposition === 'cancelled') await expect(read).rejects.toMatchObject({ name: 'AbortError' });
        else {
            const result = await read;
            expect(result.sessions).toEqual([]);
            expect(result.howYouWork).toMatchObject([{ errorCode: 'credential_scope_denied' }]);
            expect(result.howYouWork[0]).not.toHaveProperty('updateRequired');
        }
        expect(post).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalled();
    });

    it('rejects an evidence response that silently drops an explicitly selected Session', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: 'required', includeWorkEvidence: false });
        vi.spyOn(axios, 'post').mockImplementation(async () => batchResponse({
            requests: [{ query, sessionIds: [] }], results: [],
        }));
        const result = await readCliUsageDetail({ queries: [query], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.sessions).toEqual([]);
        expect(result.howYouWork[0]).toHaveProperty('errorCode');
    });

    it('reads only snapshots for work demand without Session intervals or transcript bodies', async () => {
        const session = createSessionRecordFixture({ id: 'work-only', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({
            results: [{ sessionId: session.id, detail: { status: 200, body: { session } } }],
        }, 200, request));
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session } });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeSessionEvidence: false,
            includeTranscriptEvidence: false, includeWorkEvidence: true });
        const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [{
            id: 'work-cost', observedAtMs: 150, sessionId: session.id, turnId: 'turn', agentId: 'claude', modelId: null,
            machineId: null, projectKey: null, workspaceId: null, source: 'session',
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
        }] });
        const result = await readCliUsageDetail({ queries: [query], accounting: [{ query, status: 'available', value: accounting }],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: request => ({ 'requester-authorization': JSON.stringify(request) }) });
        expect(result.sessions.map(row => row.id)).toEqual([session.id]);
        expect(result.howYouWork).toEqual([]);
        const body = UsageSessionEvidenceRequestSchema.parse({ nowMs: 200, requests: [{ query, sessionIds: [session.id] }] });
        expect(post).toHaveBeenCalledExactlyOnceWith(`http://usage-batch.test${USAGE_SESSION_EVIDENCE_PATH}`, body,
            expect.objectContaining({ headers: expect.objectContaining({ 'requester-authorization': JSON.stringify({
                method: 'POST', path: USAGE_SESSION_EVIDENCE_PATH, body,
            }) }) }));
        expect(get).not.toHaveBeenCalled();
    });

    it('uses canonical compact accounting membership for historical evidence and SCM metadata demand', async () => {
        const session = createSessionRecordFixture({ id: 'compact-member', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, projects: ['historical-project'],
            includeTranscriptEvidence: false });
        const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            sessionMembership: { turns: [{ sessionId: session.id, turnId: 'historical-turn', executions: ['happier'] }] },
        });
        expect(value.contributions).toBeUndefined();
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({
            results: [{ sessionId: session.id, detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [{ turnId: 'historical-turn', agentId: 'claude',
                    status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] } } }],
        }, 200, request));
        const result = await readCliUsageDetail({ queries: [query], accounting: [{ query, status: 'available', value }],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.sessions.map(row => row.id)).toEqual([session.id]);
        expect(result.howYouWork[0]?.detail.facts).toContainEqual(expect.objectContaining({
            workId: JSON.stringify([session.id, 'historical-turn']), kind: 'busy', startMs: 120, endMs: 180,
        }));
        expect(UsageSessionEvidenceRequestSchema.parse(post.mock.calls[0]![1]).requests)
            .toEqual([{ query, sessionIds: [session.id] }]);
    });

    it.each([
        ['machine', 'compact'], ['machine', 'contributions'], ['agent', 'compact'], ['agent', 'contributions'],
    ] as const)('retains historical %s membership alongside discovery with %s accounting and Work disabled', async (dimension, format) => {
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeTranscriptEvidence: false,
            includeWorkEvidence: false, ...(dimension === 'machine' ? { machines: ['machine-a'] } : { agents: ['claude'] }) });
        const sessions = ['discovered', 'shared', 'historical'].map(id => createSessionRecordFixture({ id,
            encryptionMode: 'plain', share: null, metadata: JSON.stringify({ path: '/repo',
                machineId: id === 'historical' ? 'machine-b' : 'machine-a', agent: id === 'historical' ? 'codex' : 'claude' }) }));
        const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 2,
            tokens: { input: 2, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            ...(format === 'compact' ? { sessionMembership: { turns: ['historical', 'shared'].map(sessionId => ({
                sessionId, turnId: 'turn', executions: ['happier'],
            })) } } : { contributions: ['historical', 'shared'].map(sessionId => ({ id: sessionId,
                observedAtMs: 140, sessionId, turnId: 'turn', agentId: 'claude', modelId: null, machineId: 'machine-a',
                projectKey: null, workspaceId: null, source: 'session',
                tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            })) }),
        });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            const requests = UsageSessionEvidenceRequestSchema.parse(body).requests.map(row => ({ query: row.query,
                sessionIds: row.sessionIds ?? ['discovered', 'shared'] }));
            const selected = new Set(requests.flatMap(row => row.sessionIds));
            return batchResponse({ requests, results: sessions.filter(session => selected.has(session.id)).map(session => ({
                sessionId: session.id, detail: { status: 200, body: { session } }, turns: { status: 200,
                    body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [{ turnId: 'turn',
                        agentId: session.id === 'historical' ? 'codex' : 'claude', status: 'completed', startedAt: 120,
                        terminalAt: 180, updatedAt: 180 }] } },
            })) });
        });
        const result = await readCliUsageDetail({ queries: [query], accounting: [{ query, status: 'available', value }],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.howYouWork[0]?.detail.facts).toHaveLength(3);
        expect(result.howYouWork[0]?.detail.facts).toContainEqual(expect.objectContaining({
            workId: JSON.stringify(['historical', 'turn']), agentId: 'codex', machineId: 'machine-b', kind: 'busy',
        }));
        expect(post).toHaveBeenCalledTimes(1);
        expect(UsageSessionEvidenceRequestSchema.parse(post.mock.calls[0]![1]).requests)
            .toEqual([{ query }, { query, sessionIds: ['historical', 'shared'] }]);
    });

    it('retains server-selected overlap and decision evidence alongside accounting-admitted Sessions', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeTranscriptEvidence: false });
        const sessions = ['overlap', 'decision', 'scm-only'].map(id => createSessionRecordFixture({ id,
            encryptionMode: 'plain', share: null, metadata: JSON.stringify({ path: '/repo', agent: 'claude' }),
            ...(id === 'decision' ? { agentState: JSON.stringify(AgentStateSchema.parse({ completedRequests: { permission: {
                tool: 'Read', arguments: {}, turnId: 'turn', createdAt: 80, completedAt: 150, status: 'approved',
            } } })) } : {}),
        }));
        const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [{ id: 'scm-event',
                observedAtMs: 140, sessionId: 'scm-only', turnId: 'turn', agentId: 'claude', modelId: null,
                machineId: null, projectKey: null, workspaceId: null, source: 'session',
                tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            }] });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            const request = UsageSessionEvidenceRequestSchema.parse(body);
            expect(request.requests).toEqual([{ query }, { query, sessionIds: ['scm-only'] }]);
            return batchResponse(UsageSessionEvidenceResponseSchema.parse({
                requests: [{ query, sessionIds: ['overlap', 'decision'] }, { query, sessionIds: ['scm-only'] }],
                results: sessions.map(session => ({ sessionId: session.id, detail: { status: 200, body: { session } },
                    turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [{ turnId: 'turn',
                        agentId: 'claude', status: 'completed', startedAt: 90, terminalAt: 120, updatedAt: 180 }] } },
                })),
            }));
        });
        const get = vi.spyOn(axios, 'get');
        const result = await readCliUsageDetail({ queries: [query], accounting: [{ query, status: 'available', value }],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.sessions.map(row => row.id)).toEqual(['overlap', 'decision', 'scm-only']);
        const detail = result.howYouWork[0]!.detail;
        expect(detail.facts).toContainEqual(expect.objectContaining({ workId: JSON.stringify(['overlap', 'turn']), startMs: 90, endMs: 120 }));
        expect(detail.permissions).toContainEqual(expect.objectContaining({ requestId: 'permission', requestedAtMs: 80, decidedAtMs: 150 }));
        expect(detail.facts?.some(fact => fact.workId === JSON.stringify(['scm-only', 'turn']))).toBe(true);
        expect(post).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalled();
    });

    it('retains compact permission decisions and waits when plain private state is absent', async () => {
        const session = createSessionRecordFixture({ id: 'compact-permission', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', agent: 'claude' }), agentState: null });
        const expected = projectSessionUsageWorkEvidence({ id: session.id, metadata: null, agentState: {
            completedRequests: { permission: { tool: 'Read', turnId: 'turn', createdAt: 80, completedAt: 150, status: 'approved' } },
        } });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: session.id,
            includeTranscriptEvidence: false, includeWorkEvidence: false });
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: [{
            sessionId: session.id, detail: { status: 200, body: { session } },
            turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } },
            stateEvidence: { permissions: expected.permissions ?? [], waits: expected.facts ?? [] },
        }] }, 200, request));
        const result = await readCliUsageDetail({ queries: [query], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.sessions).toHaveLength(1);
        expect(session.agentState).toBeNull();
        expect(result.howYouWork[0]?.detail.permissions).toEqual(expected.permissions);
        expect(result.howYouWork[0]?.detail.permissions).toHaveLength(1);
        expect(result.howYouWork[0]?.detail.facts).toEqual(expected.facts);
        expect(result.howYouWork[0]?.detail.facts).toContainEqual(expect.objectContaining({ kind: 'permission_wait', startMs: 80, endMs: 150 }));
    });

    it('keeps transcript facts confined to the queries that requested them', async () => {
        const session = createSessionRecordFixture({ id: 'shared-evidence', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) });
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: session.id, includeWorkEvidence: false });
        const withoutTranscript = normalizeUsageQuery({ ...query, includeTranscriptEvidence: false });
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: [{ sessionId: session.id,
            detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [{ turnId: 'turn', agentId: 'claude',
                    status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] } },
            messageEvidence: { phaseEvents: [{ evidenceId: 'transcript-phase', sessionId: session.id, turnId: 'turn',
                observedAtMs: 140, kind: 'read', method: 'tool_classification' }] }, messagesComplete: true,
        }] }, 200, request));
        const result = await readCliUsageDetail({ queries: [query, withoutTranscript], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.howYouWork[0]!.detail.phaseEvents).toContainEqual(expect.objectContaining({ evidenceId: 'transcript-phase' }));
        expect(result.howYouWork[1]!.detail.phaseEvents).toBeUndefined();
        expect(result.howYouWork[1]!.detail.facts).toEqual(result.howYouWork[0]!.detail.facts);
    });

    it.each([
        { name: 'missing recipient envelope', key: null, cause: 'encrypted_access_pending' },
        { name: 'unopenable recipient envelope', key: 'AA==', cause: 'encrypted_access_needs_repair' },
        { name: 'recipient setup required', key: null, cause: 'recipient_encryption_setup_required',
            readiness: { status: 'unavailable', reason: 'encryption_setup_required' } },
        { name: 'unopenable owner metadata', key: null, cause: 'metadata_unavailable', owner: true },
    ] as const)('reports $name beside the readable sibling’s partial activity', async row => {
        const { key, cause } = row;
        const secret = new Uint8Array(32).fill(17);
        const metadata = encodeBase64(encrypt(secret, 'legacy', { path: '/repo', machineId: 'machine', agent: 'claude' }));
        const owner = 'owner' in row && row.owner;
        const sessions = [
            createSessionRecordFixture({ id: 'locked', encryptionMode: 'e2ee', dataEncryptionKey: key,
                metadata: owner ? 'AA==' : metadata, share: owner ? null : { accessLevel: 'view', canApprovePermissions: false } }),
            createSessionRecordFixture({ id: 'available', encryptionMode: 'e2ee', metadata, share: null }),
        ];
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: sessions.map(session => ({
            sessionId: session.id, detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [{ turnId: 'turn', agentId: 'claude',
                    status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] } },
        })) }, 200, request));
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new RpcError('Machine offline', 'machine_offline'));
        const sessionIds = sessions.map(session => session.id);
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: sessionIds,
            includeTranscriptEvidence: false, includeWorkEvidence: true });
        const value = twoSessionAccounting(sessionIds);
        const accounting = [{ query, status: 'available' as const, value }];
        const result = await readCliUsageDetail({ queries: [query], accounting,
            credentials: { token: 'token', encryption: { type: 'legacy', secret } },
            serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test', accountEncryptionMode: 'e2ee',
            recipientEnvelopeReadiness: 'readiness' in row ? row.readiness : undefined,
            allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {}, resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        expect(result.sessions.map(row => row.id)).toEqual(['available']);
        const answer = UsageQueryBatchResultSchema.parse(resolveUsagePageAggregation({ queries: [query], nowMs: 200,
            accounting, work: result.work, howYouWork: result.howYouWork, howYouWorkProgress: result.howYouWorkProgress },
        bundledUsageModelPriceCatalog)).results[0];
        expect(answer?.howYouWork).toMatchObject({ detailStatus: 'partial', intervals: { agentTimeMs: 60 } });
        expect(answer?.accounting?.totals).toEqual(value.totals);
        expect(answer?.sources).toContainEqual(expect.objectContaining({
            source: 'how_you_work:sessions', status: 'partial', errorCode: cause,
        }));
        expect(answer?.sources).toContainEqual(expect.objectContaining({
            source: 'work', status: 'unknown', errorCode: 'machine_offline', unreadSessions: { failed: 1, machine_unavailable: 1 },
        }));
    });

    it.each([true, false])('opens opaque E2EE evidence locally and refuses server-supplied plaintext facts (key available: %s)', async available => {
        const secret = new Uint8Array(32).fill(17);
        const session = createSessionRecordFixture({ id: 'encrypted-evidence', seq: 1, encryptionMode: 'e2ee', share: null,
            metadata: encodeBase64(encrypt(secret, 'legacy', { path: '/repo', agent: 'claude' })) });
        const content = encodeBase64(encrypt(secret, 'legacy', { role: 'agent', content: { type: 'output', data: {
            type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'actual-read', name: 'Read',
                input: { file_path: '/private-e2ee-file' } }] },
        } } }));
        vi.spyOn(axios, 'post').mockImplementation(async (_url, request) => batchResponse({ results: [{ sessionId: session.id,
            detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } },
            messages: { status: 200, body: { hasMore: false, messages: [{ id: 'sealed', seq: 1, createdAt: 140,
                content: { t: 'encrypted', c: content } }] } },
            messageEvidence: { phaseEvents: [{ evidenceId: 'server-forged', sessionId: session.id, turnId: null,
                observedAtMs: 140, kind: 'change', method: 'tool_classification' }] }, messagesComplete: true,
            stateEvidence: { permissions: [{ requestId: 'server-forged', workId: JSON.stringify([session.id, 'turn']),
                requestedAtMs: 100, decidedAtMs: 140, toolId: 'Read', answeringClientCategory: null }], waits: [] },
        }] }, 200, request));
        const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: session.id, includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'token', encryption: available ? { type: 'legacy', secret } : null },
            serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test', accountEncryptionMode: 'e2ee',
            allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {}, resolveHeaders: () => ({ Authorization: 'Bearer token' }) });
        if (available) expect(result.howYouWork[0]?.detail.phaseEvents).toEqual([expect.objectContaining({ evidenceId: 'actual-read', kind: 'read' })]);
        else expect(result.sessions).toEqual([]);
        expect(JSON.stringify(result)).not.toContain('server-forged');
        expect(JSON.stringify(result)).not.toContain('/private-e2ee-file');
    });

    it('retains all 660 selected Session facts without inventory or full Session reads', async () => {
        // Measured workload: lanes/USAGE-SESSION-BATCH-READ.md, ROOT-12 / REPLAY-R28.
        const sessions = Array.from({ length: 660 }, (_, index) => createSessionRecordFixture({
            id: `usage-${index}`, encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }),
        }));
        const turns = (sessionId: string) => SessionTurnsProjectionV1Schema.parse({ v: 1, sessionId, updatedAt: 180,
            turns: [{ turnId: 'turn', agentId: 'claude', status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] });
        const messages = SessionMessagesPageV1Schema.parse({ hasMore: false, messages: [{ id: 'read', seq: 1, createdAt: 140, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'output', data: { type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-tool', name: 'Read', input: { file_path: '/private' } }] } } } } } }] });
        const app = fastify();
        const paths: string[] = [];
        const responseBytes: number[] = [];
        const selectedCounts: number[] = [];
        app.addHook('preHandler', async request => { paths.push(request.url.split('?')[0]!); });
        app.addHook('onSend', async (request, _reply, payload) => {
            if (request.url === USAGE_SESSION_EVIDENCE_PATH && typeof payload === 'string') responseBytes.push(Buffer.byteLength(payload));
            return payload;
        });
        app.get<{ Querystring: { cursor?: string; limit?: string } }>('/v2/sessions', async request => {
            const offset = Number(request.query.cursor ?? 0);
            const limit = Math.min(Number(request.query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT), SESSION_LIST_PAGE_MAX_LIMIT);
            const next = offset + limit;
            return { sessions: sessions.slice(offset, next).map(createCompactSessionListRowFixture),
                hasNext: next < sessions.length, ...(next < sessions.length ? { nextCursor: String(next) } : {}) };
        });
        app.get('/v2/sessions/archived', async () => ({ sessions: [], hasNext: false }));
        app.get<{ Params: { id: string } }>('/v2/sessions/:id', async request => ({ session: sessions.find(row => row.id === request.params.id) }));
        app.get<{ Params: { id: string } }>('/v1/sessions/:id/turns', async request => turns(request.params.id));
        app.get('/v1/sessions/:id/messages', async () => messages);
        app.post('/v2/sessions/read-batch', async request => createSessionReadBatchResponseFixture({ request: request.body, sessions,
            turns: new Map(sessions.map(row => [row.id, { status: 200, body: turns(row.id) }])),
            messages: new Map(sessions.map(row => [row.id, { status: 200, body: messages }])),
        }));
        app.post(USAGE_SESSION_EVIDENCE_PATH, async request => {
            const input = UsageSessionEvidenceRequestSchema.parse(request.body);
            const requests = input.requests.map(row => ({ query: row.query, sessionIds: row.sessionIds ?? sessions.map(session => session.id) }));
            const selectedIds = [...new Set(requests.flatMap(row => row.sessionIds))];
            selectedCounts.push(selectedIds.length);
            const parts = createSessionReadBatchResponseFixture({ request: { sessionIds: selectedIds,
                includeSnapshot: true, includeTurns: true, includeMessages: false }, sessions,
                turns: new Map(sessions.map(row => [row.id, { status: 200, body: turns(row.id) }])),
            });
            return UsageSessionEvidenceResponseSchema.parse({
                requests,
                results: parts.results.map(part => ({ ...part, messageEvidence: { acceptedInputs: [], phaseEvents: [{
                    evidenceId: 'read-tool', sessionId: part.sessionId, turnId: null, observedAtMs: 140,
                    kind: 'read', method: 'tool_classification',
                }] }, messagesComplete: true })),
            });
        });
        const cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-batch.test' });
        try {
            const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
                includeWorkEvidence: false })], accounting: [], credentials: { token: 'token', encryption: null },
                serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test', accountEncryptionMode: 'plain',
                allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
                resolveHeaders: () => ({ Authorization: 'Bearer token' }),
            });
            expect(result.sessions).toHaveLength(660);
            expect(result.howYouWork[0]?.detail.facts).toHaveLength(660);
            expect(result.howYouWork[0]?.detail.facts).toContainEqual(expect.objectContaining({
                workId: JSON.stringify(['usage-659', 'turn']), kind: 'busy', startMs: 120, endMs: 180,
            }));
            expect(result.howYouWork[0]?.detail.phaseEvents).toContainEqual(expect.objectContaining({ sessionId: 'usage-659', kind: 'read' }));
            expect(JSON.stringify(result)).not.toContain('/private');
            const selected = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
                session: 'usage-659', includeWorkEvidence: false })], accounting: [], credentials: { token: 'token', encryption: null },
                serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test', accountEncryptionMode: 'plain',
                allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
                resolveHeaders: () => ({ Authorization: 'Bearer token' }),
            });
            expect(selected.sessions.map(row => row.id)).toEqual(['usage-659']);
            expect(selected.howYouWork[0]?.detail.facts).toHaveLength(1);
            expect(selectedCounts).toEqual([660, 1]);
            expect(responseBytes).toHaveLength(2);
            expect(responseBytes[1]).toBeLessThan(responseBytes[0]!);
            expect(paths.filter(path => path === '/v2/sessions'
                || path === '/v2/sessions/archived' || path === '/v2/sessions/read-batch')).toEqual([]);
        } finally {
            cleanup();
            await app.close();
        }
    });
});
