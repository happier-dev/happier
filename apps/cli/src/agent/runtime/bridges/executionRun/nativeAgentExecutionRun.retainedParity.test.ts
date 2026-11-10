import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { readRuntimeTurnFailureAlreadySurfacedEvent } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    createNativeAgentSessionExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
} from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import { createRetainedExecutionRunInputDelivery } from './pending/retainedExecutionRunInputDelivery';
import { createVoiceSessionRuntimeThroughNativeFactory, createNativeSessionBoundary } from './testkit/nativeSessionContext';
import { createDeferred } from '@/testkit/async/deferred';

describe('native Session Run parity', () => {
    it.each(['finite', 'retained'] as const)('awaits the %s Session context cleanup before retirement', async adapter => {
        const boundary = createNativeSessionBoundary();
        const cleanupEntered = createDeferred<void>();
        const releaseCleanup = createDeferred<void>();
        let cleanupFinished = false;
        const createHost = adapter === 'finite'
            ? createNativeAgentSessionExecutionRunHostRuntime
            : createNativeAgentSessionInteractionHostRuntime;
        const host = createHost({
            runtime: { sessions: { open: boundary.open } },
            lease: { pluginId: 'acme.cleanup', pluginVersion: '1.0.0', agentId: 'acme.cleanup/default',
                localAgentId: 'default', occurrenceId: 'cleanup-fixture', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-cleanup', scope: 'session_owned', backendId: 'acme.cleanup/default',
                permissionMode: 'read_only', start: { intent: 'review' } },
            supportsResume: false,
            sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal,
                async dispose() { cleanupEntered.resolve(); await releaseCleanup.promise; cleanupFinished = true; } }),
        });
        await host.provisionRuntime({ initialPrompt: 'Prepare the Session-owned Run' });
        boundary.complete();
        await host.waitForTurnCompletion?.();
        let retired = false;
        const retirement = host.dispose().then(() => { retired = true; });
        try {
            await cleanupEntered.promise;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(retired).toBe(false);
        } finally { releaseCleanup.resolve(); await retirement; }
        expect(cleanupFinished).toBe(true);
    });

    it.each(['bob', 'carol', null])('binds requester %s to the finite Run invocation without publishing it to the Agent', async accountId => {
        const attribution = materializeActionRequestAttributionV1({ requestRef: 'finite-request',
            requester: accountId ? { serverId: 'home', accountId } : null,
            persona: { serverId: 'home', sessionId: 'session-parent' }, origin: null });
        const boundary = createNativeSessionBoundary();
        const createSessionContext = vi.fn<Parameters<typeof createNativeAgentSessionExecutionRunHostRuntime>[0]['createSessionContext']>(
            ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }));
        const host = createNativeAgentSessionExecutionRunHostRuntime({ runtime: { sessions: { open: boundary.open } },
            lease: { pluginId: 'acme.cause', pluginVersion: '1.0.0', agentId: 'acme.cause/default',
                localAgentId: 'default', occurrenceId: 'finite-cause-fixture', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'finite-cause', scope: 'session_owned', backendId: 'acme.cause/default',
                permissionMode: 'read_only', actionRequestAttributionV1: attribution, start: { intent: 'delegate' } },
            supportsResume: true, createSessionContext });
        try {
            await host.provisionRuntime({ initialPrompt: 'Execute admitted work' });
            expect(createSessionContext.mock.calls[0]?.[0].actionRequestAttributionV1).toEqual(attribution);
            expect(boundary.opens[0]).not.toHaveProperty('actionRequestAttributionV1');
            expect(boundary.inputs[0]).not.toHaveProperty('actionRequestAttributionV1');
            boundary.complete();
            await host.waitForTurnCompletion?.();
        } finally { await host.dispose(); }
    });
    it('retains each admitted requester privately through the resumed retained Run owner', async () => {
        const boundary = createNativeSessionBoundary();
        let readWitness: (() => AgentInvocationTurnAdmissionWitness | null) | undefined;
        const runtime: AgentRuntime = { sessions: { open: boundary.open } };
        const host = createNativeAgentSessionInteractionHostRuntime({ runtime,
            lease: { pluginId: 'acme.cause', pluginVersion: '1.0.0', agentId: 'acme.cause/default',
                localAgentId: 'default', occurrenceId: 'cause-fixture', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-cause', scope: 'session_owned', backendId: 'acme.cause/default',
                permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'bounded', retentionPolicy: 'resumable' } },
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal, readActiveTurnAdmissionWitness }) => {
                readWitness = readActiveTurnAdmissionWitness;
                return createVoiceSessionContextLease({ services, signal, async dispose() {} });
            },
        });
        const controller: ExecutionRunBackendController = {
            kind: 'backend', controllerOccurrenceId: 'cause-controller', backend: host, backendSupportsResume: true,
            runtimeId: 'run-cause', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
            cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
            admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
            terminalPromise: Promise.resolve(), resolveTerminal() {},
        };
        const delivery = createRetainedExecutionRunInputDelivery({ runId: 'run-cause', controller,
            authorizeProviderEffect: async () => ({ ok: true }) });
        try {
            await host.provisionRuntime({ resumeRuntimeId: 'registry-native-session' });
            const attribution = materializeActionRequestAttributionV1({ requestRef: 'bob-input',
                requester: { serverId: 'home', accountId: 'bob' }, persona: { serverId: 'home', sessionId: 'session-parent' }, origin: null });
            await expect(delivery.delivery.deliver({ role: 'user', content: { type: 'text', text: 'Bob request' },
                localId: 'bob-input', authorAccountId: 'bob', inputAdmissionReceipt: null, pendingProviderAction: null,
                actionRequestAttributionV1: attribution })).resolves.toEqual({ status: 'admitted' });
            expect(readWitness?.()?.actionRequestAttributionV1).toEqual(attribution);
            expect(host.readActiveTurnAdmissionWitness?.()?.actionRequestAttributionV1).toEqual(attribution);
            expect(boundary.inputs[0]).not.toHaveProperty('actionRequestAttributionV1');
            boundary.complete();
            await host.waitForTurnCompletion?.();
            expect(readWitness?.()).toBeNull();
            const autonomous = materializeActionRequestAttributionV1({ ...attribution, requestRef: 'autonomous-input', requester: null });
            await host.deliverInput('run-cause', { text: 'Autonomous continuation' }, {
                localId: 'autonomous-input', actionRequestAttributionV1: autonomous });
            expect(readWitness?.()?.actionRequestAttributionV1).toEqual(autonomous);
            boundary.complete();
            await host.waitForTurnCompletion?.();
        } finally { delivery.dispose(); await host.dispose(); }
    });
    it.each(['send', 'steer'] as const)('projects an attributed retained input only once through native %s', async action => {
        const boundary = createNativeSessionBoundary();
        const host = createVoiceSessionRuntimeThroughNativeFactory({ runtime: { sessions: { open: boundary.open } },
            modelId: 'fixture', capabilities: { open: ['create', 'resume'], delivery: ['newTurn', 'steer'], cancel: false },
            start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' } });
        const runId = 'host-voice-run';
        const controller: ExecutionRunBackendController = {
            kind: 'backend', controllerOccurrenceId: 'framing-controller', backend: host, backendSupportsResume: true,
            runtimeId: runId, buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
            cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
            admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
            terminalPromise: Promise.resolve(), resolveTerminal() {},
        };
        const delivery = createRetainedExecutionRunInputDelivery({ runId, controller,
            authorizeProviderEffect: async () => ({ ok: true }) });
        try {
            await host.provisionRuntime({ resumeRuntimeId: 'registry-native-session' });
            if (action === 'steer') await host.deliverInput(runId, { text: 'Initial input' }, { localId: 'initial' });
            const text = String.raw`[\[Inner\](happier-ref:session:inner)](happier-ref:session:outer)`;
            expect(await delivery.delivery.deliver({ role: 'user', content: { type: 'text', text },
                localId: 'framed', authorAccountId: 'owner', inputAdmissionReceipt: null, pendingProviderAction: action,
                meta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'action' } },
            })).toEqual({ status: 'admitted' });
            const rendered = boundary.inputs.at(-1)!.input.text;
            const frame = rendered.match(/<happier_session_message v="1">\n([\s\S]*?)\n<\/happier_session_message>/)?.[1];
            expect(frame).toBeDefined();
            expect(JSON.parse(frame!.match(/^message=(.*)$/m)![1]!)).toBe('[Inner](happier-ref:session:inner)');
            expect(rendered.match(/<happier_session_message v="1">/g)).toHaveLength(1);
            boundary.complete();
            await host.waitForTurnCompletion?.();
        } finally { delivery.dispose(); await host.dispose(); }
    });

    it('preserves a correlated asynchronous native refusal after dispatch admission', async () => {
        let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sessionId = '';
        const sends: Parameters<AgentSessionRuntime['send']>[0][] = [];
        const runtime: AgentRuntime = { sessions: { async open(openRequest) {
            sessionId = openRequest.sessionId;
            return {
                async send(input) { sends.push(input); return { status: 'admitted' as const }; },
                watch(listener) { emit = listener; return { dispose() {} }; }, async dispose() {},
            };
        } } };
        const host = createNativeAgentSessionInteractionHostRuntime({ runtime,
            lease: { pluginId: 'acme.retained', pluginVersion: '1.0.0', agentId: 'acme.retained/default',
                localAgentId: 'default', occurrenceId: 'fixture-async-refusal', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-async-refusal', scope: 'session_owned', backendId: 'acme.retained/default',
                permissionMode: 'read_only' },
            sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        try {
            await host.provisionRuntime();
            await expect(host.deliverInput('run-async-refusal', { text: 'generate' }, { localId: 'initial', turnId: 'turn-initial' }))
                .resolves.toEqual({ status: 'admitted' });
            const completion = expect(host.waitForTurnCompletion!()).rejects.toMatchObject({ code: 'native_async_refused' });
            emit!({ kind: 'input-rejected', sessionId, sequence: 1, emittedAtMs: 1,
                inputIds: sends[0]!.inputIds, diagnostic: { code: 'native_async_refused', severity: 'error' }, retryable: true });
            await completion;
            await expect(host.waitForTurnCompletion!()).rejects.toMatchObject({ code: 'native_async_refused' });
        } finally { await host.dispose(); }
    });

    it.each([false, true])('preserves a definite unavailable send as a typed retained-turn failure (retryable=%s)', async retryable => {
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send() { return { status: 'unavailable' as const, retryable,
                diagnostic: { code: 'native_terminal_host_unavailable', severity: 'error' as const } }; },
            watch() { return { dispose() {} }; }, async dispose() {},
        }; } } };
        const host = createNativeAgentSessionInteractionHostRuntime({ runtime,
            lease: { pluginId: 'acme.retained', pluginVersion: '1.0.0', agentId: 'acme.retained/default',
                localAgentId: 'default', occurrenceId: 'fixture-unavailable', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-unavailable', scope: 'session_owned', backendId: 'acme.retained/default',
                permissionMode: 'read_only' },
            sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        try {
            await host.provisionRuntime();
            await expect(host.deliverInput('run-unavailable', { text: 'generate' }, { localId: 'initial', turnId: 'turn-initial' }))
                .rejects.toThrow();
            await expect(host.waitForTurnCompletion!()).rejects.toMatchObject({ code: 'native_terminal_host_unavailable' });
            await expect(host.waitForTurnCompletion!()).rejects.toMatchObject({ code: 'native_terminal_host_unavailable' });
        } finally { await host.dispose(); }
    });
    it.each(['finite', 'retained'] as const)('projects only proven foreground text into a %s Run and preserves retained tool facts', async adapter => {
        let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        const turnId = 'run-scope-turn-1';
        // An arbitrary installed Agent is the external boundary; host admission and projection stay real.
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                publishRuntimeEvent!({ sequence: 1, sessionId: 'session-parent', emittedAtMs: 1,
                    kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                publishRuntimeEvent!({ sequence: 2, sessionId: 'session-parent', emittedAtMs: 2,
                    kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                return { status: 'admitted' as const };
            },
            watch(listener) { publishRuntimeEvent = listener; return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const createHost = adapter === 'finite'
            ? createNativeAgentSessionExecutionRunHostRuntime
            : createNativeAgentSessionInteractionHostRuntime;
        const host = createHost({
            runtime,
            lease: { pluginId: 'acme.scope', pluginVersion: '1.0.0', agentId: 'acme.scope/default',
                localAgentId: 'default', occurrenceId: 'scope-fixture', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-scope', scope: 'session_owned', backendId: 'acme.scope/default',
                permissionMode: 'read_only', start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
            supportsResume: false,
            sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        const messages: AgentMessage[] = [];
        const unsubscribe = host.subscribeMessages(message => messages.push(message));
        try {
            await host.provisionRuntime();
            await host.deliverInput('run-scope', { text: 'perform foreground work' }, { turnId });
            let sequence = 2;
            for (const { label, scope } of [
                { label: 'session', scope: {} },
                { label: 'sidechain', scope: { turnId, sidechainId: 'child' } },
                { label: 'older', scope: { turnId: 'older-turn' } },
                { label: 'foreground', scope: { turnId } },
            ]) {
                for (const channel of ['assistant', 'reasoning'] as const) {
                    publishRuntimeEvent!({ sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                        kind: 'message-delta', channel, text: `${label} ${channel} draft`, messageId: `${label}-${channel}`, ...scope });
                }
                publishRuntimeEvent!({ sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                    kind: 'transcript-message-committed', role: 'assistant', text: `${label} final answer`, messageId: `${label}-assistant`, ...scope });
                publishRuntimeEvent!({ sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                    kind: 'tool-call', toolCallId: `${label}-tool`, toolName: 'read_file', input: ['README.md'], ...scope });
                publishRuntimeEvent!({ sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                    kind: 'tool-result', toolCallId: `${label}-tool`, output: null, ...scope });
            }
            expect(messages.filter(message => message.type === 'model-output' || (message.type === 'event' && message.name === 'thinking'))).toEqual([
                { type: 'model-output', textDelta: 'foreground assistant draft', messageId: 'foreground-assistant' },
                { type: 'event', name: 'thinking', payload: { textDelta: 'foreground reasoning draft' } },
                { type: 'model-output', fullText: 'foreground final answer', messageId: 'foreground-assistant' },
            ]);
            expect(messages.filter(message => message.type === 'tool-call' || message.type === 'tool-result')).toEqual(adapter === 'retained' ? [
                { type: 'tool-call', callId: 'foreground-tool', toolName: 'read_file', args: ['README.md'] },
                { type: 'tool-result', callId: 'foreground-tool', result: null },
            ] : []);
        } finally {
            unsubscribe();
            await host.dispose();
        }
    });

    it.each(['finite', 'retained'] as const)('publishes %s Run usage to the Session and exact Workflow owners', async adapter => {
        let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        const publishUsage = vi.fn(async () => undefined);
        const observeWorkflowUsage = vi.fn();
        // The native Agent is the external boundary. Its accepted lifecycle reaches the real host owner.
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                publishRuntimeEvent!({ sequence: 1, sessionId: 'session-parent', emittedAtMs: 10,
                    kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                publishRuntimeEvent!({ sequence: 2, sessionId: 'session-parent', emittedAtMs: 10,
                    kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                return { status: 'admitted' as const };
            },
            watch(listener) { publishRuntimeEvent = listener; return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const createHost = adapter === 'finite'
            ? createNativeAgentSessionExecutionRunHostRuntime
            : createNativeAgentSessionInteractionHostRuntime;
        const host = createHost({
            runtime,
            lease: { pluginId: 'acme.finite', pluginVersion: '1.0.0', agentId: 'acme.finite/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-usage', scope: 'session_owned', backendId: 'acme.finite/default',
                permissionMode: 'read_only', start: {
                    intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral', observeWorkflowUsage,
                } },
            supportsResume: false,
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => ({
                ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                usagePublisher: { provider: 'acme.finite/default', publish: publishUsage },
            }),
        });
        try {
            await host.provisionRuntime();
            await host.deliverInput('run-usage', { text: 'measure this run' }, { turnId: 'run-usage-turn-1' });
            publishRuntimeEvent!({ sequence: 3, sessionId: 'session-parent', emittedAtMs: 20,
                turnId: 'run-usage-turn-1', kind: 'usage-observed', observationId: 'usage-attached-1',
                source: 'provider', scope: 'turn_delta', modelId: 'model-a',
                promptCache: { lastUseAtMs: 10 },
                tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 } });
            await vi.waitFor(() => expect(publishUsage).toHaveBeenCalledOnce());
            expect(publishUsage).toHaveBeenCalledWith(expect.objectContaining({
                externalKey: 'usage-attached-1', turnId: 'run-usage-turn-1',
                observation: expect.objectContaining({ provider: 'acme.finite/default',
                    tokens: expect.objectContaining({ total: 12 }) }),
            }));
            expect(publishUsage).toHaveBeenCalledWith(expect.objectContaining({
                observation: expect.objectContaining({ promptCache: { lastUseAtMs: 10 } }),
            }));
            expect(observeWorkflowUsage).toHaveBeenCalledWith({
                turnId: 'run-usage-turn-1', observation: expect.objectContaining({
                    provider: 'acme.finite/default', scope: 'turn_delta',
                    tokens: expect.objectContaining({ input: 8, output: 4 }),
                    availability: { inputTokens: true, outputTokens: true, reportedCostUsd: false },
                }),
            });
            publishRuntimeEvent!({ sequence: 4, sessionId: 'session-parent', emittedAtMs: 21,
                turnId: 'run-usage-turn-1', kind: 'usage-observed', observationId: 'child-usage-identity',
                source: 'native-statistics', scope: 'session_cumulative',
                accounting: { nativeSessionId: 'child-native', historyComplete: false } });
            await vi.waitFor(() => expect(publishUsage).toHaveBeenCalledTimes(2));
            expect(publishUsage).toHaveBeenLastCalledWith(expect.objectContaining({
                observation: expect.objectContaining({ tokens: null, cost: null }),
                metadata: { usageAccounting: expect.objectContaining({ nativeSessionId: 'child-native', historyComplete: false }) },
            }));
        } finally { await host.dispose(); }
    });

    it('sanitizes retained failure completion while preserving native recovery evidence', async () => {
        let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                publishRuntimeEvent!({ sessionId: 'session-parent', sequence: 1, emittedAtMs: 10,
                    kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                publishRuntimeEvent!({ sessionId: 'session-parent', sequence: 2, emittedAtMs: 10,
                    kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                return { status: 'admitted' as const };
            },
            watch(listener) { publishRuntimeEvent = listener; return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.retained', pluginVersion: '1.0.0', agentId: 'acme.retained/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-failure', scope: 'session_owned', backendId: 'acme.retained/default',
                permissionMode: 'read_only', sanitizeProviderDiagnosticText: text => text.replaceAll('provider-secret', '[REDACTED]') },
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        try {
            await host.provisionRuntime();
            await host.deliverInput('run-failure', { text: 'perform work' }, { turnId: 'run-failure-turn-1' });
            publishRuntimeEvent!({ sessionId: 'session-parent', sequence: 3, emittedAtMs: 20,
                kind: 'turn-failed', turnId: 'run-failure-turn-1',
                diagnostic: { code: 'provider_capacity', severity: 'error', message: 'busy provider-secret',
                    details: { retryAfterMs: 2000 } } });
            const completionError = await host.waitForTurnCompletion!().catch((error: unknown) => error);
            expect(completionError).toMatchObject({ message: expect.stringContaining('busy [REDACTED]') });
            expect(readRuntimeTurnFailureAlreadySurfacedEvent(completionError)).toMatchObject({
                kind: 'turn-failed', turnId: 'run-failure-turn-1',
                diagnostic: { code: 'provider_capacity', severity: 'error', message: 'busy [REDACTED]',
                    details: { retryAfterMs: 2000 } },
            });
        } finally { await host.dispose(); }
    });
});
