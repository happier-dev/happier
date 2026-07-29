import { describe, expect, it } from 'vitest';

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

import { createPluginInvocationUi } from './ui';

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

describe('plugin invocation tool approval', () => {
    it('returns unavailable without a bound current session and cancelled when the invocation aborts', async () => {
        const subject = { kind: 'tool' as const, name: 'Bash', input: {} };
        const unavailable = createPluginInvocationUi({
            currentSession: null,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        await expect(unavailable.requestApproval({
            title: 'Run Bash?',
            subject,
        })).resolves.toMatchObject({
            status: 'unavailable',
            diagnostic: { code: 'plugin_ui_unavailable' },
        });

        const controller = new AbortController();
        const cancelled = createPluginInvocationUi({
            currentSession: {
                interactions: new TestInteractions(async (_request, options) => {
                    await new Promise<never>((_resolve, reject) => {
                        options?.signal?.addEventListener(
                            'abort',
                            () => reject(new Error('invocation stopped')),
                            { once: true },
                        );
                    });
                    throw new Error('unreachable');
                }),
            },
            signal: controller.signal,
            isGenerationCurrent: () => true,
            createOperationId: () => 'host-approval-cancelled',
        });
        const pending = cancelled.requestApproval({
            title: 'Run Bash?',
            subject,
        });
        controller.abort();
        await expect(pending).resolves.toEqual({ status: 'cancelled' });
    });

    it('projects only tool approval intent and keeps session persistence host-decided', async () => {
        const requests: HostSessionApprovalRequest[] = [];
        const results: HostSessionApprovalResult[] = [
            { kind: 'approval', status: 'approved' },
            {
                kind: 'approval',
                status: 'approved',
                effects: {
                    persistApprovals: [{ scope: 'session', toolName: 'Bash' }],
                },
            },
            { kind: 'approval', status: 'approved' },
            { kind: 'approval', status: 'denied', rationale: 'Read-only mode' },
            { kind: 'approval', status: 'cancelled' },
            {
                kind: 'approval',
                status: 'unavailable',
                diagnostic: {
                    code: 'interaction_unavailable',
                    severity: 'warning',
                    message: 'No current client',
                },
            },
        ];
        const ui = createPluginInvocationUi({
            currentSession: {
                interactions: new TestInteractions(async (request) => {
                    if (request.kind !== 'approval') throw new Error(`Unexpected ${request.kind} interaction`);
                    requests.push(request);
                    const result = results.shift();
                    if (!result) throw new Error('Missing approval result fixture');
                    return result;
                }),
            },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            createOperationId: (() => {
                let sequence = 0;
                return () => `host-approval-${++sequence}`;
            })(),
        });
        const subject = { kind: 'tool' as const, name: 'Bash', input: { command: 'pwd' } };

        await expect(ui.requestApproval({ title: 'Run Bash?', subject }))
            .resolves.toEqual({ status: 'approved', persistence: 'once' });
        await expect(ui.requestApproval({
            title: 'Run Bash?',
            description: 'Print the working directory',
            subject,
            allowSessionPersistence: true,
        })).resolves.toEqual({ status: 'approved', persistence: 'session' });
        await expect(ui.requestApproval({
            title: 'Run Bash?',
            subject,
            allowSessionPersistence: true,
        })).resolves.toEqual({ status: 'approved', persistence: 'once' });
        await expect(ui.requestApproval({ title: 'Run Bash?', subject }))
            .resolves.toEqual({ status: 'denied', rationale: 'Read-only mode' });
        await expect(ui.requestApproval({ title: 'Run Bash?', subject }))
            .resolves.toEqual({ status: 'cancelled' });
        await expect(ui.requestApproval({ title: 'Run Bash?', subject }))
            .resolves.toEqual({
                status: 'unavailable',
                diagnostic: {
                    code: 'interaction_unavailable',
                    severity: 'warning',
                    message: 'No current client',
                },
            });

        expect(requests).toEqual([
            {
                kind: 'approval',
                requestId: 'host-approval-1',
                title: 'Run Bash?',
                subject,
            },
            {
                kind: 'approval',
                requestId: 'host-approval-2',
                title: 'Run Bash?',
                description: 'Print the working directory',
                subject,
                allowedPersistenceScopes: ['session'],
            },
            {
                kind: 'approval',
                requestId: 'host-approval-3',
                title: 'Run Bash?',
                subject,
                allowedPersistenceScopes: ['session'],
            },
            {
                kind: 'approval',
                requestId: 'host-approval-4',
                title: 'Run Bash?',
                subject,
            },
            {
                kind: 'approval',
                requestId: 'host-approval-5',
                title: 'Run Bash?',
                subject,
            },
            {
                kind: 'approval',
                requestId: 'host-approval-6',
                title: 'Run Bash?',
                subject,
            },
        ]);
    });

    it('fails closed on malformed and ambiguous approval effects', async () => {
        const subject = { kind: 'tool' as const, name: 'Bash', input: {} };
        for (const result of [
            {
                kind: 'approval',
                status: 'approved',
                effects: { persistApprovals: [{ scope: 'workspace', toolName: 'Bash' }] },
            },
            {
                kind: 'approval',
                status: 'approved',
                effects: { replaceInput: { command: 'rm -rf .' } },
            },
            {
                kind: 'approval',
                status: 'approved',
                effects: { persistApprovals: [{ scope: 'session', toolName: 'Other' }] },
            },
        ] as HostSessionApprovalResult[]) {
            const ui = createPluginInvocationUi({
                currentSession: {
                    interactions: new TestInteractions(async () => result),
                },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
                createOperationId: () => 'host-approval',
            });
            await expect(ui.requestApproval({
                title: 'Run Bash?',
                subject,
                allowSessionPersistence: true,
            })).resolves.toMatchObject({
                status: 'unavailable',
                diagnostic: { code: 'plugin_ui_approval_unavailable' },
            });
        }
    });
});
