import { describe, expect, it } from 'vitest';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerProjectFiniteRpcHandlers } from './registerProjectFiniteRpcHandlers';

describe('finite Project RPC receiver', () => {
    it('refuses malformed authority and unavailable runtime before work enters any process owner', async () => {
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        registerProjectFiniteRpcHandlers(registrar, { serverId: 'home', machineId: 'machine' });
        const handler = handlers.get(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.prepare'])!;
        const input = { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' }, phase: 'setup' };
        expect(await handler({ ...input, actorAccountId: 'owner' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await handler({ ...input, workspace: { ...input.workspace, serverId: 'another-home' } })).toMatchObject({ ok: false, errorCode: 'target_mismatch' });
        expect(await handler(input)).toMatchObject({ ok: false, errorCode: 'project_finite_execution_unavailable' });
        expect(handlers.size).toBe(3);
    });
});
