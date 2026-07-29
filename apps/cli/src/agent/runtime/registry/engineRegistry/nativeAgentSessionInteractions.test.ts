import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type {
    HostSessionApprovalRequest as PluginSessionApprovalRequest,
    HostSessionConfirmationRequest as PluginSessionConfirmationRequest,
    HostSessionQuestionsRequest as PluginSessionQuestionsRequest,
} from '@/agent/runtime/state/currentSessionUiTypes';

import { createNativeAgentSessionServices } from './nativeAgentSessionInteractions';

type PermissionHandlerBoundary = Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;

function createServices(handleToolCall: PermissionHandlerBoundary['handleToolCall']) {
    return createNativeAgentSessionServices({
        permissionHandler: { handleToolCall },
        pluginId: 'acme.plugin',
        contributionId: 'acme.agent',
        runtimeId: 'acme.agent',
        sessionId: 'session-1',
        generationId: 'generation-1',
        isCurrent: () => true,
    });
}

describe('native Agent current-session interactions', () => {
    it('persists native subagent writes through authenticated server custody before reporting success', async () => {
        const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            const href = String(url);
            if (href.endsWith('/subagents/custody/capability')) {
                return {
                    status: 200,
                    data: {
                        capability: 'session.subagents.durable-custody.v1',
                        maxRecords: 256,
                        maxReceipts: 4_096,
                        receiptRetentionMs: 86_400_000,
                    },
                } as never;
            }
            if (href.includes('/subagents/custody')) {
                return { status: 200, data: { records: [] } } as never;
            }
            return {
                status: 200,
                data: {
                    session: {
                        id: 'session-1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 20,
                        archivedAt: null,
                        encryptionMode: 'plain',
                        metadata: '{}',
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        dataEncryptionKey: null,
                    },
                },
            } as never;
        });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            const request = body as Record<string, unknown>;
            return ({
                status: 200,
                data: {
                    record: {
                        subagentId: request.subagentId,
                        groupId: request.groupId,
                        status: request.status,
                        revision: 0,
                        updatedAt: 100,
                    },
                    replayed: false,
                },
            }) as never;
        });
        const services = createNativeAgentSessionServices({
            permissionHandler: { handleToolCall: vi.fn() },
            credentials: {
                token: 'account-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            },
            pluginId: 'acme.plugin',
            contributionId: 'assistant',
            runtimeId: 'acme.agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
            immutableGenerationId: 'immutable-generation-1',
            isCurrent: () => true,
        });
        expect(services.sessions.subagents.capabilities()).toMatchObject({
            list: { status: 'available' },
            observe: { status: 'unavailable' },
        });
        await expect(services.sessions.subagents.observe({
            observationId: 'worker-native-1',
            status: 'running',
        })).resolves.toMatchObject({ status: 'running' });
        expect(post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/subagents/custody/mutations'),
            expect.objectContaining({
                operationId: expect.stringMatching(/^plugin-subagent-observation-v1:/),
                scope: {
                    pluginId: 'acme.plugin',
                    contributionId: 'assistant',
                    immutableGenerationId: 'immutable-generation-1',
                },
                status: 'running',
                content: { t: 'plain', v: null },
            }),
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }),
        );
        expect(get).toHaveBeenCalledWith(
            expect.stringContaining('/subagents/custody/capability'),
            expect.any(Object),
        );
        expect(services.sessions.external.capabilities().list).toEqual({
            status: 'unavailable',
            code: 'plugin_external_list_unavailable',
        });
        await expect(services.sessions.external.list()).rejects.toMatchObject({
            code: 'plugin_external_list_unavailable',
        });
    });

    it('exposes account session inventory independently from optional interaction presentation custody', () => {
        const services = createNativeAgentSessionServices({
            permissionHandler: null,
            credentials: {
                token: 'account-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            },
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
            isCurrent: () => true,
        });

        expect(services.availability('sessions')).toEqual({ status: 'available' });
        expect(services.sessions.current.availability()).toEqual({ status: 'available' });
    });

    it('does not bind a host interaction when the caller signal is already aborted', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const interactions = createServices(handleToolCall).sessions.current.interactions;
        const controller = new AbortController();
        controller.abort(new Error('caller stopped'));

        await expect(interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-1',
            title: 'Continue?',
            message: 'Continue?',
        }, { signal: controller.signal })).rejects.toThrow('caller stopped');

        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('propagates caller cancellation into the canonical permission request and returns cancelled', async () => {
        const handleToolCall = vi.fn((
            _toolCallId: string,
            _toolName: string,
            _input: unknown,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted at owner')), { once: true });
        }));
        const interactions = createServices(handleToolCall).sessions.current.interactions;
        const controller = new AbortController();

        const pending = interactions.request({
            kind: 'questions',
            requestId: 'questions-cancelled',
            questions: [{
                id: 'language',
                prompt: 'Language?',
                selection: 'text',
                required: true,
                presentation: { inputMode: 'singleLine', whitespace: 'trim', allowEmpty: false },
            }],
        }, { signal: controller.signal });
        controller.abort();

        await expect(pending).resolves.toEqual({ kind: 'questions', status: 'cancelled' });
        expect(handleToolCall).toHaveBeenCalledWith(
            'questions-cancelled',
            'AskUserQuestion',
            expect.anything(),
            expect.objectContaining({
                owner: { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.agent' },
                signal: controller.signal,
            }),
        );
    });

    it('cancels only the affected session interaction when its runtime scope retires', async () => {
        const capturedSignals: AbortSignal[] = [];
        const handleToolCall = vi.fn((
            _toolCallId: string,
            _toolName: string,
            _input: unknown,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => new Promise<never>((_resolve, reject) => {
            const signal = options?.signal;
            if (signal) {
                capturedSignals.push(signal);
                signal.addEventListener('abort', () => reject(new Error('session scope retired')), { once: true });
            }
        }));
        const firstScope = new AbortController();
        const secondScope = new AbortController();
        const firstParams = {
            permissionHandler: { handleToolCall },
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent:first',
            sessionId: 'session-1',
            generationId: 'generation-1',
            isCurrent: () => true,
            signal: firstScope.signal,
        };
        const secondParams = {
            ...firstParams,
            runtimeId: 'acme.agent:second',
            sessionId: 'session-2',
            signal: secondScope.signal,
        };
        const firstPending = createNativeAgentSessionServices(firstParams)
            .sessions.current.interactions.request({
                kind: 'confirmation',
                requestId: 'confirmation-session-1',
                title: 'Continue?',
                message: 'Continue in session one?',
            });
        const secondPending = createNativeAgentSessionServices(secondParams)
            .sessions.current.interactions.request({
                kind: 'confirmation',
                requestId: 'confirmation-session-2',
                title: 'Continue?',
                message: 'Continue in session two?',
            });
        let firstResult: unknown;
        let secondSettled = false;
        void firstPending.then((result) => {
            firstResult = result;
        });
        void secondPending.then(() => {
            secondSettled = true;
        });
        await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalledTimes(2));

        firstScope.abort(new Error('session one disposed'));

        await vi.waitFor(() => expect(firstResult).toEqual({
            kind: 'confirmation',
            status: 'cancelled',
        }), { timeout: 100 });
        expect(capturedSignals).toHaveLength(2);
        expect(capturedSignals[0]!.aborted).toBe(true);
        expect(capturedSignals[1]!.aborted).toBe(false);
        expect(secondSettled).toBe(false);

        secondScope.abort(new Error('session two disposed'));
        await expect(secondPending).resolves.toEqual({
            kind: 'confirmation',
            status: 'cancelled',
        });
    });

    it('propagates tool-approval cancellation into the canonical permission request', async () => {
        const handleToolCall = vi.fn((
            _toolCallId: string,
            _toolName: string,
            _input: unknown,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('approval aborted')), { once: true });
        }));
        const interactions = createServices(handleToolCall).sessions.current.interactions;
        const controller = new AbortController();
        const pending = interactions.request({
            kind: 'approval',
            requestId: 'approval-cancelled',
            title: 'Run Bash?',
            subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
        }, { signal: controller.signal });

        controller.abort();

        await expect(pending).resolves.toEqual({ kind: 'approval', status: 'cancelled' });
        expect(handleToolCall).toHaveBeenCalledWith(
            'approval-cancelled',
            'Bash',
            expect.anything(),
            expect.objectContaining({ signal: controller.signal }),
        );
    });

    it('maps tool approval decisions through the current-session owner with a session-only ceiling', async () => {
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
        const interactions = createServices(handleToolCall).sessions.current.interactions;
        const request: PluginSessionApprovalRequest = {
            kind: 'approval',
            requestId: 'approval-1',
            title: 'Run Bash?',
            description: 'Inspect the working tree',
            subject: { kind: 'tool', name: 'Bash', input: { command: 'git status --short' } },
            allowedPersistenceScopes: ['session'],
        };

        await expect(interactions.request(request)).resolves.toEqual({
            kind: 'approval',
            status: 'approved',
        });
        await expect(interactions.request({ ...request, requestId: 'approval-2' })).resolves.toEqual({
            kind: 'approval',
            status: 'approved',
            effects: {
                persistApprovals: [{ scope: 'session', toolName: 'Bash' }],
            },
        });
        await expect(interactions.request({ ...request, requestId: 'approval-3' })).resolves.toEqual({
            kind: 'approval',
            status: 'denied',
            rationale: 'Read-only mode',
        });
        await expect(interactions.request({ ...request, requestId: 'approval-4' })).resolves.toEqual({
            kind: 'approval',
            status: 'cancelled',
        });
        expect(handleToolCall).toHaveBeenNthCalledWith(
            1,
            'approval-1',
            'Bash',
            {
                title: 'Run Bash?',
                description: 'Inspect the working tree',
                subject: request.subject,
                allowedPersistenceScopes: ['session'],
            },
            expect.objectContaining({
                owner: { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.agent' },
            }),
        );
    });

    it('fails closed when the host exceeds or ambiguously describes the approval ceiling', async () => {
        const request: PluginSessionApprovalRequest = {
            kind: 'approval',
            requestId: 'approval-1',
            title: 'Run Bash?',
            subject: { kind: 'tool', name: 'Bash', input: {} },
        };
        const persisted = createServices(vi.fn(async () => ({
            decision: 'approved_for_session' as const,
        }))).sessions.current.interactions;
        await expect(persisted.request(request)).resolves.toMatchObject({
            kind: 'approval',
            status: 'unavailable',
        });

        const malformed = createServices(vi.fn(async () => ({
            decision: 'denied' as const,
            rationale: 42,
        } as never))).sessions.current.interactions;
        await expect(malformed.request(request)).resolves.toMatchObject({
            kind: 'approval',
            status: 'unavailable',
        });
    });

    it.each([
        { decision: 'approved_for_session' as const },
        { decision: 'approved_execpolicy_amendment' as const, execPolicyAmendment: { command: ['git', 'status'] } },
    ])('does not turn an effect-bearing decision into an effect-free confirmation: $decision', async (decision) => {
        const interactions = createServices(vi.fn(async () => decision)).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-1',
            title: 'Continue?',
            message: 'Continue?',
        })).resolves.toEqual(expect.objectContaining({
            kind: 'confirmation',
            status: 'unavailable',
        }));
    });

    it('does not ignore an exec-policy effect attached to a nominally effect-free approval', async () => {
        const interactions = createServices(vi.fn(async () => ({
            decision: 'approved' as const,
            execPolicyAmendment: { command: ['git', 'status'] },
        }))).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-1',
            title: 'Continue?',
            message: 'Continue?',
        })).resolves.toEqual(expect.objectContaining({
            kind: 'confirmation',
            status: 'unavailable',
        }));
    });

    it('does not accept persistence or exec-policy decisions as question answers', async () => {
        const request: PluginSessionQuestionsRequest = {
            kind: 'questions',
            requestId: 'questions-1',
            questions: [{
                id: 'language',
                prompt: 'Language',
                selection: 'single',
                choices: [{ id: 'ts', label: 'TypeScript' }],
            }],
        };

        for (const decision of ['approved_for_session', 'approved_execpolicy_amendment'] as const) {
            const interactions = createServices(vi.fn(async () => ({
                decision,
                answers: { language: 'ts' },
                ...(decision === 'approved_execpolicy_amendment'
                    ? { execPolicyAmendment: { command: ['git', 'status'] } }
                    : {}),
            }))).sessions.current.interactions;

            await expect(interactions.request(request)).resolves.toEqual(expect.objectContaining({
                kind: 'questions',
                status: 'unavailable',
            }));
        }
    });

    it('preserves a present empty required text answer when the request allows empty text', async () => {
        const handleToolCall = vi.fn(async () => ({
            decision: 'approved' as const,
            answers: { notes: '' },
        }));
        const interactions = createServices(handleToolCall).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'questions',
            requestId: 'questions-1',
            questions: [{
                id: 'notes',
                prompt: 'Notes',
                selection: 'text',
                required: true,
                presentation: {
                    inputMode: 'multiLine',
                    whitespace: 'preserve',
                    allowEmpty: true,
                },
            }],
        })).resolves.toEqual({
            kind: 'questions',
            status: 'answered',
            answers: [{ questionId: 'notes', selection: 'text', value: '' }],
        });
        expect(handleToolCall).toHaveBeenCalledWith(
            'questions-1',
            'AskUserQuestion',
            expect.objectContaining({
                questions: [expect.objectContaining({ id: 'notes', required: true })],
            }),
            expect.anything(),
        );
    });

    it('keeps a comma-bearing choice label as one multiple-choice answer', async () => {
        const interactions = createServices(vi.fn(async () => ({
            decision: 'approved' as const,
            answers: { region: 'Washington, D.C.' },
        }))).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'questions',
            requestId: 'questions-1',
            questions: [{
                id: 'region',
                prompt: 'Region',
                selection: 'multiple',
                choices: [{ id: 'dc', label: 'Washington, D.C.' }],
            }],
        })).resolves.toEqual({
            kind: 'questions',
            status: 'answered',
            answers: [{
                questionId: 'region',
                selection: 'multiple',
                answers: [{ kind: 'choice', choiceId: 'dc' }],
            }],
        });
    });

    it('preserves exact ordered multiple-choice arrays with comma-bearing choices and one custom answer', async () => {
        const interactions = createServices(vi.fn(async () => ({
            decision: 'approved' as const,
            answers: {
                components: ['alpha-beta', 'gamma', 'Custom, other'],
            },
        }))).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'questions',
            requestId: 'questions-1',
            questions: [{
                id: 'components',
                prompt: 'Components',
                selection: 'multiple',
                choices: [
                    { id: 'alpha-beta', label: 'Alpha, Beta' },
                    { id: 'gamma', label: 'Gamma' },
                ],
                allowCustom: true,
            }],
        })).resolves.toEqual({
            kind: 'questions',
            status: 'answered',
            answers: [{
                questionId: 'components',
                selection: 'multiple',
                answers: [
                    { kind: 'choice', choiceId: 'alpha-beta' },
                    { kind: 'choice', choiceId: 'gamma' },
                    { kind: 'custom', value: 'Custom, other' },
                ],
            }],
        });
    });

    it('maps exact one-element arrays for text, single choice, and single custom answers', async () => {
        const interactions = createServices(vi.fn(async () => ({
            decision: 'approved' as const,
            answers: {
                notes: ['Keep Alpha, Beta intact'],
                mode: ['ship'],
                goal: ['Custom, goal'],
            },
        }))).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'questions',
            requestId: 'questions-1',
            questions: [
                {
                    id: 'notes',
                    prompt: 'Notes',
                    selection: 'text',
                    presentation: {
                        inputMode: 'singleLine',
                        whitespace: 'preserve',
                        allowEmpty: false,
                    },
                },
                {
                    id: 'mode',
                    prompt: 'Mode',
                    selection: 'single',
                    choices: [{ id: 'ship', label: 'Ship' }],
                },
                {
                    id: 'goal',
                    prompt: 'Goal',
                    selection: 'single',
                    choices: [{ id: 'template', label: 'Template' }],
                    allowCustom: true,
                },
            ] as const,
        })).resolves.toEqual({
            kind: 'questions',
            status: 'answered',
            answers: [
                {
                    questionId: 'notes',
                    selection: 'text',
                    value: 'Keep Alpha, Beta intact',
                },
                {
                    questionId: 'mode',
                    selection: 'single',
                    answer: { kind: 'choice', choiceId: 'ship' },
                },
                {
                    questionId: 'goal',
                    selection: 'single',
                    answer: { kind: 'custom', value: 'Custom, goal' },
                },
            ],
        });
    });

    it.each([
        ['cyclic subject input', () => {
            const input: Record<string, unknown> = {};
            input.self = input;
            return {
                kind: 'approval', requestId: 'approval-1', title: 'Approve',
                subject: { kind: 'tool', name: 'Bash', input },
            } as PluginSessionApprovalRequest;
        }],
        ['prototype-bearing subject input', () => ({
            kind: 'approval', requestId: 'approval-1', title: 'Approve',
            subject: { kind: 'tool', name: 'Bash', input: new (class BoundaryValue {})() },
        } as unknown as PluginSessionApprovalRequest)],
        ['oversized subject input', () => ({
            kind: 'approval', requestId: 'approval-1', title: 'Approve',
            subject: { kind: 'tool', name: 'Bash', input: 'x'.repeat(256 * 1_024 + 1) },
        } as PluginSessionApprovalRequest)],
    ])('fails closed without presenting a %s', async (_label, buildRequest) => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const interactions = createServices(handleToolCall).sessions.current.interactions;

        await expect(interactions.request(buildRequest())).resolves.toEqual(expect.objectContaining({
            kind: 'approval',
            status: 'unavailable',
        }));
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('does not invoke accessors while validating an interaction request', async () => {
        const getter = vi.fn(() => ({ kind: 'tool', name: 'Bash', input: {} }));
        const request = {
            kind: 'approval',
            requestId: 'approval-1',
            title: 'Approve',
        } as Record<string, unknown>;
        Object.defineProperty(request, 'subject', { enumerable: true, get: getter });
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));

        await expect(createServices(handleToolCall).sessions.current.interactions.request(
            request as unknown as PluginSessionApprovalRequest,
        )).resolves.toEqual(expect.objectContaining({ status: 'unavailable' }));
        expect(getter).not.toHaveBeenCalled();
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('fails closed when a malformed request proxy throws during inspection', async () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));

        await expect(createServices(handleToolCall).sessions.current.interactions.request(
            proxy as PluginSessionApprovalRequest,
        )).resolves.toEqual(expect.objectContaining({ status: 'unavailable' }));
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('turns permission-owner failures into typed unavailability without exposing the exception', async () => {
        const interactions = createServices(vi.fn(async () => {
            throw new Error('sensitive provider failure');
        })).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'approval',
            requestId: 'approval-1',
            title: 'Approve',
            subject: { kind: 'tool', name: 'Bash', input: {} },
        })).resolves.toEqual({
            kind: 'approval',
            status: 'unavailable',
            diagnostic: {
                code: 'agent_session_interaction_unavailable',
                severity: 'error',
                message: 'The current host session interaction failed',
            },
        });
    });

    it('fails closed on accessor-bearing answer records', async () => {
        const getter = vi.fn(() => 'TypeScript');
        const answers = {} as Record<string, string>;
        Object.defineProperty(answers, 'language', { enumerable: true, get: getter });
        const interactions = createServices(vi.fn(async () => ({
            decision: 'approved' as const,
            answers,
        }))).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'questions',
            requestId: 'questions-1',
            questions: [{
                id: 'language',
                prompt: 'Language',
                selection: 'single',
                choices: [{ id: 'ts', label: 'TypeScript' }],
            }],
        })).resolves.toEqual(expect.objectContaining({
            kind: 'questions',
            status: 'unavailable',
        }));
        expect(getter).not.toHaveBeenCalled();
    });

    it('rejects unknown and duplicate answer correlations instead of partially applying them', async () => {
        const request: PluginSessionQuestionsRequest = {
            kind: 'questions',
            requestId: 'questions-1',
            questions: [{
                id: 'language',
                prompt: 'Language',
                selection: 'single',
                choices: [{ id: 'ts', label: 'TypeScript' }],
            }],
        };
        const invalidAnswers: ReadonlyArray<Record<string, string>> = [
            { language: 'ts', unexpected: 'ignored?' },
            { language: 'ts', Language: 'TypeScript' },
        ];
        for (const answers of invalidAnswers) {
            const interactions = createServices(vi.fn(async () => ({
                decision: 'approved' as const,
                answers,
            }))).sessions.current.interactions;

            await expect(interactions.request(request)).resolves.toEqual(expect.objectContaining({
                kind: 'questions',
                status: 'unavailable',
            }));
        }
    });

    it('rejects an interaction identifier with surrounding whitespace before presentation', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const interactions = createServices(handleToolCall).sessions.current.interactions;

        await expect(interactions.request({
            kind: 'approval',
            requestId: ' approval-1 ',
            title: 'Approve',
            subject: { kind: 'tool', name: 'Bash', input: {} },
        })).resolves.toEqual(expect.objectContaining({ status: 'unavailable' }));
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('reports sessions unavailable when the supplied permission owner is not callable', async () => {
        // Boundary fixture deliberately violates the host type to prove runtime availability stays truthful.
        const services = createNativeAgentSessionServices({
            permissionHandler: {} as PermissionHandlerBoundary,
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
        });

        expect(services.availability('sessions')).toEqual(expect.objectContaining({ status: 'unavailable' }));
        await expect(services.sessions.current.interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-1',
            title: 'Continue?',
            message: 'Continue?',
        } as PluginSessionConfirmationRequest)).resolves.toEqual(expect.objectContaining({
            status: 'unavailable',
        }));
    });

    it('fails closed when generation ownership cannot be verified', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const services = createNativeAgentSessionServices({
            permissionHandler: { handleToolCall },
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
        });

        expect(services.availability('sessions')).toEqual(expect.objectContaining({
            status: 'unavailable',
        }));
        await expect(services.sessions.current.interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-unverifiable-generation',
            title: 'Continue?',
            message: 'Continue?',
        })).resolves.toEqual(expect.objectContaining({
            kind: 'confirmation',
            status: 'unavailable',
        }));
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('fences interaction requests after their plugin generation retires', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const services = createNativeAgentSessionServices({
            permissionHandler: { handleToolCall },
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
            isCurrent: () => false,
        });

        await expect(services.sessions.current.interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-1',
            title: 'Continue?',
            message: 'Continue?',
        })).resolves.toEqual(expect.objectContaining({
            kind: 'confirmation',
            status: 'unavailable',
        }));
        expect(handleToolCall).not.toHaveBeenCalled();
    });

    it('fences tool approvals before presentation and after an in-flight generation retires', async () => {
        let current = false;
        let resolveHost!: (value: { decision: 'approved' }) => void;
        const handleToolCall = vi.fn(() => new Promise<{ decision: 'approved' }>((resolve) => {
            resolveHost = resolve;
        }));
        const services = createNativeAgentSessionServices({
            permissionHandler: { handleToolCall },
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
            isCurrent: () => current,
        });
        const request: PluginSessionApprovalRequest = {
            kind: 'approval',
            requestId: 'approval-retired',
            title: 'Run Bash?',
            subject: { kind: 'tool', name: 'Bash', input: {} },
        };

        await expect(services.sessions.current.interactions.request(request)).resolves.toMatchObject({
            kind: 'approval',
            status: 'unavailable',
        });
        expect(handleToolCall).not.toHaveBeenCalled();

        current = true;
        const pending = services.sessions.current.interactions.request({
            ...request,
            requestId: 'approval-retired-in-flight',
        });
        await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalledOnce());
        current = false;
        resolveHost({ decision: 'approved' });
        await expect(pending).resolves.toMatchObject({
            kind: 'approval',
            status: 'unavailable',
        });
    });

    it('does not deliver an interaction result after its plugin generation retires while awaiting the host', async () => {
        let current = true;
        let resolveHost!: (value: { decision: 'approved' }) => void;
        const handleToolCall = vi.fn(() => new Promise<{ decision: 'approved' }>((resolve) => {
            resolveHost = resolve;
        }));
        const services = createNativeAgentSessionServices({
            permissionHandler: { handleToolCall },
            pluginId: 'acme.plugin',
            contributionId: 'acme.agent',
            runtimeId: 'acme.agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
            isCurrent: () => current,
        });
        const pending = services.sessions.current.interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-1',
            title: 'Continue?',
            message: 'Continue?',
        });

        await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalledOnce());
        current = false;
        resolveHost({ decision: 'approved' });

        await expect(pending).resolves.toEqual(expect.objectContaining({
            kind: 'confirmation',
            status: 'unavailable',
        }));
    });

});
