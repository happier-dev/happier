import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

describe('sessionPromptPreview', () => {
    beforeEach(() => {
        sessionRpcWithServerScopeMock.mockReset();
    });

    it('returns the live runner payload through the selected server scope', async () => {
        const payload = {
            ok: true,
            sessionId: 'session-1',
            text: 'Rendered prompt',
            blocks: [{ id: 'coding.base', scope: 'coding', chars: 15 }],
            launchForm: 'retained',
            providerNotes: ['Provider appends a second rendering.'],
        } as const;
        sessionRpcWithServerScopeMock.mockResolvedValue(payload);

        const { sessionPromptPreview } = await import('./sessionPromptPreview');
        await expect(sessionPromptPreview({ sessionId: 'session-1', serverId: 'server-a' })).resolves.toEqual(payload);
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-a',
            method: SESSION_RPC_METHODS.SESSION_PROMPT_PREVIEW_GET_V1,
            payload: {},
        });
    });

    it('rejects a response that does not satisfy the protocol contract', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true, text: 'Missing diagnostics' });

        const { sessionPromptPreview } = await import('./sessionPromptPreview');
        await expect(sessionPromptPreview({ sessionId: 'session-1', serverId: null }))
            .rejects.toThrow('invalid-session-prompt-preview-response');
    });
});
