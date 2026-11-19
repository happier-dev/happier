import { getSessionCommittedTranscriptLocalIds, loadCommittedTranscriptLocalIdBaseline } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AgentExecutionRunEvent,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentExecutionRunConversationRuntimeV1,
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
import { reloadConfiguration } from '@/configuration';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { buildStandardReviewPrompt } from '@/agent/reviews/prompt/buildStandardReviewPrompt';
import { readRetainedExecutionRunRecords } from '@/daemon/executionRunRegistry';
import type { ExecutionRunState } from './executionRunTypes';
import { finishExecutionRun } from './finishExecutionRun';
import { createExecutionRunControllerMessageHandler } from './messages/sessionStateEmission';
import { createPiRuntimeEventProjector } from '@happier-dev/plugins-pi/agent/runtime/rpc/events';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { readExecutionRunErrorCode } from './errors';

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

it.each(['bounded', 'long_lived'] as const)('refuses an unavailable native mode through the real %s Session-owned Run factory', async (runClass) => {
    const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
    const dispose = vi.fn();
    const runtime: AgentRuntime = { sessions: { async open(_request, context) {
        context.session.services.modes.bind({
            read: () => ({ modes: [{ id: 'build', name: 'Build' }], currentModeId: 'build' }),
            subscribe: () => ({ dispose() {} }),
        });
        return { send, dispose, watch: () => ({ dispose() {} }) };
    } } };
    const host = createVoiceSessionRuntimeThroughNativeFactory({ runtime, modelId: 'native-mode-fixture',
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        configuration: { mode: { value: 'default', updatedAtMs: 1 }, model: { value: null, updatedAtMs: 0 },
            permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
        start: { intent: runClass === 'bounded' ? 'memory_hints' : 'voice_agent', runClass, retentionPolicy: 'ephemeral' },
    });
    try {
        await expect(host.provisionRuntime({ initialPrompt: 'Do not send' }))
            .rejects.toMatchObject({ code: 'native_agent_session_mode_unavailable' });
        expect(send).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    } finally { await host.dispose(); }
});

it.each(['session', 'detached', 'execution-only'] as const)(
    'keeps Review intent separate from native Session input through the %s facet', async (facet) => {
        // The native process boundary validates the same envelope Muse and OpenCode accept.
        // Explicit execution-only review engines instead consume the Review payload itself.
        const intentInput = { engineId: 'native', engineIds: ['native'], instructions: 'Inspect the changed code',
            changeType: 'uncommitted', base: { kind: 'none' } };
        const prompt = buildStandardReviewPrompt({ instructions: 'Inspect the changed code', intentInput });
        for (const admission of ['provision', 'delivery'] as const) {
            // A valid explicit media envelope is the known-good control for this boundary.
            for (const structuredInput of [{ v: 1 } as const, undefined]) {
                const inputs: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionInput[] = [];
                const accept = (input: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionInput) => {
                    if (facet !== 'execution-only' && input.structuredInput !== undefined) {
                        HappierStructuredInputV1Schema.parse(input.structuredInput);
                        expect(input.structuredInput).toHaveProperty('v', 1);
                    }
                    inputs.push(input);
                };
                const executionRuns: NonNullable<AgentRuntime['executionRuns']> = { async open(request) {
                    if (request.kind === 'create') accept(request.input);
                    return {
                        async send(input) { accept(input); return { status: 'admitted' as const }; },
                        async stop() { return { status: 'requested' as const }; },
                        watch() { return { dispose() {} }; }, async dispose() {},
                    };
                } };
                const runtime: AgentRuntime = facet === 'session' ? { sessions: { async open() { return {
                    async send(request) { accept(request.input); return { status: 'admitted' as const }; },
                    watch() { return { dispose() {} }; }, async dispose() {},
                }; } } } : { executionRuns };
                const common = {
                    runtime, supportsResume: false,
                    lease: { pluginId: 'acme.native', pluginVersion: '1.0.0', agentId: 'acme.native/default',
                        localAgentId: 'default', occurrenceId: 'review-input-fixture', isCurrent: () => true },
                    options: { cwd: '/repo', runId: 'review-input-run', scope: 'detached' as const,
                        backendId: 'acme.native/default', permissionMode: 'read_only' as const,
                        start: { intent: 'review' as const, intentInput,
                            ...(structuredInput ? { structuredInput } : {}),
                            runClass: 'bounded' as const, retentionPolicy: 'ephemeral' as const } },
                };
                const host = facet === 'session'
                    ? createNativeAgentSessionExecutionRunHostRuntime({ ...common,
                        createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                    })
                    : createNativeAgentExecutionRunHostRuntime({ ...common,
                        ...(facet === 'detached' ? { executionRunContextV1: executionRuns } : {}),
                    });
                try {
                    await host.provisionRuntime(admission === 'provision' ? { initialPrompt: prompt } : undefined);
                    if (admission === 'delivery') {
                        await expect(host.deliverInput('review-input-run', { text: prompt })).resolves.toMatchObject({ status: 'admitted' });
                    }
                    expect(inputs).toEqual([{ text: prompt,
                        ...(structuredInput ? { structuredInput } : facet === 'execution-only' ? { structuredInput: intentInput } : {}),
                    }]);
                    expect(inputs[0]?.text).toContain('Inspect the changed code');
                    expect(inputs[0]?.text).toContain('uncommitted');
                } finally { await host.dispose(); }
            }
        }
    },
);

it.each(['session', 'retained-session', 'detached', 'execution-only'] as const)(
    'delivers ordinary Review transcript input through %s', async (facet) => {
        for (const admission of ['provision', 'delivery'] as const) {
            const inputs: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionInput[] = [];
            const observedEvents: unknown[] = [];
            const executionRuns: NonNullable<AgentRuntime['executionRuns']> = { async open(request) {
                if (request.kind === 'create') inputs.push(request.input);
                return { async send(input) { inputs.push(input); return { status: 'admitted' as const }; },
                    async stop() { return { status: 'requested' as const }; },
                    watch() { return { dispose() {} }; }, async dispose() {} };
            } };
            const runtime: AgentRuntime = facet === 'session' || facet === 'retained-session'
                ? { sessions: { async open(request) {
                    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
                    let sequence = 0;
                    return { async send(input) {
                        inputs.push(input.input);
                        listener?.({ kind: 'input-accepted', sessionId: request.sessionId,
                            sequence: ++sequence, emittedAtMs: sequence, inputIds: input.inputIds, delivery: input.delivery });
                        listener?.({ kind: 'transcript-message-committed', sessionId: request.sessionId,
                            sequence: ++sequence, emittedAtMs: sequence, messageId: 'native-user-message', role: 'user',
                            text: input.input.text, nativeContent: [{ type: 'text', text: input.input.text }] });
                        return { status: 'admitted' as const };
                    }, watch(next) { listener = next; return { dispose() {} }; }, async dispose() {} };
                } } } : { executionRuns };
            const resolveStructuredInputForDispatch: NonNullable<NativeAgentSessionContextLeaseFactory['resolveStructuredInputForDispatch']> = async ({ input }) => {
                return input;
            };
            const createSessionContext = Object.assign(
                ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) =>
                    createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                { resolveStructuredInputForDispatch },
            );
            const common = { runtime, supportsResume: false,
                lease: { pluginId: 'acme.private', pluginVersion: '1.0.0', agentId: 'acme.private/default',
                    localAgentId: 'default', occurrenceId: 'private-review', isCurrent: () => true },
                options: { cwd: '/repo', runId: 'private-review', scope: 'detached' as const,
                    backendId: 'acme.private/default', permissionMode: 'read_only',
                    start: { intent: 'review' as const, runClass: 'bounded' as const, retentionPolicy: 'ephemeral' as const } } };
            const host = facet === 'retained-session'
                ? createNativeAgentSessionInteractionHostRuntime({ ...common, createSessionContext,
                    sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false } })
                : facet === 'session'
                    ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, createSessionContext })
                    : createNativeAgentExecutionRunHostRuntime({ ...common, resolveStructuredInputForDispatch,
                        ...(facet === 'detached' ? { executionRunContextV1: executionRuns } : {}) });
            const authoredInput = { text: 'Review the implementation against the request.\n\nSource Session transcript (partial):\nPreserve the original behavior.' };
            host.subscribeRuntimeEvents?.(event => { observedEvents.push(event); });
            try {
                await host.provisionRuntime(admission === 'provision' ? { initialPrompt: authoredInput.text } : undefined);
                if (admission === 'delivery') {
                    await expect(host.deliverInput('private-review', authoredInput)).resolves.toMatchObject({ status: 'admitted' });
                }
                expect(inputs).toHaveLength(1);
                expect(inputs[0]?.text).toBe(authoredInput.text);
                if (facet === 'retained-session') {
                    expect(observedEvents).toContainEqual(expect.objectContaining({
                        kind: 'transcript-message-committed', text: authoredInput.text,
                    }));
                }
                // A bounded Session Run has one active input; retained Sessions
                // and finite execution runtimes expose ordinary follow-up sends.
                if (facet !== 'session') {
                    await expect(host.deliverInput('private-review', { text: 'Clarification: include the regression tests.' }, { localId: 'review-follow-up' }))
                        .resolves.toMatchObject({ status: 'admitted' });
                    expect(inputs).toHaveLength(2);
                    expect(inputs[1]?.text).toBe('Clarification: include the regression tests.');
                }
            } finally { await host.dispose(); }
        }
    },
);

