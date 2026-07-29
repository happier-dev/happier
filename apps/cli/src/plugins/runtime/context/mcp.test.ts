import { describe, expect, it } from 'vitest';

import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createSessionScopedMcpServices } from './session/services/mcp';

class FakeSessionRpcHandlerManager {
    handlers = new Map<string, (payload: any) => any>();

    registerHandler(name: string, handler: any) {
        this.handlers.set(name, handler);
    }
}

class FakePermissionSession {
    sessionId = 'session-mcp-integration';
    rpcHandlerManager = new FakeSessionRpcHandlerManager();
    agentState: any = { requests: {}, completedRequests: {} };

    getAgentStateSnapshot() {
        return this.agentState;
    }

    updateAgentState(updater: any) {
        this.agentState = updater(this.agentState);
        return this.agentState;
    }

    getMetadataSnapshot() {
        return null;
    }
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
    const pending = Symbol('pending');
    const result = await Promise.race([
        promise.then(() => 'fulfilled' as const, () => 'rejected' as const),
        Promise.resolve(pending),
    ]);
    return result === pending ? 'pending' : result;
}

async function flushAsyncPermissionPublication(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('createSessionScopedMcpServices permission integration', () => {
    it('routes MCP elicitation through provider-enforced permission responses with plugin owner isolation', async () => {
        const session = new FakePermissionSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(session as any, {
            logPrefix: '[SessionMcpIntegration]',
        });
        const ownerA = { kind: 'plugin' as const, pluginId: 'plugin-a', runtimeId: 'runtime-a' };
        const ownerB = { kind: 'plugin' as const, pluginId: 'plugin-b', runtimeId: 'runtime-b' };
        const serviceA = createSessionScopedMcpServices({
            owner: ownerA,
            readScope: async () => ({ permissionHandler }),
        });
        const serviceB = createSessionScopedMcpServices({
            owner: ownerB,
            readScope: async () => ({ permissionHandler }),
        });
        const respond = session.rpcHandlerManager.handlers.get('permission');
        expect(respond).toBeTypeOf('function');

        const input = { command: 'printf happier-permission-wave3' };
        const approvedForSession = serviceA.elicit({
            requestId: 'mcp-allow-session',
            serverName: 'shell',
            toolName: 'run_command',
            input,
        });

        await flushAsyncPermissionPublication();
        expect(session.agentState.requests['mcp-allow-session']).toMatchObject({
            tool: 'mcp__shell__run_command',
            arguments: input,
            owner: ownerA,
        });

        await respond?.({
            id: 'mcp-allow-session',
            approved: true,
            decision: 'approved_for_session',
            answers: { confirmation: 'yes' },
        });
        await expect(approvedForSession).resolves.toEqual({
            status: 'accepted',
            decision: 'approved_for_session',
            content: { confirmation: 'yes' },
        });
        expect(session.agentState.completedRequests['mcp-allow-session']).toMatchObject({
            status: 'approved',
            decision: 'approved_for_session',
            owner: ownerA,
        });

        await expect(serviceA.elicit({
            requestId: 'mcp-auto-owner-a',
            serverName: 'shell',
            toolName: 'run_command',
            input,
        })).resolves.toEqual({
            status: 'accepted',
            decision: 'approved_for_session',
        });
        expect(session.agentState.requests['mcp-auto-owner-a']).toBeUndefined();
        expect(session.agentState.completedRequests['mcp-auto-owner-a']).toMatchObject({
            status: 'approved',
            decision: 'approved_for_session',
            owner: ownerA,
        });

        const ownerBRequest = serviceB.elicit({
            requestId: 'mcp-owner-b',
            serverName: 'shell',
            toolName: 'run_command',
            input,
        });
        await flushAsyncPermissionPublication();
        expect(await settledState(ownerBRequest)).toBe('pending');
        expect(session.agentState.requests['mcp-owner-b']).toMatchObject({
            tool: 'mcp__shell__run_command',
            arguments: input,
            owner: ownerB,
        });
        await respond?.({ id: 'mcp-owner-b', approved: false, decision: 'denied' });
        await expect(ownerBRequest).resolves.toEqual({
            status: 'declined',
            decision: 'denied',
        });

        const cancelled = serviceB.elicit({
            requestId: 'mcp-cancelled',
            serverName: 'shell',
            toolName: 'run_command',
            input: { command: 'printf cancelled' },
        });
        await flushAsyncPermissionPublication();
        await respond?.({ id: 'mcp-cancelled', approved: false, decision: 'abort' });
        await expect(cancelled).resolves.toEqual({
            status: 'cancelled',
            decision: 'abort',
        });
    });
});
