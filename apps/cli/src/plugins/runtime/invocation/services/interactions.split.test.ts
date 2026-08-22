import { describe, expect, it } from 'vitest';
import type { HostCurrentSessionInteractionsService } from '../../../../agent/runtime/state/currentSessionUiTypes';

import {
    createPluginInteractionsService,
    createPluginInvocationPresentation,
} from './interactions';

describe('plugin invocation interactions and presentation split', () => {
    it('keeps interaction decisions off the presentation facade', async () => {
        const signal = new AbortController().signal;
        const interactions = createPluginInteractionsService({
            currentSession: null,
            signal,
            isGenerationCurrent: () => true,
        });
        const presentation = createPluginInvocationPresentation({
            currentSession: null,
            signal,
            isGenerationCurrent: () => true,
        });

        expect(presentation).not.toHaveProperty('requestApproval');
        expect(presentation).not.toHaveProperty('askQuestions');
        expect(presentation).not.toHaveProperty('confirm');
        expect(interactions).not.toHaveProperty('notify');
        expect(interactions).not.toHaveProperty('status');

        await expect(interactions.requestApproval({
            kind: 'approval',
            title: 'Run Bash?',
            subject: { kind: 'tool', name: 'Bash', input: {} },
        })).resolves.toEqual({
            requestId: expect.any(String),
            kind: 'approval',
            status: 'unavailable',
        });
        await expect(interactions.askQuestions({
            kind: 'questions',
            questions: [{ id: 'reason', prompt: 'Reason?', type: 'text' }],
        })).resolves.toEqual({
            requestId: expect.any(String),
            kind: 'questions',
            status: 'unavailable',
        });
        await expect(interactions.confirm({
            kind: 'confirmation',
            message: 'Continue?',
        })).resolves.toEqual({
            requestId: expect.any(String),
            kind: 'confirmation',
            status: 'unavailable',
        });
    });

    it('does not overwrite already terminal host results with facade-local currentness', async () => {
        const cases = [
            {
                hostResult: Object.freeze({
                    requestId: 'host-approval',
                    kind: 'approval' as const,
                    status: 'approved' as const,
                }),
                invoke: (interactions: ReturnType<typeof createPluginInteractionsService>) => interactions.requestApproval({
                    kind: 'approval',
                    title: 'Run Bash?',
                    subject: { kind: 'tool', name: 'Bash', input: {} },
                }),
            },
            {
                hostResult: Object.freeze({
                    requestId: 'host-questions',
                    kind: 'questions' as const,
                    status: 'userCancelled' as const,
                }),
                invoke: (interactions: ReturnType<typeof createPluginInteractionsService>) => interactions.askQuestions({
                    kind: 'questions',
                    questions: [{ id: 'reason', prompt: 'Reason?', type: 'text' }],
                }),
            },
            {
                hostResult: Object.freeze({
                    requestId: 'host-confirmation',
                    kind: 'confirmation' as const,
                    status: 'declined' as const,
                }),
                invoke: (interactions: ReturnType<typeof createPluginInteractionsService>) => interactions.confirm({
                    kind: 'confirmation',
                    message: 'Continue?',
                }),
            },
        ] as const;

        for (const testCase of cases) {
            let current = true;
            const interactions = createPluginInteractionsService({
                currentSession: {
                    interactions: {
                        request: (async () => {
                            // The bound host interaction owner, not this facade,
                            // is authoritative for first-terminal settlement.
                            current = false;
                            return testCase.hostResult;
                        }) as unknown as HostCurrentSessionInteractionsService['request'],
                    },
                },
                signal: new AbortController().signal,
                isGenerationCurrent: () => current,
            });

            await expect(testCase.invoke(interactions)).resolves.toEqual(testCase.hostResult);
        }
    });

    it('normalizes caller cancellation while a confirmation is in flight', async () => {
        const caller = new AbortController();
        const interactions = createPluginInteractionsService({
            currentSession: {
                interactions: {
                    request: (async (_request: unknown, options?: { signal?: AbortSignal }) => {
                        await new Promise<never>((_resolve, reject) => {
                            options?.signal?.addEventListener('abort', () => reject(new Error('host abort')), { once: true });
                        });
                        throw new Error('unreachable');
                    }) as unknown as HostCurrentSessionInteractionsService['request'],
                },
            },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const pending = interactions.confirm({ kind: 'confirmation', message: 'Continue?' }, { signal: caller.signal });
        caller.abort();

        await expect(pending).resolves.toEqual({
            requestId: expect.any(String),
            kind: 'confirmation',
            status: 'requesterAborted',
        });
    });
});