it.each(['provider-secret-value', 'https://example.test/provider-secret'])(
'redacts Provider secrets quoted by native conversation end before Run subscribers retain it (%s)', async (secret) => {
    let publish: Parameters<AgentExecutionRunConversationRuntimeV1['watch']>[0] | undefined;
    let turnId = '';
    const observedEvents: unknown[] = [];
    const executionRuns: NonNullable<Parameters<typeof createNativeAgentExecutionRunHostRuntime>[0]['executionRunContextV1']> = {
        async open() { throw new Error('Expected retained native conversation'); },
        async openConversation() { return {
            async send(request) {
                turnId = request.delivery.turnId;
                return { status: 'admitted' as const };
            }, watch(listener) { publish = listener; return { dispose() {} }; }, async dispose() {},
        }; },
    };
    const host = createNativeAgentExecutionRunHostRuntime({ runtime: {}, executionRunContextV1: executionRuns,
        retainedConversation: true, supportsResume: false,
        lease: { pluginId: 'acme.private', pluginVersion: '1.0.0', agentId: 'acme.private/default',
            localAgentId: 'default', occurrenceId: 'private-runtime-end', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'private-runtime-end', scope: 'detached', backendId: 'acme.private/default',
            permissionMode: 'read_only', start: { intent: 'review' },
            sanitizeProviderDiagnosticText: text => text.replaceAll(secret, '[redacted]') },
    });
    host.subscribeRuntimeEvents?.(event => { observedEvents.push(event); });
    try {
        await host.provisionRuntime({ initialPrompt: 'Review the code' });
        publish?.({ kind: 'turn-complete', turnId });
        publish?.({ kind: 'runtime-ended', diagnostic: { code: 'provider_ended', severity: 'error', message: secret,
            details: { cause: { prompt: secret } }, remediation: { kind: 'openUrl',
                url: secret.startsWith('https:') ? secret : `https://example.test/${secret}` } } });
        expect(observedEvents).toEqual([expect.objectContaining({ kind: 'runtime-ended', diagnostic:
            expect.objectContaining({ code: 'provider_ended', message: '[redacted]' }) })]);
        expect(JSON.stringify(observedEvents)).not.toContain(secret);
        if (secret.startsWith('https:')) {
            expect(observedEvents.at(-1)).not.toHaveProperty('diagnostic.remediation');
        }
    } finally { await host.dispose(); }
});

