import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const boundary = { rpc: vi.fn() };
// The daemon's serialized answer is external; the scoped transport, transcript
// adapter/schema, normalizer and reducer stay real beneath this Socket.IO kit.
const requests = installSessionActionRpcBoundary(request => boundary.rpc(request));
await loadSyncSingletonForTests();
const transcriptNormalization = await import('@/sync/runtime/external/normalizeExternalSessionTranscriptMessages');
const { readExternalSessionExchange } = await import('./readExternalSessionExchange');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;

const prompt: ExternalSessionTranscriptRawMessageV1 = { id: 'prompt', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'Explain this failure' } } };
const answer: ExternalSessionTranscriptRawMessageV1 = { id: 'answer', createdAtMs: 2, raw: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'The complete answer' } } } };
const input = () => ({
    request: { machineId: 'machine', agentId: 'codex', source: { kind: 'codexHome' as const, home: 'user' as const }, remoteSessionId: 'conversation' },
    sourceItemId: 'answer', signal: new AbortController().signal,
    accountLifetime: { scope: { serverId, accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
});

describe('readExternalSessionExchange', () => {
    beforeEach(async () => {
        await homes.reset();
        requests.length = 0;
        serverId = await homes.addHome({ name: 'Exchange Home', serverUrl: 'https://exchange-read.test', accountId: 'account' });
        const machine = createPlainMachineRowFixture({ id: 'machine', accountId: 'account' });
        homes.answer(serverId, '/v1/machines/machine', { body: { machine } });
        homes.answer(serverId, '/v1/machines', { body: [machine] });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://exchange-read.test', accountId: 'account', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        boundary.rpc.mockReset();
    });
    afterEach(async () => { await connection?.dispose(); connection = undefined; });
    it('returns the prompt and late hit without the intervening long turn', async () => {
        const steps = Array.from({ length: 600 }, (_, index) => ({ ...answer, id: `step-${index}`, createdAtMs: index + 2,
            raw: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: `${index}: ${'Long tool observation. '.repeat(50)}` } } } }));
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [prompt, ...steps], hasMore: false });
        const exchange = await readExternalSessionExchange({ ...input(), sourceItemId: 'step-550' });
        expect(exchange.messages.map(message => message.realID)).toEqual(['prompt', 'step-550']);
        expect(exchange.matchedMessageId).toBe(exchange.messages[1]!.id);
        expect(exchange.elidedMessageCount).toBe(550);
    });
    it('does not normalize completed later turns again while seeking an older selected exchange', async () => {
        // Observe the real normalizer without replacing its implementation.
        const normalize = vi.spyOn(transcriptNormalization, 'normalizeExternalSessionTranscriptMessages');
        try {
            const pageCount = 10;
            const turnsPerPage = 100;
            for (let pageIndex = pageCount - 1; pageIndex >= 0; pageIndex--) {
                const items = Array.from({ length: turnsPerPage }, (_, turnIndex) => {
                    const turn = pageIndex * turnsPerPage + turnIndex;
                    return [
                        { ...prompt, id: `prompt-${turn}`, createdAtMs: turn * 2 + 1 },
                        { ...answer, id: `answer-${turn}`, createdAtMs: turn * 2 + 2 },
                    ];
                }).flat();
                boundary.rpc.mockResolvedValueOnce({ ok: true, items, hasMore: pageIndex > 0,
                    ...(pageIndex > 0 ? { nextCursor: `page-${pageIndex - 1}` } : {}) });
            }
            const messages = await readExternalSessionExchange({ ...input(), sourceItemId: 'answer-0' });
            expect(messages.messages.map(message => message.realID)).toEqual(['prompt-0', 'answer-0']);
            expect(normalize.mock.calls.reduce((total, [items]) => total + items.length, 0))
                .toBe(pageCount * turnsPerPage * 2);
        } finally {
            normalize.mockRestore();
        }
    });
    it('keeps a tool-result hit attached to its completed call, not an empty preview', async () => {
        const callId = 'read-notes';
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [prompt,
            { id: 'tool-call', createdAtMs: 2, raw: { role: 'agent', content: { type: 'codex', data: {
                type: 'tool-call', callId, name: 'exec', input: { command: 'read notes' },
            } } } },
            { id: 'tool-result', createdAtMs: 3, raw: { role: 'agent', content: { type: 'codex', data: {
                type: 'tool-call-result', callId, output: [{ type: 'input_text', text: 'violet harbor lantern' }],
            } } } },
        ], hasMore: false });
        const exchange = await readExternalSessionExchange({ ...input(), sourceItemId: 'tool-result' });
        expect(exchange.messages).toHaveLength(2);
        expect(exchange.messages[1]).toMatchObject({ kind: 'tool-call', tool: { id: callId, state: 'completed' } });
        expect(exchange.matchedMessageId).toBe(exchange.messages[1]!.id);
        expect(exchange.elidedMessageCount).toBe(0);
    });
    it.each(['prompt', 'absent'])('does not substitute a different message for a %s hit', async sourceItemId => {
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [prompt, answer], hasMore: false });
        const exchange = await readExternalSessionExchange({ ...input(), sourceItemId });
        expect(exchange.messages.map(message => message.realID)).toEqual(sourceItemId === 'prompt' ? ['prompt'] : []);
        expect(exchange.matchedMessageId).toBe(sourceItemId === 'prompt' ? exchange.messages[0]!.id : null);
        expect(exchange.elidedMessageCount).toBe(0);
    });
    it('finds the selected item across three pages without publishing the rest of its turn', async () => {
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [{ ...answer, id: 'answer-end', createdAtMs: 4 },
            { ...prompt, id: 'next', createdAtMs: 5 }, { ...answer, id: 'next-answer', createdAtMs: 6 }], hasMore: true, nextCursor: 'middle' })
            .mockResolvedValueOnce({ ok: true, items: [{ ...answer, id: 'answer-middle', createdAtMs: 3 }], hasMore: true, nextCursor: 'start' })
            .mockResolvedValueOnce({ ok: true, items: [prompt, answer], hasMore: false });
        const messages = await readExternalSessionExchange(input());
        expect(messages.messages.map(message => message.realID)).toEqual(['prompt', 'answer']);
        expect(messages.elidedMessageCount).toBe(0);
    });
    it('reads the selected exchange across pages and excludes the following turn', async () => {
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [answer, { ...prompt, id: 'next', createdAtMs: 3 }], hasMore: true, nextCursor: 'older' })
            .mockResolvedValueOnce({ ok: true, items: [prompt], hasMore: false });
        const messages = await readExternalSessionExchange(input());
        expect(messages.messages.map(message => message.realID)).toEqual(['prompt', 'answer']);
        expect(messages.messages.map(message => 'text' in message ? message.text : '')).toEqual(['Explain this failure', 'The complete answer']);
        expect(requests[0]).toMatchObject({ method: expect.stringMatching(/^machine:/), params: { sourceItemId: 'answer' } });
        expect(requests[1]).toMatchObject({ method: expect.stringMatching(/^machine:/), params: { cursor: 'older', sourceItemId: 'answer' } });
        const admission = homes.requests.find(request => request.path === '/v1/machines/read-batch');
        expect(admission).toMatchObject({ serverId, token: expect.any(String), input: { machineIds: ['machine'] } });
    });
    it('retains a three-page sidechain answer independently of newer parent prompts', async () => {
        const childPrompt: ExternalSessionTranscriptRawMessageV1 = { id: 'child-prompt', createdAtMs: 1, sidechainId: 'child',
            raw: { role: 'agent', content: { type: 'output', data: { type: 'user', sidechainId: 'child',
                message: { content: 'The native sidechain prompt' } } } } };
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [{ ...prompt, id: 'parent-next', createdAtMs: 4 },
            { ...answer, id: 'child-end', sidechainId: 'child', createdAtMs: 5 }], hasMore: true, nextCursor: 'middle' })
            .mockResolvedValueOnce({ ok: true, items: [{ ...answer, id: 'child-middle', sidechainId: 'child', createdAtMs: 3 }],
                hasMore: true, nextCursor: 'start' })
            .mockResolvedValueOnce({ ok: true, items: [childPrompt, { ...answer, sidechainId: 'child' }], hasMore: false });
        expect((await readExternalSessionExchange(input())).messages.map(message => message.realID))
            .toEqual(['child-prompt', 'answer']);
    });
    it('projects a sidechain exchange through the same reducer rather than returning the parent conversation', async () => {
        boundary.rpc.mockResolvedValueOnce({ ok: true, hasMore: false, items: [
            prompt, { id: 'child-prompt', createdAtMs: 1, sidechainId: 'child', raw: { role: 'agent', content: { type: 'output', data: {
                type: 'user', sidechainId: 'child', message: { content: 'The native sidechain prompt' },
            } } } }, { ...answer, sidechainId: 'child' },
        ] });
        const messages = await readExternalSessionExchange(input());
        expect(messages.messages.map(message => message.realID)).toEqual(['child-prompt', 'answer']);
    });
    it('rejects a late response when cancelled and never follows its cursor', async () => {
        const controller = new AbortController();
        boundary.rpc.mockImplementationOnce(async () => {
            controller.abort();
            return { ok: true, items: [answer], hasMore: true, nextCursor: 'older' };
        });
        await expect(readExternalSessionExchange({ ...input(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
    });
});
