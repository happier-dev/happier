import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    AgentExecutionRunEvent,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentRuntime,
    AgentRuntimeContext,
    AgentSessionOpenRequest,
    AgentSessionRuntimeEvent,
    AgentSessionRuntime,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    AgentSessionProviderBindingV1Schema,
    PortableRuntimeDescriptorV1Schema,
    ProviderBoundModelRefSchema,
    buildReviewCommentsOutboundMessage,
    buildMentionRefForKindV1,
    MENTION_KIND_V1,
    createProviderErrorV1,
    type ExecutionRunResumeHandle,
} from '@happier-dev/protocol';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import { executeBoundedBackendRun } from './bounded/loop';
import { createRetainedExecutionRunInputDelivery } from './pending/retainedExecutionRunInputDelivery';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { createVoiceSessionContextLease, createVoiceSessionRuntimeThroughNativeFactory } from './testkit/nativeSessionContext';
import { logger } from '@/ui/logger';

import {
    createNativeAgentExecutionRunHostRuntime,
    createNativeAgentSessionExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
    type NativeAgentSessionContextLeaseFactory,
} from './nativeAgentExecutionRun';
import {
    composeNativeAgentSessionRuntimeContext,
    createNativeAgentSessionHostServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

async function createUnexpectedAgentRuntimeSurfaceInvocationContext(): Promise<never> {
    throw new Error('Execution-run fixture should not create an Agent runtime surface invocation context');
}

type UnsequencedSessionEvent<T> = T extends AgentSessionRuntimeEvent
    ? Omit<T, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never;

/**
 * Declared Session capabilities for the retained Voice interaction fixtures.
 * The host reads resume admission and every offered control from this one
 * declaration.
 */
const VOICE_INTERACTION_SESSION_CAPABILITIES: AgentSessionCapabilities = {
    open: ['create', 'resume'],
    delivery: ['newTurn'],
    cancel: true,
};

describe('retained native Voice conversation continuity', () => {
    it.each([
        { identityTiming: 'open', supportsResume: true },
        { identityTiming: 'first_turn', supportsResume: true },
        { identityTiming: 'open', supportsResume: false },
    ] as const)('projects native resume identity with $identityTiming publication and resume=$supportsResume', async ({ identityTiming, supportsResume }) => {
        const requests: AgentSessionOpenRequest[] = [];
        const published: Array<ExecutionRunResumeHandle | null> = [];
        const nativeSubscriptions: Array<(event: AgentSessionRuntimeEvent) => void> = [];
        const manager = new VoiceAgentManager({ onResumeHandleChanged: (_voiceAgentId, handle) => published.push(handle), createRuntime: ({ modelId }) => {
            const providerSessionId = `vendor-${modelId}`;
            const runtime: AgentRuntime = { sessions: { async open(request) {
                requests.push(request);
                if (request.kind === 'resume' && request.providerSessionId !== providerSessionId) {
                    throw new Error('Vendor session identity does not exist');
                }
                let listener: ((event: AgentSessionRuntimeEvent) => void) | null = null;
                let sequence = 0;
                const emit = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>) => listener?.({
                    ...event, sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                } as AgentSessionRuntimeEvent);
                return {
                    watch(next) {
                        listener = next;
                        nativeSubscriptions.push(next);
                        if (identityTiming === 'open') emit({ kind: 'provider-session-id', providerSessionId });
                        return { dispose() { listener = null; } };
                    },
                    async send(input) {
                        if (identityTiming === 'first_turn') emit({ kind: 'provider-session-id', providerSessionId });
                        const turnId = input.delivery.turnId;
                        emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                        emit({ kind: 'turn-start', turnId, startedBy: 'host' });
                        emit({ kind: 'message-delta', turnId, channel: 'assistant', text: `answer-${modelId}` });
                        emit({ kind: 'turn-complete', turnId });
                        return { status: 'admitted' as const };
                    },
                    async dispose() {},
                };
            } } };
            return createVoiceSessionRuntimeThroughNativeFactory({ runtime, modelId, capabilities: {
                ...VOICE_INTERACTION_SESSION_CAPABILITIES, cancel: false, open: supportsResume ? ['create', 'resume'] : ['create'],
            } });
        } });
        const params = {
            voiceAgentId: 'voice-continuity', backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
            chatModelId: 'chat', commitModelId: 'commit', commitIsolation: true, permissionIntent: 'read-only' as const,
            idleTtlSeconds: 60, initialContext: '',
        };
        try {
            await manager.start(params);
            if (identityTiming === 'first_turn') expect(manager.getResumeHandle(params.voiceAgentId)).toBeNull();
            await manager.sendTurn({ voiceAgentId: params.voiceAgentId, userText: 'remember blue' });
            await manager.commit({ voiceAgentId: params.voiceAgentId });
            const resumeHandle = manager.getResumeHandle(params.voiceAgentId);
            if (!supportsResume) {
                expect(resumeHandle).toBeNull();
                return;
            }
            expect(resumeHandle).toMatchObject({ kind: 'voice_agent_sessions.v1', chatProviderSessionId: 'vendor-chat', commitProviderSessionId: 'vendor-commit' });
            expect(published.at(-1)).toEqual(resumeHandle);
            await manager.stop({ voiceAgentId: params.voiceAgentId });
            await manager.start({ ...params, resumeHandle });
            const publicationsAfterResume = published.length;
            // A provider can race its detached watch disposal. Previous native
            // evidence must not publish through the resumed Voice occurrence.
            nativeSubscriptions[0]?.({ kind: 'provider-session-id', providerSessionId: 'vendor-chat', nativeSessionLogPath: '/old/late.log', sequence: 100, sessionId: 'session-parent', emittedAtMs: 100 });
            expect(published).toHaveLength(publicationsAfterResume);
            expect(manager.getResumeHandle(params.voiceAgentId)).toEqual(resumeHandle);
            expect(requests.filter((request) => request.kind === 'resume')).toMatchObject([
                { providerSessionId: 'vendor-chat' }, { providerSessionId: 'vendor-commit' },
            ]);
            await expect(manager.sendTurn({ voiceAgentId: params.voiceAgentId, userText: 'continue' })).resolves.toMatchObject({ assistantText: 'answer-chat' });
        } finally { await manager.dispose(); }
    });

    it.each([false, true])('preserves conversation and admitted Follow across cancel (runtime ends=%s)', async (runtimeEnds) => {
        const nativeListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const prompts: string[] = [];
        let sequence = 0;
        let openedSessions = 0;
        let cancelledTurnId: string | null = null;
        let sentSecond!: () => void;
        const secondSent = new Promise<void>((resolve) => { sentSecond = resolve; });
        const emit = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>) => {
            for (const listener of nativeListeners) listener({ ...event, sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence } as AgentSessionRuntimeEvent);
        };
        const open = async (): Promise<AgentSessionRuntime> => {
            const providerSessionId = `vendor-conversation-${++openedSessions}`;
            return {
            watch(listener) {
                nativeListeners.add(listener);
                emit({ kind: 'provider-session-id', providerSessionId });
                return { dispose() { nativeListeners.delete(listener); } };
            },
            async send(input) {
                prompts.push(input.input.text);
                const turnId = input.delivery.turnId;
                emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                emit({ kind: 'turn-start', turnId, startedBy: 'host' });
                if (prompts.length === 2) { cancelledTurnId = turnId; sentSecond(); }
                else {
                    if (cancelledTurnId) emit({ kind: 'message-delta', turnId: cancelledTurnId, channel: 'assistant', text: 'STALE CANCELLED OUTPUT <voice_actions>{"actions":[{"t":"ui.voice_agent.teleport","args":{"sessionId":"stale-effect-session"}}]}</voice_actions>' });
                    emit({ kind: 'message-delta', turnId, channel: 'assistant', text: prompts.length === 1 ? 'blue retained response' : 'continuing blue conversation' });
                    emit({ kind: 'turn-complete', turnId });
                }
                return { status: 'admitted' as const };
            },
            async cancel({ turnId }) {
                emit({ kind: 'turn-cancelled', turnId, cause: 'user' });
                if (runtimeEnds) emit({ kind: 'runtime-ended', cause: 'providerEnded', retryable: true });
                return { status: 'requested' as const, turnId };
            },
            async dispose() {},
            };
        };
        const runtime: AgentRuntime = { sessions: { open } };
        const acknowledgeAccepted = vi.fn();
        const manager = new VoiceAgentManager({
            prepareFollowContext: async () => ({ updates: [{
                v: 1, kind: 'session_follow_update', edge: { sourceSessionId: 'follow-source', destinationSessionId: 'session-parent' },
                reason: 'source_changed', deliveryIntent: 'context_only', observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
                awareness: { v: 1, sessionId: 'follow-source', lifecycle: 'ready', runtime: 'idle', freshness: 'live', operational: { primary: 'ready', reasons: ['ready'] }, encryption: 'plain', availability: 'complete' },
                recentMessages: [], truncated: false,
            }], acknowledgeAccepted }),
            createRuntime: () => createVoiceSessionRuntimeThroughNativeFactory({ runtime, modelId: 'chat', capabilities: VOICE_INTERACTION_SESSION_CAPABILITIES }),
        });
        try {
            const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat', commitModelId: 'chat', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
            await manager.sendTurn({ voiceAgentId, userText: 'remember blue' });
            const originalConversation = manager.getResumeHandle(voiceAgentId);
            const cancelled = await manager.startTurnStream({ voiceAgentId, userText: 'cancel this', durableUserTranscriptLocalId: 'voice-cancel-user' });
            await secondSent;
            expect(acknowledgeAccepted).toHaveBeenCalledOnce();
            expect(prompts[1]).toContain('follow-source');
            await manager.cancelTurnStream({ voiceAgentId, streamId: cancelled.streamId });
            const nextTurn = await manager.startTurnStream({ voiceAgentId, userText: 'continue blue' });
            let cursor = 0;
            const streamedEvents = [];
            for (;;) {
                const page = await manager.readTurnStream({ voiceAgentId, streamId: nextTurn.streamId, cursor, waitForEvents: true });
                streamedEvents.push(...page.events);
                cursor = page.nextCursor;
                if (page.done) {
                    expect(page.terminalEvent).toMatchObject({ t: 'voice_output', output: { kind: 'turn_final', text: 'continuing blue conversation' } });
                    break;
                }
            }
            expect(JSON.stringify(streamedEvents)).not.toContain('STALE CANCELLED OUTPUT');
            expect(JSON.stringify(streamedEvents)).not.toContain('stale-effect-session');
            expect(manager.getResumeHandle(voiceAgentId)).toMatchObject({ providerSessionId: runtimeEnds ? 'vendor-conversation-2' : 'vendor-conversation-1' });
            if (runtimeEnds) {
                expect(prompts[2]).toContain('remember blue');
                expect(prompts[2]).toContain('blue retained response');
                expect(prompts[2]).toContain('follow-source');
                expect(prompts[2]).not.toContain('cancel this');
            } else {
                expect(manager.getResumeHandle(voiceAgentId)).toEqual(originalConversation);
                expect(prompts[2]).toBe('User: continue blue\nVoice agent:');
            }
        } finally { await manager.dispose(); }
    });
});