it('redacts Provider secrets inside a finite native failure cause before public Run projection', async () => {
    const secret = 'provider-secret-in-native-failure';
    let publish: Parameters<AgentExecutionRunRuntime['watch']>[0] | undefined;
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { executionRuns: { async open(request) {
            return { async send() { return { status: 'admitted' as const }; },
                async stop() { return { status: 'requested' as const }; },
                watch(listener) { publish = listener; return { dispose() {} }; }, async dispose() {},
            };
        } } }, supportsResume: false,
        lease: { pluginId: 'acme.private', pluginVersion: '1.0.0', agentId: 'acme.private/default',
            localAgentId: 'default', occurrenceId: 'private-finite-failure', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'private-finite-failure', scope: 'detached', backendId: 'acme.private/default',
            permissionMode: 'read_only', start: { intent: 'review' },
            sanitizeProviderDiagnosticText: text => text.replaceAll(secret, '[redacted]') },
    });
    try {
        await host.provisionRuntime({ initialPrompt: 'Review the code' });
        publish?.({ kind: 'run-failed', runId: 'private-finite-failure', sequence: 1, emittedAtMs: 1,
            diagnostic: { code: 'provider_failed', severity: 'error', message: secret,
                details: { failureCause: { phase: 'turn', failureReason: 'unclassified_provider_error', providerErrorMessage: secret } } } });
        const failure = await host.waitForTurnCompletion!().catch((error: unknown) => error);
        expect(readExecutionRunErrorCode(failure)).toBe('provider_failed');
        expect(failure).toHaveProperty('runtimeIssueV1.failureCause.providerErrorMessage', '[redacted]');
        expect(JSON.stringify(failure)).not.toContain(secret);
    } finally { await host.dispose(); }
});

it('settles a native execution-only Run when send returns unavailable without a terminal event', async () => {
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { executionRuns: { async open() { return {
            async send() { return { status: 'unavailable' as const, diagnostic: { code: 'native_input_unavailable', severity: 'error' as const } }; },
            async stop() { return { status: 'notRunning' as const }; },
            watch() { return { dispose() {} }; }, async dispose() {},
        }; } } },
        lease: { pluginId: 'acme.execution-only', pluginVersion: '1.0.0', agentId: 'acme.execution-only/default',
            localAgentId: 'default', occurrenceId: 'unavailable-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'native-unavailable', scope: 'detached', backendId: 'acme.execution-only/default',
            permissionMode: 'no_tools', start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' } },
        supportsResume: false,
    });
    const outcome: { completed?: boolean; code?: string | null } = {};
    let completion: Promise<void> | undefined;
    try {
        await host.provisionRuntime({ initialPrompt: 'Initial input' });
        completion = host.waitForTurnCompletion!().then(() => { outcome.completed = true; }, error => { outcome.code = readExecutionRunErrorCode(error); });
        await expect(host.deliverInput('native-unavailable', { text: 'Follow up' })).rejects.toThrow();
        await Promise.resolve();
        expect(outcome).toEqual({ code: 'native_input_unavailable' });
    } finally { await host.dispose(); await completion; }
});

it.each([
    { intent: 'memory_hints' as const, expected: { pluginId: 'acme.agent', localId: 'memory-hints' } },
    { intent: 'scm_diff_summary' as const, expected: { pluginId: 'acme.agent', localId: 'scm-diff-summary' } },
    { intent: 'memory_hints' as const, profileId: 'acme.profiles/custom-profile', expected: { pluginId: 'acme.profiles', localId: 'custom-profile' } },
])('projects the selected host profile without changing explicit contribution identity: %j', async ({ intent, profileId, expected }) => {
    const requests: AgentExecutionRunOpenRequest[] = [];
    const runtime: AgentRuntime = { executionRuns: { async open(request) {
        requests.push(request);
        return {
            async send() { return { status: 'admitted' as const }; },
            async stop() { return { status: 'requested' as const }; },
            watch() { return { dispose() {} }; },
            async dispose() {},
        };
    } } };
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime,
        supportsResume: false,
        lease: { pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'acme.agent/default',
            localAgentId: 'default', occurrenceId: 'profile-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'profile-run', scope: 'detached', backendId: 'acme.agent/default', permissionMode: 'no_tools',
            start: { intent, ...(profileId ? { profileId } : {}), runClass: 'bounded', retentionPolicy: 'ephemeral' } },
    });
    try {
        await host.provisionRuntime({ initialPrompt: 'Prepared host input' });
        expect(requests[0]?.profile).toEqual(expected);
    } finally {
        await host.dispose();
    }
});

