import { describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';

import { createStablePluginEventsBroker } from './events';
import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createPluginInvocationServicesFactory,
} from './factory';

class FakeSession {
    readonly sessionId = 'session-1';
    readonly rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
    agentState: AgentState = { requests: {}, completedRequests: {} };

    getAgentStateSnapshot(): AgentState {
        return this.agentState;
    }

    updateAgentState(updater: (state: AgentState) => AgentState): AgentState {
        this.agentState = updater(this.agentState);
        return this.agentState;
    }

    getMetadataSnapshot(): null {
        return null;
    }
}

function requests(session: FakeSession): NonNullable<AgentState['requests']> {
    if (!session.agentState.requests) throw new Error('Expected the permission request store');
    return session.agentState.requests;
}

async function answerThroughPresentUserRpc(session: FakeSession, response: unknown): Promise<void> {
    const handler = session.rpcHandlerManager.handlers.get('session.permission.respond');
    if (!handler) throw new Error('Expected the canonical permission response RPC handler');
    await handler(response);
}

describe('plugin interaction caller attribution', () => {
    it('uses one stable host-stamped contribution owner and isolates siblings', async () => {
        const session = new FakeSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(
            session as unknown as ApiSessionClient,
            { logPrefix: '[Test]' },
        );
        const currentSession = createNativeAgentCurrentSessionUiServices({
            permissionHandler,
            pluginId: 'happier.agent.host',
            contributionId: 'host-agent',
            runtimeId: 'host-agent-runtime',
            sessionId: session.sessionId,
            generationId: 'host-generation-1',
            interactionDeadlineMs: 1_000,
            isCurrent: () => true,
            signal: new AbortController().signal,
        });
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('ordinary-generation-1', 'binding');
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.ordinary', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.ordinary/actions/run' }),
            generation: 'ordinary-generation-1',
            correlationId: 'ordinary-correlation-1',
            surface: 'cli' as const,
            session: Object.freeze({ id: session.sessionId }),
            currentSession,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const request = Object.freeze({
            kind: 'approval' as const,
            title: 'Run Bash?',
            subject: Object.freeze({
                kind: 'tool' as const,
                name: 'Bash',
                input: Object.freeze({ command: 'echo stable' }),
            }),
            allowSessionPersistence: true,
        });

        const first = createServices(seed, binding).interactions.requestApproval(request);
        await vi.waitFor(() => expect(Object.keys(requests(session))).toHaveLength(1));
        const [firstId, firstRequest] = Object.entries(requests(session))[0]!;
        expect(firstRequest).toMatchObject({
            owner: {
                kind: 'plugin',
                pluginId: 'acme.ordinary',
                runtimeId: 'acme.ordinary/actions/run',
            },
        });
        await answerThroughPresentUserRpc(session, {
            id: firstId,
            approved: true,
            decision: 'approved_for_session',
        });
        await expect(first).resolves.toEqual({
            requestId: firstId,
            kind: 'approval',
            status: 'approved',
            persistence: 'session',
        });

        await expect(createServices({ ...seed, correlationId: 'ordinary-correlation-2' }, binding)
            .interactions.requestApproval(request)).resolves.toMatchObject({
            requestId: expect.any(String),
            kind: 'approval',
            status: 'approved',
            persistence: 'session',
        });
        expect(Object.keys(requests(session))).toEqual([]);

        const sibling = createServices({
            ...seed,
            contribution: Object.freeze({ id: 'inspect', qualifiedId: 'acme.ordinary/actions/inspect' }),
            correlationId: 'ordinary-correlation-3',
        }, binding).interactions;
        const siblingPending = Reflect.apply(sibling.requestApproval, sibling, [request, {
            permissionContext: {
                owner: { kind: 'plugin', pluginId: 'forged.plugin', runtimeId: 'forged/runtime' },
            },
        }]);
        await vi.waitFor(() => expect(Object.keys(requests(session))).toHaveLength(1));
        const [siblingId, siblingRequest] = Object.entries(requests(session))[0]!;
        expect(siblingRequest).toMatchObject({
            owner: {
                kind: 'plugin',
                pluginId: 'acme.ordinary',
                runtimeId: 'acme.ordinary/actions/inspect',
            },
        });
        await answerThroughPresentUserRpc(session, {
            id: siblingId,
            approved: false,
            decision: 'denied',
        });
        await expect(siblingPending).resolves.toEqual({
            requestId: siblingId,
            kind: 'approval',
            status: 'declined',
        });
    });

    it('keeps native Agent interactions on the Agent owner when no caller stamp is supplied', async () => {
        const session = new FakeSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(
            session as unknown as ApiSessionClient,
            { logPrefix: '[Test]' },
        );
        const interactions = createNativeAgentCurrentSessionUiServices({
            permissionHandler,
            pluginId: 'happier.agent.native',
            contributionId: 'native-agent',
            runtimeId: 'native-agent-runtime',
            sessionId: session.sessionId,
            generationId: 'native-generation-1',
            interactionDeadlineMs: 1_000,
            isCurrent: () => true,
            signal: new AbortController().signal,
        }).interactions!;

        const pending = interactions.request({
            kind: 'approval',
            title: 'Native approval',
            subject: { kind: 'tool', name: 'Bash', input: { command: 'echo native' } },
        });
        await vi.waitFor(() => expect(Object.keys(requests(session))).toHaveLength(1));
        const [requestId, nativeRequest] = Object.entries(requests(session))[0]!;
        expect(nativeRequest).toMatchObject({
            owner: {
                kind: 'plugin',
                pluginId: 'happier.agent.native',
                runtimeId: 'native-agent-runtime',
            },
        });
        await answerThroughPresentUserRpc(session, {
            id: requestId,
            approved: false,
            decision: 'denied',
        });
        await expect(pending).resolves.toEqual({
            requestId,
            kind: 'approval',
            status: 'declined',
        });
    });

    it('keeps an OpenCode native-plugin approval bounded by its active admitted turn after Session widens', async () => {
        const session = new FakeSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(
            session as unknown as ApiSessionClient,
            { logPrefix: '[Test]' },
        );
        permissionHandler.setPermissionMode('yolo');
        const handleToolCall = vi.spyOn(permissionHandler, 'handleToolCall');
        const currentSession = createNativeAgentCurrentSessionUiServices({
            permissionHandler,
            pluginId: 'happier.agent.opencode',
            contributionId: 'opencode',
            runtimeId: 'happier.agent.opencode/agents/opencode',
            sessionId: session.sessionId,
            generationId: 'opencode-generation-1',
            interactionDeadlineMs: 1_000,
            isCurrent: () => true,
            signal: new AbortController().signal,
        });
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
        });
        const interaction = createServices(Object.freeze({
            plugin: Object.freeze({ id: 'happier.agent.opencode', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'opencode',
                qualifiedId: 'happier.agent.opencode/agents/opencode',
            }),
            generation: 'opencode-generation-1',
            correlationId: 'opencode-correlation-1',
            surface: 'agent' as const,
            session: Object.freeze({ id: session.sessionId }),
            currentSession,
            signal: new AbortController().signal,
            readActiveTurnAdmissionWitness: () => Object.freeze({
                inputId: 'input-opencode-read-only',
                turnId: 'turn-opencode-read-only',
                userMessageSeq: 1,
                userMessageSeqs: Object.freeze([1]),
                causalPermissionAuthority: Object.freeze({
                    kind: 'admittedSessionInputV1' as const,
                    admittedPermissionCeiling: 'read-only' as const,
                }),
            }),
            isGenerationCurrent: () => true,
        }), createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'opencode-generation-1',
            'opencode-binding-1',
        )).interactions;

        const pending = interaction.requestApproval({
            kind: 'approval',
            title: 'Run Bash?',
            subject: { kind: 'tool', name: 'Bash', input: { command: 'echo bounded' } },
        });

        await vi.waitFor(() => expect(Object.keys(requests(session))).toHaveLength(1));
        expect(handleToolCall.mock.calls[0]?.[3]).toMatchObject({
            turnId: 'turn-opencode-read-only',
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
            },
        });
        const [requestId] = Object.keys(requests(session));
        if (!requestId) throw new Error('expected bounded approval request');
        await answerThroughPresentUserRpc(session, {
            id: requestId,
            approved: false,
            decision: 'denied',
        });
        await expect(pending).resolves.toEqual({
            requestId,
            kind: 'approval',
            status: 'declined',
        });
    });

    it('fails closed when an active native-plugin turn lacks its causal authority', async () => {
        const session = new FakeSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(
            session as unknown as ApiSessionClient,
            { logPrefix: '[Test]' },
        );
        permissionHandler.setPermissionMode('yolo');
        const handleToolCall = vi.spyOn(permissionHandler, 'handleToolCall');
        const currentSession = createNativeAgentCurrentSessionUiServices({
            permissionHandler,
            pluginId: 'happier.agent.opencode',
            contributionId: 'opencode',
            runtimeId: 'happier.agent.opencode/agents/opencode',
            sessionId: session.sessionId,
            generationId: 'opencode-generation-2',
            interactionDeadlineMs: 1_000,
            isCurrent: () => true,
            signal: new AbortController().signal,
        });
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
        });
        const interaction = createServices(Object.freeze({
            plugin: Object.freeze({ id: 'happier.agent.opencode', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'opencode',
                qualifiedId: 'happier.agent.opencode/agents/opencode',
            }),
            generation: 'opencode-generation-2',
            correlationId: 'opencode-correlation-2',
            surface: 'agent' as const,
            session: Object.freeze({ id: session.sessionId }),
            currentSession,
            signal: new AbortController().signal,
            readActiveTurnAdmissionWitness: () => Object.freeze({
                inputId: 'input-opencode-missing-authority',
                turnId: 'turn-opencode-missing-authority',
                userMessageSeq: 2,
                userMessageSeqs: Object.freeze([2]),
            }),
            isGenerationCurrent: () => true,
        }), createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'opencode-generation-2',
            'opencode-binding-2',
        )).interactions;

        await expect(interaction.requestApproval({
            kind: 'approval',
            title: 'Run Bash?',
            subject: { kind: 'tool', name: 'Bash', input: { command: 'echo deny' } },
        })).resolves.toMatchObject({
            kind: 'approval',
            status: 'declined',
        });
        expect(Object.keys(requests(session))).toEqual([]);
        const context = handleToolCall.mock.calls[0]?.[3];
        expect(context).toBeDefined();
        expect(Object.hasOwn(context ?? {}, 'causalPermissionAuthority')).toBe(true);
        expect(Object.hasOwn(context ?? {}, 'turnId')).toBe(true);
        expect(context).toMatchObject({
            turnId: 'turn-opencode-missing-authority',
            causalPermissionAuthority: null,
        });
    });
});
