import { describe, expect, it } from 'vitest';

import { CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE, CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/agents';

import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('PermissionHandler (dispose)', () => {
    it.each(['abort', 'reset', 'dispose'] as const)('retires resumed remote-only requests during %s while preserving other owners and claims', async (action) => {
        const { session, client } = createPermissionHandlerSessionStub(`orphan-${action}`);
        const handler = new PermissionHandler(session);
        const request = { tool: 'Bash', arguments: { command: 'echo resumed' }, createdAt: 1 };
        const local = { ...request, source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE };
        const dialog = { ...request, source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE };
        const claimed = { ...request, permissionResponseClaimV1: { owner: 'another-runtime' } };
        client.agentState.requests = { remote: request, local, dialog, claimed };
        if (action === 'abort') await handler.abortPendingRequestsAndFlush();
        else if (action === 'reset') await handler.resetAndFlush();
        else handler.dispose();
        await expect.poll(() => client.agentState.completedRequests.remote).toMatchObject({ status: 'canceled' });
        expect(client.agentState.requests).toEqual({ local, dialog, claimed });
        expect(Object.keys(client.agentState.completedRequests)).toEqual(['remote']);
        if (action !== 'dispose') handler.dispose();
    });

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