it.each(['finite', 'retained'] as const)('persists the corrected Pi artifact through the %s native Run adapter', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-corrected-artifact-'));
    vi.stubEnv('HAPPIER_HOME_DIR', root);
    reloadConfiguration();
    const runId = `pi-artifact-${kind}`;
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    const projector = createPiRuntimeEventProjector();
    const runtime: AgentRuntime = { sessions: { async open() { return {
        watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
        async send(request) {
            const turnId = request.delivery.turnId;
            const publish = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>) => {
                for (const listener of listeners) listener({ ...event, sequence: ++sequence,
                    sessionId: 'session-parent', emittedAtMs: sequence } as AgentSessionRuntimeEvent);
            };
            publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
            publish({ kind: 'turn-start', turnId, startedBy: 'host' });
            for (const record of [
                { type: 'message_start', message: { role: 'assistant', content: [] } },
                { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier result.\n' }] } },
                { type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'Read', args: {} },
                { type: 'message_start', message: { role: 'assistant', content: [] } },
                { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Draft report' } },
                { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Corrected report.\n' },
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Corrected report.\n' }] } },
                { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Corrected report.\n' }] } },
                { type: 'message_start', message: { role: 'assistant', content: [] } },
                { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Artifact delivered.' }] } },
            ]) {
                for (const event of projector.project(record, { turnId, agentSessionId: 'native-pi', nowMs: () => sequence + 1 })) {
                    const { emittedAtMs: _nativeTime, ...fact } = event;
                    publish(fact);
                }
            }
            publish({ kind: 'turn-complete', turnId });
            return { status: 'admitted' as const };
        },
        async dispose() {},
    }; } } };
    const common = {
        runtime,
        lease: { pluginId: 'acme.pi', pluginVersion: '1.0.0', agentId: 'acme.pi/default',
            localAgentId: 'default', occurrenceId: 'pi-artifact-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId, scope: 'session_owned' as const, backendId: 'acme.pi/default',
            permissionMode: 'read_only', start: { intent: 'memory_hints' as const, profileId: 'memory-hints', runClass: 'bounded' as const,
                retentionPolicy: 'ephemeral' as const } },
        createSessionContext: ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) =>
            createVoiceSessionContextLease({ services, signal, async dispose() {} }),
    };
    const host = kind === 'finite'
        ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, supportsResume: false })
        : createNativeAgentSessionInteractionHostRuntime({ ...common, sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false } });
    const { runtimeId } = await host.provisionRuntime();
    const ctrl: ExecutionRunBackendController = {
        kind: 'backend', controllerOccurrenceId: 'pi-artifact-controller', backend: host, backendSupportsResume: false, runtimeId,
        buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null, cancelled: false,
        turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
        admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
        terminalPromise: Promise.resolve(), resolveTerminal() {},
    };
    const state: ExecutionRunState = { runId, callId: 'original-call', sidechainId: 'original-sidechain',
        sessionId: 'session-parent', depth: 1, intent: 'memory_hints', backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        backendId: 'pi', instructions: 'Produce the report', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1 };
    const runs = new Map([[runId, state]]);
    const controllers = new Map([[runId, ctrl]]);
    const unsubscribe = host.subscribeMessages(createExecutionRunControllerMessageHandler({
        ctrl, runId, sidechainId: state.sidechainId, ioMode: state.ioMode, computeSidechainStreamText: (text) => text,
        sendAcp: async () => {}, parentProvider: 'pi', runs, backendSupportsResume: false,
        writeActivityMarker: async () => {}, getNowMs: () => 2,
    }));
    try {
        await executeBoundedBackendRun({ runId, callId: state.callId, sidechainId: state.sidechainId, startedAtMs: 1,
            params: state, controllers, runs, sendAcp: async () => {}, parentProvider: 'pi', getNowMs: () => 2, boundedTimeoutMs: null,
            finishRun: async (id, next, toolResult, structuredMeta) => {
                await finishExecutionRun({ runId: id, next, toolResult, structuredMeta, runs, controllers,
                    budgetRegistry: null, parentProvider: 'pi', sendAcp: async () => {}, enqueueMarkerWrite: (_id, write) => write(),
                    terminalMarkerWritePromises: new Map() });
            },
        });
        const expected = 'Earlier result.\nCorrected report.\nArtifact delivered.';
        expect(runs.get(runId)).toMatchObject({ status: 'succeeded', latestToolResult: expected });
        const retained = await readRetainedExecutionRunRecords();
        expect(retained.find((record) => record.state.runId === runId)?.state).toMatchObject({
            runId, callId: state.callId, sidechainId: state.sidechainId, latestToolResult: expected,
        });
    } finally {
        unsubscribe();
        await host.dispose();
        vi.unstubAllEnvs();
        reloadConfiguration();
        await rm(root, { recursive: true, force: true });
    }
});

async function createUnexpectedAgentRuntimeSurfaceInvocationContext(): Promise<never> {
    throw new Error('Execution-run fixture should not create an Agent runtime surface invocation context');
}

