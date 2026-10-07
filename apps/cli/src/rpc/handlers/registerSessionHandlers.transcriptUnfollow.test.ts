import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createSessionTranscriptFollowLeaseRegistry } from '@/api/session/followSessionTranscript';
import { executeCliTranscriptAction } from '@/session/actions/executeCliTranscriptAction';
import { SESSION_TRANSCRIPT_RPC_SCOPES } from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';

describe('session transcript unfollow RPC', () => {
    it('releases the real follow lease through the canonical session transcript RPC scope', async () => {
        const registry = createSessionTranscriptFollowLeaseRegistry({ idleTtlMs: 60_000 });
        let released = false;
        registry.retain({
            sessionId: 'session-1', leaseId: 'lease-1', idleTtlMs: 60_000,
            release: async () => { released = true; },
        });
        const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
        try {
            registerActionSpecRpcHandlers({
                scopes: SESSION_TRANSCRIPT_RPC_SCOPES,
                rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
                actionExecutor: {
                    execute: async (actionId, input, context) => (await executeCliTranscriptAction({
                        actionId, input, context, defaultSessionId: 'session-1',
                        options: { transcriptFollowLeaseRegistry: registry },
                    })) ?? { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' },
                },
            });
            const unfollow = handlers.get(RPC_METHODS.TRANSCRIPT_UNFOLLOW);
            expect(unfollow).toBeTypeOf('function');
            await expect(unfollow?.({ sessionId: 'session-1', leaseId: 'lease-1' })).resolves.toEqual({ ok: true, released: true });
            expect(released).toBe(true);
            expect(registry.activeCount()).toBe(0);
            await expect(unfollow?.({ sessionId: 'session-1', leaseId: 'lease-1' })).resolves.toEqual({ ok: true, released: false });
        } finally {
            await registry.dispose();
        }
    });
});
