import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { AgentState } from '@/api/types';
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
    agentState: AgentState = { requests: {}, completedRequests: {} };
    stateReadFailure: Error | null = null;

    getAgentStateSnapshot() {
        if (this.stateReadFailure) throw this.stateReadFailure;
        return this.agentState;
    }

    updateAgentState(updater: (state: AgentState) => AgentState) {
        this.agentState = updater(this.agentState);
        return this.agentState;
    }

    async updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState): Promise<void> {
        this.updateAgentState(updater);
    }

    getMetadataSnapshot() {
        return null;
    }
}

function createMcpInteractionFixture(bindSessionLifetime = true) {
    const session = new FakePermissionSession();
    const permissionHandler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, {
        logPrefix: '[SessionMcpIntegration]',
        getWorkspaceWrites: () => 'allow',
    });
    const lifetime = new AbortController();
    const services = createNativeAgentSessionServices({
        permissionHandler,
        pluginId: 'happier.agent.test', contributionId: 'test', runtimeId: 'test',
        sessionId: session.sessionId, occurrenceId: 'occurrence-1',
        isCurrent: () => true,
        ...(bindSessionLifetime ? { signal: lifetime.signal } : {}),
        readActiveTurnAdmissionWitness: () => ({
            inputId: 'input-1', turnId: 'turn-1', userMessageSeq: 1, userMessageSeqs: [1],
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        }),
    });
    const service = createSessionScopedMcpServices({
        owner: { kind: 'plugin', pluginId: 'happier.agent.test', runtimeId: 'test' },
        interactions: services.interactions,
        readScope: async () => ({ permissionHandler }),
    });
    return {
        session, service, lifetime,
        async dispose() {
            session.stateReadFailure = null;
            lifetime.abort();
            await permissionHandler.reset();
        },
    };
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
    const pending = Symbol('pending');
    const result = await Promise.race([
        promise.then(() => 'fulfilled' as const, () => 'rejected' as const),
        Promise.resolve(pending),
    ]);
    return result === pending ? 'pending' : result;
}

function storedNativeAnswer(session: FakePermissionSession, id: string, choiceId: string) {
    const offer = session.agentState.requests?.[id]?.nativeChoices;
    expect(offer?.choices.some(choice => choice.id === choiceId)).toBe(true);
    return { id, nativeChoice: { requirementId: offer!.requirementId, choiceId } };
}

