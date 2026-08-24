import { describe, expect, it, vi } from 'vitest';

import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type {
    HostSessionApprovalRequest,
    HostSessionConfirmationRequest,
    HostSessionQuestionsRequest,
} from '@/agent/runtime/state/currentSessionUiTypes';

import {
    createNativeAgentCurrentSessionUiServices,
    createNativeAgentSessionServices,
    type NativeAgentSessionInteractionParams,
} from './nativeAgentSessionInteractions';

type PermissionHandlerBoundary = Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;

function createFixture(
    handleToolCall: PermissionHandlerBoundary['handleToolCall'] | null,
    overrides: Partial<NativeAgentSessionInteractionParams> = {},
) {
    const params: NativeAgentSessionInteractionParams = {
        permissionHandler: handleToolCall ? { handleToolCall } : null,
        pluginId: 'acme.plugin',
        contributionId: 'acme-agent',
        runtimeId: 'acme.agent/runtime',
        sessionId: 'session-1',
        generationId: 'generation-1',
        immutableGenerationId: 'immutable-generation-1',
        interactionDeadlineMs: 1_000,
        isCurrent: () => true,
        signal: new AbortController().signal,
        ...overrides,
    };
    const currentSessionUi = createNativeAgentCurrentSessionUiServices(params);
    const publicServices = createNativeAgentSessionServices({ ...params, currentSessionUi });
    return Object.freeze({
        current: currentSessionUi.interactions,
        public: publicServices.interactions,
        availability: publicServices.availability,
    });
}

const approvalRequest: HostSessionApprovalRequest = {
    kind: 'approval',
    title: 'Run Bash?',
    description: 'Inspect the working tree',
    subject: { kind: 'tool', name: 'Bash', input: { command: 'git status --short' } },
    allowSessionPersistence: true,
};

const questionsRequest: HostSessionQuestionsRequest = {
    kind: 'questions',
    title: 'Configure release',
    questions: [
        { id: 'notes', prompt: 'Notes', type: 'text', required: true, initialValue: 'Existing notes' },
        {
            id: 'components',
            prompt: 'Components',
            type: 'multipleChoice',
            allowCustom: true,
            choices: [
                { id: 'alpha-beta', label: 'Alpha, Beta' },
                { id: 'gamma', label: 'Gamma' },
            ],
        },
    ],
};

