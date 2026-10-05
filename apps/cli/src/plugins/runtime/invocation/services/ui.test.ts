import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    HostCurrentSessionInteractionsService,
    HostCurrentSessionPresentationService,
    HostSessionPresentationOwner,
    HostSessionApprovalRequest,
    HostSessionApprovalResult,
    HostSessionConfirmationRequest,
    HostSessionConfirmationResult,
    HostSessionInteractionRequest,
    HostSessionInteractionResult,
    HostSessionQuestionsRequest,
    HostSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';

import {
    createPluginInteractionsService,
    createPluginInvocationPresentation,
} from './interactions';

class TestInteractions implements HostCurrentSessionInteractionsService {
    constructor(
        private readonly handle: (
            request: HostSessionInteractionRequest,
            options?: { signal?: AbortSignal },
        ) => Promise<HostSessionInteractionResult>,
    ) {}

    request(request: HostSessionApprovalRequest, options?: { signal?: AbortSignal }): Promise<HostSessionApprovalResult>;
    request(request: HostSessionQuestionsRequest, options?: { signal?: AbortSignal }): Promise<HostSessionQuestionsResult>;
    request(request: HostSessionConfirmationRequest, options?: { signal?: AbortSignal }): Promise<HostSessionConfirmationResult>;
    async request(
        request: HostSessionInteractionRequest,
        options?: { signal?: AbortSignal },
    ): Promise<HostSessionInteractionResult> {
        return await this.handle(request, options);
    }
}

function presentation(
    overrides: Partial<HostCurrentSessionPresentationService> = {},
): HostCurrentSessionPresentationService {
    return Object.freeze({
        notify: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        setStatus: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        setWidget: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        purgeOwner: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        replaceComposerText: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        present: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
        ...overrides,
    });
}

