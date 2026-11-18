import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ExecutionRunPermissionRespondInputSchema } from '@happier-dev/protocol/actions/specs/executionRuns';
import { buildSessionUserActionAnswerMap, buildSessionUserActionAnswerDetails, buildSessionUserActionAnswerItems } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { createExecutionRunHostBackendFromConversationRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentExecutionRunRuntimeContextV1, AgentExecutionRunConversationEventV1, AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import type { AgentState } from '@/api/types';
import { reloadConfiguration } from '@/configuration';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveExecutionRunRoleV1 } from '@/agent/executionRuns/profiles/review/reviewRole';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';

const backendId = 'acme.review/agents/default';
const agent: ResolvedAgentContribution = {
    id: backendId, pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
    identity: { pluginId: 'acme.review', localId: 'default' },
    definition: { kindVersion: 1, id: backendId, ownedBackendIds: [] },
    richDefinition: { provenance: 'external', definition: PluginAgentContributionV2Schema.parse({
        id: 'default', title: { key: 'review.title', fallback: 'Reviewer' },
        description: { key: 'review.description', fallback: 'Review fixture' },
        runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { sessions: {
            open: ['create', 'resume'], delivery: ['newTurn'], cancel: true,
            workspaceWrites: 'deny', executionRunContext: { versions: [1] },
        } },
    }) },
};

