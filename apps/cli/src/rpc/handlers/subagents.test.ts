import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSubagentRpcHandlers } from './subagents';
import type { RpcActionExecutor } from './_actionDispatchAdapter';

describe('subagent RPC handlers', () => {
    it('does not own a static RPC binding table', async () => {
        const source = await readFile(new URL('./subagents.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('SUBAGENT_RPC_BINDINGS');
    });

    it('registers subagent RPC methods as thin ActionSpec dispatch adapters', async () => {
        const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
        const calls: unknown[] = [];
        const actionExecutor: RpcActionExecutor = {
            execute: async (actionId, input, context) => {
                calls.push({ actionId, input, context });
                return { ok: true, result: { actionId, input } };
            },
        };

        registerSubagentRpcHandlers({
            rpcHandlerManager: {
                registerHandler(method, handler) {
                    handlers.set(method, handler);
                },
            },
            actionExecutor,
        });

        await expect(handlers.get(RPC_METHODS.SESSIONS_SUBAGENTS_LIST)?.({
            parentSessionId: 'session-1',
        })).resolves.toEqual({
            actionId: 'sessions.subagents.list',
            input: { parentSessionId: 'session-1' },
        });
        await expect(handlers.get(RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT)?.({
            id: 'subagent-1',
            parentSessionId: 'session-1',
            origin: 'plugin',
            kind: 'custom',
        })).resolves.toEqual({
            actionId: 'sessions.subagents.upsert',
            input: {
                id: 'subagent-1',
                parentSessionId: 'session-1',
                origin: 'plugin',
                kind: 'custom',
            },
        });

        expect(calls).toEqual([
            {
                actionId: 'sessions.subagents.list',
                input: { parentSessionId: 'session-1' },
                context: {
                    defaultSessionId: 'session-1',
                    surface: 'rpc',
                },
            },
            {
                actionId: 'sessions.subagents.upsert',
                input: {
                    id: 'subagent-1',
                    parentSessionId: 'session-1',
                    origin: 'plugin',
                    kind: 'custom',
                },
                context: {
                    defaultSessionId: 'session-1',
                    surface: 'rpc',
                },
            },
        ]);
    });

    it('returns stable forbidden errors for external mutation RPC calls', async () => {
        const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
        const actionExecutor: RpcActionExecutor = {
            execute: async () => ({
                ok: false,
                errorCode: 'subagent_write_forbidden',
                error: 'subagent_write_forbidden',
            }),
        };

        registerSubagentRpcHandlers({
            rpcHandlerManager: {
                registerHandler(method, handler) {
                    handlers.set(method, handler);
                },
            },
            actionExecutor,
        });

        await expect(handlers.get(RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT)?.({
            id: 'subagent-1',
            parentSessionId: 'session-1',
            origin: 'plugin',
            kind: 'custom',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'subagent_write_forbidden',
            error: 'subagent_write_forbidden',
        });
    });
});