describe('plugin invocation interaction and presentation facades', () => {
    it('forwards the exact questions author request and exact answered result', async () => {
        const request = {
            kind: 'questions' as const,
            title: 'Project settings',
            questions: [
                { id: 'notes', prompt: 'Notes?', type: 'text' as const },
                {
                    id: 'language',
                    prompt: 'Language?',
                    type: 'singleChoice' as const,
                    choices: [{ id: 'ts', label: 'TypeScript' }],
                },
                {
                    id: 'targets',
                    prompt: 'Targets?',
                    type: 'multipleChoice' as const,
                    choices: [{ id: 'web' }, { id: 'ios', description: 'Apple mobile' }],
                    allowCustom: true,
                },
            ],
        };
        const handle = vi.fn(async (): Promise<HostSessionQuestionsResult> => ({
            requestId: 'host-questions',
            kind: 'questions',
            status: 'answered',
            answers: {
                notes: { kind: 'text', value: 'keep spacing' },
                language: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'ts' } },
                targets: {
                    kind: 'multipleChoice',
                    answers: [
                        { kind: 'choice', choiceId: 'web' },
                        { kind: 'custom', value: 'custom target' },
                    ],
                },
            },
        }));
        const interactions = createPluginInteractionsService({
            currentSession: { interactions: new TestInteractions(handle) },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });

        await expect(interactions.askQuestions(request)).resolves.toMatchObject({
            requestId: 'host-questions',
            kind: 'questions',
            status: 'answered',
        });
        expect(handle).toHaveBeenCalledWith(request, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('forwards confirmation author intent without exposing host request identity', async () => {
        const request = { kind: 'confirmation' as const, title: 'Review', message: 'Proceed?' };
        const handle = vi.fn(async (): Promise<HostSessionConfirmationResult> => ({
            requestId: 'host-confirmation',
            kind: 'confirmation',
            status: 'approved',
        }));
        const signal = new AbortController().signal;
        const interactions = createPluginInteractionsService({
            currentSession: { interactions: new TestInteractions(handle) },
            signal,
            isOccurrenceCurrent: () => true,
        });

        await expect(interactions.confirm(request)).resolves.toEqual({
            requestId: 'host-confirmation',
            kind: 'confirmation',
            status: 'approved',
        });
        expect(handle).toHaveBeenCalledWith(request, { signal });
    });

    it('projects one-shot and stateful presentation through the current-session owner', async () => {
        const hostPresentation = presentation();
        const signal = new AbortController().signal;
        let operation = 0;
        const facade = createPluginInvocationPresentation({
            currentSession: { presentation: hostPresentation },
            signal,
            isOccurrenceCurrent: () => true,
            createOperationId: () => `host-operation-${++operation}`,
            presentationOwner: {
                pluginId: 'acme.alpha',
                contributionId: 'run',
                generationId: 'immutable-occurrenceId-alpha',
                invocationId: 'invocation-a',
            },
        });

        await expect(facade.notify('Finished', { severity: 'warning' })).resolves.toBeUndefined();
        await expect(facade.status.set('build', 'Ready')).resolves.toBeUndefined();
        await expect(facade.widget.set('summary', {
            placement: 'afterComposer',
            lines: ['One', 'Two'],
        })).resolves.toBeUndefined();
        await expect(facade.widget.set('summary', null)).resolves.toBeUndefined();
        await expect(facade.composer.replace('next prompt')).resolves.toBeUndefined();
        await expect(facade.present({ kind: 'board.item.reveal', widgetId: 'note-1' })).resolves.toBeUndefined();
        const writesBeforeInvalidAuthorIntent = vi.mocked(hostPresentation.present).mock.calls.length;
        // JavaScript authors can bypass types; the invocation boundary must still reject host-only mutation input.
        await expect(Reflect.apply(facade.present, facade, [{
            kind: 'companion.instance.rename', instanceId: 'copy-a', displayName: 'Forged',
        }])).rejects.toMatchObject({ code: 'plugin_ui_invalid_presentation_intent' });
        expect(vi.mocked(hostPresentation.present).mock.calls).toHaveLength(writesBeforeInvalidAuthorIntent);

        expect(hostPresentation.notify).toHaveBeenCalledWith({
            operationId: 'host-operation-1',
            message: 'Finished',
            severity: 'warning',
        }, { signal });
        expect(hostPresentation.present).toHaveBeenCalledWith({
            operationId: 'host-operation-6',
            intent: { kind: 'board.item.reveal', widgetId: 'note-1' },
        }, { signal });
        expect(hostPresentation.setWidget).toHaveBeenLastCalledWith({
            operationId: 'host-operation-4',
            key: 'summary',
            placement: 'beforeComposer',
            lines: null,
            owner: {
                pluginId: 'acme.alpha',
                contributionId: 'run',
                generationId: 'immutable-occurrenceId-alpha',
                invocationId: 'invocation-a',
            },
        }, { signal });
    });

    it('uses only a host-stamped invocation owner for transient rows and purges it on retirement', async () => {
        const hostPresentation = presentation({
            purgeOwner: vi.fn(async () => ({ status: 'applied' as const, revision: '2' })),
        });
        const controller = new AbortController();
        const owner: HostSessionPresentationOwner = {
            pluginId: 'acme.alpha',
            contributionId: 'run',
            generationId: 'immutable-occurrenceId-a',
            invocationId: 'invocation-a',
        };
        const facade = createPluginInvocationPresentation({
            currentSession: { presentation: hostPresentation },
            signal: controller.signal,
            isOccurrenceCurrent: () => true,
            presentationOwner: owner,
            createOperationId: () => 'host-operation',
        });

        await facade.status.set('progress', 'Running');
        await facade.widget.set('progress', { placement: 'beforeComposer', lines: ['1/2'] });

        expect(hostPresentation.setStatus).toHaveBeenCalledWith(expect.objectContaining({
            key: 'progress',
            owner,
        }), expect.objectContaining({ signal: controller.signal }));
        expect(hostPresentation.setWidget).toHaveBeenCalledWith(expect.objectContaining({
            key: 'progress',
            owner,
        }), expect.objectContaining({ signal: controller.signal }));

        controller.abort();
        await Promise.resolve();
        expect(hostPresentation.purgeOwner).toHaveBeenCalledWith(expect.objectContaining({ owner }));
    });

    it('fails status and widget writes without a host-stamped invocation owner', async () => {
        const hostPresentation = presentation();
        const facade = createPluginInvocationPresentation({
            currentSession: { presentation: hostPresentation },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });

        await expect(facade.status.set('progress', 'Running')).rejects.toMatchObject({
            code: 'plugin_ui_unavailable',
        });
        await expect(facade.widget.set('progress', { placement: 'beforeComposer', lines: ['1/2'] })).rejects.toMatchObject({
            code: 'plugin_ui_unavailable',
        });
        expect(hostPresentation.setStatus).not.toHaveBeenCalled();
        expect(hostPresentation.setWidget).not.toHaveBeenCalled();
    });

    it('does not expose actionable presentation through the plugin facade', () => {
        const facade = createPluginInvocationPresentation({
            currentSession: { presentation: presentation() },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });

        expect('actionable' in facade).toBe(false);
        expect('title' in facade).toBe(false);
    });

    it('returns exact unavailable interaction terminals and truthful presentation failures', async () => {
        let operation = 0;
        const params = {
            currentSession: null,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            createOperationId: () => `fallback-${++operation}`,
        };
        const interactions = createPluginInteractionsService({
            ...params,
            isOccurrenceCurrent: params.isOccurrenceCurrent,
        });
        const facade = createPluginInvocationPresentation(params);

        await expect(interactions.confirm({
            kind: 'confirmation',
            message: 'Proceed?',
        })).resolves.toEqual({
            requestId: 'fallback-1',
            kind: 'confirmation',
            status: 'unavailable',
        });
        await expect(interactions.askQuestions({
            kind: 'questions',
            questions: [{ id: 'reason', prompt: 'Reason?', type: 'text' }],
        })).resolves.toEqual({
            requestId: 'fallback-2',
            kind: 'questions',
            status: 'unavailable',
        });
        await expect(facade.notify('Finished')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_unavailable',
        } satisfies Partial<PluginError>);
        await expect(facade.present({ kind: 'chat.return' })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_unavailable',
        } satisfies Partial<PluginError>);
    });

    it('fails presentation calls truthfully for retired generations and inconclusive host outcomes', async () => {
        const retiredPresentation = presentation();
        const retired = createPluginInvocationPresentation({
            currentSession: { presentation: retiredPresentation },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => false,
        });
        await expect(retired.notify('Stale occurrenceId')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_ui_generation_retired',
        } satisfies Partial<PluginError>);
        expect(retiredPresentation.notify).not.toHaveBeenCalled();

        const inconclusive = createPluginInvocationPresentation({
            currentSession: {
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
            isOccurrenceCurrent: () => true,
            presentationOwner: {
                pluginId: 'acme.alpha',
                contributionId: 'run',
                generationId: 'immutable-occurrenceId-alpha',
                invocationId: 'invocation-a',
            },
        });
        await expect(inconclusive.notify('Finished')).rejects.toMatchObject({
            code: 'plugin_ui_outcome_unknown',
        });
        await expect(inconclusive.status.set('build', 'Ready')).rejects.toMatchObject({
            code: 'plugin_ui_conflict',
        });
    });
});
