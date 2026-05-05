import { describe, expect, it } from 'vitest';

import {
    buildActionExecutorContextForRpc,
    dispatchActionFromRpc,
    type RpcActionExecutor,
} from './_actionDispatchAdapter';

describe('RPC action dispatch adapter', () => {
    it('maps RPC invocation context to the accepted action executor surface', async () => {
        const calls: unknown[] = [];
        const executor: RpcActionExecutor = {
            execute: async (actionId, input, context) => {
                calls.push({ actionId, input, context });
                return { ok: true as const, result: { dispatched: true } };
            },
        };

        const result = await dispatchActionFromRpc({
            actionId: 'session.message.send',
            input: { sessionId: 'session-1', message: 'hello' },
            defaultSessionId: 'session-1',
            serverId: 'server-1',
            executor,
        });

        expect(result).toEqual({ ok: true, result: { dispatched: true } });
        expect(calls).toEqual([
            {
                actionId: 'session.message.send',
                input: { sessionId: 'session-1', message: 'hello' },
                context: {
                    defaultSessionId: 'session-1',
                    serverId: 'server-1',
                    surface: 'rpc',
                },
            },
        ]);
    });

    it('omits empty routing hints instead of passing placeholder values', () => {
        expect(buildActionExecutorContextForRpc({
            defaultSessionId: '  ',
            serverId: null,
        })).toEqual({ surface: 'rpc' });
    });
});
