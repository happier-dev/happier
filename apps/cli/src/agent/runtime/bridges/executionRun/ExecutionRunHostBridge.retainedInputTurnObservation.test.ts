import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunAdmittedPendingInputV1 } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { ExecutionRunState } from './executionRunTypes';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import { ScmComparisonSchema, readActionCompletionRunObservationV1, ExecutionRunGetResponseSchema } from '@happier-dev/protocol';
import { startExecutionRun } from './startExecutionRun';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { createTestExecutionRunHostRuntime } from './testkit';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { createExecutionRunRpcActionDeps } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { finishExecutionRun } from './finishExecutionRun';
import { publishExecutionRunTurn } from './publishExecutionRunTurn';
import { stopExecutionRun } from './executionRunStop';
import { ScmDiffSummaryProfile } from './kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { readOrCreateSavedScmResult } from './kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import type { RegisterExecutionRunOccurrence } from './runOccurrenceWitness';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import { SessionMessageReplyMutationV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { CommittedTranscriptMessageOptions } from '@/api/session/transcriptPort';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { ScmDiffSummaryPublicationReceiptSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { HappierMetaEnvelopeSchema } from '@happier-dev/protocol/messages/structured/HappierMetaEnvelope';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { AgentSessionRuntimeEvent, AgentExecutionRunConversationEventV1, AgentSessionExecutionRunRuntimeFactoryV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import { createNativeAgentExecutionRunHostRuntime, createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { createLazyExecutionRunHostRuntime } from './hostRuntime/lazy';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { readScmDiffSummaryPublicationReceipt } from '../../../../../../ui/sources/sync/domains/scm/diffSummary/publicationReceipt';
import { withCodexNativeAttachFixture } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import type { ExecutionRunPendingInputBinding } from '@/api/session/client/transport/sessionClientInteractionApi';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { projectExecutionRunSessionUpdateState } from './publicState';

const TEST_BACKEND_ID = `${'test'}.${'agent'}` as never;

const { createBundledPluginPublicationFsFixture } = await vi.hoisted(
    () => import('@/plugins/projection/registry/builtIn/locators.testkit'),
);
vi.mock('node:fs', async (importOriginal) =>
    createBundledPluginPublicationFsFixture(await importOriginal<typeof import('node:fs')>()));
beforeEach(() => {
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
});
afterEach(() => vi.unstubAllEnvs());

type RuntimeEvent = Parameters<NonNullable<ExecutionRunBackendController['backend']['subscribeRuntimeEvents']>>[0] extends (
    event: infer E,
) => void ? E : never;

/**
 * A Session-owned retained Run composed through the bridge's real retained
 * attachment: the canonical occurrence witness registration, retained input
 * delivery and public-state projection are all production code. Only the
 * provider runtime (its event stream) and the parent Session's Pending transport
 * are boundaries.
 */
function composeRetainedRun(admissionFailure?: 'rejected' | 'outcomeUnknown', onPublicStateUpdated?: (run: ExecutionRunPublicState) => void,
    replyTransportUnavailable = false, committedResultSidechainId = 'sidechain-1', nativeRuntime?: ExecutionRunHostRuntime, detached = false,
    pendingTransport?: Readonly<{
        bindExecutionRunPendingInput: (binding: ExecutionRunPendingInputBinding) => import('./pending/executionRunPendingInputConsumer').ExecutionRunPendingInputPortLike;
        listExecutionRunPendingDeliveryStatuses?: NonNullable<ConstructorParameters<typeof ExecutionRunHostBridge>[0]['sessionInteractionHost']>['session']['listExecutionRunPendingDeliveryStatuses'];
        blockExecutionRunPendingDelivery?: NonNullable<ConstructorParameters<typeof ExecutionRunHostBridge>[0]['sessionInteractionHost']>['session']['blockExecutionRunPendingDelivery'];
    }>) {
    const admittedParts: { text: string; localId: string }[] = [];
    const replyMutations: unknown[] = [];
    let replyRefusal: 'conflict' | undefined;
    let beforeCommittedResultRead: (() => Promise<void>) | undefined;
    const releasedSourceTurns: unknown[] = [];
    const committedResultLookups: string[] = [];
    const transcriptPublications: { body: ACPMessageData; meta?: Record<string, unknown>; localId?: string }[] = [];
    const runtimeLifetime = new AbortController();
    const runtimeEventListeners = new Set<(event: RuntimeEvent) => void>();
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>(resolve => { resolveTerminal = resolve; });
    const controller = {
        kind: 'backend',
        controllerOccurrenceId: 'retained-occurrence-1',
        backend: nativeRuntime ?? {
            interaction: {
                kind: 'retained_agent_session.v1',
                capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
            },
            deliverInput: async () => ({ status: 'admitted' as const }),
            subscribeRuntimeEvents: (handler: (event: RuntimeEvent) => void) => {
                runtimeEventListeners.add(handler);
                return () => { runtimeEventListeners.delete(handler); };
            },
            getRuntimeLifetimeSignal: () => runtimeLifetime.signal,
            subscribeMessages: () => () => undefined,
            readResumeSupport: async () => true,
            provisionRuntime: async () => ({ runtimeId: 'provider-session-1' }),
            cancel: async () => undefined,
            dispose: async () => undefined,
        },
        backendSupportsResume: true,
        runtimeId: 'provider-session-1',
        buffer: '',
        sidechainStreamBuffer: '',
        sidechainStreamKey: '',
        streamWriter: null,
        cancelled: false,
        turnCount: 0,
        turnEpoch: 0,
        turnInFlight: false,
        turnCancelReason: null,
        turnCancelEpoch: null,
        admittedLiveInterventions: [],
        admittedLiveInterventionsSignal: null,
        lastMarkerWriteAtMs: 0,
        terminalPromise,
        resolveTerminal,
    } as unknown as ExecutionRunBackendController;
    const manager = new ExecutionRunHostBridge({
        parentProvider: TEST_BACKEND_ID,
        cwd: '/repo',
        // The synthetic parent Session supplies its admitted metadata boundary;
        // prompt preparation itself remains the real canonical owner.
        resolveVoicePromptPreparation: async (input) => await resolveCliVoicePromptPreparation({
            ...input,
            sessionMetadata: {},
            // This synthetic parent has no Project attachments; use the
            // producer's explicit-empty contract, not missing host custody.
            projectEntries: [],
        }),
        sendAcp: async (_provider, body, options) => { transcriptPublications.push({ body, meta: options?.meta }); },
        onPublicStateUpdated,
        sessionInteractionHost: {
            session: {
                sessionId: 'session-1',
                enqueueSessionUserMessageWithDisposition: async (input: { text: string; localId: string }) => {
                    admittedParts.push(input);
                    if (admissionFailure && admittedParts.length > 1) return { status: admissionFailure, code: 'admission_boundary_failure' };
                    return { status: 'accepted' as const, localId: input.localId };
                },
                getMetadataSnapshot: () => null,
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
                enqueueAgentMessageCommitted: vi.fn(async (_provider: string, body: ACPMessageData, options: CommittedTranscriptMessageOptions) => {
                    transcriptPublications.push({ body, meta: options?.meta, localId: options.localId });
                    return { persisted: true, delivered: true };
                }),
                readCommittedTranscriptMessageByLocalId: async (localId: string) => {
                    committedResultLookups.push(localId);
                    await beforeCommittedResultRead?.();
                    return { type: 'found', message: { id: `committed:${localId}`, localId, sidechainId: committedResultSidechainId,
                        seq: 1, createdAt: 1, updatedAt: 1, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Committed result' } } } } };
                },
                mutateSessionMessageReply: async (input: unknown) => {
                    SessionMessageReplyMutationV1Schema.parse({ v: 1, sessionId: 'session-1',
                        ...(typeof input === 'object' && input !== null ? input : {}) });
                    replyMutations.push(input);
                    if (replyTransportUnavailable) throw new Error('reply transport unavailable');
                    if (replyRefusal) return { v: 1, ok: false, error: replyRefusal } as const;
                    return { v: 1, ok: true, progress: { v: 1, mode: 'wait', disposition: 'observing' } } as const;
                },
                releaseSessionMessageReplySourceTurn: async (input: unknown) => { releasedSourceTurns.push(input); return { v: 1, ok: true }; },
                bindExecutionRunPendingInput: (_binding: { consume: (input: ExecutionRunAdmittedPendingInputV1) => boolean }) => ({
                    getMetadataSnapshot: () => null,
                    waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
                    shouldAttemptPendingMaterialization: () => false,
                    reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
                    materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
                    observeProviderInputSettlement: async () => true,
                    readDurableProviderInputAcceptanceV1: async () => 'unknown' as const,
                    dispose: () => undefined,
                }),
                ...pendingTransport,
            },
            machineId: 'machine-1',
            permissionHandler: { handleToolCall: vi.fn() },
        },
    } as ConstructorParameters<typeof ExecutionRunHostBridge>[0]);
    const internals = manager as unknown as {
        runs: Map<string, ExecutionRunState>;
        controllers: Map<string, ExecutionRunBackendController>;
        voiceAgentManager: VoiceAgentManager;
        finishRun: import('./executionRunFinishRun').FinishExecutionRun;
        emitPublicStateUpdated(runId: string): void;
        registerRunOccurrence: RegisterExecutionRunOccurrence;
        createSessionOwnedRunScope(runId: string): import('@/agent/runtime/registry/engineRegistryTypes').ExecutionRunHostRunScopeBinding | null;
        attachRetainedRunSessionInput(input: {
            runId: string; sidechainId: string; controller: ExecutionRunBackendController;
        }): { release(): Promise<void> } | null;
    };
    internals.runs.set('run-1', {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', sessionId: detached ? null : 'session-1', depth: 0,
        intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        backendId: TEST_BACKEND_ID, instructions: 'Continue.', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
    } as ExecutionRunState);
    internals.controllers.set('run-1', controller);
    const releaseOccurrence = internals.registerRunOccurrence({ runId: 'run-1', sidechainId: 'sidechain-1', controller });
    const retainedAttachment = detached ? { release: async () => undefined }
        : internals.attachRetainedRunSessionInput({ runId: 'run-1', sidechainId: 'sidechain-1', controller });
    if (!retainedAttachment) { releaseOccurrence(); throw new Error('Missing retained Session input attachment'); }
    const attachment = { ...retainedAttachment, release: async () => {
        try { await retainedAttachment.release(); } finally { releaseOccurrence(); }
    } };
    const emitRuntimeEvent = (event: Record<string, unknown>) => {
        if (!runtimeEventListeners.size) throw new Error('retained delivery did not subscribe to runtime events');
        for (const listener of runtimeEventListeners) listener(event as RuntimeEvent);
    };
    const prepareScmInput = async (localId: string) => {
        let run = internals.runs.get('run-1')!;
        const input = run.intentInput && typeof run.intentInput === 'object' ? run.intentInput as Record<string, unknown> : {};
        if (run.intent !== 'scm_diff_summary' || !ScmComparisonSchema.safeParse(input.comparison).success) return;
        // This synthetic runtime event fixture does not run prepareStart or
        // Pending delivery. Exercise their real saved-state admission here.
        if (!input.resultId) {
            const saved = await readOrCreateSavedScmResult(run, run.structuredMeta?.payload);
            run = { ...run, intentInput: { ...input, resultId: saved.result.resultId, resultInitialInputId: localId } };
            const initial = await ScmDiffSummaryProfile.onStarted?.({ start: run, rawText: '', finishedAtMs: 1 });
            run = { ...run, structuredMeta: initial?.structuredMeta, latestToolResult: initial?.toolResultOutput };
            internals.runs.set('run-1', run);
        }
        await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: run, localId });
    };
    const acceptInput = async (localId: string, turnId: string) => {
        await prepareScmInput(localId);
        emitRuntimeEvent({ kind: 'input-accepted', sessionId: 'session-1', sequence: 1, emittedAtMs: 1,
            inputIds: [localId], delivery: { kind: 'newTurn', turnId } });
    };
    return { manager, internals, attachment, emitRuntimeEvent, acceptInput, prepareScmInput, runtimeLifetime, admittedParts,
        replyMutations, releasedSourceTurns, committedResultLookups, transcriptPublications,
        refuseReply: () => { replyRefusal = 'conflict'; },
        beforeCommittedResultRead: (hook: () => Promise<void>) => { beforeCommittedResultRead = hook; } };
}

describe('ExecutionRunHostBridge retained exact input observation', () => {
    it.skipIf(process.platform === 'win32')('keeps a Codex usage-limit cause on the failed native turn through the structured Run read', async () => {
        await withCodexNativeAttachFixture(async ({ openConfiguredSession, emitNotification }) => {
            const native = createNativeAgentSessionInteractionHostRuntime({
                runtime: { sessions: { open: async () => await openConfiguredSession() } },
                lease: { pluginId: 'happier.agent.codex', pluginVersion: '1.0.0', agentId: 'codex',
                    localAgentId: 'codex', occurrenceId: 'quota-cause', isCurrent: () => true },
                options: { cwd: '/repo', runId: 'run-1', scope: 'session_owned', backendId: 'codex', permissionMode: 'read_only' },
                sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
                createSessionContext: ({ services, signal }) => {
                    const lease = createVoiceSessionContextLease({ services, signal, async dispose() {} });
                    return { ...lease, context: { ...lease.context, session: { ...lease.context.session, id: 'actual-happier-session' } } };
                },
            });
            const backend = createLazyExecutionRunHostRuntime({ resolveRuntime: async () => native });
            await backend.provisionRuntime();
            const fixture = composeRetainedRun(undefined, undefined, false, 'sidechain-1', backend);
            try {
                await backend.deliverInput('run-1', { text: 'Hello' }, { localId: 'quota-input', turnId: 'quota-turn' });
                const terminal = backend.waitForTurnCompletion?.().catch(() => undefined);
                emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'failed',
                    error: { message: "You've hit your usage limit. Try again at Nov 7, 2026 1:00 PM.",
                        codexErrorInfo: 'UsageLimitExceeded', resetsAt: '2026-11-07T13:00:00Z', requestId: 'req-quota-fixture' } } });
                await terminal;
                await vi.waitFor(() => expect(fixture.manager.getPublic('run-1')?.inputTurns?.last).toMatchObject({ state: 'failed' }));
                const rpc = createExecutionRunRpcActionDeps({ manager: fixture.manager,
                    context: { sessionId: 'session-1', cwd: '/repo' }, isExecutionRunsEnabled: () => true,
                    policy: { boundedTimeoutMs: null, reviewBoundedTimeoutMs: null,
                        maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
                const read = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!('session-1', { runId: 'run-1', includeStructured: true }));
                expect(read.run).toMatchObject({ status: 'running', turnInFlight: false, inputTurns: { last: {
                    inputIds: ['quota-input'], state: 'failed', error: { code: 'usage_limit', runtimeIssueV1: {
                        source: 'usage_limit', usageLimit: { resetAtMs: Date.parse('2026-11-07T13:00:00Z') },
                        failureCause: { failureReason: 'usage_limit', retryable: false, requestId: 'req-quota-fixture' },
                    } },
                } } });
                expect(projectExecutionRunSessionUpdateState(read.run).inputTurns?.last).not.toHaveProperty('error');
            } finally { await fixture.attachment.release(); await backend.dispose(); }
        });
    });

    it.skipIf(process.platform === 'win32').each([
        { ioMode: 'request_response', retentionPolicy: 'resumable' },
        { ioMode: 'streaming', retentionPolicy: 'resumable' },
        { ioMode: 'request_response', retentionPolicy: 'ephemeral' },
    ] as const)('keeps first and fresh targeted Pending input admissible through real Codex ($ioMode, $retentionPolicy)', async ({ ioMode, retentionPolicy }) => {
        await withCodexNativeAttachFixture(async ({ openConfiguredSession, requests, emitNotification }) => {
            const native = createNativeAgentSessionInteractionHostRuntime({
                runtime: { sessions: { open: async () => await openConfiguredSession() } },
                lease: { pluginId: 'happier.agent.codex', pluginVersion: '1.0.0', agentId: 'codex',
                    localAgentId: 'codex', occurrenceId: 'retained-codex-input', isCurrent: () => true },
                options: { cwd: '/repo', runId: 'run-1', scope: 'session_owned', backendId: 'codex', permissionMode: 'read_only' },
                sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
                createSessionContext: ({ services, signal }) => {
                    const lease = createVoiceSessionContextLease({ services, signal, async dispose() {} });
                    return { ...lease, context: { ...lease.context, session: { ...lease.context.session, id: 'actual-happier-session' } } };
                },
            });
            const backend = createLazyExecutionRunHostRuntime({ resolveRuntime: async () => native });
            await backend.provisionRuntime();
            const accepted = new Set<string>();
            let releaseClaims!: () => void;
            const claims = new Promise<void>(resolve => { releaseClaims = resolve; });
            let pendingBinding: ExecutionRunPendingInputBinding | undefined;
            const rows: ExecutionRunAdmittedPendingInputV1[] = [{ role: 'user', content: { type: 'text', text: 'First targeted input' },
                localId: 'first-targeted', authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' }];
            const block = vi.fn(async (_runId: string, localId: string) => {
                const index = rows.findIndex(row => row.localId === localId);
                if (index >= 0) rows.splice(index, 1);
                return true;
            });
            const fixture = composeRetainedRun(undefined, undefined, false, 'sidechain-1', backend, false, {
                listExecutionRunPendingDeliveryStatuses: async () => rows.map(row => ({ localId: row.localId!, status: 'queued' as const,
                    deliveryStatus: { status: 'queued' as const } })),
                blockExecutionRunPendingDelivery: block,
                bindExecutionRunPendingInput: binding => { pendingBinding = binding; return {
                    getMetadataSnapshot: () => createTestMetadata(),
                    waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
                    shouldAttemptPendingMaterialization: () => rows.length > 0,
                    reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
                    materializeNextPendingMessageSafely: async () => {
                        await claims;
                        if (binding.foregroundState() !== 'ready') return { type: 'no_pending' as const };
                        const input = rows.shift();
                        if (!input) return { type: 'no_pending' as const };
                        binding.consume(input);
                        return { type: 'materialized' as const, localId: input.localId!, seq: null, content: null };
                    },
                    observeProviderInputSettlement: async outcome => { if (outcome.kind === 'accepted') accepted.add(outcome.localId); return true; },
                    readDurableProviderInputAcceptanceV1: async localId => accepted.has(localId) ? 'accepted' as const : 'unknown' as const,
                    dispose() {},
                }; },
            });
            fixture.internals.runs.set('run-1', { ...fixture.internals.runs.get('run-1')!, ioMode, retentionPolicy });
            fixture.internals.controllers.get('run-1')!.runtimeId = 'run-1';
            try {
                // The real pending-change observer can run before any first input is claimed.
                await fixture.manager.reconcilePendingExecutionRunTarget('run-1');
                expect(block).not.toHaveBeenCalled();
                releaseClaims();
                await vi.waitFor(() => expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1));
                expect(fixture.manager.getPublic('run-1')?.inputTurns?.current).toMatchObject({ inputIds: ['first-targeted'], state: 'active' });
                rows.push({ role: 'user', content: { type: 'text', text: 'Fresh targeted input' }, localId: 'fresh-targeted',
                    authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' });
                await fixture.manager.reconcilePendingExecutionRunTarget('run-1');
                expect(block).not.toHaveBeenCalled();
                emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
                await backend.waitForTurnCompletion?.();
                await vi.waitFor(() => expect(fixture.manager.getPublic('run-1')?.inputTurns?.last).toMatchObject({ inputIds: ['first-targeted'], state: 'completed' }));
                pendingBinding!.wake?.();
                await vi.waitFor(() => expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(2));
                expect(fixture.manager.getPublic('run-1')?.inputTurns?.current).toMatchObject({ inputIds: ['fresh-targeted'], state: 'active' });
                emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-2', status: 'completed' } });
                await backend.waitForTurnCompletion?.();
                await vi.waitFor(() => expect(fixture.manager.getPublic('run-1')?.inputTurns?.last).toMatchObject({ inputIds: ['fresh-targeted'], state: 'completed' }));
                expect(accepted.has('first-targeted')).toBe(true);
                expect(accepted.has('fresh-targeted')).toBe(true);
            } finally { releaseClaims(); await fixture.attachment.release(); await backend.dispose(); }
        });
    });

    it('settles detached idle process death through the same Run owner without a Session identity', async () => {
        let publish: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
        const factory: AgentSessionExecutionRunRuntimeFactoryV1 = {
            async open() { throw new Error('Finite open is not a retained conversation'); },
            async openConversation() { return {
                watch(listener) { publish = listener; listener({ kind: 'provider-session-id', providerSessionId: 'detached-native' }); return { dispose() {} }; },
                async send(input) {
                    publish!({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                    publish!({ kind: 'turn-complete', turnId: input.delivery.turnId });
                    return { status: 'admitted' as const };
                },
                async dispose() {},
            }; },
        };
        const native = createNativeAgentExecutionRunHostRuntime({
            runtime: { sessions: { async open() { throw new Error('Detached Run cannot open a Session'); }, executionRunContextV1: factory } },
            executionRunContextV1: factory, retainedConversation: true, supportsResume: true,
            lease: { pluginId: 'acme.exit', pluginVersion: '1.0.0', agentId: 'acme.exit/default',
                localAgentId: 'default', occurrenceId: 'detached-exit', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-1', scope: 'detached', backendId: 'acme.exit/default', permissionMode: 'read_only',
                start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' } },
        });
        const backend = createLazyExecutionRunHostRuntime({ resolveRuntime: async () => native });
        // Registration precedes lazy creation, as it does in real Start and Resume.
        const { manager, internals, attachment } = composeRetainedRun(undefined, undefined, false, 'sidechain-1', backend, true);
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, resumeHandle: { kind: 'provider_session.v1',
            backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: TEST_BACKEND_ID }), providerSessionId: 'detached-native' } });
        try {
            await backend.provisionRuntime({ initialPrompt: 'Complete the first detached input.' });
            await backend.waitForTurnCompletion?.();
            publish!({ kind: 'runtime-ended', emittedAtMs: 3, cause: 'processExited', retryable: true,
                diagnostic: { code: 'native_process_exited', severity: 'error' } });
            await manager.waitForTerminal('run-1');
            expect(manager.getPublic('run-1')).toMatchObject({ status: 'failed',
                error: { code: 'native_process_exited' }, lifecycle: { state: 'recoverable' },
                resumeHandle: { providerSessionId: 'detached-native' } });
            expect(internals.controllers.has('run-1')).toBe(false);
        } finally { await attachment.release(); await backend.dispose(); }
    });

    it('fails an interrupted retained input and ignores repeated native termination', async () => {
        const { manager, internals, attachment, acceptInput, emitRuntimeEvent, transcriptPublications } = composeRetainedRun();
        try {
            await acceptInput('interrupted-input', 'interrupted-turn');
            emitRuntimeEvent({ kind: 'runtime-ended', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                cause: 'processExited', retryable: true, diagnostic: { code: 'native_process_exited', severity: 'error' } });
            emitRuntimeEvent({ kind: 'runtime-ended', sessionId: 'session-1', sequence: 3, emittedAtMs: 3,
                cause: 'processExited', retryable: true, diagnostic: { code: 'native_process_exited', severity: 'error' } });
            await manager.waitForTerminal('run-1');
            expect(manager.getPublic('run-1')).toMatchObject({ status: 'failed',
                error: { code: 'native_process_exited' }, inputTurns: { last: { state: 'failed', inputIds: ['interrupted-input'] } } });
            await vi.waitFor(() => expect(internals.controllers.has('run-1')).toBe(false));
            expect(transcriptPublications.filter(item => item.body.type === 'tool-result')).toHaveLength(1);
        } finally { await attachment.release(); }
    });

    it('does not let a departing native runtime settle a replacement while prior publication is pending', async () => {
        const { manager, internals, attachment, emitRuntimeEvent } = composeRetainedRun();
        const departed = internals.controllers.get('run-1')!;
        let acknowledge!: () => void;
        departed.pendingHostBarrier = new Promise<void>(resolve => { acknowledge = resolve; });
        try {
            emitRuntimeEvent({ kind: 'runtime-ended', sessionId: 'session-1', sequence: 1, emittedAtMs: 1,
                cause: 'processExited', retryable: true });
            expect(manager.getPublic('run-1')?.status).toBe('running');
            const replacement = { ...departed, controllerOccurrenceId: 'replacement', executionRunOccurrence: undefined };
            internals.controllers.set('run-1', replacement);
            acknowledge();
            await departed.pendingHostBarrier;
            await Promise.resolve();
            expect(manager.getPublic('run-1')).toMatchObject({ status: 'running', lifecycle: { state: 'current' } });
            expect(internals.controllers.get('run-1')).toBe(replacement);
        } finally { acknowledge(); await attachment.release(); }
    });

    it.each(['resumable', 'ephemeral'] as const)('settles an idle %s Run once when its native process exits, preserving its completed input', async retentionPolicy => {
        let publish: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sequence = 0;
        const disposeNative = vi.fn(async () => undefined);
        // The installed Agent is the system boundary. Lazy resolution, native
        // admission, occurrence registration and Run settlement remain real.
        const native = createNativeAgentSessionInteractionHostRuntime({
            runtime: { sessions: { async open(request) { return {
                async send(input) {
                    publish!({ kind: 'input-accepted', sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: 1,
                        inputIds: input.inputIds, delivery: input.delivery });
                    publish!({ kind: 'turn-start', sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: 1,
                        turnId: input.delivery.turnId, startedBy: 'host' });
                    publish!({ kind: 'turn-complete', sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: 2,
                        turnId: input.delivery.turnId });
                    return { status: 'admitted' as const };
                },
                watch(listener) { publish = listener; return { dispose() {} }; },
                dispose: disposeNative,
            }; } } },
            lease: { pluginId: 'acme.exit', pluginVersion: '1.0.0', agentId: 'acme.exit/default',
                localAgentId: 'default', occurrenceId: 'native-exit', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-1', scope: 'session_owned', backendId: 'acme.exit/default', permissionMode: 'read_only' },
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        const backend = createLazyExecutionRunHostRuntime({ resolveRuntime: async () => native });
        await backend.readResumeSupport();
        const fixture = composeRetainedRun(undefined, undefined, false, 'sidechain-1', backend);
        const { manager, internals, attachment, transcriptPublications } = fixture;
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, retentionPolicy,
            ...(retentionPolicy === 'resumable' ? { resumeHandle: { kind: 'provider_session.v1',
                backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: TEST_BACKEND_ID }), providerSessionId: 'original-native-thread' } } : {}) });
        try {
            await backend.readResumeSupport();
            await backend.provisionRuntime();
            await backend.deliverInput('run-1', { text: 'Complete the first turn.' }, { localId: 'completed-input', turnId: 'completed-turn' });
            await backend.waitForTurnCompletion?.();
            await internals.controllers.get('run-1')!.pendingHostBarrier;
            expect(manager.getPublic('run-1')).toMatchObject({ status: 'running', inputTurns: { last: { state: 'completed', inputIds: ['completed-input'] } } });
            for (let index = 0; index < 2; index++) publish!({ kind: 'runtime-ended', sessionId: 'session-parent',
                sequence: ++sequence, emittedAtMs: 3, cause: 'processExited', retryable: true,
                diagnostic: { code: 'native_process_exited', severity: 'error' } });
            await manager.waitForTerminal('run-1');
            expect(manager.getPublic('run-1')).toMatchObject({ status: 'failed',
                error: { code: 'native_process_exited' }, lifecycle: { state: retentionPolicy === 'resumable' ? 'recoverable' : 'unavailable' },
                inputTurns: { last: { state: 'completed', inputIds: ['completed-input'] } } });
            await vi.waitFor(() => expect(internals.controllers.has('run-1')).toBe(false));
            await vi.waitFor(() => expect(disposeNative).toHaveBeenCalledOnce());
            const terminalResults = transcriptPublications.filter(item => item.body.type === 'tool-result');
            expect(terminalResults).toHaveLength(1);
            await expect(manager.send('run-1', { message: 'Follow up.' })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
            if (retentionPolicy === 'resumable') expect(manager.get('run-1')?.resumeHandle).toMatchObject({ providerSessionId: 'original-native-thread' });
        } finally { await attachment.release(); await backend.dispose(); }
    });

    it('keeps the SCM baseline in public Run state without writing an empty transcript row', async () => {
        const { internals, attachment, transcriptPublications } = composeRetainedRun();
        const comparison = ScmComparisonSchema.parse({ id: 'baseline-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            comparison, outputs: ['walkthrough'], source: comparison.source, sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            const controller = internals.controllers.get('run-1')!;
            expect(await publishExecutionRunTurn({ runId: 'run-1', turnId: 'baseline', rawText: '', finishedAtMs: 2,
                started: true, controller, controllers: internals.controllers, runs: internals.runs, parentProvider: 'test.agent',
                sendAcp: async (_provider, body, options) => { transcriptPublications.push({ body, meta: options?.meta }); },
            })).toBe(true);
            expect(transcriptPublications.filter(item => item.body.type === 'message')).toEqual([]);
            expect(internals.runs.get('run-1')).toMatchObject({ latestToolResult: { success: true, comparison,
                outputs: { walkthrough: { state: 'pending' } } }, structuredMeta: { kind: 'scm_diff_summary.v1' } });
        } finally { await attachment.release(); }
    });

    it('publishes a saved-result receipt instead of native JSON and preserves the next prose discussion', async () => {
        const { internals, attachment, acceptInput, emitRuntimeEvent, transcriptPublications, replyMutations } = composeRetainedRun();
        const comparison = ScmComparisonSchema.parse({ id: 'receipt-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            comparison, outputs: ['walkthrough'], source: comparison.source, sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await acceptInput('write-reading', 'generation-turn');
            const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
            const stream = createKeyedStreamedTranscriptBridge({ provider: 'test.agent', createSessionForStream: () => transcript });
            const text = JSON.stringify({ walkthrough: { title: 'Saved explanation', intro: '', stops: [], otherChangeRefs: [] } });
            await projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', event: {
                kind: 'transcript-message-committed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'generation-turn', messageId: 'generation-answer', role: 'assistant', text,
            } });
            expect(transcriptPublications.filter(item => item.body.type === 'message' && item.body.message.includes('"walkthrough"'))).toEqual([]);
            const consumed = transcriptPublications.find(item => item.body.type === 'output');
            expect(consumed).toMatchObject({ body: { sidechainId: 'sidechain-1', type: 'output', data: {
                type: 'progress', marker: 'source_fact_consumed', reason: 'host_structured_output',
            } }, meta: { runtimeTurnId: 'generation-turn' } });
            expect(normalizeRawMessage('native-answer', 'generation-answer', 2,
                buildAcpAgentMessageEnvelope({ provider: 'test.agent', body: consumed?.body }))).toBeNull();
            internals.controllers.get('run-1')!.buffer = text;
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'generation-turn' });
            // Native terminal projection can arrive while the saved publication is still queued.
            const terminalProjection = projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', runtimeMessageDeltaBridge: stream, event: {
                kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'generation-turn',
            } });
            await internals.controllers.get('run-1')!.pendingHostBarrier;
            const receipts = transcriptPublications.filter(item => item.meta?.scmResultUpdate !== undefined);
            expect(receipts).toHaveLength(1);
            expect(receipts[0]?.meta?.scmResultUpdate).toMatchObject({ status: 'published',
                outputs: [{ kind: 'walkthrough', change: 'created' }] });
            expect(ScmDiffSummaryPublicationReceiptSchema.parse(receipts[0]?.meta?.scmResultUpdate).outputs)
                .toEqual([{ kind: 'walkthrough', change: 'created' }]);
            const normalizedReceipt = normalizeRawMessage('saved-receipt', receipts[0]?.localId ?? null, 3,
                buildAcpAgentMessageEnvelope({ provider: 'test.agent', body: receipts[0]?.body, meta: receipts[0]?.meta }));
            expect(normalizedReceipt?.meta?.scmResultUpdate).toEqual(receipts[0]?.meta?.scmResultUpdate);
            const envelope = createStoredReadSchema(HappierMetaEnvelopeSchema).parse(normalizedReceipt?.meta?.happier);
            expect(envelope.kind).toBe('scm_diff_summary.v1');
            const admittedOutput = createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema).parse(envelope.payload);
            const receipt = readScmDiffSummaryPublicationReceipt(admittedOutput, normalizedReceipt?.meta?.scmResultUpdate);
            expect(receipt?.output).toEqual(internals.runs.get('run-1')?.structuredMeta?.payload);
            expect(receipt?.publication.outputs).toEqual([{ kind: 'walkthrough', change: 'created' }]);
            expect(receipt?.publication.updateNotice).toMatchObject({ kind: 'generation', revision: receipt?.output.revision,
                affectedStopIds: [] });
            await terminalProjection;
            expect(replyMutations).toMatchObject([{ requestLocalId: 'write-reading', operation: {
                kind: 'fulfill', outcome: { kind: 'answer', result: { sessionId: 'session-1' } },
            } }]);
            expect(receipts[0]?.localId).toEqual(expect.any(String));
            expect(replyMutations).toMatchObject([{ operation: {
                nativeResult: { localId: receipts[0]?.localId },
                outcome: { result: { messageId: `committed:${receipts[0]?.localId}` } },
            } }]);
            const saved = internals.runs.get('run-1')?.structuredMeta;
            await acceptInput('ask-question', 'discussion-turn');
            const answer = 'The deleted code remains available on the before side.';
            await projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', event: {
                kind: 'transcript-message-committed', sessionId: 'session-1', sequence: 4, emittedAtMs: 4,
                turnId: 'discussion-turn', messageId: 'discussion-answer', role: 'assistant', text: answer,
            } });
            internals.controllers.get('run-1')!.buffer = answer;
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 5, emittedAtMs: 5, turnId: 'discussion-turn' });
            await internals.controllers.get('run-1')!.pendingHostBarrier;
            expect(transcriptPublications.filter(item => item.body.type === 'message' && item.body.message === answer)).toHaveLength(1);
            expect(transcriptPublications.filter(item => item.meta?.scmResultUpdate !== undefined)).toHaveLength(1);
            expect(internals.runs.get('run-1')?.structuredMeta).toEqual(saved);
        } finally { await attachment?.release(); }
    });
    it('fulfills and releases only the exact native input after its committed terminal fact', async () => {
        const { internals, attachment, acceptInput, replyMutations, releasedSourceTurns, committedResultLookups } = composeRetainedRun();
        try {
            await acceptInput('original-ask', 'native-turn');
            const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
            const options = { localId: 'native-answer', meta: { runtimeTurnId: 'native-turn', runtimeEventKind: 'transcript-message-committed' },
                provenance: { kind: 'non_dependent' as const, source: 'external' as const } };
            await projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', event: {
                kind: 'transcript-message-committed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'native-turn', messageId: 'native-answer', role: 'assistant', text: 'Exact answer',
            } });
            expect(replyMutations).toEqual([]);
            expect(releasedSourceTurns).toEqual([]);
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'message', message: 'Unrelated' }, {
                ...options, localId: 'other-answer', meta: { runtimeTurnId: 'unrelated-turn' },
            });
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'message', message: 'Other child answer', sidechainId: 'other-child' }, {
                ...options, localId: 'other-child-answer',
            });
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'thinking', text: 'Still thinking' }, {
                ...options, localId: 'thinking',
            });
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'message', message: 'Draft checkpoint' }, {
                ...options, localId: 'draft-checkpoint', meta: { runtimeTurnId: 'native-turn', happierStreamSegmentV1: {
                    segmentKind: 'assistant', segmentState: 'streaming',
                } },
            });
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'message', message: 'Unvalidated metadata' }, {
                ...options, localId: 'unvalidated-result', meta: { runtimeTurnId: 'native-turn',
                    happier: { kind: 'external.unvalidated', payload: null } },
            });
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'task_complete', id: 'native-turn' }, {
                ...options, localId: 'native-turn:task_complete',
            });
            expect(committedResultLookups).toEqual(['native-answer']);
            expect(replyMutations).toEqual([{ requestSessionId: 'session-1', requestLocalId: 'original-ask', operation: {
                kind: 'fulfill', turnId: 'native-turn', outcome: { kind: 'answer', result: { sessionId: 'session-1', messageId: 'committed:native-answer' } },
                nativeResult: { runId: 'run-1', sidechainId: 'sidechain-1', localId: 'native-answer' },
            } }]);
            expect(releasedSourceTurns).toEqual([{ sourceTurnId: 'native-turn', sourceInputId: 'original-ask' }]);
            expect(internals.runs.get('run-1')?.status).toBe('running');
        } finally { await attachment.release(); }
    });

    it('settles the accepted reply on native completion before a normal Run Stop', async () => {
        const { manager, internals, attachment, acceptInput, emitRuntimeEvent, transcriptPublications, replyMutations } = composeRetainedRun();
        try {
            await acceptInput('original-ask', 'native-turn');
            const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
            await projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', event: {
                kind: 'transcript-message-committed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'native-turn', messageId: 'native-answer', role: 'assistant', text: 'Exact answer',
            } });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'native-turn' });
            await internals.controllers.get('run-1')!.pendingHostBarrier;
            expect(transcriptPublications.filter(item => item.body.type === 'task_complete').map(item => item.localId))
                .toEqual(['native-turn:task_complete']);
            const wanted = [{ requestSessionId: 'session-1', requestLocalId: 'original-ask', operation: {
                kind: 'fulfill', turnId: 'native-turn', outcome: { kind: 'answer', result: { sessionId: 'session-1', messageId: 'committed:native-answer' } },
                nativeResult: { runId: 'run-1', sidechainId: 'sidechain-1', localId: 'native-answer' },
            } }];
            expect(replyMutations).toEqual(wanted);
            await manager.stop('run-1');
            expect(manager.getPublic('run-1')?.inputTurns?.last?.state).toBe('completed');
            expect(replyMutations).toEqual(wanted);
        } finally { await attachment.release(); }
    });

    it('does not fulfill another Ask when the completion has no accepted input identity', async () => {
        const { internals, attachment, acceptInput, emitRuntimeEvent, replyMutations } = composeRetainedRun();
        try {
            await acceptInput('original-ask', 'another-turn');
            emitRuntimeEvent({ kind: 'turn-start', turnId: 'unaddressed-turn', emittedAtMs: 2 });
            emitRuntimeEvent({ kind: 'turn-complete', turnId: 'unaddressed-turn', emittedAtMs: 3 });
            await internals.controllers.get('run-1')!.pendingHostBarrier;
            expect(replyMutations).toEqual([]);
        } finally { await attachment.release(); }
    });

    it('preserves completed Ask settlement if Stop arrives during its committed result lookup', async () => {
        const { manager, internals, attachment, acceptInput, emitRuntimeEvent, beforeCommittedResultRead, replyMutations } = composeRetainedRun();
        let readStarted!: () => void;
        const reading = new Promise<void>(resolve => { readStarted = resolve; });
        let finishRead!: () => void;
        const readGate = new Promise<void>(resolve => { finishRead = resolve; });
        beforeCommittedResultRead(async () => { readStarted(); await readGate; });
        try {
            await acceptInput('original-ask', 'native-turn');
            const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
            await projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', event: {
                kind: 'transcript-message-committed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'native-turn', messageId: 'native-answer', role: 'assistant', text: 'Exact answer',
            } });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'native-turn' });
            await reading;
            const stopping = stopExecutionRun({ runId: 'run-1', runs: internals.runs, controllers: internals.controllers,
                voiceAgentManager: internals.voiceAgentManager, getNowMs: () => 4, finishRun: internals.finishRun.bind(manager) });
            finishRead();
            expect(await stopping).toMatchObject({ ok: true });
            expect(replyMutations).toMatchObject([{ requestLocalId: 'original-ask', operation: { outcome: { kind: 'answer' } } }]);
        } finally { finishRead(); await attachment.release(); }
    });

    it('publishes Home’s typed refusal on the completed exact input', async () => {
        const { internals, attachment, acceptInput, emitRuntimeEvent, transcriptPublications, refuseReply } = composeRetainedRun();
        try {
            await acceptInput('original-ask', 'native-turn');
            refuseReply();
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'native-turn' });
            await internals.controllers.get('run-1')!.pendingHostBarrier;
            expect(transcriptPublications.find(item => item.localId === 'native-turn:task_complete')?.meta
                ?.happierExecutionRunReplyRefusalsV1).toEqual({ 'original-ask': { v: 1, ok: false, error: 'conflict' } });
        } finally { await attachment.release(); }
    });

    it('uses the existing Run stream row as the native answer when the Turn completes', async () => {
        const { internals, attachment, acceptInput, emitRuntimeEvent, transcriptPublications, replyMutations } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const writer = createStreamedTranscriptWriter({ provider: 'test.agent', makeLocalId: () => 'streamed-answer', session: {
            async enqueueAgentMessageCommitted(_provider, body, options) {
                transcriptPublications.push({ body, localId: options.localId, meta: options.meta });
                return { persisted: true, delivered: true };
            },
        } });
        controller.streamWriter = writer;
        try {
            await acceptInput('original-ask', 'native-turn');
            writer.appendAssistantDelta('Exact answer', { sidechainId: 'sidechain-1', meta: { runtimeTurnId: 'native-turn' } });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'native-turn' });
            await controller.pendingHostBarrier;
            expect(replyMutations).toEqual([{ requestSessionId: 'session-1', requestLocalId: 'original-ask', operation: {
                kind: 'fulfill', turnId: 'native-turn', outcome: { kind: 'answer', result: { sessionId: 'session-1', messageId: 'committed:streamed-answer' } },
                nativeResult: { runId: 'run-1', sidechainId: 'sidechain-1', localId: 'streamed-answer' },
            } }]);
            const answerWrites = transcriptPublications.filter(item => item.body.type === 'message');
            expect(new Set(answerWrites.map(item => item.localId))).toEqual(new Set(['streamed-answer']));
            expect(answerWrites.at(-1)?.meta).toMatchObject({ happierStreamSegmentV1: { segmentState: 'complete' } });
        } finally { writer.discard(); await attachment.release(); }
    });

    it('selects the actual unnamed streamed row after native finalization, preserving its checkpoint identity', async () => {
        const { internals, attachment, acceptInput, replyMutations, committedResultLookups } = composeRetainedRun();
        const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
        const stream = createKeyedStreamedTranscriptBridge({ provider: 'test.agent', createSessionForStream: () => transcript });
        try {
            await acceptInput('streamed-ask', 'streamed-turn');
            const project = async (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({
                session: transcript, provider: 'test.agent', runtimeMessageDeltaBridge: stream,
                event: { sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'streamed-turn', ...event },
            });
            await project({ kind: 'message-delta', channel: 'assistant', text: 'Draft' });
            await project({ kind: 'transcript-message-committed', role: 'assistant', messageId: 'provider-final', text: 'Actual final' });
            await project({ kind: 'turn-complete' });
            expect(committedResultLookups).toEqual([expect.any(String)]);
            expect(committedResultLookups[0]).not.toBe('provider-final');
            expect(replyMutations).toEqual([{ requestSessionId: 'session-1', requestLocalId: 'streamed-ask', operation: {
                kind: 'fulfill', turnId: 'streamed-turn', outcome: { kind: 'answer', result: {
                    sessionId: 'session-1', messageId: `committed:${committedResultLookups[0]}`,
                } }, nativeResult: { runId: 'run-1', sidechainId: 'sidechain-1', localId: committedResultLookups[0] },
            } }]);
        } finally { stream.clear(); await attachment.release(); }
    });

    it.each(['task_complete', 'turn_failed', 'turn_cancelled'] as const)('publishes payload-free %s for an exact native turn with no result', async (type) => {
        const { internals, attachment, acceptInput, replyMutations, releasedSourceTurns, committedResultLookups } = composeRetainedRun();
        try {
            await acceptInput('original-ask', 'native-turn');
            const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'message', message: type === 'turn_cancelled' ? '' : 'Intermediate output' }, {
                localId: 'intermediate-output', meta: { runtimeTurnId: 'native-turn', runtimeEventKind: 'transcript-message-committed' },
                provenance: { kind: 'non_dependent', source: 'external' },
            });
            if (type === 'task_complete') await transcript.enqueueAgentMessageCommitted('test.agent', {
                type: 'tool-call', id: 'last-tool', callId: 'last-tool', name: 'Read', input: {},
            }, { localId: 'last-tool', meta: { runtimeTurnId: 'native-turn' },
                provenance: { kind: 'non_dependent', source: 'external' } });
            await transcript.enqueueAgentMessageCommitted('test.agent', { type, id: 'native-turn' }, {
                localId: `native-turn:${type}`, meta: { runtimeTurnId: 'native-turn' },
                provenance: { kind: 'non_dependent', source: 'external' },
            });
            expect(committedResultLookups).toEqual([]);
            expect(replyMutations).toMatchObject([{ requestLocalId: 'original-ask', operation: { turnId: 'native-turn', outcome: {
                kind: type === 'task_complete' ? 'terminal_no_result' : type === 'turn_failed' ? 'failed' : 'cancelled',
            } } }]);
            expect(releasedSourceTurns).toEqual([{ sourceTurnId: 'native-turn', sourceInputId: 'original-ask' }]);
        } finally { await attachment.release(); }
    });

    it.each(['native', 'stop'] as const)('retains the exact committed partial across a later tool call on %s cancellation', async cancellation => {
        const { manager, internals, attachment, acceptInput, replyMutations, committedResultLookups } = composeRetainedRun();
        try {
            await acceptInput('stopped-input', 'stopped-native-turn');
            const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
            await projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', event: {
                kind: 'transcript-message-committed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'stopped-native-turn', messageId: 'partial-answer', role: 'assistant', text: 'Work so far',
            } });
            await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'tool-call', id: 'tool', callId: 'tool', name: 'Read', input: {} }, {
                localId: 'tool', meta: { runtimeTurnId: 'stopped-native-turn' }, provenance: { kind: 'non_dependent', source: 'external' },
            });
            if (cancellation === 'stop') expect(await manager.stop('run-1')).toMatchObject({ ok: true });
            else await transcript.enqueueAgentMessageCommitted('test.agent', { type: 'turn_cancelled', id: 'stopped-native-turn' }, {
                localId: 'cancelled', meta: { runtimeTurnId: 'stopped-native-turn' }, provenance: { kind: 'non_dependent', source: 'external' },
            });
            expect(committedResultLookups).toEqual(['partial-answer']);
            expect(replyMutations).toEqual([{ requestSessionId: 'session-1', requestLocalId: 'stopped-input', operation: {
                kind: 'fulfill', turnId: 'stopped-native-turn', outcome: { kind: 'cancelled', result: {
                    sessionId: 'session-1', messageId: 'committed:partial-answer',
                } }, nativeResult: { runId: 'run-1', sidechainId: 'sidechain-1', localId: 'partial-answer' },
            } }]);
        } finally { await attachment.release(); }
    });

    it.each([false, true])('releases the original source native turn when Stop retires its transcript writer (transport unavailable: %s)', async unavailable => {
        const { manager, internals, attachment, acceptInput, replyMutations, releasedSourceTurns } = composeRetainedRun(undefined, undefined, unavailable);
        try {
            await acceptInput('stopped-input', 'stopped-native-turn');
            expect(await manager.stop('run-1')).toMatchObject({ ok: true });
            expect(replyMutations).toMatchObject([{ requestLocalId: 'stopped-input', operation: {
                kind: 'fulfill', turnId: 'stopped-native-turn', outcome: { kind: 'cancelled' },
            } }]);
            expect(releasedSourceTurns).toEqual([{ sourceTurnId: 'stopped-native-turn', sourceInputId: 'stopped-input' }]);
            expect(internals.runs.get('run-1')?.status).toBe('cancelled');
        } finally { await attachment.release(); }
    });

    it('leaves a stopped partial pending when its exact committed lookup returns another sidechain', async () => {
        const { manager, internals, attachment, acceptInput, replyMutations, committedResultLookups } = composeRetainedRun(undefined, undefined, false, 'other-sidechain');
        try {
            await acceptInput('stopped-input', 'stopped-native-turn');
            const transcript = internals.createSessionOwnedRunScope('run-1')!.projectRunTranscriptSession();
            await projectRuntimeTranscriptEvent({ session: transcript, provider: 'test.agent', event: {
                kind: 'transcript-message-committed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'stopped-native-turn', messageId: 'partial-answer', role: 'assistant', text: 'Work so far',
            } });
            expect(await manager.stop('run-1')).toMatchObject({ ok: true });
            expect(committedResultLookups).toEqual(['partial-answer']);
            expect(replyMutations).toEqual([]);
        } finally { await attachment.release(); }
    });

    it('publishes active Voice turns independently of the retained handle and unread stream', async () => {
        const publicStates: ExecutionRunPublicState[] = [];
        const { manager, internals, attachment } = composeRetainedRun(undefined, (run) => publicStates.push(run));
        let releaseTurn!: () => void;
        const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
        const runtime = createTestExecutionRunHostRuntime({
            onSendPrompt: async () => { runtime.emitMessage({ type: 'model-output', fullText: 'answer' }); },
            onWaitForTurnCompletion: async () => { await turnGate; },
        });
        try {
            const started = await startExecutionRun({
                params: { sessionId: 'session-1', intent: 'voice_agent',
                    backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, permissionMode: 'read_only',
                    retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' },
                parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
                createRuntime: () => runtime, getNowMs: () => 1, budgetRegistry: null, runs: internals.runs,
                controllers: internals.controllers, enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
                finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }),
                voiceAgentManager: internals.voiceAgentManager,
                onPublicStateUpdated: (id) => internals.emitPublicStateUpdated(id),
            });
            expect.soft(manager.getPublic(started.runId)).toMatchObject({ status: 'running', turnInFlight: false });
            const stream = await manager.startTurnStream(started.runId, { message: 'hello' });
            expect(stream).toMatchObject({ ok: true });
            expect.soft(manager.getPublic(started.runId)).toMatchObject({ status: 'running', turnInFlight: true });
            expect.soft(publicStates.at(-1)).toMatchObject({ runId: started.runId, status: 'running', turnInFlight: true });
            releaseTurn();
            await vi.waitFor(() => expect(publicStates.at(-1)).toMatchObject({ runId: started.runId, status: 'running', turnInFlight: false }));
            expect(manager.get(started.runId)?.status).toBe('running');
        } finally {
            releaseTurn(); await attachment?.release(); await manager.dispose();
        }
    });

    it('uses the admitted initial basis for optional-ID completion and never lets an old controller resurrect a replacement', async () => {
        const { internals, attachment, emitRuntimeEvent, prepareScmInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'optional-id-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, comparison, outputs: ['walkthrough'], sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await prepareScmInput('initial:run-1');
            const scope = { cwd: '/repo', sessionId: 'session-1',
                resultId: (internals.runs.get('run-1')!.intentInput as { resultId: string }).resultId };
            emitRuntimeEvent({ kind: 'turn-start', turnId: 'initial-native', emittedAtMs: 2 });
            controller.buffer = JSON.stringify({ walkthrough: { title: 'Initial reading', intro: '', stops: [], otherChangeRefs: [] } });
            emitRuntimeEvent({ kind: 'turn-complete', turnId: 'initial-native', emittedAtMs: 3 });
            await controller.pendingHostBarrier;
            const first = await scmDiffSummaryResultStore.read(scope);
            if (!first.success) throw new Error(first.error);
            expect(first.result.output.outputs?.walkthrough?.value?.title).toBe('Initial reading');
            const replacement = await scmDiffSummaryResultStore.bindRun({ ...scope, expectedRevision: first.result.revision, runId: 'new-run' });
            if (!replacement.success) throw new Error(replacement.error);
            const manual = await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: replacement.result.revision,
                edit: { kind: 'renameWalkthrough', title: 'New manual title' } });
            if (!manual.success) throw new Error(manual.error);
            const published = internals.runs.get('run-1')!.structuredMeta;
            emitRuntimeEvent({ kind: 'turn-start', turnId: 'late-old-native', emittedAtMs: 4 });
            controller.buffer = JSON.stringify({ walkthrough: { title: 'Old controller overwrite', intro: '', stops: [], otherChangeRefs: [] } });
            emitRuntimeEvent({ kind: 'turn-complete', turnId: 'late-old-native', emittedAtMs: 5 });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')!.structuredMeta).toEqual(published);
            expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: {
                revision: manual.result.revision, output: { runId: 'new-run', outputs: { walkthrough: { value: { title: 'New manual title' } } } },
            } });
        } finally { await attachment?.release(); }
    });
    it('observes a findings-only completed review through the real raw host result and RPC projection', async () => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'review',
            intentInput: { reviewedFingerprint: 'actual-review-basis' } });
        try {
            await acceptInput('review-input', 'review-turn');
            controller.buffer = JSON.stringify({ summary: 'No findings', findings: [] });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'review-turn' });
            await controller.pendingHostBarrier;
            const published = internals.runs.get('run-1')!;
            await finishExecutionRun({ runId: 'run-1', next: { status: 'succeeded', finishedAtMs: 3 },
                toolResult: { output: published.latestToolResult }, structuredMeta: published.structuredMeta,
                runs: internals.runs, controllers: internals.controllers, budgetRegistry: null, parentProvider: TEST_BACKEND_ID,
                sendAcp: async () => undefined,
                // Durable filesystem/Session transport are boundaries; terminal materialization remains real.
                enqueueMarkerWrite: async () => undefined, terminalMarkerWritePromises: new Map(),
            });
            const rpc = createExecutionRunRpcActionDeps({ manager, context: { sessionId: 'session-1', cwd: '/repo' },
                isExecutionRunsEnabled: () => true, policy: { boundedTimeoutMs: null,
                    reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
            const snapshot = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!('session-1', { runId: 'run-1', includeStructured: true }));
            expect(snapshot.latestToolResult).toMatchObject({ findings: [], reviewedFingerprint: 'actual-review-basis' });
            expect(readActionCompletionRunObservationV1(snapshot)).toMatchObject({ kind: 'completed',
                reviewedFingerprint: 'actual-review-basis', materialization: { kind: 'complete' }, result: { findings: [] } });
        } finally { await attachment?.release(); }
    });
    it('projects failed comment materialization on retained review findings before any narration', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'review',
            intentInput: { reviewedFingerprint: 'captured-review-basis' } });
        try {
            await acceptInput('review-input', 'review-turn');
            controller.buffer = JSON.stringify({ summary: 'One finding', findings: [
                { id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Issue' },
            ] });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'review-turn' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running',
                error: { code: 'review_comment_materialization_failed' }, structuredMeta: { kind: 'review_findings.v2', payload: {
                    reviewedFingerprint: 'captured-review-basis', commentIds: [], materialization: { kind: 'failed' },
                    materializationFailures: [{ findingId: 'f1', errorCode: 'review_comment_materialization_unavailable' }],
                    findings: [{ id: 'f1' }],
                } } });
        } finally { await attachment?.release(); }
    });
    it.each([
        { modelId: 'selected-model', effectiveModelId: undefined, expectedModelId: 'selected-model' },
        { modelId: 'selected-model', effectiveModelId: 'native-model', expectedModelId: 'native-model' },
        { modelId: undefined, effectiveModelId: undefined, expectedModelId: undefined },
    ])('observes walkthrough completion through publication with Run model attribution ($expectedModelId)', async ({ modelId, effectiveModelId, expectedModelId }) => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        const retained = internals.runs.get('run-1')!;
        internals.runs.set('run-1', { ...retained, intent: 'scm_diff_summary',
            ...(modelId ? { launch: { ...retained.launch, modelId } } : {}),
            ...(effectiveModelId ? { effectiveEngine: { agentId: TEST_BACKEND_ID, modelId: effectiveModelId } } : {}), intentInput: {
            source: comparison.source, comparison, outputs: ['walkthrough'], sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        const rpc = createExecutionRunRpcActionDeps({ manager, context: { sessionId: 'session-1', cwd: '/repo' },
            isExecutionRunsEnabled: () => true, policy: { boundedTimeoutMs: null,
                reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
        const observed = rpc.executionRunGet!('session-1', { runId: 'run-1', includeStructured: true,
            waitForOutput: { kind: 'review_walkthrough', comparisonId: comparison.id } });
        try {
            await acceptInput('execution-run-initial:run-1', 'walkthrough-turn');
            controller.buffer = JSON.stringify({ walkthrough: { title: 'Explanation', intro: 'Captured comparison', stops: [], otherChangeRefs: [] } });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'walkthrough-turn' });
            expect(await observed).toMatchObject({ structuredMeta: { payload: { outputs: { walkthrough: { state: 'complete' } } } } });
            expect(manager.get('run-1')).toMatchObject({ status: 'running', structuredMeta: { payload: { outputs: { walkthrough: { state: 'complete' } } } } });
            const scope = { cwd: '/repo', sessionId: 'session-1',
                resultId: (internals.runs.get('run-1')!.intentInput as { resultId: string }).resultId };
            const saved = await scmDiffSummaryResultStore.read(scope);
            if (!saved.success) throw new Error(saved.error);
            expect(saved.result.output.outputs?.walkthrough?.state).toBe('complete');
            expect(saved.result.output.producer?.modelId).toBe(expectedModelId);
        } finally { await attachment?.release(); }
    });
    it.each(['native-failure', 'malformed-model'] as const)('settles prior admission uncertainty after current %s publishes failed walkthrough output', async (failure) => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary',
            error: { code: 'execution_run_send_outcome_unknown', message: 'Admission response was lost' },
            intentInput: { source: comparison.source, comparison, outputs: ['walkthrough'], sourceKey: comparison.id,
                metadata: { source: comparison.source, sourceKey: comparison.id } } });
        const rpc = createExecutionRunRpcActionDeps({ manager, context: { sessionId: 'session-1', cwd: '/repo' },
            isExecutionRunsEnabled: () => true, policy: { boundedTimeoutMs: null,
                reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
        try {
            await acceptInput('execution-run-initial:run-1', 'settled-turn');
            if (failure === 'native-failure') {
                emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                    turnId: 'settled-turn', diagnostic: { code: 'native_generation_failed', message: 'Native generation failed', severity: 'error' } });
            } else {
                controller.buffer = 'This turn did not return structured output.';
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'settled-turn' });
            }
            await controller.pendingHostBarrier;
            const snapshot = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!('session-1', { runId: 'run-1', includeStructured: true }));
            expect(snapshot).toMatchObject({ run: { status: 'running' }, latestToolResult: { outputs: { walkthrough: { state: 'failed' } } },
                structuredMeta: { payload: { outputs: { walkthrough: { state: 'failed' } } } } });
            expect(snapshot.run.error).toBeUndefined();
            expect(readActionCompletionRunObservationV1(snapshot, { kind: 'review_walkthrough', comparisonId: comparison.id }))
                .toMatchObject({ kind: 'completed', result: { outputs: { walkthrough: { state: 'failed' } } } });
            expect(internals.controllers.get('run-1')).toBe(controller);
        } finally { await attachment?.release(); }
    });
    it('provisions a deferred SCM narrator without admitting its prepared initial prompt', async () => {
        const { manager, internals, attachment, admittedParts } = composeRetainedRun();
        const runtime = internals.controllers.get('run-1')!.backend;
        const comparison = ScmComparisonSchema.parse({ id: 'deferred-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
                path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' },
                occurrences: [{ id: 'change-1', alias: 'c1', path: 'a.ts', position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
            }] } });
        const started = await startExecutionRun({ params: { sessionId: 'session-1', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id,
            instructions: 'Prepared narration must wait for all review engines.',
            initialInput: { kind: 'deferred_session_pending' },
            intentInput: { comparison, outputs: ['walkthrough'], metadata: { source: comparison.source, sourceKey: comparison.id },
                scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [], parts: [], supplied: [], analysed: [],
                    failures: [], failedRefs: [], completed: 0, totalParts: 1 } },
            permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' },
            parentProvider: 'claude', sendAcp: async () => undefined, streamedTranscriptSession: null, createRuntime: () => runtime,
            getNowMs: () => 1, budgetRegistry: null, runs: internals.runs, controllers: internals.controllers,
            enqueueMarkerWrite: async () => undefined, writeActivityMarker: async () => undefined,
            finishRun: async () => undefined, executeBoundedRun: async () => undefined, send: async () => ({ ok: true }),
            voiceAgentManager: new VoiceAgentManager({ createRuntime: () => runtime }),
            enqueueRetainedRunInitialInput: async ({ text, localId }) => { admittedParts.push({ text, localId }); return { status: 'accepted', localId }; },
            attachRetainedRunSessionInput: () => ({ release: async () => undefined, awaitInputAdmission: async () => 'accepted' }),
        });
        const controller = internals.controllers.get(started.runId)!;
        try {
            await controller.provisioningPromise;
            expect(controller.runtimeId).toBe('provider-session-1');
            expect(admittedParts).toEqual([]);
            expect(internals.runs.get(started.runId)?.structuredMeta?.payload).toMatchObject({ analysis: { parts: { completed: 0, total: 1 } } });
            expect(internals.runs.get(started.runId)).toMatchObject({ runClass: 'long_lived', status: 'running' });
        } finally { await manager.dispose(); await attachment?.release(); }
    });
    it('publishes failed requested output when initial generation completes with malformed prose and preserves it through later discussion', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, comparison, outputs: ['summary'], metadata: { source: comparison.source, sourceKey: comparison.id },
            sourceKey: comparison.id,
        } });
        try {
            await acceptInput('execution-run-initial:run-1', 'initial-generation');
            controller.buffer = 'I did not provide the requested structured result.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'initial-generation' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running', structuredMeta: { payload: {
                success: false, comparison, outputs: { summary: { state: 'failed' } },
            } } });
            const saved = internals.runs.get('run-1')?.structuredMeta;
            await acceptInput('discussion', 'later-discussion');
            controller.buffer = 'Ordinary later discussion.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'later-discussion' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')?.structuredMeta).toEqual(saved);
        } finally { await attachment?.release(); }
    });
    it.each(['complete', 'malformed-fragment'] as const)('partitions a single rejected occurrence at content boundaries with honest %s coverage', async (outcome) => {
        const { internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const diff = '@@ -1,2 +1,2 @@\n-old-a\n+new-a😀\n-old-b\n+new-b😀\n';
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
                path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: diff }, occurrences: [{ id: 'change-0', alias: 'c1', path: 'a.ts', position: 0,
                    before: { startLine: 1, lineCount: 2 }, after: { startLine: 1, lineCount: 2 } }],
            }] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, sourceKey: comparison.id, comparison, outputs: ['summary'],
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await acceptInput('full-evidence', 'full-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'full-turn', diagnostic: { code: 'agent_context_window_exceeded', severity: 'error' } });
            await controller.pendingHostBarrier;
            expect(admittedParts).toHaveLength(1);
            for (const index of [0, 1, 2]) {
                await acceptInput(admittedParts[index]!.localId, `fragment-${index}`);
                controller.buffer = outcome === 'malformed-fragment' && index === 0
                    ? 'A malformed completed fragment response.' : JSON.stringify({ summaryMarkdown: `Usable fragment ${index}` });
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: index + 3, emittedAtMs: index + 3,
                    turnId: `fragment-${index}` });
                await controller.pendingHostBarrier;
                if (index === 0) expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({ payload: {
                    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-0'] } } });
            }
            expect(admittedParts).toHaveLength(3);
            expect(admittedParts.slice(0, 2).map((part) => part.text).join('')).toContain('+new-a😀');
            expect(admittedParts.slice(0, 2).map((part) => part.text).join('')).toContain('+new-b😀');
            expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({ payload: {
                outputs: { summary: { state: outcome === 'complete' ? 'complete' : 'partial' } }, analysis: {
                    suppliedChangeRefs: ['change-0'], analysedChangeRefs: outcome === 'complete' ? ['change-0'] : [],
                    remainingChangeRefs: outcome === 'complete' ? [] : ['change-0'],
                } } });
        } finally { await attachment?.release(); }
    });
    it.each(['rejected', 'outcomeUnknown'] as const)('preserves usable parts after %s continuation admission without poisoning lifecycle custody', async (failure) => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun(failure);
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
                files: ['a.ts', 'b.ts'].map((path, index) => ({ path, changeKind: 'modified', binary: false,
                    generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: `@@ -1 +1 @@\n-old\n+new-${path}\n` },
                    occurrences: [{ id: `change-${index}`, alias: `c${index + 1}`, path, position: 0,
                        before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
                })),
            } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, sourceKey: comparison.id, comparison, outputs: ['summary'],
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await acceptInput('full-evidence', 'full-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'full-turn', diagnostic: { code: 'agent_context_window_exceeded', severity: 'error' } });
            await controller.pendingHostBarrier;
            await acceptInput(admittedParts[0]!.localId, 'part-a');
            controller.buffer = JSON.stringify({ summaryMarkdown: 'Usable part a' });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'part-a' });
            await expect(controller.pendingHostBarrier).resolves.toBeUndefined();
            expect(admittedParts).toHaveLength(2);
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running',
                error: { code: failure === 'outcomeUnknown' ? 'execution_run_send_outcome_unknown' : 'admission_boundary_failure' },
                structuredMeta: { payload: { summaryMarkdown: 'Usable part a', outputs: { summary: { state: failure === 'outcomeUnknown' ? 'writing' : 'partial' } },
                    analysis: { analysedChangeRefs: ['change-0'], remainingChangeRefs: ['change-1'] } } } });
            expect(internals.controllers.get('run-1')).toBe(controller);
            if (failure === 'outcomeUnknown') await manager.waitForOutput('run-1', { kind: 'review_walkthrough', comparisonId: comparison.id });
        } finally { await attachment?.release(); }
    });
    it('never invents a capacity retry from an unclassified failure or a cancelled controller', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: { kind: 'workingTree' }, metadata: { source: { kind: 'workingTree' }, sourceKey: 'test' },
        } });
        try {
            await acceptInput('unknown-input', 'unknown-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'unknown-turn', diagnostic: { code: 'unknown', severity: 'error' } });
            await controller.pendingHostBarrier;
            await acceptInput('cancelled-input', 'cancelled-turn');
            controller.cancelled = true;
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 3, emittedAtMs: 3,
                turnId: 'cancelled-turn', diagnostic: { code: 'agent_context_window_exceeded', severity: 'error' } });
            await controller.pendingHostBarrier;
            expect(admittedParts).toEqual([]);
        } finally { await attachment?.release(); }
    });

    it('partitions native-rejected evidence through new admissions on the same retained run and publishes integrated output', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
                files: ['a.ts', 'b.ts'].map((path, index) => ({ path, changeKind: 'modified', binary: false,
                    generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: `@@ -1 +1 @@\n-old-${path}\n+new-${path}\n` },
                    occurrences: [{ id: `change-${index}`, alias: `c${index + 1}`, path, position: 0,
                        before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
                })),
            } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, sourceKey: comparison.id, comparison, outputs: ['summary'],
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await acceptInput('full-evidence', 'full-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'full-turn', diagnostic: { code: 'agent_context_window_exceeded', message: 'Context window exceeded', severity: 'error' } });
            await vi.waitFor(() => expect(admittedParts).toHaveLength(1));
            expect(controller.lastInputTurn).toMatchObject({ turnId: 'full-turn', state: 'failed' });
            expect(admittedParts[0]?.text).toContain('+new-a.ts');
            expect(admittedParts[0]?.text).not.toContain('+new-b.ts');
            // Discussion may already be queued ahead of the host-authored next part.
            const pendingPartCount = admittedParts.length;
            await acceptInput('human-discussion', 'discussion-between-parts');
            controller.buffer = 'An ordinary explanation while generation continues.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3,
                turnId: 'discussion-between-parts' });
            await controller.pendingHostBarrier;
            expect(admittedParts).toHaveLength(pendingPartCount);
            for (const [index, summary] of ['Part a', 'Part b', 'Integrated result'].entries()) {
                await acceptInput(admittedParts[index]!.localId, `part-${index}`);
                controller.buffer = JSON.stringify({ summaryMarkdown: summary });
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: index + 3,
                    emittedAtMs: index + 3, turnId: `part-${index}` });
                await controller.pendingHostBarrier;
                if (index === 0) expect(internals.runs.get('run-1')?.intentInput).toMatchObject({
                    scmAnalysis: { current: ['change-1'], analysed: ['change-0'] },
                });
                if (index < 2) expect(admittedParts).toHaveLength(index + 2);
            }
            expect(admittedParts).toHaveLength(3);
            expect(admittedParts[2]?.text).not.toContain('+new-a.ts');
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running', structuredMeta: {
                payload: { summaryMarkdown: 'Integrated result', outputs: { summary: { state: 'complete' } },
                    analysis: { suppliedChangeRefs: ['change-0', 'change-1'], analysedChangeRefs: ['change-0', 'change-1'], remainingChangeRefs: [] } },
            } });
            expect(internals.controllers.get('run-1')).toBe(controller);
            expect(controller.runtimeId).toBe('provider-session-1');
        } finally { await attachment?.release(); }
    });

    it('publishes each structured retained turn without finishing the generator or replacing it with ordinary prose', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const run = internals.runs.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'turn-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...run, intent: 'scm_diff_summary', intentInput: {
            comparison, outputs: ['summary'], source: comparison.source, sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            for (const [index, summary] of ['First part.', 'Integrated explanation.'].entries()) {
                const turnId = `summary-turn-${index}`;
                if (index > 0) {
                    const input = internals.runs.get('run-1')!.intentInput as { resultId: string };
                    const admitted = await scmDiffSummaryResultStore.beginInput({ cwd: '/repo', sessionId: 'session-1',
                        resultId: input.resultId, inputId: `summary-input-${index}`, outputs: ['summary'] });
                    if (!admitted.success) throw new Error(admitted.error);
                }
                await acceptInput(`summary-input-${index}`, turnId);
                controller.buffer = JSON.stringify({ summaryMarkdown: summary });
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: index + 2,
                    emittedAtMs: index + 2, turnId });
                await vi.waitFor(() => expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({
                    kind: 'scm_diff_summary.v1', payload: { summaryMarkdown: summary },
                }));
                expect(internals.runs.get('run-1')?.status).toBe('running');
            }
            const previous = internals.runs.get('run-1')?.structuredMeta;
            await acceptInput('discussion-input', 'discussion-turn');
            controller.buffer = 'This is an ordinary answer about the code.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 5,
                emittedAtMs: 5, turnId: 'discussion-turn' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')?.structuredMeta).toEqual(previous);
            expect(internals.runs.get('run-1')?.status).toBe('running');
        } finally { await attachment?.release(); }
    });

    it('projects the exact native acceptance timestamp for a retained Workflow input', async () => {
        const { internals, attachment, emitRuntimeEvent } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const observations: unknown[] = [];
        controller.workflowObservation = {
            localInputId: 'workflow-retained', usage: createExactTurnUsageAccumulator(),
            sink: { commit: async (observation) => { observations.push(observation); } },
        };
        try {
            emitRuntimeEvent({ kind: 'input-accepted', sessionId: 'session-1', sequence: 1, emittedAtMs: 100,
                inputIds: ['unrelated-input'], delivery: { kind: 'newTurn', turnId: 'unrelated-turn' } });
            emitRuntimeEvent({ kind: 'input-accepted', sessionId: 'session-1', sequence: 2, emittedAtMs: 2_000,
                inputIds: ['workflow-retained'], delivery: { kind: 'newTurn', turnId: 'workflow-turn' } });
            await controller.pendingHostBarrier;
            expect(observations).toEqual([{ kind: 'input_accepted', runId: 'run-1',
                localInputId: 'workflow-retained', acceptedAtMs: 2_000 }]);
        } finally {
            await attachment?.release();
        }
    });

    it('observes a completed retained input under the same occurrence the public state exposes', async () => {
        const { manager, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        try {
            await acceptInput('input-1', 'turn-1');
            let observed: unknown = 'pending';
            const waiting = manager.waitForInputTurn('run-1', 'input-1').then((value) => { observed = value; });
            await Promise.resolve();
            expect(observed).toBe('pending');
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'turn-1' });
            await vi.waitFor(() => expect(observed).not.toBe('pending'), { timeout: 1_000 });
            await waiting;
            const publicTurns = manager.getPublic('run-1')?.inputTurns;
            expect(publicTurns).toMatchObject({
                occurrenceId: 'retained-occurrence-1',
                last: { turnId: 'turn-1', inputIds: ['input-1'], state: 'completed' },
            });
            // The blocking exact observation and the public state agree on one occurrence.
            expect(observed).toEqual({ occurrenceId: publicTurns?.occurrenceId, turn: publicTurns?.last });
        } finally {
            await attachment?.release();
        }
    });

    it('retains the cancelled retained input under the canonical occurrence when the Run is stopped', async () => {
        const { manager, internals, attachment, acceptInput } = composeRetainedRun();
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            comparison, sourceKey: comparison.id, metadata: { source: comparison.source, sourceKey: comparison.id }, outputs: ['summary', 'walkthrough'],
        }, structuredMeta: { kind: 'scm_diff_summary.v1', payload: { success: true, comparison, sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id }, requestedOutputs: ['summary', 'walkthrough'],
            outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Retained completed output' } }, walkthrough: { state: 'writing' } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        } } });
        try {
            await acceptInput('input-2', 'turn-2');
            expect(manager.getPublic('run-1')?.inputTurns).toMatchObject({
                occurrenceId: 'retained-occurrence-1',
                current: { turnId: 'turn-2', state: 'active' },
            });
            await manager.stop('run-1');
            expect(internals.controllers.has('run-1')).toBe(false);
            expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({ payload: { outputs: {
                summary: { state: 'complete', value: { summaryMarkdown: 'Retained completed output' } }, walkthrough: { state: 'cancelled' },
            } } });
            expect(internals.runs.get('run-1')?.inputTurns).toEqual({
                occurrenceId: 'retained-occurrence-1',
                last: { turnId: 'turn-2', inputIds: ['input-2'], state: 'cancelled' },
            });
            await expect(manager.waitForInputTurn('run-1', 'input-2')).resolves.toEqual({
                occurrenceId: 'retained-occurrence-1',
                turn: { turnId: 'turn-2', inputIds: ['input-2'], state: 'cancelled' },
            });
        } finally {
            await attachment?.release();
        }
    });
});