describe('native Agent current-session interactions', () => {
    it('presents through the permission owner without a caller-supplied deadline', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const fixture = createFixture(handleToolCall, { interactionDeadlineMs: undefined });

        expect(fixture.availability('interactions')).toEqual({ status: 'available' });
        await expect(fixture.public.confirm({
            kind: 'confirmation',
            message: 'Continue?',
        })).resolves.toEqual({
            requestId: expect.any(String),
            kind: 'confirmation',
            status: 'approved',
        });
        expect(handleToolCall).toHaveBeenCalledWith(
            expect.any(String),
            'AgentConfirmation',
            expect.objectContaining({ message: 'Continue?' }),
            expect.objectContaining({
                owner: { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.agent/runtime' },
            }),
        );
    });

    it('fails closed when a caller supplies a malformed deadline', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const fixture = createFixture(handleToolCall, { interactionDeadlineMs: 0 });

        expect(fixture.availability('interactions')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        await expect(fixture.public.confirm({
            kind: 'confirmation',
            message: 'Continue?',
        })).resolves.toEqual({
            requestId: expect.any(String),
            kind: 'confirmation',
            status: 'unavailable',
        });
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('keeps Session inventory available while transient presentation is unavailable', async () => {
        const fixture = createFixture(null, {
            credentials: {
                token: 'account-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            },
        });

        expect(fixture.availability('sessions')).toEqual({ status: 'available' });
        expect(fixture.availability('interactions')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        await expect(fixture.public.requestApproval(approvalRequest)).resolves.toEqual({
            requestId: expect.any(String),
            kind: 'approval',
            status: 'unavailable',
        });
    });

    it('maps approval outcomes into the strict result vocabulary and session ceiling', async () => {
        const decisions = [
            { decision: 'approved' as const },
            { decision: 'approved_for_session' as const },
            { decision: 'denied' as const, rationale: 'Read-only mode' },
            { decision: 'abort' as const },
        ];
        const handleToolCall = vi.fn(async () => {
            const decision = decisions.shift();
            if (!decision) throw new Error('Missing permission decision fixture');
            return decision;
        });
        const fixture = createFixture(handleToolCall);

        await expect(fixture.public.requestApproval(approvalRequest)).resolves.toMatchObject({
            kind: 'approval', status: 'approved', persistence: 'once',
        });
        await expect(fixture.public.requestApproval(approvalRequest)).resolves.toMatchObject({
            kind: 'approval', status: 'approved', persistence: 'session',
        });
        await expect(fixture.public.requestApproval(approvalRequest)).resolves.toMatchObject({
            kind: 'approval', status: 'declined',
        });
        await expect(fixture.public.requestApproval(approvalRequest)).resolves.toMatchObject({
            kind: 'approval', status: 'userCancelled',
        });
        expect(handleToolCall).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            'Bash',
            {
                title: 'Run Bash?',
                description: 'Inspect the working tree',
                subject: approvalRequest.subject,
                allowedPersistenceScopes: ['session'],
            },
            expect.objectContaining({
                owner: {
                    kind: 'plugin',
                    pluginId: 'acme.plugin',
                    runtimeId: 'acme.agent/runtime',
                },
            }),
        );
    });

    it('rejects persistence outside the author-requested approval ceiling', async () => {
        const fixture = createFixture(vi.fn(async () => ({
            decision: 'approved_for_session' as const,
        })));

        await expect(fixture.public.requestApproval({
            ...approvalRequest,
            allowSessionPersistence: undefined,
        })).resolves.toMatchObject({ kind: 'approval', status: 'unavailable' });
    });

    it('maps exact question answer records without splitting comma-bearing values', async () => {
        const handleToolCall = vi.fn(async () => ({
            decision: 'approved' as const,
            answers: {
                notes: ['Keep Alpha, Beta intact'],
                components: ['alpha-beta', 'gamma', 'Custom, other'],
            },
        }));
        const fixture = createFixture(handleToolCall);

        await expect(fixture.public.askQuestions(questionsRequest)).resolves.toMatchObject({
            kind: 'questions',
            status: 'answered',
            answers: {
                notes: { kind: 'text', value: 'Keep Alpha, Beta intact' },
                components: {
                    kind: 'multipleChoice',
                    answers: [
                        { kind: 'choice', choiceId: 'alpha-beta' },
                        { kind: 'choice', choiceId: 'gamma' },
                        { kind: 'custom', value: 'Custom, other' },
                    ],
                },
            },
        });
        expect(handleToolCall).toHaveBeenCalledWith(
            expect.any(String),
            'AskUserQuestion',
            {
                title: 'Configure release',
                questions: [
                    {
                        id: 'notes',
                        question: 'Notes',
                        required: true,
                        selection: 'text',
                        presentation: { initialValue: 'Existing notes' },
                    },
                    {
                        id: 'components',
                        question: 'Components',
                        selection: 'multiple',
                        options: [
                            { id: 'alpha-beta', label: 'Alpha, Beta' },
                            { id: 'gamma', label: 'Gamma' },
                        ],
                        allowCustom: true,
                    },
                ],
            },
            expect.anything(),
        );
    });

    it('fails closed on missing required, unknown, duplicate, empty, or accessor-backed answers', async () => {
        const answerFixtures: unknown[] = [
            {},
            { notes: ['note'], components: ['gamma'], unknown: ['ignored?'] },
            { notes: ['note'], components: ['gamma', 'gamma'] },
            { notes: [''], components: ['gamma'] },
        ];
        const accessorAnswers: Record<string, unknown> = { components: ['gamma'] };
        Object.defineProperty(accessorAnswers, 'notes', {
            enumerable: true,
            get: () => { throw new Error('must not escape the boundary'); },
        });
        answerFixtures.push(accessorAnswers);

        for (const answers of answerFixtures) {
            const fixture = createFixture(vi.fn(async () => ({
                decision: 'approved' as const,
                answers,
            } as never)));
            await expect(fixture.public.askQuestions(questionsRequest)).resolves.toMatchObject({
                kind: 'questions',
                status: 'unavailable',
            });
        }
    });

    it('maps confirmations and refuses effect-bearing permission results', async () => {
        const confirmation: HostSessionConfirmationRequest = {
            kind: 'confirmation',
            title: 'Continue?',
            message: 'Continue with the operation?',
        };
        const decisions = [
            { decision: 'approved' as const },
            { decision: 'denied' as const },
            { decision: 'abort' as const },
            { decision: 'approved_for_session' as const },
            {
                decision: 'approved' as const,
                execPolicyAmendment: { command: ['git', 'status'] },
            },
        ];
        const fixture = createFixture(vi.fn(async () => decisions.shift()!));

        await expect(fixture.public.confirm(confirmation)).resolves.toMatchObject({ status: 'approved' });
        await expect(fixture.public.confirm(confirmation)).resolves.toMatchObject({ status: 'declined' });
        await expect(fixture.public.confirm(confirmation)).resolves.toMatchObject({ status: 'userCancelled' });
        await expect(fixture.public.confirm(confirmation)).resolves.toMatchObject({ status: 'unavailable' });
        await expect(fixture.public.confirm(confirmation)).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('settles an already-aborted caller without presenting it', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const fixture = createFixture(handleToolCall);
        const caller = new AbortController();
        caller.abort(new Error('caller stopped'));

        await expect(fixture.public.confirm({
            kind: 'confirmation',
            message: 'Continue?',
        }, { signal: caller.signal })).resolves.toMatchObject({
            kind: 'confirmation',
            status: 'requesterAborted',
        });
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('distinguishes requester abort, session end, and generation retirement', async () => {
        const handleToolCall = vi.fn((
            _requestId: string,
            _toolName: string,
            _input: unknown,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const authorRequest: HostSessionConfirmationRequest = {
            kind: 'confirmation',
            message: 'Continue?',
        };

        const requester = new AbortController();
        const requesterPending = createFixture(handleToolCall).current.request(authorRequest, {
            signal: requester.signal,
        });
        requester.abort();
        await expect(requesterPending).resolves.toMatchObject({ status: 'requesterAborted' });

        const session = new AbortController();
        const sessionPending = createFixture(handleToolCall, { signal: session.signal })
            .current.request(authorRequest);
        session.abort();
        await expect(sessionPending).resolves.toMatchObject({ status: 'sessionEnded' });

        let current = true;
        const retired = new AbortController();
        const retiredPending = createFixture(handleToolCall, {
            signal: retired.signal,
            isCurrent: () => current,
        }).current.request(authorRequest);
        current = false;
        retired.abort();
        await expect(retiredPending).resolves.toMatchObject({ status: 'generationRetired' });
    });

    it('fences before presentation and after an in-flight generation retires', async () => {
        let current = false;
        let resolveHost!: (result: { decision: 'approved' }) => void;
        const handleToolCall = vi.fn(() => new Promise<{ decision: 'approved' }>((resolve) => {
            resolveHost = resolve;
        }));
        const fixture = createFixture(handleToolCall, { isCurrent: () => current });
        const request: HostSessionConfirmationRequest = { kind: 'confirmation', message: 'Continue?' };

        await expect(fixture.current.request(request)).resolves.toMatchObject({ status: 'generationRetired' });
        expect(handleToolCall).not.toHaveBeenCalled();

        current = true;
        const pending = fixture.current.request(request);
        await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalledOnce());
        current = false;
        resolveHost({ decision: 'approved' });
        await expect(pending).resolves.toMatchObject({ status: 'generationRetired' });
    });

    it('host-stamps authenticated requester attribution into the permission owner', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const fixture = createFixture(handleToolCall);

        const result = await fixture.current.request({
            kind: 'confirmation',
            message: 'Continue?',
        }, {
            requester: {
                pluginId: 'caller.plugin',
                contributionId: 'caller-action',
                generationId: 'caller-generation',
                invocationId: 'native-agent-runtime',
            },
        });

        expect(result).toMatchObject({
            requestId: expect.any(String),
            kind: 'confirmation',
            status: 'approved',
        });
        expect(handleToolCall).toHaveBeenCalledWith(
            result.requestId,
            'AgentConfirmation',
            { title: undefined, message: 'Continue?' },
            expect.objectContaining({
                owner: {
                    kind: 'plugin',
                    pluginId: 'caller.plugin',
                    runtimeId: 'native-agent-runtime',
                },
            }),
        );
    });

    it('fails closed on strict request violations without invoking the permission owner', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const fixture = createFixture(handleToolCall);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        const invalidRequests: unknown[] = [
            { ...approvalRequest, requestId: 'author-must-not-supply-this' },
            { ...approvalRequest, subject: { kind: 'tool', name: 'Bash', input: cyclic } },
            {
                ...approvalRequest,
                subject: { kind: 'tool', name: 'Bash', input: 'x'.repeat(256 * 1_024 + 1) },
            },
            proxy,
        ];

        for (const request of invalidRequests) {
            await expect(fixture.current.request(request as HostSessionApprovalRequest)).resolves.toMatchObject({
                status: 'unavailable',
            });
        }
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('turns permission-owner failures and malformed results into typed unavailability', async () => {
        const failures: Array<PermissionHandlerBoundary['handleToolCall']> = [
            vi.fn(async () => { throw new Error('sensitive provider failure'); }),
            vi.fn(async () => ({ decision: 42 } as never)),
            vi.fn(async () => ({ decision: 'mystery' } as never)),
        ];

        for (const handleToolCall of failures) {
            const result = await createFixture(handleToolCall).public.requestApproval(approvalRequest);
            expect(result).toEqual({
                requestId: expect.any(String),
                kind: 'approval',
                status: 'unavailable',
            });
            expect(result).not.toHaveProperty('diagnostic');
        }
    });
});
