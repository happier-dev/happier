import { describe, expect, it, vi } from 'vitest';

import type {
    HostCurrentSessionInteractionsService,
    HostSessionApprovalRequest,
    HostSessionApprovalResult,
    HostSessionConfirmationRequest,
    HostSessionConfirmationResult,
    HostSessionInteractionRequest,
    HostSessionInteractionResult,
    HostSessionQuestionsRequest,
    HostSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';

import { createPluginInteractionsService } from './interactions';

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

describe('plugin invocation transient approval', () => {
    it('returns the exact unavailable terminal without a bound current session', async () => {
        const interactions = createPluginInteractionsService({
            currentSession: null,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            createOperationId: () => 'fallback-approval',
        });

        await expect(interactions.requestApproval({
            kind: 'approval',
            title: 'Run Bash?',
            subject: { kind: 'tool', name: 'Bash', input: {} },
        })).resolves.toEqual({
            requestId: 'fallback-approval',
            kind: 'approval',
            status: 'unavailable',
        });
    });

    it('forwards only author intent and preserves the exact current-session result', async () => {
        const request = {
            kind: 'approval' as const,
            title: 'Run Bash?',
            description: 'Print the working directory',
            subject: { kind: 'tool' as const, name: 'Bash', input: { command: 'pwd' } },
            allowSessionPersistence: true,
        };
        const handle = vi.fn(async (): Promise<HostSessionApprovalResult> => ({
            requestId: 'host-approval',
            kind: 'approval',
            status: 'approved',
            persistence: 'session',
        }));
        const interactions = createPluginInteractionsService({
            currentSession: { interactions: new TestInteractions(handle) },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        await expect(interactions.requestApproval(request)).resolves.toEqual({
            requestId: 'host-approval',
            kind: 'approval',
            status: 'approved',
            persistence: 'session',
        });
        expect(handle).toHaveBeenCalledWith(request, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('settles requester abort and generation retirement with distinct exact terminals', async () => {
        const request = {
            kind: 'approval' as const,
            title: 'Run Bash?',
            subject: { kind: 'tool' as const, name: 'Bash', input: {} },
        };
        const invocationController = new AbortController();
        const pending = createPluginInteractionsService({
            currentSession: {
                interactions: new TestInteractions(async (_request, options) => {
                    await new Promise<never>((_resolve, reject) => {
                        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                    });
                    throw new Error('unreachable');
                }),
            },
            signal: invocationController.signal,
            isGenerationCurrent: () => true,
            createOperationId: () => 'fallback-aborted',
        }).requestApproval(request);
        invocationController.abort();
        await expect(pending).resolves.toEqual({
            requestId: 'fallback-aborted',
            kind: 'approval',
            status: 'requesterAborted',
        });

        const retired = createPluginInteractionsService({
            currentSession: { interactions: new TestInteractions(async () => { throw new Error('must not invoke'); }) },
            signal: new AbortController().signal,
            isGenerationCurrent: () => false,
            createOperationId: () => 'fallback-retired',
        });
        await expect(retired.requestApproval(request)).resolves.toEqual({
            requestId: 'fallback-retired',
            kind: 'approval',
            status: 'generationRetired',
        });
    });
});