it.each(['plan', 'delegate'] as const)('repairs a bounded %s reply through the real Session runtime factory', async intent => {
    const runId = 'host-voice-run';
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    const prompts: string[] = [];
    let sequence = 0;
    const repaired = intent === 'plan'
        ? { summary: 'Child replied', sections: [{ title: 'Result', items: ['Reply received'] }], risks: [], milestones: [] }
        : { summary: 'Child replied', deliverables: [{ id: 'reply', title: 'Reply received' }] };
    // The external Agent SDK is the boundary. Factory selection, native Session
    // adaptation, bounded repair, profile parsing and terminal publication are real.
    const runtime: AgentRuntime = { sessions: { async open() { return {
        watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
        async send(request) {
            prompts.push(request.input.text);
            const publish = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>) => {
                for (const listener of listeners) listener({ ...event, sequence: ++sequence,
                    sessionId: 'session-parent', emittedAtMs: sequence } as AgentSessionRuntimeEvent);
            };
            const turnId = request.delivery.turnId;
            publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
            publish({ kind: 'turn-start', turnId, startedBy: 'host' });
            publish({ kind: 'message-delta', turnId, channel: 'assistant',
                text: prompts.length === 1 ? 'QA_CHILD_OK' : JSON.stringify(repaired) });
            publish({ kind: 'turn-complete', turnId });
            return { status: 'admitted' as const };
        },
        async cancel() { return { status: 'notRunning' as const }; },
        async dispose() {},
    }; } } };
    const host = createVoiceSessionRuntimeThroughNativeFactory({ runtime,
        capabilities: VOICE_INTERACTION_SESSION_CAPABILITIES, modelId: 'claude-haiku-4-5',
        start: { intent, runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response' } });
    const { runtimeId } = await host.provisionRuntime();
    const ctrl: ExecutionRunBackendController = {
        kind: 'backend', controllerOccurrenceId: 'bounded-repair', backend: host, backendSupportsResume: true, runtimeId,
        buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null, cancelled: false,
        turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
        admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
        terminalPromise: Promise.resolve(), resolveTerminal() {},
    };
    const state: ExecutionRunState = { runId, callId: 'repair-call', sidechainId: 'repair-sidechain',
        sessionId: 'session-parent', depth: 1, intent, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        backendId: 'claude', instructions: 'Reply exactly QA_CHILD_OK.', permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1 };
    const runs = new Map([[runId, state]]);
    const controllers = new Map([[runId, ctrl]]);
    const unsubscribe = host.subscribeMessages(createExecutionRunControllerMessageHandler({
        ctrl, runId, sidechainId: state.sidechainId, ioMode: state.ioMode, computeSidechainStreamText: text => text,
        sendAcp: async () => {}, parentProvider: 'claude', runs, backendSupportsResume: true,
        writeActivityMarker: async () => {}, getNowMs: () => 2,
    }));
    try {
        await executeBoundedBackendRun({ runId, callId: state.callId, sidechainId: state.sidechainId, startedAtMs: 1,
            params: state, controllers, runs, sendAcp: async () => {}, parentProvider: 'claude',
            getNowMs: () => 2, boundedTimeoutMs: null,
            finishRun: async (_id, next) => { runs.set(runId, { ...runs.get(runId)!, ...next }); },
        });
        expect(runs.get(runId)).toMatchObject({ status: 'succeeded', summary: 'Child replied' });
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain('QA_CHILD_OK');
    } finally { unsubscribe(); await host.dispose(); }
});

it.each(['bounded', 'retained', 'finite'] as const)('follows the child native source in its own %s Run context', async kind => {
    const observed: unknown[] = [];
    const runWrites = vi.fn(async () => ({ persisted: true, delivered: true }));
    const runUserWrites = vi.fn(async () => ({ persisted: true, delivered: true }));
    const parentWrites = vi.fn(async () => ({ persisted: true, delivered: true }));
    const disposedFollow = vi.fn(async () => {});
    let failSource!: (error: Error) => void;
    const failure = new Promise<Error>(resolve => { failSource = resolve; });
    let sourceBinding: Awaited<ReturnType<NonNullable<AgentSessionRuntimeContext['session']['services']['transcripts']['followSource']>>> | undefined;
    let nativeContext: AgentSessionRuntimeContext | undefined;
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const sourceRow = { type: 'assistant', uuid: 'child-source', message: { content: [] } };
    // The native Agent SDK and the daemon transport are external boundaries.
    // Factory selection, ordered baseline, source projector and durable writer stay real.
    const runtime: AgentRuntime = { sessions: { async open(_request, context) {
        nativeContext = context;
        return {
            async observeSourceTranscript(input) { observed.push(input); },
            watch(publish) { listener = publish; return { dispose() {} }; },
            async send(request) {
                sourceBinding = await context.session.services.transcripts.followSource!({ providerSessionId: 'native-child', replay: 'historical' });
                listener!({ kind: 'input-accepted', sequence: 1, sessionId: 'session-parent', emittedAtMs: 1,
                    inputIds: request.inputIds, delivery: request.delivery });
                listener!({ kind: 'turn-start', sequence: 2, sessionId: 'session-parent', emittedAtMs: 2,
                    turnId: request.delivery.turnId, startedBy: 'host' });
                listener!({ kind: 'turn-complete', sequence: 3, sessionId: 'session-parent', emittedAtMs: 3,
                    turnId: request.delivery.turnId });
                return { status: 'admitted' as const };
            },
            async dispose() {},
        };
    } } };
    const host = createVoiceSessionRuntimeThroughNativeFactory({ runtime, modelId: 'child-model',
        capabilities: { open: ['create'], delivery: kind === 'finite' ? ['steer'] : ['newTurn'], cancel: false },
        start: { intent: 'delegate', runClass: kind === 'retained' ? 'long_lived' : 'bounded',
            retentionPolicy: kind === 'retained' ? 'resumable' : 'ephemeral', ioMode: 'streaming' },
        session: { sessionId: 'session-parent', getMetadataSnapshot: () => ({ path: '/repo' }),
            updateMetadata: vi.fn(), updateAgentState: vi.fn(), enqueueAgentMessageCommitted: parentWrites,
            async fetchCommittedTranscriptLocalIdBaseline(input: { signal?: AbortSignal; deadlineAtMs?: number }) {
                return await loadCommittedTranscriptLocalIdBaseline({ ...input,
                    localIds: getSessionCommittedTranscriptLocalIds(this),
                    fetchPage: async () => ({ messages: [{ localId: 'already-written' }], hasMore: false, nextBeforeSeq: null }),
                });
            },
        } as never,
        sessionOwnedRunScope: { runId: 'host-voice-run', workDepth: 1, sidechainId: 'child-sidechain',
            readCurrentRunOccurrence: () => null, publishSupportedSessionReadActions() {},
            projectRunTranscriptSession: () => ({ sessionId: 'session-parent', requiresDurableTurnCompletionMarker: true,
                updateMetadata: vi.fn(), enqueueAgentMessageCommitted: runWrites, enqueueUserTextMessageCommitted: runUserWrites }),
        },
        externalSessionHostOperations: { bindSession(sessionId) {
            expect(sessionId).toBe('session-parent');
            return {
                async executeFollow() { throw new Error('Unexpected unscoped follow'); },
                async executeProviderSessionFollow(request) {
                    expect(request.providerSessionId).toBe('native-child');
                    await request.listener({ kind: 'data', phase: 'initial_replay', providerSessionId: 'native-child',
                        fromCursor: null, nextCursor: 'child-cursor', items: [
                            { kind: 'source_observation', id: 'child-source', timestampMs: 1, data: sourceRow },
                            { kind: 'user', id: 'child-input', localId: 'child-input', userProjection: 'source_fact', timestampMs: 1,
                                data: { role: 'user', content: { type: 'text', text: 'Child input' } } },
                            { kind: 'agent', id: 'duplicate', localId: 'already-written', timestampMs: 1,
                                data: { role: 'agent', content: { type: 'message', message: 'Already stored' } } },
                            { kind: 'agent', id: 'new', localId: 'child-display', timestampMs: 2,
                                data: { role: 'agent', content: { type: 'message', message: 'Child source display' } } },
                        ] });
                    return { status: 'following' as const, startingCursor: 'child-cursor', failure, subscription: { dispose: disposedFollow } };
                },
                async retire() {},
            };
        } },
    });
    try {
        await host.provisionRuntime();
        await host.deliverInput('host-voice-run', { text: 'Follow child output' });
        await host.waitForTurnCompletion?.();
        expect(observed).toEqual([{ providerSessionId: 'native-child', sourceId: 'child-source', row: sourceRow, phase: 'initial_replay' }]);
        expect(runWrites).toHaveBeenCalledOnce();
        expect(runWrites).toHaveBeenCalledWith('acme.voice/agents/default',
            expect.objectContaining({ type: 'message', message: 'Child source display' }),
            expect.objectContaining({ localId: 'child-display' }));
        expect(parentWrites).not.toHaveBeenCalled();
        expect(runUserWrites).toHaveBeenCalledWith('Child input', expect.objectContaining({ localId: 'child-input' }));
        expect(nativeContext?.session.id).toBe('session-parent');
        if (kind === 'retained') {
            const lost = new Error('child source channel lost');
            failSource(lost);
            await expect(sourceBinding?.failure).resolves.toBe(lost);
            expect(nativeContext?.signal.aborted).toBe(false);
        }
    } finally { await host.dispose(); }
    expect(disposedFollow).toHaveBeenCalledOnce();
});

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

it.each(['finite', 'retained'] as const)('isolates %s child hook resources from the live parent Session', async kind => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-child-run-hooks-'));
    const hooks = createSessionHooksService({ happyHomeDir, hasCapability: capability => capability === 'sessionHooks' });
    const identity = { providerId: 'acme.voice/agents/default', sessionId: 'session-parent',
        lifecycle: { kind: 'session' as const, sessionId: 'session-parent' } };
    const parent = await hooks.startServer({ ...identity });
    const parentDir = await hooks.createPluginDir({ ...identity, files: [{ path: 'origin.txt', contents: 'parent' }] });
    const child: { server: Awaited<ReturnType<typeof hooks.startServer>> | null; dir: string | null } = { server: null, dir: null };
    // An external Agent SDK fixture consumes the real public host hook services.
    // The host adapter, context binding, loopback server and filesystem remain real.
    const runtime: AgentRuntime = { sessions: { async open(_request, context) {
        child.server = await context.session.services.sessionHooks.startServer({});
        child.dir = await context.session.services.sessionHooks.createPluginDir({ files: [{ path: 'origin.txt', contents: 'child' }] });
        return {
            async send() { return { status: 'admitted' as const }; },
            async cancel({ turnId }) { return { status: 'requested' as const, turnId }; },
            watch() { return { dispose() {} }; },
            async dispose() { await child.server?.dispose(); if (child.dir) await context.session.services.sessionHooks.disposePluginDir(child.dir); },
        };
    } } };
    const common = {
        runtime,
        lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default',
            localAgentId: 'default', occurrenceId: 'hook-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: `run-hooks-${kind}`, scope: 'session_owned' as const,
            backendId: 'acme.voice/agents/default', permissionMode: 'no_tools' as const,
            start: { intent: 'scm_diff_summary' as const, runClass: 'long_lived' as const, retentionPolicy: 'resumable' as const } },
        createSessionContext: ({ services, signal }: Parameters<NativeAgentSessionContextLeaseFactory>[0]) =>
            createVoiceSessionContextLease({ services, signal, sessionHooks: hooks, async dispose() {} }),
    };
    const host = kind === 'finite'
        ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, supportsResume: false })
        : createNativeAgentSessionInteractionHostRuntime({ ...common, sessionCapabilities: VOICE_INTERACTION_SESSION_CAPABILITIES });
    try {
        await host.provisionRuntime({ initialPrompt: 'Propose commits without tools.' });
        expect(child.server).not.toBeNull();
        expect(child.dir).not.toBeNull();
        expect(child.server?.port).not.toBe(parent.port);
        expect(child.dir).not.toBe(parentDir);
        expect(await readFile(join(parentDir, 'origin.txt'), 'utf8')).toBe('parent');
        await host.dispose();
        await child.server?.dispose();
        expect((await fetch(`http://127.0.0.1:${parent.port}/unknown`)).status).toBe(404);
    } finally {
        await host.dispose();
        await child.server?.dispose();
        await parent.dispose();
        if (child.dir) await hooks.disposePluginDir(child.dir);
        await hooks.disposePluginDir(parentDir);
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

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
        const runtimeEvents: AgentExecutionRunEvent[] = [];
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
        const skillIndex = 'child-skill: Child-only skill index';
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
                skillIndex,
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
            expect(requests[0]?.input.text).toContain(skillIndex);
            expect(resolveStructuredInputForDispatch).toHaveBeenCalledWith({
                input: { text: 'Review the image', structuredInput },
                localId: 'input-with-media',
                signal: expect.any(AbortSignal),
            });
            expect(requests[0]?.input).toEqual({
                text: `${skillIndex}\n\nResolved context\n\nReview the image`,
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
                    origin: { kind: 'discussion' as const, serverId: 'server-1', discussionId: 'discussion-1', messageIds: ['message-1'] },
                    supportedReadActions: [
                        'session.transcript.get',
                        'discussion.read',
                    ] as const,
                },
            };
            const delivery = createRetainedExecutionRunInputDelivery(options);
            const outcomes: unknown[] = [];
            const unsubscribe = delivery.delivery.subscribeProviderInputOutcomes?.((outcome) => outcomes.push(outcome));
            const token = '[Source](happier-ref:session:source-session)';
            const reviewInput = buildReviewCommentsOutboundMessage({ sessionId: 'session-parent',
                drafts: [{ id: 'saved-change', filePath: 'src/value.ts', source: 'diff',
                    anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: 1, newLine: 1 },
                    snapshot: { selectedLines: ['+const value = "blue";'], beforeContext: [], afterContext: [] },
                    body: 'Explain the saved blue value.', createdAt: 1 }],
                additionalMessage: `${token} First input`,
            });
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
                expect(requests.at(-1)?.input.text).toContain('<happier_references v="1">');
                expect(requests.at(-1)?.input.text).toContain('source-session');
                expect(requests.at(-1)?.input.text).not.toContain('happier-ref:');
                expect(requests.at(-1)?.input.text).toContain('discussion-1');
                expect(requests.at(-1)?.input.text).toContain('session.transcript.get');
                expect(requests.at(-1)?.input.text).toContain('discussion.read');
                expect(requests.at(-1)?.input.text).not.toContain('discussion.post');
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

        const refusal = await host.provisionRuntime().catch((error: unknown) => error);
        expect(refusal).toMatchObject({ name: openFailure.name, message: openFailure.message });
        await expect(host.provisionRuntime()).rejects.toBe(refusal);
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
                values: { ALLOWED_VALUE: 'bounded', PATH: process.env.PATH },
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

    it.each(['saved', 'connected_account'] as const)('carries the exact %s Provider selection and bounded launch inputs without persistent Session inputs', async source => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() { return Object.freeze({ status: 'admitted' as const }); },
            async stop() { return Object.freeze({ status: 'requested' as const }); },
            watch() { return Object.freeze({ dispose: vi.fn() }); },
            async dispose() {},
        });
        const open = vi.fn(async (
            _request: AgentExecutionRunOpenRequest,
            _context: AgentRuntimeContext,
        ) => {
            if (_request.providerBinding && _request.configuration?.model.value !== _request.providerBinding.model.id) {
                throw new Error('Bound model configuration is not selectable');
            }
            return opened;
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const modelSelection = ProviderBoundModelRefSchema.parse({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: source === 'saved' ? 'pc_openai' : null,
            modelId: source === 'saved' ? 'gpt-5.1-codex' : 'native/gpt-5.1-codex',
        });
        const configuration = Object.freeze({
            mode: Object.freeze({ value: null, updatedAtMs: 0 }),
            model: Object.freeze({ value: modelSelection.modelId, updatedAtMs: 5 }),
            permissionIntent: Object.freeze({ value: 'default', updatedAtMs: 5 }),
            options: Object.freeze({
                reasoning_effort: Object.freeze({ value: 'high', updatedAtMs: 5 }),
            }),
        });
        const providerBinding = AgentSessionProviderBindingV1Schema.parse({
            ...(source === 'saved' ? { connectionId: 'pc_openai' } : { source: { kind: 'connected_account',
                purpose: { consumer: { pluginId: 'acme.agent', localId: 'agent' }, purpose: 'inference' },
                account: { service: { pluginId: 'acme.accounts', localId: 'accounts' }, accountId: 'selected' } } }),
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
            configuration: { ...configuration, model: { ...configuration.model, value: providerBinding.model.id } },
            providerBinding,
            runtimeDescriptorV1: options.runtimeDescriptorV1,
        }), expect.anything());
        expect(open.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
            connectedAccounts: expect.anything(),
            mcpServers: expect.anything(),
            startupInstructions: expect.anything(),
        }));
        expect(options.modelSelection).toEqual(modelSelection);
        expect(options.configuration?.model.value).toBe(modelSelection.modelId);
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
        for (const failure of [
            Object.assign(new Error(`open echoed ${secret}`), { executionRunErrorCode: 'provider_open_rejected' }),
            { rpcErrorCode: 'provider_open_rejected', message: `open echoed ${secret}`, details: { secret } },
            `open echoed ${secret}`,
        ]) {
            const failingOpenRuntime: AgentRuntime = Object.freeze({
                executionRuns: Object.freeze({ async open() { throw failure; } }),
            });
            const failingOpenHost = createNativeAgentExecutionRunHostRuntime({
                runtime: failingOpenRuntime,
                lease: createLease(failingOpenRuntime),
                options: baseOptions,
                supportsResume: false,
            });

            const refusal = await failingOpenHost.provisionRuntime({ initialPrompt: 'start' }).catch((error: unknown) => error);
            expect(refusal).toMatchObject({
                ...(typeof failure === 'object' ? { code: 'provider_open_rejected' } : {}),
                message: 'open echoed [REDACTED]',
            });
            expect(refusal).not.toHaveProperty('details');
            let terminalFailure: unknown;
            const completion = failingOpenHost.waitForTurnCompletion!().catch(error => { terminalFailure = error; });
            await vi.waitFor(() => expect(terminalFailure).toMatchObject({
                executionRunErrorCode: typeof failure === 'object' ? 'provider_open_rejected' : 'agent_execution_run_open_failed',
                message: 'open echoed [REDACTED]',
            }));
            await failingOpenHost.dispose();
            await completion;
        }

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
        await expect(activeHost.waitForTurnCompletion!()).rejects.toMatchObject({
            executionRunErrorCode: 'provider_send_rejected', message: 'send echoed [REDACTED]',
        });
        expect(messages).toContainEqual({ type: 'status', status: 'error', detail: 'send echoed [REDACTED]' });
        await expect(activeHost.cancel('run-provider-redaction'))
            .rejects.toThrow('stop echoed [REDACTED]');
        // Definite send rejection already settled this Run. Check provider-event
        // redaction on a fresh Run so a second terminal event cannot replace it.
        await activeHost.dispose();
        const eventHost = createNativeAgentExecutionRunHostRuntime({
            runtime: activeRuntime, lease: createLease(activeRuntime), options: baseOptions, supportsResume: false,
        });
        const eventMessages: AgentMessage[] = [];
        eventHost.subscribeMessages(message => eventMessages.push(message));
        await eventHost.provisionRuntime({ initialPrompt: 'start' });
        watchState.listener?.({
            sequence: 0,
            runId: 'run-provider-redaction',
            emittedAtMs: 1,
            kind: 'run-failed',
            diagnostic: {
                code: 'provider_run_failed',
                severity: 'error',
                message: `event echoed ${secret}`,
                details: { runtimeAuthClassification: { kind: 'usage_limit', serviceId: 'openai-codex',
                    source: 'structured_provider_error', resetsAtMs: 42_000 } },
            },
        });
        expect(eventMessages).toContainEqual({
            type: 'status',
            status: 'error',
            detail: 'event echoed [REDACTED]',
        });
        expect(failureLog).toHaveBeenCalledWith('[EXECUTION RUN] provider failure', {
            runId: 'run-provider-redaction', agentId: 'codex',
            phase: 'event', code: 'provider_run_failed',
            selectedMembers: [{ serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'happier', profileId: 'account-work', label: 'account-work' }],
        });
        expect(JSON.stringify(failureLog.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(failureLog.mock.calls)).not.toContain('private-policy-value');
        await expect(eventHost.waitForTurnCompletion!()).rejects.toMatchObject({
            executionRunErrorCode: 'provider_run_failed', message: 'event echoed [REDACTED]',
            runtimeIssueV1: { source: 'usage_limit', usageLimit: { resetAtMs: 42_000 } },
        });
        await eventHost.dispose();
    });

    it('sanitizes typed setup failures from a retained Session used by bounded Plans', async () => {
        const secret = 'retained-provider-secret';
        const runtime: AgentRuntime = { sessions: { async open() {
            throw { code: 'agent_startup_failed', message: `Setup refused ${secret}`, details: { secret } };
        } } };
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.agent', pluginVersion: '1.0.0', agentId: 'acme.agent/default',
                localAgentId: 'default', occurrenceId: 'retained-setup-failure', isCurrent: () => true },
            options: { cwd: '/repo', scope: 'session_owned', runId: 'plan-setup-failure', backendId: 'acme.agent/default',
                permissionMode: 'read_only', start: { intent: 'plan', runClass: 'bounded', retentionPolicy: 'ephemeral' },
                sanitizeProviderDiagnosticText: value => value.replaceAll(secret, '[REDACTED]') },
            sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        try {
            const refusal = await host.provisionRuntime().catch((error: unknown) => error);
            expect(refusal).toMatchObject({
                code: 'agent_startup_failed', message: 'Setup refused [REDACTED]',
            });
            expect(refusal).not.toHaveProperty('details');
        } finally { await host.dispose(); }
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
        expect(open.mock.calls[0]?.[0].launchEnvironment?.values.PATH).toBe(process.env.PATH);

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
