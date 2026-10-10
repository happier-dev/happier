import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { readExternalSessionExchange } from './readExternalSessionExchange';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// Keep the real transcript RPC adapter/schema/normalizer/reducer beneath the network boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: unknown) => boundary.rpc(input),
}));

const prompt: ExternalSessionTranscriptRawMessageV1 = { id: 'prompt', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'Explain this failure' } } };
const answer: ExternalSessionTranscriptRawMessageV1 = { id: 'answer', createdAtMs: 2, raw: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'The complete answer' } } } };
const input = () => ({
    request: { machineId: 'machine', agentId: 'codex', source: { kind: 'codexHome' as const, home: 'user' as const }, remoteSessionId: 'conversation' },
    sourceItemId: 'answer', signal: new AbortController().signal,
    accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
});

describe('readExternalSessionExchange', () => {
    beforeEach(() => boundary.rpc.mockReset());
    it('keeps every answer page before finding the selected item in a three-page exchange', async () => {
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [{ ...answer, id: 'answer-end', createdAtMs: 4 },
            { ...prompt, id: 'next', createdAtMs: 5 }, { ...answer, id: 'next-answer', createdAtMs: 6 }], hasMore: true, nextCursor: 'middle' })
            .mockResolvedValueOnce({ ok: true, items: [{ ...answer, id: 'answer-middle', createdAtMs: 3 }], hasMore: true, nextCursor: 'start' })
            .mockResolvedValueOnce({ ok: true, items: [prompt, answer], hasMore: false });
        const messages = await readExternalSessionExchange(input());
        expect(messages.map(message => message.realID)).toEqual(['prompt', 'answer', 'answer-middle', 'answer-end']);
    });
    it('reads the selected exchange across pages and excludes the following turn', async () => {
        boundary.rpc.mockResolvedValueOnce({ ok: true, items: [answer, { ...prompt, id: 'next', createdAtMs: 3 }], hasMore: true, nextCursor: 'older' })
            .mockResolvedValueOnce({ ok: true, items: [prompt], hasMore: false });
        const messages = await readExternalSessionExchange(input());
        expect(messages.map(message => message.realID)).toEqual(['prompt', 'answer']);
        expect(messages.map(message => 'text' in message ? message.text : '')).toEqual(['Explain this failure', 'The complete answer']);
        expect(boundary.rpc.mock.calls[1]?.[0]).toMatchObject({ serverId: 'home', accountId: 'account', payload: { cursor: 'older' } });
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
        expect((await readExternalSessionExchange(input())).map(message => message.realID))
            .toEqual(['child-prompt', 'answer', 'child-middle', 'child-end']);
    });
    it('projects a sidechain exchange through the same reducer rather than returning the parent conversation', async () => {
        boundary.rpc.mockResolvedValueOnce({ ok: true, hasMore: false, items: [
            prompt, { id: 'child-prompt', createdAtMs: 1, sidechainId: 'child', raw: { role: 'agent', content: { type: 'output', data: {
                type: 'user', sidechainId: 'child', message: { content: 'The native sidechain prompt' },
            } } } }, { ...answer, sidechainId: 'child' },
        ] });
        const messages = await readExternalSessionExchange(input());
        expect(messages.map(message => message.realID)).toEqual(['child-prompt', 'answer']);
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