describe('createSessionScopedMcpServices permission integration', () => {
    beforeEach(() => {
        setActiveAccountSettingsSnapshot({ scopeKey: 'session-mcp-permission-test', source: 'network', settingsVersion: 1,
            settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
            promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    });
    afterEach(() => resetActiveAccountSettingsSnapshotForTests());
    it('requires the stored native MCP offer and ignores caller decision aliases', async () => {
        const fixture = createMcpInteractionFixture();
        const { service, session } = fixture;
        try {
            const pending = service.elicit({ requestId: 'native-mcp', serverName: 'shell', toolName: 'run_command' });
            await vi.waitFor(() => expect(session.agentState.requests?.['native-mcp']).toBeDefined());
            const offer = session.agentState.requests?.['native-mcp']?.nativeChoices;
            expect(offer).toMatchObject({
                source: 'mcp.elicitation',
                choices: [
                    { id: 'approved', label: 'Allow once', decision: 'approved', scope: 'once', response: { approved: true, decision: 'approved' } },
                    { id: 'approved_for_session', label: 'Allow for this session', decision: 'approved_for_session', scope: 'session', response: { approved: true, decision: 'approved_for_session' } },
                    { id: 'denied', label: 'Deny', decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } },
                    { id: 'abort', label: 'Cancel', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
                ],
            });
            const respond = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
            await expect(respond({ id: 'native-mcp', approved: true })).resolves.toMatchObject({
                ok: false, errorCode: 'permission_response_invalid',
            });
            expect(session.agentState.requests?.['native-mcp']).toBeDefined();
            await respond({ id: 'native-mcp', nativeChoice: { requirementId: offer!.requirementId, choiceId: 'approved' },
                approved: false, decision: 'abort' });
            await expect(pending).resolves.toEqual({ status: 'accepted', decision: 'approved' });
            expect(session.agentState.completedRequests?.['native-mcp']).toMatchObject({
                decision: 'approved', nativeChoices: offer,
                nativeChoice: { requirementId: offer!.requirementId, choiceId: 'approved' },
            });
        } finally {
            await fixture.dispose();
        }
    });
    it('presents long schema context through the real session interaction and permission owners', async () => {
        const fixture = createMcpInteractionFixture();
        const { service, session } = fixture;
        try {
            const pending = service.elicit({
                toolName: 'configure', prompt: 'Deployment context. '.repeat(400),
                schema: { type: 'object', properties: {
                    mode: { type: 'string', title: 'Which deployment mode?', enum: ['safe', 'fast'] },
                }, required: ['mode'] },
            });
            await vi.waitFor(() => expect(Object.keys(session.agentState.requests ?? {})).toHaveLength(1));
            const [id, request] = Object.entries(session.agentState.requests ?? {})[0]!;
            expect(request).toMatchObject({
                tool: 'AskUserQuestion', kind: 'user_action',
                arguments: { questions: [{ question: expect.stringContaining('Which deployment mode?') }] },
            });
            await session.rpcHandlerManager.handlers.get('session.user_action.answer')!({
                id, turnId: 'turn-1', approved: true, decision: 'approved', answers: { mode: ['safe'] },
            });
            await expect(pending).resolves.toEqual({ status: 'accepted', decision: 'approved', content: { mode: 'safe' } });
        } finally {
            await fixture.dispose();
        }
    });
    it('routes MCP elicitation through provider-enforced permission responses with plugin owner isolation', async () => {
        const session = new FakePermissionSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, {
            logPrefix: '[SessionMcpIntegration]',
            getWorkspaceWrites: () => 'allow',
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

        await vi.waitFor(() => expect(session.agentState.requests?.['mcp-allow-session']).toMatchObject({
            tool: 'mcp__shell__run_command',
            arguments: input,
            owner: ownerA,
        }));

        const firstAnswer = storedNativeAnswer(session, 'mcp-allow-session', 'approved_for_session');
        await respond?.(firstAnswer);
        await expect(approvedForSession).resolves.toEqual({
            status: 'accepted',
            decision: 'approved_for_session',
        });
        expect(session.agentState.completedRequests?.['mcp-allow-session']).toMatchObject({
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
        expect(session.agentState.requests?.['mcp-auto-owner-a']).toBeUndefined();
        expect(session.agentState.completedRequests?.['mcp-auto-owner-a']).toMatchObject({
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
        await vi.waitFor(() => expect(session.agentState.requests?.['mcp-owner-b']).toMatchObject({
            tool: 'mcp__shell__run_command',
            arguments: input,
            owner: ownerB,
        }));
        expect(await settledState(ownerBRequest)).toBe('pending');
        await respond?.(storedNativeAnswer(session, 'mcp-owner-b', 'denied'));
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
        await vi.waitFor(() => expect(session.agentState.requests?.['mcp-cancelled']).toBeDefined());
        await respond?.(storedNativeAnswer(session, 'mcp-cancelled', 'abort'));
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
        await vi.waitFor(() => expect(session.agentState.requests?.['mcp-aborted-by-caller']).toBeDefined());
        controller.abort(new Error('caller retired'));
        await expect(aborted).rejects.toThrow('caller retired');
        await vi.waitFor(() => expect(session.agentState.requests?.['mcp-aborted-by-caller']).toBeUndefined());
    });

    it('returns typed form content and confirmation outcomes through real session interactions', async () => {
        const fixture = createMcpInteractionFixture();
        const { service, session } = fixture;
        try {
            const pending = service.elicit({
                requestId: 'mcp-form', toolName: 'configure', prompt: 'Configure deployment',
                schema: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', title: 'Enable deployment' },
                        retries: { type: 'integer', title: 'Retry count' },
                        mode: { type: 'string', enum: ['safe', 'fast'], enumNames: ['Safe mode', 'Fast mode'] },
                        tags: { type: 'array', title: 'Checks', items: { anyOf: [
                            { const: 'lint', title: 'Lint' }, { const: 'test', title: 'Tests' },
                        ] } },
                    },
                    required: ['enabled', 'retries', 'mode'],
                },
                meta: { decision: 'approved_for_session', owner: { pluginId: 'forged-plugin' }, correlation: ['data-only', 1, true] },
            });
            await vi.waitFor(() => expect(Object.keys(session.agentState.requests ?? {})).toHaveLength(1));
            const [id, request] = Object.entries(session.agentState.requests ?? {})[0]!;
            expect(request).toMatchObject({
                tool: 'AskUserQuestion', kind: 'user_action',
                owner: { kind: 'plugin', pluginId: 'happier.agent.test', runtimeId: 'test' },
                arguments: { title: 'Configure deployment', questions: [
                    expect.objectContaining({ id: 'enabled', question: 'Enable deployment', selection: 'single' }),
                    expect.objectContaining({ id: 'retries', question: 'Retry count', selection: 'text' }),
                    expect.objectContaining({ id: 'mode', selection: 'single', options: [
                        { id: 'safe', label: 'Safe mode' }, { id: 'fast', label: 'Fast mode' },
                    ] }),
                    expect.objectContaining({ id: 'tags', selection: 'multiple', options: [
                        { id: 'lint', label: 'Lint' }, { id: 'test', label: 'Tests' },
                    ] }),
                ] },
            });
            const answer = session.rpcHandlerManager.handlers.get('session.user_action.answer');
            expect(answer).toBeDefined();
            await answer!({ id, turnId: 'turn-1', approved: true, answers: {
                enabled: ['true'], retries: ['3'], mode: ['Safe mode'], tags: ['Lint', 'Tests'],
            } });
            await expect(pending).resolves.toEqual({ status: 'accepted', decision: 'approved', content: {
                enabled: true, retries: 3, mode: 'safe', tags: ['lint', 'test'],
            } });
            const emptyForm = { toolName: 'confirm_deployment', prompt: 'Proceed with deployment?',
                schema: { type: 'object' as const, properties: {} } };
            const confirming = service.elicit({ ...emptyForm, requestId: 'mcp-empty-form' });
            await vi.waitFor(() => expect(Object.keys(session.agentState.requests ?? {})).toHaveLength(1));
            const [confirmationId, confirmation] = Object.entries(session.agentState.requests ?? {})[0]!;
            expect(confirmation).toMatchObject({ tool: 'AskUserQuestion', kind: 'user_action', arguments: {
                questions: [{ id: 'confirmation', question: 'Proceed with deployment?', required: true,
                    options: [{ id: 'confirm', label: 'Confirm' }, { id: 'decline', label: 'Cancel' }] }],
            } });
            await answer!({ id: confirmationId, turnId: 'turn-1', approved: true, answers: { confirmation: ['decline'] } });
            await expect(confirming).resolves.toEqual({ status: 'declined', decision: 'denied' });
            fixture.lifetime.abort();
            await expect(service.elicit({ ...emptyForm, requestId: 'mcp-empty-form-cancelled' })).resolves.toEqual({
                status: 'cancelled', decision: 'abort',
            });
            expect(Object.keys(session.agentState.requests ?? {})).toEqual([]);

            // A missing host Session lifetime makes the real native owner unavailable.
            const unbound = createMcpInteractionFixture(false);
            try {
                await expect(unbound.service.elicit({ ...emptyForm, requestId: 'mcp-empty-form-unavailable' })).resolves.toEqual({
                    status: 'unavailable', reason: 'mcp_elicitation_interaction_unavailable',
                });
                expect(Object.keys(unbound.session.agentState.requests ?? {})).toEqual([]);
            } finally {
                await unbound.dispose();
            }
        } finally {
            await fixture.dispose();
        }
    });

    it('validates metadata and refuses unoffered effects and secret-bearing Session boundary faults through real owners', async () => {
        const fixture = createMcpInteractionFixture();
        const { service, session } = fixture;
        const respond = session.rpcHandlerManager.handlers.get('permission');
        expect(respond).toBeDefined();
        try {
            const amendment = ['git', 'status'];
            const unsupported = service.elicit({
                requestId: 'mcp-exec-policy', toolName: 'shell',
                input: { command: 'git status', proposedExecpolicyAmendment: amendment },
            });
            await vi.waitFor(() => expect(session.agentState.requests?.['mcp-exec-policy']).toBeDefined());
            await expect(respond!({ id: 'mcp-exec-policy', approved: true, decision: 'approved_execpolicy_amendment',
                execPolicyAmendment: { command: amendment } })).resolves.toMatchObject({
                ok: false, errorCode: 'permission_response_invalid',
            });
            expect(await settledState(unsupported)).toBe('pending');
            await respond!(storedNativeAnswer(session, 'mcp-exec-policy', 'denied'));
            await expect(unsupported).resolves.toEqual({ status: 'declined', decision: 'denied' });
            await expect(service.elicit({
                requestId: 'mcp-invalid-meta', toolName: 'shell', input: { command: 'git status' },
                meta: { decision: () => 'approved' },
            })).resolves.toEqual({ status: 'failed', reason: 'mcp_elicitation_meta_invalid' });
            expect(Object.keys(session.agentState.requests ?? {})).toEqual([]);

            const deeplyNestedMeta: Record<string, unknown> = {};
            let cursor = deeplyNestedMeta;
            for (let depth = 0; depth < 25; depth += 1) {
                const next: Record<string, unknown> = {};
                cursor.next = next;
                cursor = next;
            }
            cursor.decision = 'approved_for_session';
            const deep = service.elicit({ requestId: 'mcp-deep-meta', toolName: 'shell', meta: deeplyNestedMeta });
            await vi.waitFor(() => expect(session.agentState.requests?.['mcp-deep-meta']).toMatchObject({
                tool: 'shell', owner: { kind: 'plugin', pluginId: 'happier.agent.test', runtimeId: 'test' },
            }));
            expect(await settledState(deep)).toBe('pending');
            await respond!(storedNativeAnswer(session, 'mcp-deep-meta', 'denied'));
            await expect(deep).resolves.toEqual({ status: 'declined', decision: 'denied' });

            // Session state is a genuine external boundary; no internal owner is replaced.
            session.stateReadFailure = new Error('host secret must not cross the Session boundary');
            await expect(service.elicit({ requestId: 'mcp-host-error', toolName: 'shell' })).resolves.toEqual({
                status: 'failed', reason: 'mcp_elicitation_failed',
            });
        } finally {
            await fixture.dispose();
        }
    });
});
