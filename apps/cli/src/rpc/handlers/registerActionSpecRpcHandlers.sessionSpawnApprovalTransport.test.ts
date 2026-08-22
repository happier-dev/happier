import { describe, expect, it, vi } from 'vitest';

import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';

function createRpcHarness() {
    const handlers = new Map<string, (
        input: unknown,
        context?: Readonly<{ signal: AbortSignal }>,
    ) => Promise<unknown>>();
    return {
        handlers,
        rpcHandlerManager: {
            hasHandler(method: string) {
                return handlers.has(method);
            },
            registerHandler(
                method: string,
                handler: (input: unknown, context?: Readonly<{ signal: AbortSignal }>) => Promise<unknown>,
            ) {
                handlers.set(method, handler);
            },
        },
    };
}

const sessionSpawnInput = {
    creationKey: 'manual:approval-transport-1',
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    directory: '/tmp/project',
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    },
};

describe('session.spawn_new Action RPC deferred approval transport', () => {
    it('settles the canonical directory approval artifact instead of masking it as invalid transport output', async () => {
        const { handlers, rpcHandlerManager } = createRpcHarness();
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: 'approval_request_created' as const,
                artifactId: 'approval-request-1',
                actionId: 'session.spawn_new' as const,
            },
        }));

        registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [getActionSpec('session.spawn_new')],
        });

        const handler = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await expect(handler(sessionSpawnInput)).resolves.toEqual({
            kind: 'approval_request_created',
            artifactId: 'approval-request-1',
            actionId: 'session.spawn_new',
        });
        expect(execute).toHaveBeenCalledWith(
            'session.spawn_new',
            sessionSpawnInput,
            { surface: 'rpc' },
        );
    });

    it('keeps client-supplied caller provenance outside the strict Session spawn input', async () => {
        const { handlers, rpcHandlerManager } = createRpcHarness();
        const execute = vi.fn();

        registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [getActionSpec('session.spawn_new')],
        });

        const handler = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await expect(handler({
            ...sessionSpawnInput,
            callerSurface: 'voice',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_action_transport_input',
            error: 'invalid_action_transport_input',
        });
        expect(execute).not.toHaveBeenCalled();
    });
});
