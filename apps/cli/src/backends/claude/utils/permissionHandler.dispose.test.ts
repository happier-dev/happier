import { describe, expect, it } from 'vitest';

import { CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE, CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/agents';

import { PermissionHandler } from './permissionHandler';
import { CodexLikePermissionHandler } from '@/agent/permissions/CodexLikePermissionHandler';
import { createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/runtime/runScopedExecutionPermissionHandler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('PermissionHandler (dispose)', () => {
    it.each(['old-request', 'next-turn'] as const)('keeps %s structured answers routable after an older reset admission', async (nextId) => {
        const { session, client } = createPermissionHandlerSessionStub('claude-reset-routing');
        const handler = new PermissionHandler(session);
        const original = handler.handleToolCall('Bash', { command: 'echo old' }, { permissionMode: 'default' } as never, {
            signal: new AbortController().signal, toolUseId: 'old-request',
        });
        const rejected = expect(original).rejects.toThrow('Session reset');
        const admissions: (() => void)[] = [];
        client.updateAgentStateRequestSettlement = async (updater) => {
            updater(client.agentState); // Real journal capture precedes asynchronous disk admission.
            await new Promise<void>((resolve) => { admissions.push(resolve); });
        };
        handler.reset();
        handler.reset();
        admissions[0]!();
        await rejected;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const input = { questions: [{ question: 'Next?', options: [{ label: 'Yes' }] }], providerMarker: 'keep-original-provider-input' };
        const next = handler.handleToolCall('AskUserQuestion', input, { permissionMode: 'default' } as never, {
            signal: new AbortController().signal, toolUseId: nextId,
        });
        void next.catch(() => undefined);
        admissions[1]!();
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
            const rpc = client.rpcHandlerManager.getHandler('permission');
            await rpc?.({ id: nextId, approved: true, structuredAnswersV1: { 'Next?': ['Yes'] } });
            expect(client.agentState.completedRequests[nextId]).toMatchObject({ status: 'approved' });
            await expect(next).resolves.toMatchObject({ behavior: 'allow', updatedInput: { ...input, answers: { 'Next?': 'Yes' } } });
        } finally {
            client.updateAgentStateRequestSettlement = async (updater) => { client.agentState = updater(client.agentState); };
            handler.dispose();
            await next.catch(() => undefined);
        }
    });

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

    it('preserves an independent execution-run prompt during foreground retirement and responses', async () => {
        const { session, client } = createPermissionHandlerSessionStub('claude-execution-owner');
        const executionOwner = new CodexLikePermissionHandler({
            session: client as unknown as ApiSessionClient, logPrefix: '[ExecutionRun]', requestScope: 'execution_run',
        });
        const run = createRunScopedExecutionPermissionHandler({ runId: 'claude-background', handler: executionOwner });
        const pending = run.handler.handleToolCall('call_1', 'Write', { path: '/tmp/background' });
        const requestId = Object.keys(client.agentState.requests)[0]!;
        const request = client.agentState.requests[requestId];
        const foreground = new PermissionHandler(session);

        await foreground.abortPendingRequestsAndFlush();
        await client.rpcHandlerManager.getHandler('permission')!({ id: requestId, approved: true });

        expect(client.agentState.requests[requestId]).toEqual(request);
        expect(client.agentState.completedRequests[requestId]).toBeUndefined();
        run.dispose('Test cleanup');
        await expect(pending).resolves.toMatchObject({ decision: 'abort' });
        foreground.dispose();
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
