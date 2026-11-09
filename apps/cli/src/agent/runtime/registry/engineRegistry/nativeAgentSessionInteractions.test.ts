import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { NATIVE_TOOL_APPROVAL_REQUEST_SOURCE, NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE } from '@happier-dev/protocol/sessions/permissions/v1';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionClientExecutionRunService } from '@/api/session/client/executionRuns/createSessionClientExecutionRunService';
import { createPluginSessionHandleCapabilitiesFactory } from '@/session/services/pluginSessionHandleCapabilities';
import { applyPermissionModeIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
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

const { callSessionRpc } = vi.hoisted(() => ({ callSessionRpc: vi.fn() }));

// Keep the real execution-run service and permission owner beneath the RPC boundary.
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc }));

function createFixture(
    overrides: Partial<Omit<NativeAgentSessionInteractionParams, 'permissionHandler' | 'sessionId'>> = {},
    options: Readonly<{ mode?: 'default' | 'yolo'; presentationAvailable?: boolean }> = {},
) {
    // Only Session state and the authenticated server RPC transport are replaced.
    // The existing transport testkit stamps the account actor required by permission replies.
    const rpc = new ServerBoundPermissionRpcHandlerManager('session-1');
    const session = createMutableApiSessionClientFixture({
        sessionId: 'session-1',
        overrides: {
            // The transport testkit intentionally implements only registration/delivery.
            rpcHandlerManager: rpc as unknown as ApiSessionClient['rpcHandlerManager'],
        },
    });
    const handler = new ProviderEnforcedPermissionHandler(session, {
        logPrefix: '[Native interaction test]', getWorkspaceWrites: () => 'allow',
    });
    handler.setPermissionMode(options.mode ?? 'default');
    const lifetime = new AbortController();
    const params: NativeAgentSessionInteractionParams = {
        permissionHandler: options.presentationAvailable === false ? null : handler,
        pluginId: 'acme.plugin',
        contributionId: 'acme-agent',
        runtimeId: 'acme.agent/runtime',
        sessionId: session.sessionId,
        occurrenceId: 'occurrence-1',
        immutableGenerationId: 'immutable-generation-1',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-generation-1', installSource: 'npm' },
        interactionDeadlineMs: 1_000,
        isCurrent: () => true,
        signal: lifetime.signal,
        ...overrides,
    };
    const currentSessionUi = createNativeAgentCurrentSessionUiServices(params);
    const publicServices = createNativeAgentSessionServices({ ...params, currentSessionUi });
    onTestFinished(async () => {
        lifetime.abort();
        await handler.abortPendingRequestsAndFlush('test cleanup');
        await session.close();
    });
    return Object.freeze({
        session,
        handler,
        current: currentSessionUi.interactions,
        public: publicServices.interactions,
        sessions: publicServices.sessions,
        availability: publicServices.availability,
        async publishedRequest() {
            await vi.waitFor(() => expect(Object.keys(session.__getAgentState().requests ?? {})).toHaveLength(1));
            const [id, request] = Object.entries(session.__getAgentState().requests ?? {})[0]!;
            return { id, request };
        },
        async respond(input: unknown, kind: 'user_action' | 'permission' = 'user_action') {
            const respond = rpc.handlers.get(kind === 'user_action' ? 'session.user_action.answer' : 'session.permission.respond');
            if (!respond) throw new Error('Expected registered Session response RPC');
            return await respond(input);
        },
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
    it('requires an offered native selection even inside a reviewed parent operation', async () => {
        const fixture = createFixture({ interactionDeadlineMs: undefined });
        const interactions = createPluginInteractionsService({
            currentSession: { interactions: fixture.current },
            reviewedParent: { actionId: 'deployments.deploy', input: {} },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });
        await expect(interactions.requestApproval(approvalRequest)).resolves.toMatchObject({ status: 'approved' });
        const nativeChoices = { requirementId: 'reviewed-native', source: 'test-agent', choices: [{
            id: 'opaque:stop', label: 'Stop', decision: 'abort' as const, scope: 'once' as const,
            response: { approved: false, decision: 'abort' as const },
        }] };
        const pending = interactions.requestApproval({ ...approvalRequest, nativeChoices });
        const { id, request } = await fixture.publishedRequest();
        expect(request.nativeChoices).toEqual(nativeChoices);
        const nativeChoice = { requirementId: 'reviewed-native', choiceId: 'opaque:stop' };
        await fixture.respond({ id, nativeChoice }, 'permission');
        await expect(pending).resolves.toMatchObject({ status: 'userCancelled', nativeChoice });
    });
    it('applies an offered read-only stop through the current Session mode owner', async () => {
        const fixture = createFixture({ interactionDeadlineMs: undefined,
            applyPermissionModeIntent: async permissionMode => {
                fixture.session.updateMetadata(metadata => metadata
                    ? applyPermissionModeIntentSessionMetadata(metadata, { permissionMode, updatedAt: 42 }) : metadata);
            },
        });
        fixture.session.__setMetadata(createTestMetadata({ permissionMode: 'default' }));
        const pending = fixture.current.request({ ...approvalRequest, nativeChoices: {
            requirementId: 'mode-stop', source: 'native-test', choices: [{
                id: 'opaque:stop', label: 'Stop', decision: 'abort', scope: 'once',
                response: { approved: false, decision: 'abort', mode: 'read-only' },
            }],
        } });
        const { id } = await fixture.publishedRequest();
        await fixture.respond({ id, nativeChoice: { requirementId: 'mode-stop', choiceId: 'opaque:stop' } }, 'permission');
        await expect(pending).resolves.toMatchObject({ status: 'userCancelled' });
        expect(fixture.session.__getMetadata()).toMatchObject({ permissionMode: 'read-only' });
    });
    it('keeps custom text equal to a choice label distinct and preserves the answer note', async () => {
        const fixture = createFixture({ interactionDeadlineMs: undefined });
        const pending = fixture.current.request({
            kind: 'questions', title: 'Choose', questions: [{
                id: 'selection', prompt: 'Choose', type: 'multipleChoice', allowCustom: true,
                minSelections: 1, maxSelections: 2, allowNote: true,
                choices: [{ id: 'selected', label: 'Selected' }, { id: 'other', label: 'Custom text' }],
            }],
        });
        const { id, request } = await fixture.publishedRequest();
        expect(request.arguments).toMatchObject({ questions: [{ minSelections: 1, maxSelections: 2, allowNote: true }] });
        await fixture.respond({ id, approved: true, answers: { selection: ['selected'] },
            answerDetails: { selection: { freeText: 'Custom text', note: 'Additional context' } } });
        await expect(pending).resolves.toMatchObject({ kind: 'questions', status: 'answered', answers: {
            selection: { kind: 'multipleChoice', answers: [
                { kind: 'choice', choiceId: 'selected' }, { kind: 'custom', value: 'Custom text' },
            ], note: 'Additional context' },
        } });
    });

    it('accepts a note without selections when the question explicitly permits zero', async () => {
        const fixture = createFixture({ interactionDeadlineMs: undefined });
        const pending = fixture.current.request({ kind: 'questions', questions: [{
            id: 'selection', prompt: 'Choose', type: 'multipleChoice', minSelections: 0,
            allowNote: true, choices: [{ id: 'selected', label: 'Selected' }],
        }] });
        const { id } = await fixture.publishedRequest();
        await fixture.respond({ id, approved: true, answers: { selection: [] },
            answerDetails: { selection: { note: 'None apply' } } });
        await expect(pending).resolves.toMatchObject({ kind: 'questions', status: 'answered', answers: {
            selection: { kind: 'multipleChoice', answers: [], note: 'None apply' },
        } });
    });

    it.each([
        { decision: 'abort', status: 'userCancelled' },
        { decision: 'denied', status: 'declined' },
        { decision: 'approved', status: 'approved' },
        { decision: 'approved_execpolicy_amendment', status: 'approved' },
    ] as const)('preserves an offered native choice through canonical permission settlement ($decision)', async ({ decision, status }) => {
        const fixture = createFixture({ interactionDeadlineMs: undefined });
        const nativeChoices = { requirementId: 'native-occurrence', source: 'test-agent', choices: [{
            id: 'opaque:selection', label: 'Native selection', decision,
            scope: decision === 'approved_execpolicy_amendment' ? 'localPersistent' as const : 'once' as const,
            response: { approved: decision === 'approved' || decision === 'approved_execpolicy_amendment', decision,
                ...(decision === 'approved_execpolicy_amendment' ? { execPolicyAmendment: { command: ['git', 'fetch'] } } : {}),
            },
        }] };
        const pending = fixture.current.request({ ...approvalRequest, nativeChoices });
        const { id, request } = await fixture.publishedRequest();
        expect(request.nativeChoices).toEqual(nativeChoices);
        const nativeChoice = { requirementId: 'native-occurrence', choiceId: 'opaque:selection' };
        await fixture.respond({ id, nativeChoice }, 'permission');
        await expect(pending).resolves.toMatchObject({ kind: 'approval', status, nativeChoice });
    });
    it('escalates a public permission request containing a Date mutated during the reviewer wait', async () => {
        const fixture = createFixture({ interactionDeadlineMs: undefined });
        fixture.session.__setMetadata(createTestMetadata({ approvalReviewerEnabled: true }));
        Object.assign(fixture.session, { executionRuns: createSessionClientExecutionRunService({
            token: 'test-token', sessionId: fixture.session.sessionId, serverUrl: 'https://home.example.test',
            getStoredContentCryptoContext: () => ({ mode: 'plain', ctx: null }),
        }) });
        const lifetime = new AbortController();
        onTestFinished(() => lifetime.abort());
        const live = { scopeId: Symbol('public-permissions'), permissionHandler: fixture.handler,
            readPermissionMode: () => fixture.handler.getPermissionMode() };
        const capabilities = createPluginSessionHandleCapabilitiesFactory({
            credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            caller: { pluginId: 'acme.plugin', contributionId: 'acme-agent',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'generation', installSource: 'npm' } },
            signal: lifetime.signal, isCurrent: () => true, readAgentId: async () => 'codex',
            resolveLiveCapabilities: () => live,
        })(fixture.session.sessionId);
        const date = new Date('2026-01-01T00:00:00.000Z');
        callSessionRpc.mockReset();
        callSessionRpc.mockResolvedValueOnce({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-chain' });
        callSessionRpc.mockImplementationOnce(async () => {
            date.setUTCFullYear(2027);
            return { ok: true, status: 'succeeded', result: {
                run: { runId: 'review-run', callId: 'review-call', sidechainId: 'review-chain', intent: 'task',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'no_tools',
                    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                    status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
                latestToolResult: { decision: 'allow_once' },
            } };
        });
        const permissions = capabilities.permissions;
        if (!permissions) throw new Error('Expected public Session permissions');
        const pending = permissions.requestDecision({ toolCallId: 'opaque-date', toolName: 'Bash',
            source: NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE, input: { command: 'pwd', modifiedSince: date } });
        void pending.catch(() => undefined);
        await fixture.publishedRequest();
        await expect(fixture.handler.respondAsApprovalReviewer('opaque-date')).resolves.toBe('escalate');
        expect(fixture.session.__getAgentState().requests?.['opaque-date']).toBeDefined();
        expect(fixture.session.__getAgentState().requests?.['opaque-date']).not.toHaveProperty('permissionResponseClaimV1');
        expect(fixture.session.__getAgentState().completedRequests?.['opaque-date']).toBeUndefined();
    });

    it.each(['native', 'plugin'] as const)('applies a reviewer allow-once to a real %s approval without granting future permission', async surface => {
        const fixture = createFixture({ interactionDeadlineMs: undefined });
        fixture.session.__setMetadata(createTestMetadata({ approvalReviewerEnabled: true }));
        Object.assign(fixture.session, { executionRuns: createSessionClientExecutionRunService({
            token: 'test-token', sessionId: fixture.session.sessionId, serverUrl: 'https://home.example.test',
            getStoredContentCryptoContext: () => ({ mode: 'plain', ctx: null }),
        }) });
        const reply = createDeferred<unknown>();
        callSessionRpc.mockReset();
        callSessionRpc.mockResolvedValueOnce({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-chain' });
        callSessionRpc.mockImplementationOnce(() => reply.promise);
        const request: HostSessionApprovalRequest = { ...approvalRequest,
            subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } } };
        const pending = surface === 'native'
            ? fixture.current.request(request, { permissionContext: { turnId: 'reviewed-turn',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } })
            : fixture.public.requestApproval(request);
        const { id } = await fixture.publishedRequest();
        await vi.waitFor(() => expect(callSessionRpc).toHaveBeenCalledTimes(2));
        reply.resolve({ ok: true, status: 'succeeded', result: {
            run: { runId: 'review-run', callId: 'review-call', sidechainId: 'review-chain', intent: 'task',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'no_tools',
                retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
            latestToolResult: { decision: 'allow_once' },
        } });
        await expect(fixture.handler.respondAsApprovalReviewer(id)).resolves.toBe('allow_once');
        await expect(pending).resolves.toMatchObject({ kind: 'approval', status: 'approved', persistence: 'once' });
        const completed = fixture.session.__getAgentState().completedRequests?.[id];
        expect(completed).toMatchObject({ decision: 'approved',
            permissionDecisionClaimV1: { origin: 'approvalReviewer', decision: 'approved', scope: 'request',
                ...(surface === 'native' ? { turnId: 'reviewed-turn' } : {}) },
            permissionDecisionActorV1: { kind: 'approvalReviewer' },
        });
        expect(fixture.session.__getAgentState().requests?.[id]).toBeUndefined();
        expect(completed).not.toHaveProperty('allowedTools');
        expect(completed).not.toHaveProperty('updatedPermissions');
        expect(callSessionRpc).toHaveBeenCalledTimes(2);
    });

    it.each(['default', 'yolo'] as const)(
        'requires explicit confirmation answers through the real permission owner in %s mode',
        async (mode) => {
            const fixture = createFixture({}, { mode });
            for (const [choice, status] of [
                ['confirm', 'approved'], ['decline', 'declined'], ['denied', 'declined'], ['abort', 'userCancelled'],
            ] as const) {
                const pending = fixture.current.request({ kind: 'confirmation', message: 'Continue?' }, {
                    permissionContext: {
                        turnId: 'turn-1',
                        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: mode },
                    },
                });
                const { id, request } = await fixture.publishedRequest();
                expect(request).toMatchObject({
                    tool: 'AskUserQuestion', kind: 'user_action', turnId: 'turn-1',
                    arguments: {
                        questions: [{
                            id: 'confirmation', question: 'Continue?', required: true,
                            selection: 'single',
                            options: [{ id: 'confirm', label: 'Confirm' }, { id: 'decline', label: 'Cancel' }],
                        }],
                    },
                });
                const answered = choice === 'confirm' || choice === 'decline';
                await expect(fixture.respond({
                    id, approved: answered, decision: answered ? 'approved' : choice,
                    ...(answered ? { answers: { confirmation: [choice] } } : {}),
                })).resolves.toBeUndefined();
                await expect(pending).resolves.toMatchObject({ kind: 'confirmation', status });
                expect(fixture.session.__getAgentState().requests).toEqual({});
            }
        },
    );

    it('presents through the permission owner without a caller-supplied deadline', async () => {
        const fixture = createFixture({ interactionDeadlineMs: undefined });
        expect(fixture.availability('interactions')).toEqual({ status: 'available' });
        const pending = fixture.public.confirm({ kind: 'confirmation', message: 'Continue?' });
        const { id, request } = await fixture.publishedRequest();
        expect(request).toMatchObject({ tool: 'AskUserQuestion', kind: 'user_action' });
        await expect(fixture.respond({ id, approved: true, answers: { confirmation: ['confirm'] } })).resolves.toBeUndefined();
        await expect(pending).resolves.toEqual({ requestId: id, kind: 'confirmation', status: 'approved' });
        expect(fixture.session.__getAgentState().completedRequests?.[id]).toMatchObject({ status: 'approved' });
    });

    it('fails closed when a caller supplies a malformed deadline', async () => {
        const fixture = createFixture({ interactionDeadlineMs: 0 });
        expect(fixture.availability('interactions')).toEqual({ status: 'unavailable', code: 'plugin_service_unavailable' });
        await expect(fixture.public.confirm({ kind: 'confirmation', message: 'Continue?' })).resolves.toMatchObject({
            kind: 'confirmation', status: 'unavailable',
        });
        expect(fixture.session.__getAgentState().requests ?? {}).toEqual({});
        expect(fixture.session.__getAgentState().completedRequests ?? {}).toEqual({});
    });

    it('keeps Session inventory available while transient presentation is unavailable', async () => {
        const fixture = createFixture({
            credentials: { token: 'account-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        }, { presentationAvailable: false });
        expect(fixture.availability('sessions')).toEqual({ status: 'available' });
        expect(fixture.availability('interactions')).toEqual({ status: 'unavailable', code: 'plugin_service_unavailable' });
        await expect(fixture.public.requestApproval(approvalRequest)).resolves.toMatchObject({
            kind: 'approval', status: 'unavailable',
        });
        expect(fixture.session.__getAgentState().requests ?? {}).toEqual({});
    });

    it('maps real approval RPC outcomes into the strict result vocabulary and session ceiling', async () => {
        for (const [decision, status, persistence] of [
            ['approved', 'approved', 'once'], ['denied', 'declined', undefined],
            ['abort', 'userCancelled', undefined], ['approved_for_session', 'approved', 'session'],
        ] as const) {
            const fixture = createFixture();
            const pending = fixture.public.requestApproval(approvalRequest);
            const { id, request } = await fixture.publishedRequest();
            expect(request).toMatchObject({ tool: 'Bash', kind: 'permission', arguments: approvalRequest.subject.input });
            await expect(fixture.respond({
                id, approved: status === 'approved', decision,
            }, 'permission')).resolves.toBeUndefined();
            await expect(pending).resolves.toMatchObject({ kind: 'approval', status, ...(persistence ? { persistence } : {}) });
            expect(fixture.session.__getAgentState().requests).toEqual({});
        }
    });

    it('rejects reusable authority outside the author-requested approval ceiling before settling', async () => {
        const fixture = createFixture();
        const pending = fixture.public.requestApproval({ ...approvalRequest, allowSessionPersistence: undefined });
        const { id } = await fixture.publishedRequest();
        await expect(fixture.respond({ id, approved: true, decision: 'approved_for_session' }, 'permission')).resolves.toMatchObject({
            ok: false, errorCode: 'permission_response_invalid', requestId: id,
        });
        expect(fixture.session.__getAgentState().requests?.[id]).toBeDefined();
        expect(fixture.session.__getAgentState().completedRequests?.[id]).toBeUndefined();
        await expect(fixture.respond({ id, approved: true, decision: 'approved' }, 'permission')).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ kind: 'approval', status: 'approved', persistence: 'once' });
    });

    it('projects questions and maps exact real RPC answers without splitting comma-bearing values', async () => {
        const fixture = createFixture();
        const pending = fixture.public.askQuestions(questionsRequest);
        const { id, request } = await fixture.publishedRequest();
        expect(request).toMatchObject({
            tool: 'AskUserQuestion', kind: 'user_action',
            arguments: {
                title: 'Configure release',
                questions: [
                    { id: 'notes', question: 'Notes', required: true, selection: 'text', presentation: { initialValue: 'Existing notes' } },
                    { id: 'components', question: 'Components', selection: 'multiple',
                        options: [{ id: 'alpha-beta', label: 'Alpha, Beta' }, { id: 'gamma', label: 'Gamma' }], allowCustom: true },
                ],
            },
        });
        await expect(fixture.respond({ id, approved: true, answers: {
            notes: ['Keep Alpha, Beta intact'], components: ['alpha-beta', 'gamma', 'Custom, other'],
        } })).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({
            kind: 'questions', status: 'answered',
            answers: {
                notes: { kind: 'text', value: 'Keep Alpha, Beta intact' },
                components: { kind: 'multipleChoice', answers: [
                    { kind: 'choice', choiceId: 'alpha-beta' }, { kind: 'choice', choiceId: 'gamma' },
                    { kind: 'custom', value: 'Custom, other' },
                ] },
            },
        });
    });

    it('settles a dismissed question without answers or a pending user action', async () => {
        const fixture = createFixture();
        const pending = fixture.public.askQuestions(questionsRequest);
        const { id } = await fixture.publishedRequest();

        await expect(fixture.respond({ id, approved: false, decision: 'denied' })).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ kind: 'questions', status: 'userCancelled' });
        expect(fixture.session.__getAgentState().requests?.[id]).toBeUndefined();
        expect(fixture.session.__getAgentState().completedRequests?.[id]).toMatchObject({ status: 'denied' });
    });

    it('rejects missing required or unknown real question answers without consuming the request', async () => {
        for (const answers of [
            {}, { notes: ['note'], components: ['gamma'], unknown: ['ignored?'] },
        ]) {
            const fixture = createFixture();
            const pending = fixture.public.askQuestions(questionsRequest);
            const { id } = await fixture.publishedRequest();
            await expect(fixture.respond({ id, approved: true, answers })).resolves.toMatchObject({
                ok: false, errorCode: 'permission_response_invalid', requestId: id,
            });
            expect(fixture.session.__getAgentState().requests?.[id]).toBeDefined();
            expect(fixture.session.__getAgentState().completedRequests?.[id]).toBeUndefined();
            await expect(fixture.respond({ id, approved: true, answers: {
                notes: ['Valid notes'], components: ['gamma'],
            } })).resolves.toBeUndefined();
            await expect(pending).resolves.toMatchObject({ kind: 'questions', status: 'answered' });
        }
    });

    it('fails closed on empty required text at the transient interaction settlement boundary', async () => {
        const fixture = createFixture();
        const pending = fixture.public.askQuestions(questionsRequest);
        const { id } = await fixture.publishedRequest();
        // Structured answer normalization permits the string shape; the transient
        // contract validates required text before accepting the presenter result.
        await expect(fixture.respond({ id, approved: true, answers: {
            notes: [''], components: ['gamma'],
        } })).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ kind: 'questions', status: 'unavailable' });
    });

    it('rejects malformed decisions, duplicate answers, and effect-bearing user-action replies without settling', async () => {
        const fixture = createFixture();
        const pending = fixture.public.confirm({ kind: 'confirmation', title: 'Continue?', message: 'Continue with the operation?' });
        const { id, request } = await fixture.publishedRequest();
        expect(request.arguments).toMatchObject({ title: 'Continue?' });
        for (const fields of [
            { decision: 42 }, { decision: 'mystery' },
            { execPolicyAmendment: { command: ['git', 'status'] } },
            { answers: { confirmation: ['confirm', 'confirm'] } },
        ]) {
            await expect(fixture.respond({ id, approved: true, answers: { confirmation: ['confirm'] }, ...fields })).resolves.toMatchObject({
                ok: false, errorCode: 'permission_response_invalid', requestId: id,
            });
            expect(fixture.session.__getAgentState().requests?.[id]).toBeDefined();
            expect(fixture.session.__getAgentState().completedRequests?.[id]).toBeUndefined();
        }
        await expect(fixture.respond({ id, approved: true, answers: { confirmation: ['confirm'] } })).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ kind: 'confirmation', status: 'approved' });
    });

    it('rejects answerless or reusable confirmation results from the real permission owner', async () => {
        for (const fields of [
            {}, { decision: 'approved_for_session', answers: { confirmation: ['confirm'] } },
        ]) {
            const fixture = createFixture();
            const pending = fixture.public.confirm({ kind: 'confirmation', message: 'Continue?' });
            const { id } = await fixture.publishedRequest();
            await expect(fixture.respond({ id, approved: true, ...fields })).resolves.toMatchObject({
                ok: false, errorCode: 'permission_response_invalid', requestId: id,
            });
            expect(fixture.session.__getAgentState().requests?.[id]).toBeDefined();
            expect(fixture.session.__getAgentState().completedRequests?.[id]).toBeUndefined();
            await expect(fixture.respond({ id, approved: true, answers: { confirmation: ['confirm'] } })).resolves.toBeUndefined();
            await expect(pending).resolves.toMatchObject({ kind: 'confirmation', status: 'approved' });
        }
    });

    it('settles an already-aborted caller without presenting it', async () => {
        const fixture = createFixture();
        const caller = new AbortController();
        caller.abort(new Error('caller stopped'));
        await expect(fixture.public.confirm({ kind: 'confirmation', message: 'Continue?' }, { signal: caller.signal })).resolves.toMatchObject({
            kind: 'confirmation', status: 'requesterAborted',
        });
        expect(fixture.session.__getAgentState().requests ?? {}).toEqual({});
        expect(fixture.session.__getAgentState().completedRequests ?? {}).toEqual({});
    });

    it('distinguishes requester abort, session end, and occurrence retirement after real presentation', async () => {
        for (const status of ['requesterAborted', 'sessionEnded', 'occurrenceRetired'] as const) {
            const session = new AbortController();
            const requester = new AbortController();
            let current = true;
            const fixture = createFixture({ signal: session.signal, isCurrent: () => current });
            const pending = fixture.current.request({ kind: 'confirmation', message: 'Continue?' }, { signal: requester.signal });
            const { id } = await fixture.publishedRequest();
            if (status === 'requesterAborted') requester.abort();
            else {
                current = status !== 'occurrenceRetired';
                session.abort();
            }
            await expect(pending).resolves.toMatchObject({ status });
            expect(fixture.session.__getAgentState().requests?.[id]).toMatchObject({
                kind: 'user_action', questionV1: { mode: 'wait', lasting: false },
            });
            expect(fixture.session.__getAgentState().completedRequests?.[id]).toBeUndefined();
        }
    });

    it('fences before presentation and after an in-flight occurrence retires', async () => {
        let current = false;
        const fixture = createFixture({ isCurrent: () => current });
        const request: HostSessionConfirmationRequest = { kind: 'confirmation', message: 'Continue?' };
        await expect(fixture.current.request(request)).resolves.toMatchObject({ status: 'occurrenceRetired' });
        expect(fixture.session.__getAgentState().requests ?? {}).toEqual({});
        current = true;
        const pending = fixture.current.request(request);
        const { id } = await fixture.publishedRequest();
        current = false;
        await expect(fixture.respond({ id, approved: true, answers: { confirmation: ['confirm'] } })).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ status: 'occurrenceRetired' });
    });

    it('host-stamps requester attribution and isolates real session grants by plugin and invocation', async () => {
        const fixture = createFixture();
        const requester = { pluginId: 'caller.plugin', contributionId: 'caller-action', occurrenceId: 'caller-occurrence', invocationId: 'native-agent-runtime' };
        const pending = fixture.current.request(approvalRequest, { requester });
        const { id } = await fixture.publishedRequest();
        await expect(fixture.respond({ id, approved: true, decision: 'approved_for_session' }, 'permission')).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ status: 'approved', persistence: 'session' });
        await expect(fixture.current.request(approvalRequest, { requester })).resolves.toMatchObject({ status: 'approved', persistence: 'session' });
        expect(fixture.session.__getAgentState().requests).toEqual({});
        for (const otherRequester of [
            { ...requester, pluginId: 'other.plugin' }, { ...requester, invocationId: 'other-runtime' },
        ]) {
            const other = fixture.current.request(approvalRequest, { requester: otherRequester });
            const { id: otherId } = await fixture.publishedRequest();
            await expect(fixture.respond({ id: otherId, approved: false, decision: 'denied' }, 'permission')).resolves.toBeUndefined();
            await expect(other).resolves.toMatchObject({ status: 'declined' });
        }
    });

    it('fails closed on strict request violations without creating a permission request', async () => {
        const fixture = createFixture();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        for (const request of [
            { ...approvalRequest, requestId: 'author-must-not-supply-this' },
            { ...approvalRequest, subject: { kind: 'tool', name: 'Bash', input: cyclic } },
            { ...approvalRequest, subject: { kind: 'tool', name: 'Bash', input: 'x'.repeat(256 * 1_024 + 1) } },
            proxy,
        ]) {
            await expect(fixture.current.request(request as HostSessionApprovalRequest)).resolves.toMatchObject({ status: 'unavailable' });
        }
        expect(fixture.session.__getAgentState().requests ?? {}).toEqual({});
        expect(fixture.session.__getAgentState().completedRequests ?? {}).toEqual({});
    });

    it('turns a Session metadata-read failure into typed unavailability without leaking diagnostics', async () => {
        const fixture = createFixture();
        const readMetadata = fixture.session.getMetadataSnapshot.bind(fixture.session);
        let failed = false;
        fixture.session.getMetadataSnapshot = () => {
            if (!failed) {
                failed = true;
                throw new Error('sensitive Session persistence failure');
            }
            return readMetadata();
        };
        await expect(fixture.public.requestApproval(approvalRequest)).resolves.toEqual({
            requestId: expect.any(String), kind: 'approval', status: 'unavailable',
        });
        expect(fixture.session.__getAgentState().requests ?? {}).toEqual({});
    });
});


