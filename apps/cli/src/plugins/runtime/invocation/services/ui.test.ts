import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import type {
    HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService,
    HostCurrentSessionPresentationService as PluginCurrentSessionPresentationService,
    HostSessionApprovalRequest as PluginSessionApprovalRequest,
    HostSessionApprovalResult as PluginSessionApprovalResult,
    HostSessionConfirmationRequest as PluginSessionConfirmationRequest,
    HostSessionConfirmationResult as PluginSessionConfirmationResult,
    HostSessionInteractionRequest as PluginSessionInteractionRequest,
    HostSessionInteractionResult as PluginSessionInteractionResult,
    HostSessionQuestionsRequest as PluginSessionQuestionsRequest,
    HostSessionQuestionsResult as PluginSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';

import { createPluginInvocationUi } from './ui';

class FakeRpcHandlerManager {
    readonly handlers = new Map<string, (payload: unknown) => unknown>();

    registerHandler(name: string, handler: (payload: unknown) => unknown): void {
        this.handlers.set(name, handler);
    }
}

class FakeSession {
    readonly sessionId = 'session-1';
    readonly rpcHandlerManager = new FakeRpcHandlerManager();
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

function requireAgentStateRequests(state: AgentState): NonNullable<AgentState['requests']> {
    if (!state.requests) throw new Error('Expected the test session to have an agent request store');
    return state.requests;
}

class TestInteractions implements PluginCurrentSessionInteractionsService {
    constructor(
        private readonly handle: (
            request: PluginSessionInteractionRequest,
            options?: { signal?: AbortSignal },
        ) => Promise<PluginSessionInteractionResult>,
    ) {}

    request(request: PluginSessionApprovalRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionApprovalResult>;
    request(request: PluginSessionQuestionsRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionQuestionsResult>;
    request(request: PluginSessionConfirmationRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionConfirmationResult>;
    async request(
        request: PluginSessionInteractionRequest,
        options?: { signal?: AbortSignal },
    ): Promise<PluginSessionInteractionResult> {
        return await this.handle(request, options);
    }
}

function presentation(
    overrides: Partial<PluginCurrentSessionPresentationService> = {},
): PluginCurrentSessionPresentationService {
    return Object.freeze({
        notify: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        setStatus: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        setWidget: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        setSurfaceTitle: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        replaceComposerText: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        ...overrides,
    });
}

describe('plugin invocation UI facade', () => {
    it('round-trips structured questions through the sole agentState request owner', async () => {
        const session = new FakeSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(
            session as unknown as ApiSessionClient,
            { logPrefix: '[Test]' },
        );
        const services = createNativeAgentSessionServices({
            permissionHandler,
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent',
            sessionId: session.sessionId,
            generationId: 'generation-1',
            isCurrent: () => true,
        });
        let operation = 0;
        const ui = createPluginInvocationUi({
            currentSession: services.sessions.current,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            createOperationId: () => `host-question-${++operation}`,
        });

        const answered = ui.askQuestions([
            { id: 'notes', prompt: 'Notes?', type: 'text' },
            {
                id: 'language',
                prompt: 'Language?',
                type: 'single',
                choices: [{ id: 'ts', label: 'TypeScript' }],
            },
            {
                id: 'targets',
                prompt: 'Targets?',
                type: 'multiple',
                choices: [{ id: 'web' }, { id: 'ios', description: 'Apple mobile' }],
                allowCustom: true,
            },
        ]);

        expect(Object.keys(requireAgentStateRequests(session.agentState))).toEqual(['host-question-1']);
        expect(requireAgentStateRequests(session.agentState)['host-question-1']).toMatchObject({
            tool: 'AskUserQuestion',
            kind: 'user_action',
            owner: { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.agent' },
            arguments: {
                questions: [
                    { id: 'notes', selection: 'text' },
                    { id: 'language', selection: 'single', options: [{ id: 'ts', label: 'TypeScript' }] },
                    {
                        id: 'targets',
                        selection: 'multiple',
                        options: [{ id: 'web', label: 'web' }, { id: 'ios', label: 'ios', description: 'Apple mobile' }],
                        allowCustom: true,
                    },
                ],
            },
        });

        await session.rpcHandlerManager.handlers.get('session.user_action.answer')?.({
            id: 'host-question-1',
            approved: true,
            decision: 'approved',
            answers: {
                notes: 'keep spacing',
                language: 'ts',
                targets: 'web, custom target',
            },
        });
        await expect(answered).resolves.toEqual({
            status: 'answered',
            answers: {
                notes: { type: 'text', value: 'keep spacing' },
                language: { type: 'single', answer: { type: 'choice', choiceId: 'ts' } },
                targets: {
                    type: 'multiple',
                    answers: [
                        { type: 'choice', choiceId: 'web' },
                        { type: 'custom', value: 'custom target' },
                    ],
                },
            },
        });
        expect(session.agentState.requests).toEqual({});

        const cancelled = ui.askQuestions([{ id: 'reason', prompt: 'Reason?', type: 'text' }]);
        expect(Object.keys(requireAgentStateRequests(session.agentState))).toEqual(['host-question-2']);
        await session.rpcHandlerManager.handlers.get('session.user_action.answer')?.({
            id: 'host-question-2',
            approved: false,
            decision: 'abort',
        });
        await expect(cancelled).resolves.toEqual({ status: 'cancelled' });
        expect(session.agentState.requests).toEqual({});

        await expect(Reflect.apply(ui.askQuestions, ui, [[]])).resolves.toMatchObject({
            status: 'unavailable',
        });
        expect(session.agentState.requests).toEqual({});
    });

    it('projects author intent through current-session SVC10 without exposing host operation ids', async () => {
        const confirm = vi.fn(async () => ({
            kind: 'confirmation' as const,
            status: 'answered' as const,
            confirmed: true,
        }));
        const hostPresentation = presentation();
        const signal = new AbortController().signal;
        const ui = createPluginInvocationUi({
            currentSession: {
                interactions: new TestInteractions(confirm),
                presentation: hostPresentation,
            },
            signal,
            isGenerationCurrent: () => true,
            createOperationId: (() => {
                let sequence = 0;
                return () => `host-operation-${++sequence}`;
            })(),
        });

        await expect(ui.confirm('Proceed?', { title: 'Review' })).resolves.toBe(true);
        await expect(ui.notify('Finished', { severity: 'warning' })).resolves.toBeUndefined();
        await expect(ui.status.set('build', 'Ready')).resolves.toBeUndefined();
        await expect(ui.widget.set('summary', {
            placement: 'afterComposer',
            lines: ['One', 'Two'],
        })).resolves.toBeUndefined();
        await expect(ui.widget.set('summary', null)).resolves.toBeUndefined();
        await expect(ui.title.set('Review')).resolves.toBeUndefined();
        await expect(ui.composer.replace('next prompt')).resolves.toBeUndefined();

        expect(confirm).toHaveBeenCalledWith({
            kind: 'confirmation',
            requestId: 'host-operation-1',
            title: 'Review',
            message: 'Proceed?',
        }, { signal });
        expect(hostPresentation.notify).toHaveBeenCalledWith({
            operationId: 'host-operation-2',
            message: 'Finished',
            severity: 'warning',
        }, { signal });
        expect(hostPresentation.setWidget).toHaveBeenLastCalledWith({
            operationId: 'host-operation-5',
            key: 'summary',
            placement: 'beforeComposer',
            lines: null,
        }, { signal });
    });

    it('rejects a retained UI facade after its plugin generation retires', async () => {
        const hostPresentation = presentation();
        const ui = createPluginInvocationUi({
            currentSession: {
                interactions: new TestInteractions(async () => ({
                    kind: 'confirmation',
                    status: 'answered',
                    confirmed: true,
                })),
                presentation: hostPresentation,
            },
            signal: new AbortController().signal,
            isGenerationCurrent: () => false,
        });

        await expect(ui.notify('Stale generation')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_generation_retired',
        } satisfies Partial<PluginError>);
        expect(hostPresentation.notify).not.toHaveBeenCalled();
    });

    it('fails truthfully for unbound sessions and inconclusive host outcomes', async () => {
        const unavailable = createPluginInvocationUi({
            currentSession: null,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        await expect(unavailable.confirm('Proceed?')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_unavailable',
        } satisfies Partial<PluginError>);
        await expect(unavailable.askQuestions([
            { id: 'reason', prompt: 'Reason?', type: 'text' },
        ])).resolves.toMatchObject({
            status: 'unavailable',
            diagnostic: { code: 'plugin_ui_unavailable' },
        });

        const outcomeUnknown = createPluginInvocationUi({
            currentSession: {
                interactions: new TestInteractions(async () => ({
                    kind: 'confirmation',
                    status: 'unavailable',
                    diagnostic: { code: 'interaction_unavailable', severity: 'warning', message: 'Unavailable' },
                })),
                presentation: presentation({
                    notify: async () => ({
                        status: 'outcomeUnknown',
                        diagnostic: { code: 'ack_lost', severity: 'warning', message: 'Acknowledgement lost' },
                    }),
                    setStatus: async () => ({
                        status: 'conflict',
                        diagnostic: { code: 'stale_revision', severity: 'warning', message: 'Stale revision' },
                    }),
                }),
            },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            createOperationId: () => 'host-operation',
        });

        await expect(outcomeUnknown.confirm('Proceed?')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_unavailable',
        } satisfies Partial<PluginError>);
        await expect(outcomeUnknown.notify('Finished')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_outcome_unknown',
        } satisfies Partial<PluginError>);
        await expect(outcomeUnknown.status.set('build', 'Ready')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_conflict',
        } satisfies Partial<PluginError>);
    });

    it('maps question interaction failures to the typed unavailable terminal result', async () => {
        const ui = createPluginInvocationUi({
            currentSession: {
                interactions: new TestInteractions(async () => {
                    throw new Error('raw interaction transport failure');
                }),
                presentation: presentation(),
            },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            createOperationId: () => 'host-question',
        });

        await expect(ui.askQuestions([
            { id: 'reason', prompt: 'Reason?', type: 'text' },
        ])).resolves.toEqual({
            status: 'unavailable',
            diagnostic: {
                code: 'plugin_ui_questions_unavailable',
                severity: 'error',
                message: 'The requested UI questions interaction failed',
            },
        });
    });
});
