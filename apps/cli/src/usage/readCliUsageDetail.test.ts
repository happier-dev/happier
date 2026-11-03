import axios from 'axios';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { SessionReadBatchResultV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCompactSessionListRowFixture, createSessionRecordFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { readCliUsageDetail } from './readCliUsageDetail';

afterEach(() => vi.restoreAllMocks());

describe('CLI Usage Session evidence demand', () => {
    it('does not substitute the installed bearer when batch authorization is refused', async () => {
        const session = createSessionRecordFixture({ id: 'refused-batch', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { results: [{ sessionId: session.id,
            detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } },
        }] } });
        const get = vi.spyOn(axios, 'get');
        const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: session.id, includeTranscriptEvidence: false, includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'installed-owner', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: request => request.path === '/v2/sessions/read-batch' ? null : { 'requester-authorization': 'admitted' },
        });
        expect(result.sessions).toEqual([]);
        expect(post).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
    });

    it('settles an unsupported batch route without disclosing singleton Session detail', async () => {
        const session = createSessionRecordFixture({ id: 'old-home-session', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) });
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session } });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
        const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: session.id, includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }),
        });
        expect(result.sessions).toEqual([]);
        expect(result.howYouWork).toMatchObject([{ errorCode: 'update_required', detail: { status: 'unknown' },
            updateRequired: { kind: 'update_required', operation: 'session.detail', component: 'server', reason: 'session_read_batch_unsupported' } }]);
        expect(post).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalled();
    });

    it.each([
        { part: 'detail', status: 404, retained: false },
        { part: 'detail', status: 403, retained: false },
        { part: 'turns', status: 404, retained: true },
        { part: 'turns', status: 503, retained: false },
        { part: 'messages', status: 503, retained: true },
        { part: 'messages', status: 403, retained: false },
    ] as const)('preserves $part $status admission while retaining other Sessions', async ({ part, status, retained }) => {
        const sessions = ['failed', 'available'].map(id => createSessionRecordFixture({ id, encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) }));
        const parts: SessionReadBatchResultV1[] = sessions.map(session => ({ sessionId: session.id,
            detail: { status: 200, body: { session } },
            turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [
                { turnId: 'turn', agentId: 'claude', status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 },
            ] } }, messages: { status: 200, body: { messages: [], hasMore: false } },
        }));
        parts[0]![part] = { status, body: { error: 'unavailable' } };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { results: parts } });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const sessionId = String(url).includes('/available') ? 'available' : 'failed';
            const selected = parts.find(row => row.sessionId === sessionId)!;
            return String(url).endsWith('/turns') ? { status: selected.turns!.status, data: selected.turns!.body }
                : { status: selected.detail!.status, data: selected.detail!.body };
        });
        const result = await readCliUsageDetail({ queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
            session: ['available', 'failed'], includeWorkEvidence: false })], accounting: [],
            credentials: { token: 'token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://usage-batch.test',
            accountEncryptionMode: 'plain', allowPrivateRead: true, nowMs: 200, assertCurrent: async () => {},
            resolveHeaders: () => ({ Authorization: 'Bearer token' }),
        });
        expect(result.sessions.map(row => row.id).sort()).toEqual(retained ? ['available', 'failed'] : ['available']);
        expect(result.howYouWork[0]?.detail.facts?.some(fact => fact.workId === JSON.stringify(['available', 'turn']))).toBe(true);
        expect(result.howYouWork[0]).not.toHaveProperty('updateRequired');
    });

    it.each(['detail', 'turns', 'messages'] as const)('preserves a current server %s update requirement without discarding a healthy sibling', async part => {
        const sessions = ['requires-update', 'available'].map(id => createSessionRecordFixture({ id, encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }) }));
        const updateRequired = { kind: 'update_required' as const, operation: 'session.detail', component: 'client' as const,
            reason: 'access_projection_version_unsupported' };
        const parts: SessionReadBatchResultV1[] = sessions.map(session => ({ sessionId: session.id,
            detail: { status: 200, body: { session } }, turns: { status: 200,
                body: { v: 1, sessionId: session.id, updatedAt: 180, turns: [] } },
            messages: { status: 200, body: { messages: [], hasMore: false } },
        }));
        parts[0]![part] = { status: 426, body: updateRequired };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { results: parts } });
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

    it.each(['forbidden', 'cancelled'] as const)('does not relabel a %s batch as needing a newer server', async disposition => {
        const controller = new AbortController();
        const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
            if (disposition === 'cancelled') controller.abort();
            return { status: 403, data: { error: 'forbidden' } };
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
            expect(result.howYouWork).toMatchObject([{ errorCode: 'auth_failed' }]);
            expect(result.howYouWork[0]).not.toHaveProperty('updateRequired');
        }
        expect(post).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalled();
    });

    it('reads only snapshots for work demand without Session intervals or transcript bodies', async () => {
        const session = createSessionRecordFixture({ id: 'work-only', encryptionMode: 'plain', share: null,
            metadata: JSON.stringify({ path: '/repo', agent: 'claude' }) });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
            results: [{ sessionId: session.id, detail: { status: 200, body: { session } } }],
        } });
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
        expect(post).toHaveBeenCalledExactlyOnceWith('http://usage-batch.test/v2/sessions/read-batch',
            { sessionIds: [session.id], includeSnapshot: true, includeTurns: false, includeMessages: false },
            expect.objectContaining({ headers: expect.objectContaining({ 'requester-authorization': JSON.stringify({
                method: 'POST', path: '/v2/sessions/read-batch', body: {
                    sessionIds: [session.id], includeSnapshot: true, includeTurns: false, includeMessages: false,
                },
            }) }) }));
        expect(get).not.toHaveBeenCalled();
    });

    it('batches the observed 660-Session census and retains the last Session facts', async () => {
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
        app.addHook('preHandler', async request => { paths.push(request.url.split('?')[0]!); });
        app.get('/v2/sessions', async () => ({ sessions: sessions.map(createCompactSessionListRowFixture), hasNext: false }));
        app.get('/v2/sessions/archived', async () => ({ sessions: [], hasNext: false }));
        app.get<{ Params: { id: string } }>('/v2/sessions/:id', async request => ({ session: sessions.find(row => row.id === request.params.id) }));
        app.get<{ Params: { id: string } }>('/v1/sessions/:id/turns', async request => turns(request.params.id));
        app.get('/v1/sessions/:id/messages', async () => messages);
        app.post('/v2/sessions/read-batch', async request => createSessionReadBatchResponseFixture({ request: request.body, sessions,
            turns: new Map(sessions.map(row => [row.id, { status: 200, body: turns(row.id) }])),
            messages: new Map(sessions.map(row => [row.id, { status: 200, body: messages }])),
        }));
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
            expect(paths).toEqual(['/v2/sessions', '/v2/sessions/archived', '/v2/sessions/read-batch']);
        } finally {
            cleanup();
            await app.close();
        }
    });
});