describe('observed native tool approval through the existing permission owner', () => {
    it.each([
        { decision: 'approved', allowSessionPersistence: false, source: NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE, name: 'Bash' },
        { decision: 'denied', allowSessionPersistence: false, source: NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE, name: 'Bash' },
        { decision: 'approved', allowSessionPersistence: true, source: NATIVE_TOOL_APPROVAL_REQUEST_SOURCE, name: 'mcp__docs__query' },
        { decision: 'denied', allowSessionPersistence: true, source: NATIVE_TOOL_APPROVAL_REQUEST_SOURCE, name: 'mcp__docs__query' },
    ] as const)('records actual $decision for $name without granting a later request', async ({ decision, allowSessionPersistence, source, name }) => {
        const fixture = createFixture({
            interactionDeadlineMs: undefined,
            credentials: { token: 'fixture-account-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        });
        const pending = fixture.public.requestApproval({
            ...approvalRequest,
            subject: { ...approvalRequest.subject, name, toolCallId: 'native-tool-A' },
            allowSessionPersistence,
        });
        const { id, request } = await fixture.publishedRequest();
        expect(id).toBe('native-tool-A');
        expect(request).toMatchObject({ source,
            owner: { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.agent/runtime' } });
        const permissions = fixture.sessions.current?.permissions;
        if (!permissions?.settleObservedDecision) throw new Error('Expected native settlement capability');
        await expect(permissions.settleObservedDecision({ requestId: id, source: 'unrelated-source', decision })).resolves.toBe(false);
        await expect(permissions.settleObservedDecision({ requestId: id, source, decision })).resolves.toBe(true);
        await expect(pending).resolves.toMatchObject({ kind: 'approval', status: decision === 'approved' ? 'approved' : 'declined' });
        expect(fixture.session.__getAgentState().completedRequests?.[id]).toMatchObject({ status: decision, decision });
        expect(fixture.session.__getAgentState().requests?.[id]).toBeUndefined();

        const later = fixture.public.requestApproval({
            ...approvalRequest,
            subject: { ...approvalRequest.subject, name, toolCallId: 'native-tool-B' },
            allowSessionPersistence,
        });
        const next = await fixture.publishedRequest();
        expect(next.id).toBe('native-tool-B');
        expect(fixture.session.__getAgentState().completedRequests?.[next.id]).toBeUndefined();
        await fixture.respond({ id: next.id, approved: false, decision: 'denied' }, 'permission');
        await expect(later).resolves.toMatchObject({ kind: 'approval', status: 'declined' });
    });
});


it('settles a runtime-native question through the guarded public Session handle', async () => {
    const fixture = createFixture({
        interactionDeadlineMs: undefined,
        credentials: { token: 'fixture-account-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    });
    const permissions = fixture.sessions.current?.permissions;
    if (!permissions?.settleObservedDecision) throw new Error('Expected native settlement capability');
    const source = 'fixture.native.question';
    const pending = permissions.requestDecision({
        requestId: 'native-question-A', source, toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    });
    const { id, request } = await fixture.publishedRequest();
    expect(id).toBe('native-question-A');
    expect(request).toMatchObject({ source, lifetime: 'occurrence', kind: 'user_action' });
    const answers = { 'Continue?': ['No'] };
    const answerDetails = { 'Continue?': { note: 'Answered in the native terminal' } };
    await expect(permissions.settleObservedDecision({ requestId: id, source, decision: 'approved', answers, answerDetails })).resolves.toBe(true);
    await expect(pending).resolves.toEqual({ decision: 'approved', answers, answerDetails });
    expect(fixture.session.__getAgentState().completedRequests?.[id]).toMatchObject({ status: 'approved', structuredAnswersV1: answers, answerDetails });
});
