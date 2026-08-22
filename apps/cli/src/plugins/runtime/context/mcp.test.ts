import { describe, expect, it, vi } from 'vitest';

import type { InteractionsService } from '@happier-dev/plugin-sdk/interactions';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import {
    ServerBoundPermissionRpcHandlerManager,
} from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createSessionScopedMcpServices } from './session/services/mcp';

class FakePermissionSession {
    sessionId = 'session-mcp-integration';
    // Present-user permission responses are only attributable when the
    // authenticated server stamps the RPC authorization context, so this test
    // drives the canonical server-bound boundary instead of the raw handler.
    rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
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
        });
        await expect(approvedForSession).resolves.toEqual({
            status: 'accepted',
            decision: 'approved_for_session',
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

        const controller = new AbortController();
        const aborted = serviceB.elicit({
            requestId: 'mcp-aborted-by-caller',
            serverName: 'shell',
            toolName: 'run_command',
            input: { command: 'printf aborted' },
        }, { signal: controller.signal });
        await flushAsyncPermissionPublication();
        expect(session.agentState.requests['mcp-aborted-by-caller']).toBeDefined();
        controller.abort(new Error('caller retired'));
        await expect(aborted).rejects.toThrow('caller retired');
        await flushAsyncPermissionPublication();
        expect(session.agentState.requests['mcp-aborted-by-caller']).toBeUndefined();
    });

    it('uses the canonical interaction owner for schema elicitation and returns schema-shaped typed content', async () => {
        const askQuestions = vi.fn<InteractionsService['askQuestions']>(async () => ({
            requestId: 'mcp-form-interaction',
            kind: 'questions' as const,
            status: 'answered' as const,
            answers: {
                enabled: {
                    kind: 'singleChoice' as const,
                    answer: { kind: 'choice' as const, choiceId: 'true' },
                },
                retries: { kind: 'text' as const, value: '3' },
                mode: {
                    kind: 'singleChoice' as const,
                    answer: { kind: 'choice' as const, choiceId: 'safe' },
                },
                tags: {
                    kind: 'multipleChoice' as const,
                    answers: [
                        { kind: 'choice' as const, choiceId: 'lint' },
                        { kind: 'choice' as const, choiceId: 'test' },
                    ],
                },
            },
        }));
        const confirm = vi.fn<InteractionsService['confirm']>(async () => Object.freeze({
            requestId: 'mcp-confirmation',
            kind: 'confirmation' as const,
            status: 'declined' as const,
        }));
        const interactions: InteractionsService = Object.freeze({
            askQuestions,
            requestApproval: vi.fn(async () => Object.freeze({
                requestId: 'unused-approval',
                kind: 'approval' as const,
                status: 'declined' as const,
            })),
            confirm,
            approvals: Object.freeze({
                request: vi.fn(async () => Object.freeze({ approvalRequestId: 'unused' })),
                get: vi.fn(async () => null),
                list: vi.fn(async () => Object.freeze({ items: Object.freeze([]) })),
                watch: vi.fn(async () => Object.freeze({ dispose() {} })),
            }),
        });
        const handleToolCall = vi.fn(async () => Object.freeze({ decision: 'denied' as const }));
        const service = createSessionScopedMcpServices({
            interactions,
            readScope: async () => Object.freeze({ permissionHandler: { handleToolCall } }),
        });

        await expect(service.elicit({
            requestId: 'mcp-form',
            toolName: 'configure',
            prompt: 'Configure deployment',
            schema: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', title: 'Enable deployment' },
                    retries: { type: 'integer', title: 'Retry count' },
                    mode: { type: 'string', enum: ['safe', 'fast'], enumNames: ['Safe mode', 'Fast mode'] },
                    tags: {
                        type: 'array',
                        title: 'Checks',
                        items: {
                            anyOf: [
                                { const: 'lint', title: 'Lint' },
                                { const: 'test', title: 'Tests' },
                            ],
                        },
                    },
                },
                required: ['enabled', 'retries', 'mode'],
            },
            meta: {
                decision: 'approved_for_session',
                owner: { pluginId: 'forged-plugin' },
                correlation: ['data-only', 1, true],
            },
        })).resolves.toEqual({
            status: 'accepted',
            decision: 'approved',
            content: {
                enabled: true,
                retries: 3,
                mode: 'safe',
                tags: ['lint', 'test'],
            },
        });
        expect(handleToolCall).not.toHaveBeenCalled();
        expect(askQuestions).toHaveBeenCalledWith({
            kind: 'questions',
            title: 'Configure deployment',
            questions: [
                expect.objectContaining({ id: 'enabled', prompt: 'Enable deployment', type: 'singleChoice' }),
                expect.objectContaining({ id: 'retries', prompt: 'Retry count', type: 'text' }),
                expect.objectContaining({
                    id: 'mode',
                    type: 'singleChoice',
                    choices: [
                        { id: 'safe', label: 'Safe mode' },
                        { id: 'fast', label: 'Fast mode' },
                    ],
                }),
                expect.objectContaining({
                    id: 'tags',
                    type: 'multipleChoice',
                    choices: [
                        { id: 'lint', label: 'Lint' },
                        { id: 'test', label: 'Tests' },
                    ],
                }),
            ],
        }, expect.any(Object));
        await expect(service.elicit({
            requestId: 'mcp-empty-form',
            toolName: 'confirm_deployment',
            prompt: 'Proceed with deployment?',
            schema: { type: 'object', properties: {} },
        })).resolves.toEqual({
            status: 'declined',
            decision: 'denied',
        });
        expect(confirm).toHaveBeenCalledWith(
            {
                kind: 'confirmation',
                title: 'MCP request',
                message: 'Proceed with deployment?',
            },
            expect.any(Object),
        );
        confirm.mockResolvedValueOnce(Object.freeze({
            requestId: 'mcp-confirmation-unavailable',
            kind: 'confirmation' as const,
            status: 'unavailable' as const,
        }));
        await expect(service.elicit({
            requestId: 'mcp-empty-form-unavailable',
            toolName: 'confirm_deployment',
            prompt: 'Proceed with deployment?',
            schema: { type: 'object', properties: {} },
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'mcp_elicitation_interaction_unavailable',
        });
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('fails invalid metadata and unmappable exec-policy effects without granting authority', async () => {
        const handleToolCall = vi.fn()
            .mockResolvedValueOnce(Object.freeze({
                decision: 'approved_execpolicy_amendment' as const,
                execPolicyAmendment: Object.freeze({ command: Object.freeze(['git', 'status']) }),
            }))
            .mockRejectedValueOnce(new Error('host secret must not cross the Session boundary'));
        const service = createSessionScopedMcpServices({
            readScope: async () => Object.freeze({ permissionHandler: { handleToolCall } }),
        });

        await expect(service.elicit({
            requestId: 'mcp-exec-policy',
            toolName: 'shell',
            input: { command: 'git status' },
        })).resolves.toEqual({
            status: 'failed',
            reason: 'mcp_elicitation_effect_unsupported',
        });
        await expect(service.elicit({
            requestId: 'mcp-invalid-meta',
            toolName: 'shell',
            input: { command: 'git status' },
            meta: { decision: () => 'approved' },
        })).resolves.toEqual({
            status: 'failed',
            reason: 'mcp_elicitation_meta_invalid',
        });

        const oversizedMeta: Record<string, unknown> = {};
        let cursor = oversizedMeta;
        for (let depth = 0; depth < 25; depth += 1) {
            const next: Record<string, unknown> = {};
            cursor.next = next;
            cursor = next;
        }
        await expect(service.elicit({
            requestId: 'mcp-oversized-meta',
            toolName: 'shell',
            meta: oversizedMeta,
        })).resolves.toEqual({
            status: 'failed',
            reason: 'mcp_elicitation_meta_invalid',
        });
        await expect(service.elicit({
            requestId: 'mcp-host-error',
            toolName: 'shell',
        })).resolves.toEqual({
            status: 'failed',
            reason: 'mcp_elicitation_failed',
        });
        expect(handleToolCall).toHaveBeenCalledTimes(2);
    });
});