describe('native review clarification through the Run and Action owners', () => {
    let directory: string;
    let pluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    beforeAll(async () => {
        pluginRuntime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    });
    afterAll(async () => { await pluginRuntime?.dispose(); });
    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'happier-review-questions-'));
        vi.stubEnv('HAPPIER_HOME_DIR', directory);
        reloadConfiguration();
    });
    afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); rmSync(directory, { recursive: true, force: true }); });

    it.each([
        ...(['detached', 'attached'] as const).flatMap(scope => (['answer', 'freeText', 'reject', 'stop'] as const)
            .map(completion => ({ scope, completion, runClass: 'bounded' as const }))),
        ...(['detached', 'attached'] as const).map(scope => ({ scope, completion: 'answer' as const, runClass: 'long_lived' as const })),
    ])('delivers a $scope $runClass reviewer $completion without authorizing writes', async ({ scope, completion, runClass }) => {
        let state: AgentState = {};
        const publications: string[] = [];
        let attachedStore: AgentStateRequestStore | null = null;
        const session = createMutableApiSessionClientFixture({ sessionId: 'cmwec73r300gamcvijq3b0p9z',
            metadata: createTestMetadata({ path: directory, machineId: 'machine', permissionMode: 'read_only' }),
            overrides: { bindAgentStateRequestStore: value => { attachedStore = value; }, getAgentStateRequestStore: () => attachedStore } });
        const readState = () => scope === 'attached' ? session.getAgentStateSnapshot() ?? {} : state;
        const recordPublications = () => {
            for (const id of Object.keys(readState().requests ?? {})) if (!publications.includes(id)) publications.push(id);
        };
        const updateSession = session.updateAgentState.bind(session);
        vi.spyOn(session, 'updateAgentState').mockImplementation(async update => { await updateSession(update); recordPublications(); });
        const parentPermissions = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[review-parent]' });
        const detachedStore = new AgentStateRequestStore({ logPrefix: '[review-question]', target: {
            scopeId: 'review-input', readState: () => state,
            updateState: async update => {
                state = update(state);
                recordPublications();
            },
        } });
        const readStore = () => scope === 'attached' ? attachedStore : detachedStore;
        const decisions: unknown[] = [];
        const openConversation = async (_request: unknown, context: Pick<AgentExecutionRunRuntimeContextV1, 'services'>) => {
            let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
            return {
                watch(next: (event: AgentExecutionRunConversationEventV1) => void) { listener = next; return { dispose() { listener = undefined; } }; },
                async send(input: { delivery: { turnId: string } }) {
                    listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                    void (async () => {
                    decisions.push(await context.services.interactions.askQuestions({ kind: 'questions', title: 'Review scope',
                        questions: completion === 'freeText'
                            ? [{ id: 'scope', prompt: 'Which files should I review?', type: 'singleChoice', required: true,
                                choices: [{ id: 'src', label: 'Source' }], allowCustom: true, allowNote: true }]
                            : [{ id: 'scope', prompt: 'Which files should I review?', type: 'text', required: true }] }));
                    decisions.push(await context.services.interactions.requestApproval({ kind: 'approval', title: 'Write workspace',
                        subject: { kind: 'tool', name: 'Write', input: { path: join(directory, 'unsafe.ts'), content: 'unsafe' } } }));
                    decisions.push(await context.services.interactions.requestApproval({ kind: 'approval', title: 'Approve a tool',
                        subject: { kind: 'tool', name: 'AskUserQuestion', input: {} } }));
                    listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant',
                        text: JSON.stringify({ summary: 'Review finished', findings: [],
                            questions: [{ id: 'final-question', text: 'Confirm the review conclusions?', status: 'open' }] }) });
                    listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                    })().catch(error => listener?.({ kind: 'turn-failed', turnId: input.delivery.turnId,
                        diagnostic: { code: 'review_fixture_failed', message: String(error), severity: 'error' } }));
                    return { status: 'admitted' as const };
                },
                async dispose() {},
            };
        };
        // Only the external Agent SDK is replaced. Registry, profile, native adapter,
        // Run, request-store and Action response dispatch below are production owners.
        const runtime: AgentRuntime = { sessions: {
            async open(request, context) {
                if (scope !== 'attached') throw new Error('Detached review must not open a Session');
                const conversation = await openConversation(request, context);
                let next: ((event: AgentSessionRuntimeEvent) => void) | undefined;
                let sequence = 0;
                const base = () => ({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now() });
                return {
                    watch(listener) { next = listener; return conversation.watch(event => {
                        if (event.kind === 'turn-start' || event.kind === 'message-delta' || event.kind === 'turn-complete' || event.kind === 'turn-failed') {
                            listener({ ...event, ...base() });
                        }
                    }); },
                    async send(input) {
                        next?.({ ...base(), kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                        return conversation.send(input);
                    },
                    async cancel(input) { next?.({ ...base(), kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason });
                        return { status: 'requested', turnId: input.turnId }; },
                    dispose: conversation.dispose,
                };
            },
            executionRunContextV1: {
                open: async (request, context) => createExecutionRunHostBackendFromConversationRuntime({ request,
                    openConversation: () => openConversation(request, context) }),
                openConversation,
            },
        } };
        const engineRegistry = await resolveCliEngineRegistry({ backendId, runnerAgentSessionRuntimeSource: {
            agentContribution: agent,
            identity: { pluginId: 'acme.review', pluginVersion: '1.0.0', agentId: backendId, backendId,
                occurrenceId: 'review-sdk', sourceCustody: { kind: 'development', registeredRootId: directory }, isCurrent: () => true },
            createRuntime: async () => runtime,
            createInvocationServices: async context => ({ ...createUnavailablePluginServices(),
                interactions: createPluginInteractionsService({ currentSession: context.session?.current ?? null,
                    signal: context.signal, isOccurrenceCurrent: context.isOccurrenceCurrent,
                    ...(context.readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness: context.readActiveTurnAdmissionWitness } : {}) }),
            }),
            authorizeNewTurn: async () => ({ status: 'admitted' }),
        } });
        const manager = new ExecutionRunHostBridge({ parentProvider: backendId, cwd: directory, sendAcp: async () => {},
            resolveRunReportPolicy: async () => ({ preset: 'important' }),
            resolveAccountSettings: async () => ({}),
            ...(scope === 'attached' ? { getPermissionRequestStore: readStore,
                sessionInteractionHost: { session, machineId: 'machine', permissionHandler: parentPermissions,
                    readAppliedChildSelection: async () => ({ status: 'applied' as const,
                        backendTarget: { kind: 'builtInAgent' as const, agentId: backendId }, modelId: null, connectedServices: null }) } } : {}),
            resolveExecutionRunProfileCatalog: () => ({ profileCatalog: buildExecutionRunProfileCatalog([]), engineRegistry }) });
        const startReview = () => manager.start({ sessionId: scope === 'attached' ? session.sessionId : null, intent: 'review', instructions: 'Review the code',
            backendTarget: { kind: 'builtInAgent', agentId: backendId }, modelSelection: null,
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass,
            ioMode: runClass === 'bounded' ? 'request_response' : 'streaming',
            ...(runClass === 'long_lived' ? { initialInput: { kind: 'deferred_session_pending' as const } } : {}),
            resolvedRole: resolveExecutionRunRoleV1({ roleId: 'reviewer', accountRoleOverrides: { status: 'ready', overrides: {} } }),
            localInputId: 'review-input', getPermissionRequestStore: readStore });
        try {
            const started = await startReview();
            if (runClass === 'long_lived') {
                expect(await manager.send(started.runId, { message: 'Review the code', localInputId: 'review-input',
                    permissionRequestStore: readStore()! })).toMatchObject({ ok: true });
            }
            await vi.waitFor(() => expect(Object.keys(readState().requests ?? {}), JSON.stringify({
                run: manager.getPublic(started.runId), decisions,
            })).toHaveLength(1), { timeout: 10_000 });
            const requestId = Object.keys(readState().requests ?? {})[0]!;
            const executor = createActionExecutor({ executionRunCheckProtocolV2: async () => ({ ok: true }),
                executionRunGet: async (_session, input) => ({ run: manager.getPublic(input.runId) }),
                executionRunPermissionRespond: input => manager.completePermissionRequest(input.runId, ExecutionRunPermissionRespondInputSchema.parse(input)),
                // The authenticated Home RPC transport is the boundary fixture;
                // the registered Session handler still validates and applies the answer.
                sessionUserActionAnswer: async input => {
                    const result = await session.rpcHandlerManager.handleRequest({
                        method: `${session.sessionId}:session.user_action.answer`,
                        callerAuthority: 'present_user',
                        params: { id: input.requestId!, approved: input.decision !== 'reject',
                            ...(input.answers.length ? { answers: buildSessionUserActionAnswerMap(input.answers),
                                answerDetails: buildSessionUserActionAnswerDetails(input.answers) } : {}) },
                        authorization: { kind: 'session.permission.respond', sessionId: session.sessionId,
                            actor: { kind: 'accountUser', accountId: 'account', relationship: 'owner' } },
                    });
                    return result === undefined ? { ok: true } : result;
                } });
            const answerQuestion = (runId: string, questionId: string, reject = false) => scope === 'attached'
                ? executor.execute('session.user_action.answer', {
                    sessionId: session.sessionId, requestId: questionId, ...(reject ? { decision: 'reject' as const }
                        : { answers: buildSessionUserActionAnswerItems({ scope: completion === 'freeText' ? [] : ['src'] }, completion === 'freeText'
                            ? { scope: { freeText: 'src and tests', note: 'Include regressions' } } : undefined) }),
                }, { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' })
                : executor.execute('execution.run.permission.respond', { runId, requestId: questionId,
                    ...(reject ? { approved: false } : { answers: { scope: completion === 'freeText' ? [] : ['src'] }, ...(completion === 'freeText'
                        ? { answerDetails: { scope: { freeText: 'src and tests', note: 'Include regressions' } } } : {}) }) },
                { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account', executionRunTargetMachineId: 'machine' });
            if (completion === 'stop') {
                await manager.stop(started.runId);
                await vi.waitFor(() => expect(decisions[0]).toBeDefined());
                expect(decisions[0]).not.toMatchObject({ status: 'answered' });
                expect(readState().completedRequests?.[requestId]).toMatchObject({ status: 'canceled', decision: 'abort' });
                expect(manager.getPublic(started.runId)).toMatchObject({ status: 'cancelled' });
                expect(readStore()?.readOutstandingRequest(requestId)).toBeNull();
                expect(await answerQuestion(started.runId, requestId)).toMatchObject({ ok: false });
                const retry = await startReview();
                await vi.waitFor(() => expect(Object.keys(readState().requests ?? {})).toHaveLength(1));
                const retryRequestId = Object.keys(readState().requests ?? {})[0]!;
                expect(retryRequestId).not.toBe(requestId);
                expect(await answerQuestion(retry.runId, retryRequestId)).toMatchObject({ ok: true });
                await manager.waitForTerminal(retry.runId);
                expect(manager.getPublic(retry.runId), JSON.stringify(manager.getPublic(retry.runId))).toMatchObject({ status: 'succeeded' });
                expect(decisions).toContainEqual(expect.objectContaining({ status: 'answered', answers: { scope: { kind: 'text', value: 'src' } } }));
                return;
            }
            if (completion === 'answer' && scope === 'detached') {
                expect(await answerQuestion('another-run', requestId)).toMatchObject({ ok: false });
                expect(readStore()?.readOutstandingRequest(requestId)).not.toBeNull();
                expect(decisions).toEqual([]);
            }
            const answered = await answerQuestion(started.runId, requestId, completion === 'reject');
            expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
            if (runClass === 'bounded') {
                await manager.waitForTerminal(started.runId);
                expect(manager.getPublic(started.runId), JSON.stringify({ run: manager.getPublic(started.runId), decisions })).toMatchObject({ status: 'succeeded' });
            } else {
                await vi.waitFor(() => expect(manager.get(started.runId)?.structuredMeta?.payload).toMatchObject({
                    questions: [{ id: 'final-question', status: 'open' }],
                }));
            }
            expect(decisions[0]).toMatchObject(completion === 'reject' ? { status: 'userCancelled' }
                : { status: 'answered', answers: { scope: completion === 'freeText'
                    ? { kind: 'singleChoice', answer: { kind: 'custom', value: 'src and tests' }, note: 'Include regressions' }
                    : { kind: 'text', value: 'src' } } });
            expect(decisions[1]).toMatchObject({ status: 'declined' });
            expect(decisions[2]).toMatchObject({ status: 'declined' });
            expect(publications).toHaveLength(1);
            expect(manager.get(started.runId)?.structuredMeta?.payload).toMatchObject({
                questions: [{ id: 'final-question', status: 'open' }],
            });
            expect(Object.keys(readState().requests ?? {})).toHaveLength(0);
            expect(await answerQuestion(started.runId, requestId)).toMatchObject({ ok: false });
        } finally { await manager.dispose(); }
    });
});
