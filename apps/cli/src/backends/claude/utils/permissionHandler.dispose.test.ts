import { describe, expect, it } from 'vitest';

import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('PermissionHandler (dispose)', () => {
    it('cancels outstanding permission requests when disposed', async () => {
        const { session, client } = createPermissionHandlerSessionStub('dispose-s1');
        const handler = new PermissionHandler(session);

        const controller = new AbortController();
        const permissionId = 'perm-dispose-1';

        const promise = handler.handleToolCall(
            'Bash',
            { command: 'echo hi' },
            { permissionMode: 'default' } as never,
            { signal: controller.signal, toolUseId: permissionId },
        );

        expect((client.agentState as any).requests?.[permissionId]).toBeTruthy();

        handler.dispose();

        await expect(promise).rejects.toBeTruthy();
        expect((client.agentState as any).requests?.[permissionId]).toBeUndefined();
        expect((client.agentState as any).completedRequests?.[permissionId]?.status).toBe('canceled');
    });

    it('exposes an awaited reset path that flushes the session before shutdown', async () => {
        const { session, client } = createPermissionHandlerSessionStub('dispose-s2');
        const handler = new PermissionHandler(session);

        const controller = new AbortController();
        const permissionId = 'perm-dispose-2';

        const promise = handler.handleToolCall(
            'Bash',
            { command: 'echo hi' },
            { permissionMode: 'default' } as never,
            { signal: controller.signal, toolUseId: permissionId },
        );

        expect((client.agentState as any).requests?.[permissionId]).toBeTruthy();
        expect('resetAndFlush' in handler).toBe(true);

        await (handler as unknown as { resetAndFlush: () => Promise<void> }).resetAndFlush();

        await expect(promise).rejects.toBeTruthy();
        expect((client.agentState as any).requests?.[permissionId]).toBeUndefined();
        expect((client.agentState as any).completedRequests?.[permissionId]?.status).toBe('canceled');
        expect(client.flush).toHaveBeenCalledTimes(1);
    });
});