describe('createNativeAgentExecutionRunHostRuntime', () => {
    it('joins exact-turn durable interaction retirement before reporting native turn completion', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const requests: Parameters<AgentSessionRuntime['send']>[0][] = [];
        let sequence = 0;
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) { requests.push(request); return { status: 'admitted' as const }; },
            async cancel({ turnId }) { return { status: 'requested' as const, turnId }; },
            watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
            async dispose() {},
        }; } } };
        const firstRetirement: { resolve: (() => void) | null } = { resolve: null };
        let completedBodyPresent = true;
        let retirementOrdinal = 0;
        const createSessionContext = Object.assign(
            ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) => (
                createVoiceSessionContextLease({ services, signal, async dispose() {} })
            ),
            {
                async onTurnTerminal() {
                    retirementOrdinal += 1;
                    if (retirementOrdinal === 1) {
                        await new Promise<void>((resolve) => { firstRetirement.resolve = resolve; });
                        completedBodyPresent = false;
                        return;
                    }
                    throw Object.assign(
                        new Error('Workflow interaction exceeds durable capacity'),
                        { code: 'workflow_interaction_capacity_exceeded', recoverable: true as const },
                    );
                },
            },
        );
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-cleanup', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only', start: { intent: 'agent', runClass: 'long_lived', retentionPolicy: 'resumable' } },
            sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
            createSessionContext,
        });
        const emitTurn = (request: Parameters<AgentSessionRuntime['send']>[0]) => {
            const events = [
                { kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery },
                { kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' },
                { kind: 'turn-complete', turnId: request.delivery.turnId },
            ] satisfies UnsequencedSessionEvent<AgentSessionRuntimeEvent>[];
            for (const event of events) {
                for (const listener of listeners) listener({
                    ...event, sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                });
            }
        };

        try {
            const { runtimeId } = await host.provisionRuntime();
            await host.deliverInput(runtimeId, { text: 'first' }, { localId: 'input-first' });
            const firstCompletion = host.waitForTurnCompletion!();
            let firstSettled = false;
            void firstCompletion.then(() => { firstSettled = true; });
            emitTurn(requests[0]!);
            await Promise.resolve();
            expect(firstSettled).toBe(false);
            expect(completedBodyPresent).toBe(true);
            firstRetirement.resolve?.();
            await firstCompletion;
            expect(completedBodyPresent).toBe(false);

            await host.deliverInput(runtimeId, { text: 'second' }, { localId: 'input-second' });
            const secondCompletion = host.waitForTurnCompletion!();
            emitTurn(requests[1]!);
            await expect(secondCompletion).rejects.toMatchObject({
                code: 'workflow_interaction_capacity_exceeded',
                recoverable: true,
            });
        } finally {
            firstRetirement.resolve?.();
            await host.dispose();
        }
    });

    it('does not mistake a retained Run send acknowledgement for provider input acceptance', async () => {
        const requests: Parameters<AgentSessionRuntime['send']>[0][] = [];
        const eventSource: { emit?: (event: AgentSessionRuntimeEvent) => void } = {};
        const contextReader: { read?: () => AgentInvocationTurnAdmissionWitness | null } = {};
        let rejectNext = false;
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                requests.push(request);
                return rejectNext
                    ? { status: 'rejected' as const, retryable: true, diagnostic: { code: 'provider_busy', severity: 'error' as const } }
                    : { status: 'admitted' as const };
            },
            async cancel({ turnId }) { return { status: 'requested' as const, turnId }; },
            watch(handler) { eventSource.emit = handler; return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-pending', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' } },
            sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
            createSessionContext: ({ services, signal, readActiveTurnAdmissionWitness }) => {
                contextReader.read = readActiveTurnAdmissionWitness;
                return createVoiceSessionContextLease({ services, signal, async dispose() {} });
            },
        });
        const { runtimeId } = await host.provisionRuntime();
        const controller: ExecutionRunBackendController = {
            kind: 'backend', controllerOccurrenceId: 'native-agent-controller-1', backend: host, backendSupportsResume: false, runtimeId,
            buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
            cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
            turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [],
            admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
            terminalPromise: Promise.resolve(), resolveTerminal() {},
        };
        const delivery = createRetainedExecutionRunInputDelivery({
            runId: 'run-pending', controller, authorizeProviderEffect: async () => ({ ok: true }),
        });
        const outcomes: unknown[] = [];
        const runtimeEvents: AgentSessionRuntimeEvent[] = [];
        host.subscribeRuntimeEvents?.((event) => runtimeEvents.push(event));
        delivery.delivery.subscribeProviderInputOutcomes?.((outcome) => outcomes.push(outcome));
        try {
            const result = await delivery.delivery.deliver({
                role: 'user', content: { type: 'text', text: 'Inspect this input' }, localId: 'pending-input',
                authorAccountId: 'alice', inputAdmissionReceipt: null, pendingProviderAction: 'send',
            });
            expect(result).toEqual({ status: 'admitted' });
            expect(requests[0]?.inputIds).toEqual(['pending-input']);
            expect(delivery.readActiveTurnAdmissionWitness()?.turnId).toBe(requests[0]?.delivery.turnId);
            expect(contextReader.read?.()?.inputId).toBe('pending-input');
            expect(outcomes).toEqual([]);
            eventSource.emit?.({
                kind: 'input-accepted', sessionId: 'session-parent', sequence: 1, emittedAtMs: 1,
                inputIds: ['pending-input'], delivery: requests[0]!.delivery,
            });
            expect(outcomes).toMatchObject([{
                kind: 'accepted', localId: 'pending-input', providerTurnId: requests[0]!.delivery.turnId,
            }]);
            const turnId = requests[0]!.delivery.turnId;
            expect(controller.currentInputTurn).toEqual({
                turnId, inputIds: ['pending-input'], state: 'active',
            });
            expect(controller.turnInFlight).toBe(true);
            eventSource.emit?.({ kind: 'turn-start', sessionId: 'session-parent', sequence: 2,
                emittedAtMs: 2, turnId, startedBy: 'host' });
            eventSource.emit?.({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 3,
                emittedAtMs: 3, turnId });
            expect(runtimeEvents.map((event) => event.kind)).toEqual(['input-accepted', 'turn-start', 'turn-complete']);
            expect(runtimeEvents.at(-1)).toMatchObject({ kind: 'turn-complete', turnId });
            expect(controller.currentInputTurn).toBeUndefined();
            expect(controller.lastInputTurn).toEqual({
                turnId, inputIds: ['pending-input'], state: 'completed',
            });
            expect(controller.turnInFlight).toBe(false);
            expect(controller.turnCount).toBe(1);
            expect(contextReader.read?.()).toBeNull();
            const retryInput = {
                role: 'user' as const, content: { type: 'text' as const, text: 'Retry after refusal' },
                localId: 'retry-input', authorAccountId: 'alice', inputAdmissionReceipt: null,
                pendingProviderAction: 'send' as const,
            };
            rejectNext = true;
            await delivery.delivery.deliver(retryInput);
            expect(outcomes.at(-1)).toMatchObject({ kind: 'rejected_before_effect', localId: 'retry-input' });
            rejectNext = false;
            expect(await delivery.delivery.deliver(retryInput)).toEqual({ status: 'admitted' });
            expect(requests.at(-1)?.inputIds).toEqual(['retry-input']);
        } finally {
            await host.dispose();
        }
    });

    it('preserves resolved structured media and references at the retained native input boundary', async () => {
        const requests: Parameters<AgentSessionRuntime['send']>[0][] = [];
        const openRequests: AgentSessionOpenRequest[] = [];
        const mcpServers = { custom: { command: '/managed/custom-mcp', args: ['--stdio'] } };
        const runtime: AgentRuntime = { sessions: { async open(request) { openRequests.push(request); return {
            async send(request) { requests.push(request); return { status: 'admitted' as const }; },
            async cancel({ turnId }) { return { status: 'requested' as const, turnId }; },
            watch() { return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const resolveStructuredInputForDispatch = vi.fn(async ({ input }: { input: { text: string; structuredInput?: unknown } }) => ({
            text: `Resolved context\n\n${input.text}`,
            structuredInput: { v: 1, resolvedComposerAttachments: [{ instanceId: 'review-1' }] },
        }));
        const createSessionContext = Object.assign(
            ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) => ({
                ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                mcpServers,
            }),
            { resolveStructuredInputForDispatch },
        ) satisfies NativeAgentSessionContextLeaseFactory;
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-structured', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' } },
            sessionCapabilities: { ...VOICE_INTERACTION_SESSION_CAPABILITIES, delivery: ['newTurn', 'steer'] },
            createSessionContext,
        });
        const structuredInput = { v: 1, imageInputs: [{ type: 'local_image', path: '/repo/review.png' }] };
        try {
            const { runtimeId } = await host.provisionRuntime();
            expect(openRequests[0]?.mcpServers).toEqual(mcpServers);
            await host.deliverInput(runtimeId, { text: 'Review the image', structuredInput }, {
                localId: 'input-with-media',
            });
            expect(resolveStructuredInputForDispatch).toHaveBeenCalledWith({
                input: { text: 'Review the image', structuredInput },
                localId: 'input-with-media',
                signal: expect.any(AbortSignal),
            });
            expect(requests[0]?.input).toEqual({
                text: 'Resolved context\n\nReview the image',
                structuredInput: { v: 1, resolvedComposerAttachments: [{ instanceId: 'review-1' }] },
            });
        } finally {
            await host.dispose();
        }
    });

    it('rejects unsupported detached structured input before native provider admission', async () => {
        const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
        const runtime: AgentRuntime = { sessions: { async open() { return {
            send,
            async cancel({ turnId }) { return { status: 'requested' as const, turnId }; },
            watch() { return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const unsupported = Object.assign(new Error('Attachment is unsupported'), {
            code: 'composer_attachment_resolution_unavailable',
            retryable: false,
        });
        const createSessionContext = Object.assign(
            ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) => (
                createVoiceSessionContextLease({ services, signal, async dispose() {} })
            ),
            { resolveStructuredInputForDispatch: vi.fn(async () => { throw unsupported; }) },
        ) satisfies NativeAgentSessionContextLeaseFactory;
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-unsupported', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only', start: { intent: 'agent', runClass: 'long_lived', retentionPolicy: 'resumable' } },
            sessionCapabilities: { ...VOICE_INTERACTION_SESSION_CAPABILITIES, delivery: ['newTurn'] },
            createSessionContext,
        });
        try {
            const { runtimeId } = await host.provisionRuntime();
            await expect(host.deliverInput(runtimeId, {
                text: 'Review this', structuredInput: { v: 1, composerAttachments: [] },
            }, { localId: 'workflow-input-unsupported' })).resolves.toMatchObject({
                status: 'rejected',
                diagnostic: { code: 'composer_attachment_resolution_unavailable' },
                retryable: false,
            });
            expect(send).not.toHaveBeenCalled();
        } finally {
            await host.dispose();
        }
    });

    it('initializes Run prompt context on its first accepted input and rebuilds it for a new provider occurrence', async () => {
        const requests: Parameters<AgentSessionRuntime['send']>[0][] = [];
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let sequence = 0;
        let rejectNextInput = true;
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                requests.push(request);
                if (rejectNextInput) {
                    rejectNextInput = false;
                    return { status: 'rejected' as const, diagnostic: { code: 'provider_refused', severity: 'error' as const }, retryable: false };
                }
                for (const event of [
                    { kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery },
                    { kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' },
                    { kind: 'turn-complete', turnId: request.delivery.turnId },
                ] satisfies UnsequencedSessionEvent<AgentSessionRuntimeEvent>[]) {
                    for (const listener of listeners) listener({ ...event, sequence: ++sequence,
                        sessionId: 'session-parent', emittedAtMs: sequence });
                }
                return { status: 'admitted' as const };
            },
            async cancel({ turnId }) { return { status: 'requested' as const, turnId }; },
            watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
            async dispose() {},
        }; } } };
        for (const occurrence of ['create', 'resume']) {
            const host = createNativeAgentSessionInteractionHostRuntime({
                runtime,
                lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                    localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
                options: { cwd: '/repo', runId: 'run-context', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                    permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' } },
                sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
                createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
            });
            const { runtimeId } = await host.provisionRuntime(occurrence === 'resume'
                ? { resumeRuntimeId: 'provider-session-existing' }
                : {});
            const controller: ExecutionRunBackendController = {
                kind: 'backend', controllerOccurrenceId: 'native-agent-controller-2', backend: host, backendSupportsResume: false, runtimeId,
                buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
                cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
                turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [],
                admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
                terminalPromise: Promise.resolve(), resolveTerminal() {},
            };
            let authorized = false;
            let publicationReady = false;
            const preparedInputs: string[] = [];
            let preparationGate = Promise.resolve();
            let onPreparationStarted: (() => void) | undefined;
            const options = {
                runId: 'run-context', controller, authorizeProviderEffect: async () => ({ ok: authorized }),
                beforeProviderInput: async (localId: string) => {
                    if (!publicationReady) throw new Error('Result revision is unavailable');
                    preparedInputs.push(localId);
                    onPreparationStarted?.();
                    await preparationGate;
                },
                readInitialProfileContext: () => 'Saved captured explanation: the retained change is blue.',
                sessionRunContext: {
                    kind: 'happier_session_run' as const, sessionId: 'session-parent',
                    origin: { kind: 'session_discussion' as const, discussionId: 'discussion-1', messageIds: ['message-1'] },
                    supportedReadActions: [
                        'session.transcript.get',
                        'session.discussion.read',
                    ] as const,
                },
            };
            const delivery = createRetainedExecutionRunInputDelivery(options);
            const outcomes: unknown[] = [];
            const unsubscribe = delivery.delivery.subscribeProviderInputOutcomes?.((outcome) => outcomes.push(outcome));
            const reviewInput = buildReviewCommentsOutboundMessage({ sessionId: 'session-parent',
                drafts: [{ id: 'saved-change', filePath: 'src/value.ts', source: 'diff',
                    anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: 1, newLine: 1 },
                    snapshot: { selectedLines: ['+const value = "blue";'], beforeContext: [], afterContext: [] },
                    body: 'Explain the saved blue value.', createdAt: 1 }],
                additionalMessage: '@session:source First input',
            });
            const token = '@session:source';
            const mentionStart = reviewInput.text.indexOf(token);
            const firstInput = {
                role: 'user' as const, content: { type: 'text' as const, text: reviewInput.text },
                localId: `${occurrence}-first`, authorAccountId: 'alice', inputAdmissionReceipt: null,
                pendingProviderAction: 'send' as const,
                meta: { ...reviewInput.metaOverrides, happierStructuredInputV1: { v: 1,
                    mentions: [{ kind: MENTION_KIND_V1.session,
                        ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session'),
                        token, start: mentionStart, end: mentionStart + token.length }] } },
            };
            try {
                expect((await delivery.delivery.deliver(firstInput)).status).toBe('rejected_before_effect');
                expect(preparedInputs).toEqual([]);
                authorized = true;
                const requestCountBeforePreparation = requests.length;
                expect((await delivery.delivery.deliver(firstInput)).status).toBe('rejected_before_effect');
                expect(requests).toHaveLength(requestCountBeforePreparation);
                publicationReady = true;
                if (occurrence === 'create') {
                    const rejectedInput = { ...firstInput, localId: 'create-rejected' };
                    await delivery.delivery.deliver(rejectedInput);
                    // The canonical outcome event, not the command result, proves refusal.
                    expect(outcomes).toMatchObject([{ kind: 'rejected_before_effect', localId: rejectedInput.localId }]);
                    expect(requests.at(-1)?.input.text).toContain('<happier_session_run>');
                }
                expect(await delivery.delivery.deliver(firstInput)).toEqual({ status: 'admitted' });
                expect(requests.at(-1)?.input.text).toContain('<happier_session_run>');
                expect(requests.at(-1)?.input.text).toContain('session-parent');
                expect(requests.at(-1)?.input.text).toContain('Saved captured explanation');
                expect(requests.at(-1)?.input.text).toContain('Explain the saved blue value.');
                expect(requests.at(-1)?.input.text).toContain('const value');
                expect(requests.at(-1)?.input.text).toContain('<happier_session_reference>');
                expect(requests.at(-1)?.input.text).toContain('source-session');
                expect(requests.at(-1)?.input.text).toContain('discussion-1');
                expect(requests.at(-1)?.input.text).toContain('session.transcript.get');
                expect(requests.at(-1)?.input.text).toContain('session.discussion.read');
                expect(requests.at(-1)?.input.text).not.toContain('session.discussion.post');
                expect((await delivery.delivery.deliver({ ...firstInput, localId: `${occurrence}-second`,
                    content: { type: 'text', text: 'Second input' }, meta: undefined })).status).toBe('admitted');
                expect(requests.at(-1)?.input.text).toContain('Second input');
                expect(requests.at(-1)?.input.text).not.toContain('<happier_session_run>');
                expect(requests.at(-1)?.input.text).not.toContain('Saved captured explanation');
                for (const invalidation of ['cancelled', 'replaced', 'revoked'] as const) {
                    let finishPreparation = () => {};
                    preparationGate = new Promise<void>((resolve) => { finishPreparation = resolve; });
                    const preparationStarted = new Promise<void>((resolve) => { onPreparationStarted = resolve; });
                    const requestsBeforePreparation = requests.length;
                    const preparing = delivery.delivery.deliver({ ...firstInput, localId: `${occurrence}-${invalidation}` });
                    await preparationStarted;
                    if (invalidation === 'cancelled') controller.cancelled = true;
                    if (invalidation === 'replaced') controller.runtimeId = 'replacement-runtime';
                    if (invalidation === 'revoked') authorized = false;
                    finishPreparation();
                    expect((await preparing).status).toBe('rejected_before_effect');
                    expect(requests).toHaveLength(requestsBeforePreparation);
                    controller.cancelled = false;
                    controller.runtimeId = runtimeId;
                    authorized = true;
                }
            } finally {
                unsubscribe?.();
                await host.dispose();
            }
        }
    });

    it('projects the retained adapter choice and the declared Session capabilities', async () => {
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send() { return { status: 'admitted' as const }; },
            async cancel({ turnId }: { turnId: string }) { return { status: 'requested' as const, turnId }; },
            watch() { return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const retained = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-projection', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' } },
            sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        expect(retained.interaction).toEqual({
            kind: 'retained_agent_session.v1',
            capabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
        });

        // A finite Session-derived Run is not interactive and must not project one.
        const finite = createNativeAgentSessionExecutionRunHostRuntime({
            runtime,
            lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-finite', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only', start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
            supportsResume: false,
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        expect(finite.interaction).toBeUndefined();
        await retained.dispose();
        await finite.dispose();
    });

    it.each([
        { kind: 'create' as const, resumeRuntimeId: undefined },
        { kind: 'resume' as const, resumeRuntimeId: 'provider-checkpoint-1' },
    ])('carries the exact Session MCP binding through the public finite Run request on $kind', async ({
        kind,
        resumeRuntimeId,
    }) => {
        const opened: AgentSessionOpenRequest[] = [];
        const mcpServers = Object.freeze({
            review: Object.freeze({ command: '/managed/review-mcp', args: Object.freeze(['--stdio']) }),
        });
        const runtime: AgentRuntime = { sessions: { async open(request) {
            opened.push(request);
            return {
                async send() { return { status: 'admitted' as const }; },
                watch() { return { dispose() {} }; },
                async dispose() {},
            };
        } } };
        const host = createNativeAgentSessionExecutionRunHostRuntime({
            runtime,
            lease: {
                pluginId: 'acme.finite',
                pluginVersion: '1.0.0',
                agentId: 'acme.finite/default',
                localAgentId: 'default',
                occurrenceId: 'fixture-occurrence',
                isCurrent: () => true,
            },
            options: {
                cwd: '/repo',
                runId: `run-mcp-${kind}`,
                scope: 'session_owned',
                backendId: 'acme.finite/default',
                permissionMode: 'read_only',
                start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' },
            },
            supportsResume: kind === 'resume',
            createSessionContext: ({ services, signal }) => ({
                ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                mcpServers,
            }),
        });

        await host.provisionRuntime(
            resumeRuntimeId ? { resumeRuntimeId } : { initialPrompt: 'review the current change' },
        );

        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({
            kind,
            sessionId: 'session-parent',
            cwd: '/repo',
            mcpServers,
            ...(resumeRuntimeId ? { providerSessionId: resumeRuntimeId } : {}),
        });
        await host.dispose();
    });

    it('exposes exact Session-context permission cleanup through the finite host runtime', async () => {
        const abortPendingPermissionRequests = vi.fn(async () => undefined);
        const createSessionContext = Object.assign(
            ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) =>
                createVoiceSessionContextLease({ services, signal, async dispose() {} }),
            { abortPendingPermissionRequests },
        );
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send() { return { status: 'admitted' as const }; },
            watch() { return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const host = createNativeAgentSessionExecutionRunHostRuntime({
            runtime,
            lease: { pluginId: 'acme.finite', pluginVersion: '1.0.0', agentId: 'acme.finite/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-permission-cleanup', scope: 'session_owned', backendId: 'acme.finite/default',
                permissionMode: 'default', start: { intent: 'delegate', runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral' } },
            supportsResume: false,
            createSessionContext,
        });

        await host.abortPendingPermissionRequests?.('Execution run settled');

        expect(abortPendingPermissionRequests).toHaveBeenCalledWith('Execution run settled');
        await host.dispose();
    });

    it('prevents a finite Session-derived Run from publishing the parent Session work state', async () => {
        const publishParentWorkState = vi.fn(async () => ({
            status: 'applied' as const,
            revision: 'parent-work-state-1',
            sourceSequence: 1,
        }));
        let openedContext: AgentSessionRuntimeContext | null = null;
        const runtime: AgentRuntime = { sessions: { async open(_request, context) {
            openedContext = context;
            return {
                async send() { return { status: 'admitted' as const }; },
                watch() { return { dispose() {} }; },
                async dispose() {},
            };
        } } };
        const host = createNativeAgentSessionExecutionRunHostRuntime({
            runtime,
            lease: { pluginId: 'acme.finite', pluginVersion: '1.0.0', agentId: 'acme.finite/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-finite-work-state', scope: 'session_owned', backendId: 'acme.finite/default',
                permissionMode: 'read_only', start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
            supportsResume: false,
            createSessionContext: ({ services, signal }) => {
                const parent = createVoiceSessionContextLease({ services, signal, async dispose() {} });
                return {
                    ...parent,
                    context: Object.freeze({
                        ...parent.context,
                        workState: Object.freeze({
                            publisher: () => Object.freeze({ publish: publishParentWorkState }),
                        }),
                    }),
                };
            },
        });

        await host.provisionRuntime();
        await host.deliverInput('run-finite-work-state', { text: 'inspect without parent publication' });
        const publication = await openedContext!.workState.publisher('finite-run').publish({} as never);

        expect(publication).toMatchObject({
            status: 'unavailable',
            diagnostic: { code: 'agent_run_session_projection_unavailable' },
        });
        expect(publishParentWorkState).not.toHaveBeenCalled();
        await host.dispose();
    });

    it('normalizes one attached Run usage event for the Session and exact Workflow owners', async () => {
        let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | null = null;
        const publishUsage = vi.fn(async () => undefined);
        const observeWorkflowUsage = vi.fn();
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send() { return { status: 'admitted' as const }; },
            watch(listener) {
                publishRuntimeEvent = listener;
                return { dispose() {} };
            },
            async dispose() {},
        }; } } };
        const host = createNativeAgentSessionExecutionRunHostRuntime({
            runtime,
            lease: { pluginId: 'acme.finite', pluginVersion: '1.0.0', agentId: 'acme.finite/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-usage', scope: 'session_owned', backendId: 'acme.finite/default',
                permissionMode: 'read_only', start: {
                    intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral', observeWorkflowUsage,
                } },
            supportsResume: false,
            createSessionContext: ({ services, signal }) => ({
                ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                usagePublisher: { provider: 'acme.finite/default', publish: publishUsage },
            }),
        });

        await host.provisionRuntime();
        await host.deliverInput('run-usage', { text: 'measure this run' });
        publishRuntimeEvent!({
            sequence: 1,
            sessionId: 'session-parent',
            emittedAtMs: 20,
            turnId: 'run-usage-turn-1',
            kind: 'usage-observed',
            observationId: 'usage-attached-1',
            source: 'provider',
            scope: 'turn_delta',
            modelId: 'model-a',
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
        });
        await vi.waitFor(() => expect(publishUsage).toHaveBeenCalledOnce());
        expect(publishUsage).toHaveBeenCalledWith(expect.objectContaining({
            externalKey: 'usage-attached-1',
            turnId: 'run-usage-turn-1',
            observation: expect.objectContaining({
                provider: 'acme.finite/default',
                tokens: expect.objectContaining({ total: 12 }),
            }),
        }));
        expect(observeWorkflowUsage).toHaveBeenCalledWith({
            turnId: 'run-usage-turn-1',
            observation: expect.objectContaining({
                provider: 'acme.finite/default',
                scope: 'turn_delta',
                tokens: expect.objectContaining({ input: 8, output: 4 }),
                availability: { inputTokens: true, outputTokens: true, reportedCostUsd: false },
            }),
        });
        await host.dispose();
    });

    it('waits for native cancellation before admitting a bounded replacement', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let sequence = 0;
        let activeTurnId: string | null = null;
        let releaseCancellation!: () => void;
        const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve; });
        let firstAdmitted!: () => void;
        const admitted = new Promise<void>((resolve) => { firstAdmitted = resolve; });
        const deliveries: string[] = [];
        const publish = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>) => {
            for (const listener of listeners) listener({ ...event, sequence: ++sequence,
                sessionId: 'session-parent', emittedAtMs: sequence } as AgentSessionRuntimeEvent);
        };
        // The external Agent boundary holds cancellation open until the test releases it.
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                if (activeTurnId) throw new Error('Provider turn is still active');
                activeTurnId = request.delivery.turnId;
                deliveries.push(activeTurnId);
                publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                publish({ kind: 'turn-start', turnId: activeTurnId, startedBy: 'host' });
                firstAdmitted();
                if (deliveries.length > 1) {
                    publish({ kind: 'turn-complete', turnId: activeTurnId });
                    activeTurnId = null;
                }
                return { status: 'admitted' };
            },
            async cancel({ turnId }) {
                await cancellation;
                activeTurnId = null;
                publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
                return { status: 'requested', turnId };
            },
            watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
            async dispose() {},
        }; } } };
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-interrupt', scope: 'session_owned', backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only', start: { intent: 'voice_agent' } },
            sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        const { runtimeId } = await host.provisionRuntime();
        const ctrl: ExecutionRunBackendController = {
            kind: 'backend', controllerOccurrenceId: 'native-agent-controller-3', backend: host, backendSupportsResume: false, runtimeId,
            buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
            cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
            turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [],
            admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
            terminalPromise: Promise.resolve(), resolveTerminal() {},
        };
        const run = executeBoundedBackendRun({
            runId: 'run-interrupt', callId: 'call-interrupt', sidechainId: 'side-interrupt', startedAtMs: 0,
            params: { sessionId: 'session-parent', intent: 'memory_hints',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                instructions: 'initial', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
                runClass: 'bounded', ioMode: 'request_response' },
            controllers: new Map([['run-interrupt', ctrl]]), sendAcp: async () => {},
            parentProvider: 'acme.voice/agents/default', getNowMs: () => 1, boundedTimeoutMs: null,
            finishRun: async () => {},
        });
        try {
            await Promise.race([
                admitted,
                run.then(() => { throw new Error('Bounded run ended before native input admission'); }),
            ]);
            await new Promise<void>((resolve, reject) => {
                ctrl.admittedLiveInterventions.push({ message: 'replacement', delivery: 'interrupt', resolve, reject });
                ctrl.admittedLiveInterventionsSignal?.resolve();
                ctrl.admittedLiveInterventionsSignal = null;
            });
            // Let the current dispatch drain while the provider still owns cancellation.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(deliveries).toHaveLength(1);
            releaseCancellation();
            await run;
            expect(deliveries).toHaveLength(2);
        } finally {
            releaseCancellation();
            await host.dispose();
        }
    });

    it.each([true, false])('keeps current-turn authority across retained Voice turns (startup authority: %s)', async (hasStartupAuthority) => {
        const firstAuthority = {
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: 'read-only' as const,
            sourceAuthority: {
                kind: 'mediatedExternal' as const,
                mediatorPluginId: 'acme.voice',
                sourceRef: 'conversation-1',
                sourceRevisionOrEpoch: '1',
                admittedPermissionCeiling: 'read-only' as const,
                remoteApprovalMaxScope: 'request' as const,
            },
        };
        const secondAuthority = {
            ...firstAuthority,
            admittedPermissionCeiling: 'default' as const,
            sourceAuthority: {
                ...firstAuthority.sourceAuthority,
                sourceRef: 'conversation-2',
                sourceRevisionOrEpoch: '2',
                admittedPermissionCeiling: 'default' as const,
            },
        };
        const nativeListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let sequence = 0;
        let activeTurnId: string | null = null;
        const publish = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>) => {
            for (const listener of nativeListeners) listener({
                ...event,
                sequence: ++sequence,
                sessionId: 'session-parent',
                emittedAtMs: sequence,
            } as AgentSessionRuntimeEvent);
        };
        const send = vi.fn(async (request: Parameters<AgentSessionRuntime['send']>[0]) => {
            const turnId = request.delivery.turnId;
            activeTurnId = turnId;
            publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
            if (request.delivery.kind === 'newTurn') {
                publish({ kind: 'turn-start', turnId, startedBy: 'host' });
            }
            publish({ kind: 'message-delta', turnId, channel: 'assistant', text: `answer-${send.mock.calls.length}` });
            if (request.input.text !== 'wait for cancellation') {
                publish({ kind: 'turn-complete', turnId });
                activeTurnId = null;
            }
            return { status: 'admitted' as const };
        });
        const cancel = vi.fn(async ({ turnId }: Parameters<NonNullable<AgentSessionRuntime['cancel']>>[0]) => {
            expect(turnId).toBe(activeTurnId);
            publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
            activeTurnId = null;
            return { status: 'requested' as const, turnId };
        });
        const disposeSession = vi.fn(async () => undefined);
        const disposeSessionContext = vi.fn(async () => undefined);
        const runtime: AgentRuntime = Object.freeze({
            sessions: Object.freeze({
                async open(
                    request: AgentSessionOpenRequest,
                    context: AgentSessionRuntimeContext,
                ) {
                    expect(request.sessionId).toBe('session-parent');
                    expect(context.session.id).toBe('session-parent');
                    expect(context.session.services.features.isEnabled('execution.runs')).toBe(true);
                    await expect(
                        context.workState.publisher('voice').publish({} as never),
                    ).resolves.toMatchObject({ status: 'unavailable' });
                    return {
                        send,
                        cancel,
                        watch(listener: (event: AgentSessionRuntimeEvent) => void) {
                            nativeListeners.add(listener);
                            return {
                                dispose: () => {
                                    nativeListeners.delete(listener);
                                },
                            };
                        },
                        dispose: disposeSession,
                    };
                },
            }),
        });
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.voice',
                pluginVersion: '1.0.0',
                agentId: 'acme.voice/agents/default',
                localAgentId: 'default',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext: createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-voice',
                scope: 'session_owned',
                backendId: 'acme.voice/agents/default',
                ...(hasStartupAuthority ? { causalPermissionAuthority: Object.freeze({
                    kind: 'admittedSessionInputV1' as const,
                    admittedPermissionCeiling: 'yolo' as const,
                }) } : {}),
                permissionMode: 'read_only',
                start: Object.freeze({ intent: 'voice_agent' as const }),
            }),
            sessionCapabilities: { ...VOICE_INTERACTION_SESSION_CAPABILITIES, delivery: ['newTurn', 'steer'] },
            createSessionContext: ({ services, signal }) =>
                createVoiceSessionContextLease({
                    services,
                    signal,
                    dispose: disposeSessionContext,
                }),
        });
        const messages: AgentMessage[] = [];
        host.subscribeMessages((message) => messages.push(message));

        await host.provisionRuntime();
        await host.deliverInput('run-voice', { text: 'first' }, { causalPermissionAuthority: firstAuthority });
        await host.waitForTurnCompletion?.();
        await host.deliverInput('run-voice', { text: 'second' }, { causalPermissionAuthority: secondAuthority });
        await host.waitForTurnCompletion?.();

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls.slice(0, 2).map(([request]) => request.causalPermissionAuthority)).toEqual([
            firstAuthority,
            secondAuthority,
        ]);
        expect(messages.filter((message) => message.type === 'model-output')).toEqual([
            { type: 'model-output', textDelta: 'answer-1' },
            { type: 'model-output', textDelta: 'answer-2' },
        ]);
        await host.deliverInput('run-voice', { text: 'wait for cancellation' });
        const steeredTurnId = activeTurnId;
        expect(host.steerInput).toBeTypeOf('function');
        await host.steerInput!('run-voice', { text: 'finish this turn' }, {
            localId: 'voice-steer-input',
            causalPermissionAuthority: secondAuthority,
        });
        await host.waitForTurnCompletion?.();
        expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
            delivery: { kind: 'steer', turnId: steeredTurnId },
            inputIds: ['voice-steer-input'],
            causalPermissionAuthority: secondAuthority,
        });
        expect(cancel).not.toHaveBeenCalled();
        await host.deliverInput('run-voice', { text: 'wait for cancellation' });
        await host.cancel('run-voice');
        await host.waitForTurnCompletion?.();
        expect(cancel).toHaveBeenCalledOnce();
        expect(messages).toContainEqual({ type: 'status', status: 'stopped' });
        await host.dispose();
        expect(disposeSession).toHaveBeenCalledOnce();
        expect(disposeSessionContext).toHaveBeenCalledOnce();
    });

    it('releases Session context custody once when Voice open fails and preserves that admission failure', async () => {
        const openFailure = new Error('voice Session open failed');
        const open = vi.fn(async () => {
            throw openFailure;
        });
        const runtime: AgentRuntime = Object.freeze({
            sessions: Object.freeze({ open }),
        });
        const disposeSessionContext = vi.fn(async () => undefined);
        const createSessionContext = vi.fn(({
            services,
            signal,
        }: Readonly<{
            services: AgentSessionRuntimeContext['services'];
            signal: AbortSignal;
        }>) =>
            createVoiceSessionContextLease({
                services,
                signal,
                dispose: disposeSessionContext,
            }));
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.voice',
                pluginVersion: '1.0.0',
                agentId: 'acme.voice/agents/default',
                localAgentId: 'default',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-voice-open-failure',
                scope: 'session_owned',
                backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'acme.session/assistant' }),
            }),
            sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
            createSessionContext,
        });

        await expect(host.provisionRuntime()).rejects.toBe(openFailure);
        await expect(host.provisionRuntime()).rejects.toBe(openFailure);
        expect(open).toHaveBeenCalledOnce();
        expect(createSessionContext).toHaveBeenCalledOnce();
        expect(disposeSessionContext).toHaveBeenCalledOnce();

        await host.dispose();
        expect(disposeSessionContext).toHaveBeenCalledOnce();
    });

    it('does not invoke provider open after Voice context acquisition races with disposal', async () => {
        let resolveContext!: (value: Readonly<{
            context: AgentSessionRuntimeContext;
            dispose(): Promise<void>;
        }>) => void;
        const contextPromise = new Promise<Readonly<{
            context: AgentSessionRuntimeContext;
            dispose(): Promise<void>;
        }>>((resolve) => { resolveContext = resolve; });
        let createContext!: () => ReturnType<typeof createVoiceSessionContextLease>;
        let current = true;
        const open = vi.fn(async () => {
            throw new Error('provider open must not be reached');
        });
        const disposeContext = vi.fn(async () => undefined);
        const runtime: AgentRuntime = Object.freeze({
            sessions: Object.freeze({ open }),
        });
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', generation: 'generation-1', hasPrimaryRuntime: true,
                isCurrent: () => current, retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext: createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo', runId: 'run-race', scope: 'session_owned', backendId: 'acme.voice/default', permissionMode: 'read_only',
                start: Object.freeze({ intent: 'voice_agent' as const }),
            }),
            sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES,
            createSessionContext: ({ services, signal }) => {
                createContext = () => createVoiceSessionContextLease({ services, signal, dispose: disposeContext });
                return contextPromise;
            },
        });
        const provisioning = host.provisionRuntime();
        await Promise.resolve();
        current = false;
        await host.dispose();
        resolveContext(createContext());
        await expect(provisioning).rejects.toThrow(/retired generation|disposed/);
        expect(open).not.toHaveBeenCalled();
        expect(disposeContext).toHaveBeenCalledOnce();
    });

    it('does not send the first derived Run input when Session open settles retired and cleanup never settles', async () => {
        let resolveSession!: (session: AgentSessionRuntime) => void;
        const openedSession = new Promise<AgentSessionRuntime>((resolve) => {
            resolveSession = resolve;
        });
        let current = true;
        const send = vi.fn(async () => ({ status: 'admitted' as const }));
        const disposeSession = vi.fn(async () => await new Promise<void>(() => {}));
        const disposeContext = vi.fn(async () => undefined);
        const open = vi.fn(async () => await openedSession);
        const runtime: AgentRuntime = Object.freeze({
            sessions: Object.freeze({ open }),
        });
        const lease = Object.freeze({
            pluginId: 'acme.session-run',
            pluginVersion: '1.0.0',
            agentId: 'acme.session-run/default',
            localAgentId: 'default',
            occurrenceId: 'fixture-occurrence',
            generation: 'generation-1',
            hasPrimaryRuntime: true,
            isCurrent: () => current,
            retirementSignal: new AbortController().signal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            async createRuntime() { return runtime; },
        });
        const host = createNativeAgentSessionExecutionRunHostRuntime({
            runtime,
            lease,
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-retired-open',
                scope: 'session_owned',
                backendId: 'acme.session-run/default',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'default' }),
            }),
            supportsResume: true,
            createSessionContext: ({ services, signal }) =>
                createVoiceSessionContextLease({
                    services,
                    signal,
                    dispose: disposeContext,
                }),
        });

        await host.provisionRuntime();
        const sending = host.deliverInput('run-retired-open', { text: 'must not be delivered' });
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        current = false;
        resolveSession(Object.freeze({
            send,
            watch() { return Object.freeze({ dispose() {} }); },
            dispose: disposeSession,
        }));

        await expect(sending).rejects.toThrow('retired generation');
        expect(send).not.toHaveBeenCalled();
        expect(disposeSession).toHaveBeenCalledOnce();
        expect(disposeContext).toHaveBeenCalledOnce();
        await host.dispose();
    });

    it('preserves the owning plugin and local id of a qualified execution profile', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const open = vi.fn(async (
            _request: AgentExecutionRunOpenRequest,
            _context: AgentRuntimeContext,
        ) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'happier.agent.deepsec',
                pluginVersion: '1.0.0',
                agentId: 'deepsec',
                localAgentId: 'deepsec',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                backendId: 'deepsec',
                scope: 'detached',
                permissionMode: 'read_only',
                start: Object.freeze({
                    profileId: 'happier.review.deepsec/repository-security-audit',
                }),
            }),
            supportsResume: false,
        });

        const beforeAdmission = Date.now();
        await host.provisionRuntime();
        await host.deliverInput('run-1', { text: 'Audit this repository' });

        expect(open).toHaveBeenCalledOnce();
        expect(open.mock.calls[0]?.[0].profile).toEqual({
            pluginId: 'happier.review.deepsec',
            localId: 'repository-security-audit',
        });
        expect(open.mock.calls[0]?.[1].invokedAtMs).toBeGreaterThanOrEqual(beforeAdmission);
        expect(open.mock.calls[0]?.[1].invokedAtMs).toBeLessThanOrEqual(Date.now());
        await host.dispose();
    });

    it.each([
        {
            label: 'create',
            provision: undefined,
            initialPrompt: 'Review this',
        },
        {
            label: 'resume',
            provision: { resumeRuntimeId: 'checkpoint-1' },
            initialPrompt: undefined,
        },
    ])('passes only the bounded launch environment to $label open requests', async ({ provision, initialPrompt }) => {
        vi.stubEnv('HAPPIER_EXECUTION_RUN_AMBIENT_ONLY', 'must-not-leak');
        const currentAuthority = {
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: 'read-only' as const,
        };
        const send = vi.fn<AgentExecutionRunRuntime['send']>(async () => ({ status: 'admitted' }));
        const opened: AgentExecutionRunRuntime = Object.freeze({
            send,
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const open = vi.fn(async (
            _request: AgentExecutionRunOpenRequest,
            _context: AgentRuntimeContext,
        ) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                localAgentId: 'agent',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                scope: 'detached',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                start: Object.freeze({
                    profileId: 'review',
                    localInputId: 'workflow-input-1',
                    resultContract: { kind: 'text' as const },
                }),
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1' as const,
                    admittedPermissionCeiling: 'yolo' as const,
                },
                isolation: Object.freeze({
                    env: Object.freeze({ ALLOWED_VALUE: 'bounded' }),
                    unsetEnvKeys: Object.freeze(['EXPLICITLY_UNSET']),
                }),
            }),
            supportsResume: true,
        });

        await host.provisionRuntime(provision);
        await host.deliverInput('run-1', { text: initialPrompt ?? 'Resume review' }, {
            causalPermissionAuthority: currentAuthority,
        });

        expect(open).toHaveBeenCalledOnce();
        const request = open.mock.calls[0]?.[0];
        expect(request).toMatchObject({
            launchEnvironment: {
                values: { ALLOWED_VALUE: 'bounded' },
                unset: ['EXPLICITLY_UNSET'],
            },
        });
        expect(request?.launchEnvironment?.values).not.toHaveProperty(
            'HAPPIER_EXECUTION_RUN_AMBIENT_ONLY',
        );
        if (provision) {
            expect(send.mock.calls[0]?.[1]?.causalPermissionAuthority).toEqual(currentAuthority);
        } else {
            if (request?.kind !== 'create') throw new Error('expected create request');
            expect(request?.causalPermissionAuthority).toEqual(currentAuthority);
            expect(request?.localInputId).toBe('workflow-input-1');
            expect(request?.resultContract).toEqual({ kind: 'text' });
        }
        await host.dispose();
    });

    it('carries the exact Provider selection and bounded launch inputs without persistent Session inputs', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() { return Object.freeze({ status: 'admitted' as const }); },
            async stop() { return Object.freeze({ status: 'requested' as const }); },
            watch() { return Object.freeze({ dispose: vi.fn() }); },
            async dispose() {},
        });
        const open = vi.fn(async (
            _request: AgentExecutionRunOpenRequest,
            _context: AgentRuntimeContext,
        ) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const modelSelection = ProviderBoundModelRefSchema.parse({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: 'pc_openai',
            modelId: 'gpt-5.1-codex',
        });
        const configuration = Object.freeze({
            mode: Object.freeze({ value: null, updatedAtMs: 0 }),
            model: Object.freeze({ value: 'gpt-5.1-codex', updatedAtMs: 5 }),
            permissionIntent: Object.freeze({ value: 'default', updatedAtMs: 5 }),
            options: Object.freeze({
                reasoning_effort: Object.freeze({ value: 'high', updatedAtMs: 5 }),
            }),
        });
        const providerBinding = AgentSessionProviderBindingV1Schema.parse({
            connectionId: 'pc_openai',
            model: {
                id: 'gpt-5.1-codex',
                name: 'GPT-5.1 Codex',
            },
            upstream: {
                protocol: 'openai-responses',
                normalizedUrl: 'https://api.openai.example/v1',
                credential: 'apiKey',
            },
            materialization: {
                v: 1 as const,
                kind: 'engineConfig' as const,
                engineConfig: { provider: 'openai' },
            },
        });
        const options: CreateCliExecutionRunBackendParams = Object.freeze({
            cwd: '/repo',
            runId: 'run-1',
            scope: 'detached',
            backendId: 'codex',
            permissionMode: 'default',
            runtimeDescriptorV1: PortableRuntimeDescriptorV1Schema.parse({
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'acp' },
            }),
            start: Object.freeze({ profileId: 'delegate' }),
            modelSelection,
            configuration,
            providerBinding,
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'happier.agent.codex',
                pluginVersion: '1.0.0',
                agentId: 'codex',
                localAgentId: 'codex',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options,
            supportsResume: true,
        });

        await host.provisionRuntime({ resumeRuntimeId: 'checkpoint-1' });

        expect(open).toHaveBeenCalledWith(expect.objectContaining({
            modelSelection,
            configuration,
            providerBinding,
            runtimeDescriptorV1: options.runtimeDescriptorV1,
        }), expect.anything());
        expect(open.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
            connectedAccounts: expect.anything(),
            mcpServers: expect.anything(),
            startupInstructions: expect.anything(),
        }));
        await host.dispose();
    });

    it('revalidates Provider authority after wrapper construction and rejects drift before public open', async () => {
        const open = vi.fn(async () => {
            throw new Error('public open must not run');
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const revalidateProviderBeforeOpen = vi.fn(async () => ({
            ok: false as const,
            error: createProviderErrorV1('provider_authorization_changed', {
                connectionId: 'pc_openai',
                machineId: 'machine-1',
            }),
        }));
        const options: CreateCliExecutionRunBackendParams & Readonly<{
            revalidateProviderBeforeOpen: typeof revalidateProviderBeforeOpen;
            sanitizeProviderDiagnosticText: (value: string) => string;
        }> = Object.freeze({
            cwd: '/repo',
            runId: 'run-provider-drift',
            scope: 'detached',
            backendId: 'codex',
            permissionMode: 'default',
            start: Object.freeze({ profileId: 'delegate' }),
            revalidateProviderBeforeOpen,
            sanitizeProviderDiagnosticText: (value) => value,
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'happier.agent.codex',
                pluginVersion: '1.0.0',
                agentId: 'codex',
                localAgentId: 'codex',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options,
            supportsResume: true,
        });

        expect(revalidateProviderBeforeOpen).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        await expect(host.provisionRuntime({ resumeRuntimeId: 'checkpoint-1' }))
            .rejects.toMatchObject({ message: 'provider_authorization_changed' });
        expect(revalidateProviderBeforeOpen).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        await host.dispose();
    });

    it('sanitizes Provider secrets echoed by async open, send, stop, and run-failed diagnostics', async () => {
        const secret = 'provider-secret-value';
        const failureLog = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const sanitizeProviderDiagnosticText = (value: string) =>
            value.replaceAll(secret, '[REDACTED]');
        const createLease = (runtime: AgentRuntime) => Object.freeze({
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            localAgentId: 'codex',
            occurrenceId: 'fixture-occurrence',
            generation: 'generation-1',
            hasPrimaryRuntime: true,
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            async createRuntime() { return runtime; },
        });
        const baseOptions = Object.freeze({
            cwd: '/repo',
            runId: 'run-provider-redaction',
            scope: 'detached' as const,
            backendId: 'codex',
            permissionMode: 'default',
            start: Object.freeze({ profileId: 'delegate' }),
            revalidateProviderBeforeOpen: async () => ({ ok: true as const }),
            sanitizeProviderDiagnosticText,
            isolation: { env: {
                ACCESS_TOKEN: secret,
                HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                    kind: 'group', serviceId: 'happier.agent.codex/openai-codex',
                    groupId: 'happier', activeProfileId: 'account-work',
                    fallbackProfileId: 'account-work', generation: 3,
                    policy: { privateValue: 'private-policy-value' },
                }]),
            } },
        });
        const failingOpenRuntime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({
                async open() { throw new Error(`open echoed ${secret}`); },
            }),
        });
        const failingOpenHost = createNativeAgentExecutionRunHostRuntime({
            runtime: failingOpenRuntime,
            lease: createLease(failingOpenRuntime),
            options: baseOptions,
            supportsResume: false,
        });

        await expect(failingOpenHost.provisionRuntime({ initialPrompt: 'start' }))
            .rejects.toThrow('open echoed [REDACTED]');
        await failingOpenHost.dispose();

        const watchState: {
            listener?: (event: AgentExecutionRunEvent) => void;
        } = {};
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return {
                    status: 'rejected' as const,
                    diagnostic: {
                        code: 'provider_send_rejected',
                        severity: 'error' as const,
                        message: `send echoed ${secret}`,
                    },
                };
            },
            async stop() { throw new Error(`stop echoed ${secret}`); },
            watch(listener: (event: AgentExecutionRunEvent) => void) {
                watchState.listener = listener;
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const activeRuntime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ async open() { return opened; } }),
        });
        const activeHost = createNativeAgentExecutionRunHostRuntime({
            runtime: activeRuntime,
            lease: createLease(activeRuntime),
            options: baseOptions,
            supportsResume: false,
        });
        const messages: AgentMessage[] = [];
        activeHost.subscribeMessages((message) => messages.push(message));

        await activeHost.provisionRuntime({ initialPrompt: 'start' });
        await expect(activeHost.deliverInput('run-provider-redaction', { text: 'again' }))
            .rejects.toThrow('send echoed [REDACTED]');
        await expect(activeHost.cancel('run-provider-redaction'))
            .rejects.toThrow('stop echoed [REDACTED]');
        watchState.listener?.({
            sequence: 0,
            runId: 'run-provider-redaction',
            emittedAtMs: 1,
            kind: 'run-failed',
            diagnostic: {
                code: 'provider_run_failed',
                severity: 'error',
                message: `event echoed ${secret}`,
            },
        });
        expect(messages).toContainEqual({
            type: 'status',
            status: 'error',
            detail: 'event echoed [REDACTED]',
        });
        expect(failureLog).toHaveBeenCalledWith('[EXECUTION RUN] provider failure', {
            runId: 'run-provider-redaction', agentId: 'codex',
            selectedMembers: [{ serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'happier', profileId: 'account-work', label: 'account-work' }],
        });
        expect(JSON.stringify(failureLog.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(failureLog.mock.calls)).not.toContain('private-policy-value');
        await activeHost.dispose();
    });

    it('fails a finite plugin Run when it emits an event outside the strict runtime contract', async () => {
        const watchState: { publish?: (event: AgentExecutionRunEvent) => void } = {};
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() { return { status: 'admitted' as const }; },
            async stop() { return { status: 'requested' as const }; },
            watch(listener: Parameters<AgentExecutionRunRuntime['watch']>[0]) {
                watchState.publish = listener;
                return { dispose() {} };
            },
            async dispose() {},
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ async open() { return opened; } }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.finite', pluginVersion: '1.0.0', agentId: 'acme.finite/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', generation: 'generation-1', hasPrimaryRuntime: true,
                isCurrent: () => true, retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext: createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo', runId: 'run-invalid-event', scope: 'detached', backendId: 'acme.finite/default',
                permissionMode: 'read_only', start: Object.freeze({ profileId: 'default' }),
            }),
            supportsResume: false,
        });

        await host.provisionRuntime({ initialPrompt: 'start' });
        watchState.publish?.({
            sequence: 1,
            runId: 'run-invalid-event',
            emittedAtMs: 1,
            kind: 'run-complete',
            unexpected: true,
        } as unknown as AgentExecutionRunEvent);

        await expect(host.waitForTurnCompletion?.()).rejects.toThrow('invalid runtime event');
        await host.dispose();
    });

    it('isolates a throwing host listener and detaches never-settling finite cleanup after terminal truth', async () => {
        const watchState: { publish?: (event: AgentExecutionRunEvent) => void } = {};
        const disposeRuntime = vi.fn(async () => {
            await new Promise<never>(() => undefined);
        });
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() { return { status: 'admitted' as const }; },
            async stop() { return { status: 'requested' as const }; },
            watch(listener: (event: AgentExecutionRunEvent) => void) {
                watchState.publish = listener;
                return { dispose: vi.fn() };
            },
            dispose: disposeRuntime,
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ async open() { return opened; } }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.finite',
                pluginVersion: '1.0.0',
                agentId: 'acme.finite/agents/default',
                localAgentId: 'default',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-listener-isolation',
                scope: 'detached',
                backendId: 'acme.finite/agents/default',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'delegate' }),
            }),
            supportsResume: false,
        });
        const messages: AgentMessage[] = [];
        host.subscribeMessages((message) => {
            if (message.type === 'status' && message.status === 'stopped') {
                throw new Error('projection failed');
            }
        });
        host.subscribeMessages((message) => messages.push(message));

        await host.provisionRuntime({ initialPrompt: 'start' });
        watchState.publish?.({
            sequence: 1,
            runId: 'run-listener-isolation',
            emittedAtMs: 1,
            kind: 'run-complete',
        });
        await host.waitForTurnCompletion?.();

        expect(messages).toContainEqual({ type: 'status', status: 'stopped' });
        await expect(host.dispose()).resolves.toBeUndefined();
        await expect(host.dispose()).resolves.toBeUndefined();
        expect(disposeRuntime).toHaveBeenCalledOnce();
    });

    it('disposes a plugin runtime that finishes opening after host disposal starts', async () => {
        let resolveOpened!: (runtime: AgentExecutionRunRuntime) => void;
        const openedPromise = new Promise<AgentExecutionRunRuntime>((resolve) => {
            resolveOpened = resolve;
        });
        const disposeOpened = vi.fn(async () => undefined);
        const open = vi.fn((_request: AgentExecutionRunOpenRequest) => openedPromise);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                localAgentId: 'agent',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                scope: 'detached',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'review' }),
            }),
            supportsResume: false,
        });

        await host.provisionRuntime();
        const sendResult = host.deliverInput('run-1', { text: 'Review this' }).catch((error: unknown) => error);
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        expect(open.mock.calls[0]?.[0]).not.toHaveProperty('launchEnvironment');

        const disposeResult = host.dispose();
        resolveOpened(Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            dispose: disposeOpened,
        }));

        await expect(disposeResult).resolves.toBeUndefined();
        await expect(sendResult).resolves.toBeInstanceOf(Error);
        expect(disposeOpened).toHaveBeenCalledOnce();
    });

    it('settles an active completion waiter when host disposal wins the terminal race', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({
                async open() {
                    return opened;
                },
            }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                localAgentId: 'agent',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                scope: 'detached',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'review' }),
            }),
            supportsResume: false,
        });

        await host.provisionRuntime();
        await host.deliverInput('run-1', { text: 'Review this' });
        const completion = host.waitForTurnCompletion?.();

        await host.dispose();

        await expect(completion).rejects.toMatchObject({
            name: 'AbortError',
            message: 'Native Agent execution run disposed',
        });
    });

    it('omits context.session for a detached execution-only Run instead of fabricating one from the run id', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const open = vi.fn(async (
            _request: AgentExecutionRunOpenRequest,
            _context: AgentRuntimeContext,
        ) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                localAgentId: 'agent',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-detached-1',
                scope: 'detached',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'review' }),
            }),
            supportsResume: false,
        });

        await host.provisionRuntime({ initialPrompt: 'start' });

        expect(open).toHaveBeenCalledOnce();
        expect(open.mock.calls[0]?.[1]).not.toHaveProperty('session');
        await host.dispose();
    });

    it('does not fabricate Session context for an execution-only Agent when the host Run is Session-owned', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const open = vi.fn(async (
            _request: AgentExecutionRunOpenRequest,
            _context: AgentRuntimeContext,
        ) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                localAgentId: 'agent',
                occurrenceId: 'fixture-occurrence',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-session-scoped-1',
                scope: 'session_owned',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                happierSessionId: 'happier-session-1',
                start: Object.freeze({ profileId: 'review' }),
            }),
            supportsResume: false,
        });

        await host.provisionRuntime({ initialPrompt: 'start' });

        expect(open).toHaveBeenCalledOnce();
        expect(open.mock.calls[0]?.[1]).toMatchObject({
            scope: { kind: 'execution_run', executionRunId: 'run-session-scoped-1' },
            executionRun: { id: 'run-session-scoped-1' },
        });
        expect(open.mock.calls[0]?.[1]).not.toHaveProperty('session');
        await host.dispose();
    });
});
