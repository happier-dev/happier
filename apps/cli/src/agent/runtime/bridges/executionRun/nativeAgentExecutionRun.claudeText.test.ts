import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { AgentExecutionRunRuntimeContextV1, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createClaudeNativeRuntime } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createSessionHooksFixture, createTerminalHostFixture } from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeUnifiedTerminalTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from '@/daemon/connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from '@/daemon/connectedServices/runtimeAuth/temporaryThrottleRetryScheduler';
import { applyConnectedServiceRuntimeAuthFailureSourceBinding, recoverConnectedServiceRuntimeFailure } from '@/daemon/connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { resolveContinuationResumePromptMode } from '@/daemon/connectedServices/continuation/switchRecovery';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { reloadConfiguration } from '@/configuration';
import { createNativeAgentExecutionRunHostRuntime, createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { createExecutionRunControllerMessageHandler } from './messages/sessionStateEmission';
import { sendBackendLongLivedRun } from './send/backendLongLivedPrompt';
import { executeBoundedBackendRun } from './bounded/loop';
import type { ExecutionRunState } from './executionRunTypes';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

it.each(['off', 'standard'] as const)('settles consecutive Claude SDK quota failures through real recovery with continuation %s', async resumeMode => {
    const sdk = createSdkExecFixture();
    const boundary = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
        { exec: sdk.service });
    const runtime = createClaudeNativeRuntime({
        resolveSupportsEffort: async () => false, resolveSupportsSystemPromptSnapshotOff: async () => false,
        openSession: async ({ request }) => createClaudeAgentSdkTurnOperations({
            ctx: boundary, directory: request.cwd, happierSessionId: request.sessionId,
            launchEnv: {}, permissionMode: 'default',
        }),
    });
    const rows = new Map<string, unknown>();
    const recoveryDecisions: Array<Readonly<{ turnId: string; status: string; reason?: string }>> = [];
    let nowMs = Date.now();
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
        leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: Date.now,
        // Group persistence and native generation application are external
        // boundaries. A selected single profile must never touch them.
        loadState: async () => { throw new Error('No group state exists for this profile'); },
        commitSwitch: async () => { throw new Error('A profile cannot commit a group switch'); },
        applyGeneration: async () => { throw new Error('A profile cannot apply a group generation'); },
    });
    const temporaryThrottleScheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
        nowMs: () => nowMs,
        store: { read: key => rows.get(key) ?? null, write: (key, value) => { rows.set(key, value); } },
        resume: async () => ({ status: 'continued' }),
    });
    const host = createNativeAgentSessionInteractionHostRuntime({ runtime,
        lease: { pluginId: 'happier.agent.claude', pluginVersion: '1.0.0', agentId: 'claude', localAgentId: 'claude',
            occurrenceId: 'claude-consecutive-quota', isCurrent: () => true },
        options: { cwd: '/tmp/claude-consecutive-quota', runId: 'claude-consecutive-quota', scope: 'session_owned',
            backendId: 'claude', permissionMode: 'read_only',
            async prepareRuntimeFailureRecovery({ diagnostic, interruptedOriginId, signal, onRecoveryWaiting }) {
                const details = diagnostic.details;
                const failure = sanitizeConnectedServiceRuntimeFailureClassification(details && typeof details === 'object'
                    && !Array.isArray(details) ? details.runtimeAuthClassification : null);
                if (!failure) throw new Error('The SDK quota failure must retain its recovery classification');
                const serviceId = 'happier.agent.claude/claude-subscription';
                const profileId = 'quota-profile';
                const resumePromptMode = await resolveContinuationResumePromptMode({ serviceId,
                    readAccountSettings: () => ({ usageLimitRecoverySettingsV1: { resumePromptMode: resumeMode } }),
                });
                const result = await recoverConnectedServiceRuntimeFailure({
                    scope: { kind: 'run', runId: 'claude-consecutive-quota' },
                    selection: { kind: 'profile', serviceId, profileId },
                    classification: applyConnectedServiceRuntimeAuthFailureSourceBinding(failure,
                        { serviceId, profileId, groupId: null, generation: null, credentialRevision: 'csr_abcdefghijklmnopqrstuv' }),
                    switchCoordinator, temporaryThrottleScheduler, onRecoveryWaiting,
                    continuation: { interruptedOriginId, resumePromptMode, recoveryKind: failure.kind,
                        customResumePrompt: null }, signal, isCurrent: () => !signal.aborted, nowMs: Date.now,
                });
                recoveryDecisions.push({ turnId: interruptedOriginId, status: result.status,
                    ...(result.status === 'failed' ? { reason: result.reason } : {}) });
                return result.status === 'continue' ? { ...result, prepareResume: async () => undefined } : result;
            },
        },
        sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
        createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
    });
    const manager = new VoiceAgentManager({ createRuntime: () => host });
    try {
        const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'default',
            idleTtlSeconds: 60, initialContext: '' });
        let expectedProcesses = 0;
        for (const attempt of [1, 2]) {
            const { streamId } = await manager.startTurnStream({ voiceAgentId, userText: `Question ${attempt}` });
            expectedProcesses += 1;
            await vi.waitFor(() => expect(sdk.processes).toHaveLength(expectedProcesses));
            const process = sdk.processes.at(-1)!;
            await process.emit({ type: 'system', subtype: 'init', session_id: 'native-consecutive-quota', tools: [] });
            await process.emit({ type: 'assistant', uuid: `weekly-error-${attempt}`, session_id: 'native-consecutive-quota',
                isApiErrorMessage: true, isSidechain: false, error: 'rate_limit',
                message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text',
                    // The second quota follows the first reset and continuation.
                    text: `You've hit your weekly limit · resets Nov ${attempt === 1 ? 14 : 21}, 4pm (Europe/Amsterdam)` }] } });
            await vi.waitFor(async () => {
                const read = await manager.readTurnStream({ voiceAgentId, streamId, cursor: 0, waitForEvents: false });
                expect(read.done).toBe(true);
                if (resumeMode === 'off') {
                    expect(read.events).toContainEqual(expect.objectContaining({ t: 'error', errorCode: 'usage_limit' }));
                } else {
                    const speech = read.events.filter(event => event.t === 'voice_output' && event.output.kind === 'speech_segment');
                    expect(speech).toHaveLength(1);
                    expect(read.terminalEvent).toMatchObject({ t: 'voice_output', output: { kind: 'turn_final',
                        text: expect.stringContaining('Happier will retry automatically at') } });
                }
            });
            if (resumeMode === 'standard') {
                const waiting = temporaryThrottleScheduler.read('run:claude-consecutive-quota');
                expect(waiting).toMatchObject({ status: 'waiting', attemptCount: 0 });
                expect(manager.readCurrentRuntimeAuthority(voiceAgentId)?.runtimeState).toBe('active_turn');
                expect(recoveryDecisions).toHaveLength(attempt - 1);
                // Advance the real scheduler's provider reset boundary. Voice did
                // not cancel or retry the native Run when its own stream settled.
                nowMs = waiting!.nextRetryAtMs!;
                await temporaryThrottleScheduler.wake({ sessionId: waiting!.sessionId, reason: 'manual' });
                expectedProcesses += 1;
                await vi.waitFor(() => expect(sdk.processes).toHaveLength(expectedProcesses));
                await sdk.processes.at(-1)!.emit({ type: 'result', subtype: 'success', is_error: false,
                    session_id: 'native-consecutive-quota', result: 'Native recovery completed.' });
                await vi.waitFor(() => expect(manager.readCurrentRuntimeAuthority(voiceAgentId)?.runtimeState).toBe('idle'));
            } else expect(manager.readCurrentRuntimeAuthority(voiceAgentId)?.runtimeState).toBe('idle');
        }
        expect(recoveryDecisions).toEqual(resumeMode === 'off' ? [
            expect.objectContaining({ status: 'failed', reason: 'continuation_disabled' }),
            expect.objectContaining({ status: 'failed', reason: 'continuation_disabled' }),
        ] : [expect.objectContaining({ status: 'continue' }), expect.objectContaining({ status: 'continue' })]);
        expect(new Set(recoveryDecisions.map(result => result.turnId)).size).toBe(2);
        const { streamId } = await manager.startTurnStream({ voiceAgentId, userText: 'Next question' });
        await vi.waitFor(() => expect(sdk.processes).toHaveLength(expectedProcesses + 1));
        await sdk.processes.at(-1)!.emit({ type: 'result', subtype: 'success', is_error: false,
            session_id: 'native-consecutive-quota', result: 'The next turn completed.' });
        await vi.waitFor(async () => expect(await manager.readTurnStream({ voiceAgentId, streamId,
            cursor: 0, waitForEvents: false })).toMatchObject({ done: true }));
    } finally { temporaryThrottleScheduler.dispose(); await manager.dispose(); }
});

it.each([
    { hookFirst: false, apiError: false },
    { hookFirst: true, apiError: false },
    { hookFirst: false, apiError: true },
])('settles a Claude terminal child through the shared Session Run owner ($hookFirst, API error=$apiError)', async ({ hookFirst, apiError }) => {
    const terminal = createTerminalHostFixture();
    const hooks = createSessionHooksFixture();
    const boundary = createPluginContextFixture(terminal.service, createEventsFixture().service, { sessionHooks: hooks.service });
    // The native JSONL file and hook transport are OS boundaries. Prime a real
    // primary row so the production publisher admits ordered source following.
    vi.mocked(boundary.agentRuntime.transcripts.fileFollow.follow).mockImplementation(async input => {
        await input.onLine({ line: JSON.stringify({ type: 'user', uuid: 'terminal-input', sessionId: 'claude-terminal-native',
            message: { role: 'user', content: 'Return the marker' } }), sourcePath: input.path, sequence: 1 });
        return { id: 'native-jsonl', drainNow: async () => {}, close: async () => {} };
    });
    let native: AgentSessionRuntime | undefined;
    const runtime = createClaudeNativeRuntime({
        resolveSupportsEffort: async () => false, resolveSupportsSystemPromptSnapshotOff: async () => false,
        openSession: async ({ request }) => createClaudeUnifiedTerminalTurnOperations({
            ctx: boundary, directory: request.cwd, happierSessionId: request.sessionId,
            hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default',
        }),
    });
    const realOpen = runtime.sessions!.open;
    runtime.sessions!.open = async (...args) => { native = await realOpen(...args); return native; };
    const host = createNativeAgentSessionInteractionHostRuntime({ runtime,
        lease: { pluginId: 'happier.agent.claude', pluginVersion: '1.0.0', agentId: 'claude', localAgentId: 'claude',
            occurrenceId: 'claude-terminal-child', isCurrent: () => true },
        options: { cwd: '/tmp/claude-project', runId: 'claude-terminal-child', scope: 'session_owned',
            backendId: 'claude', permissionMode: 'read_only' },
        sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
        createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
    });
    const messages: import('@/agent/core/AgentMessage').AgentMessage[] = [];
    const unsubscribe = host.subscribeMessages(message => messages.push(message));
    const providerSessionId = 'claude-terminal-native';
    const text = JSON.stringify({ summary: 'C26_TERMINAL_CHILD_OK', deliverables: [{ id: 'reply', title: 'C26_TERMINAL_CHILD_OK' }] });
    let unsubscribeController: (() => void) | undefined;
    try {
        const runId = 'claude-terminal-child';
        const { runtimeId } = await host.provisionRuntime();
        const ctrl: ExecutionRunBackendController = {
            kind: 'backend', controllerOccurrenceId: runId, backend: host, backendSupportsResume: true, runtimeId,
            buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null, cancelled: false,
            turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
            admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
            terminalPromise: Promise.resolve(), resolveTerminal() {},
        };
        const run: ExecutionRunState = { runId, callId: 'terminal-call', sidechainId: 'terminal-sidechain',
            sessionId: 'session-parent', depth: 1, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            backendId: 'claude', instructions: 'Return the marker', permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1 };
        const runs = new Map([[runId, run]]);
        const controllers = new Map([[runId, ctrl]]);
        unsubscribeController = host.subscribeMessages(createExecutionRunControllerMessageHandler({
            ctrl, runId, sidechainId: run.sidechainId, ioMode: run.ioMode, computeSidechainStreamText: value => value,
            sendAcp: async () => {}, parentProvider: 'claude', runs, backendSupportsResume: true,
            writeActivityMarker: async () => {}, getNowMs: () => 2,
        }));
        const execution = executeBoundedBackendRun({ runId, callId: run.callId, sidechainId: run.sidechainId,
            startedAtMs: 1, params: { ...run, localInputId: 'terminal-input' }, controllers, runs, sendAcp: async () => {}, parentProvider: 'claude',
            getNowMs: () => 2, boundedTimeoutMs: null,
            finishRun: async (_id, result) => { runs.set(runId, { ...runs.get(runId)!, ...result }); },
        });
        void execution.catch(() => undefined);
        await vi.waitFor(() => expect(hooks.service.startServer).toHaveBeenCalled());
        const hook = hooks.service.startServer.mock.calls[0]?.[0].onSessionHook;
        if (!hook || !native?.observeSourceTranscript) throw new Error('The real Claude source observer was not opened');
        await hook(providerSessionId, { hook_event_name: 'SessionStart', session_id: providerSessionId,
            source: 'startup', transcript_path: '/tmp/claude-terminal-native.jsonl' });
        await vi.waitFor(() => expect(terminal.service.injectUserPrompt).toHaveBeenCalled());
        const prompt = vi.mocked(terminal.service.injectUserPrompt).mock.calls[0]![1].text;
        await hook(providerSessionId, { hook_event_name: 'UserPromptSubmit', session_id: providerSessionId, prompt });
        expect(boundary.agentRuntime.transcripts.followSource).toHaveBeenCalledWith({ providerSessionId, replay: 'fresh' });
        if (apiError) {
            await native.observeSourceTranscript({ providerSessionId, sourceId: 'terminal-429', row: {
                type: 'assistant', uuid: 'terminal-429', sessionId: providerSessionId,
                isApiErrorMessage: true, apiErrorStatus: 429, apiError: 'long_context_credits_required', error: 'rate_limit',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Usage credits are required for long context.' }] },
            } });
            await execution;
            expect(runs.get(runId)).toMatchObject({
                status: 'failed', error: { code: 'claude.usage_limit', runtimeIssueV1: {
                    source: 'usage_limit', usageLimit: { limitCategory: 'rate_limit' },
                } },
                inputTurns: { last: { inputIds: ['terminal-input'], state: 'failed' } },
            });
            expect(messages.filter(message => message.type === 'model-output')).toEqual([
                expect.objectContaining({ fullText: 'Usage credits are required for long context.' }),
            ]);
            return;
        }
        for (const [sourceId, row, phase] of [
            ['history', { type: 'assistant', uuid: 'history', sessionId: providerSessionId,
                message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Old reply' }] } }, 'initial_replay'],
            ['sidechain', { type: 'assistant', uuid: 'sidechain', sessionId: providerSessionId, isSidechain: true,
                message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Other child' }] } }],
            ['thinking', { type: 'assistant', uuid: 'thinking', sessionId: providerSessionId,
                message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Working', signature: 'fixture' }] } }],
        ] as const) {
            await native.observeSourceTranscript({ providerSessionId, sourceId, row, ...(phase ? { phase } : {}) });
        }
        expect(messages.filter(message => message.type === 'model-output')).toEqual([]);
        expect(messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'stopped' }));
        if (hookFirst) {
            await hook(providerSessionId, { hook_event_name: 'Stop', session_id: providerSessionId, last_assistant_message: text });
            await hook(providerSessionId, { hook_event_name: 'SessionEnd', session_id: providerSessionId, reason: 'prompt_input_exit' });
            expect(messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'stopped' }));
        }
        await native.observeSourceTranscript({ providerSessionId, sourceId: 'terminal-final', row: {
            type: 'assistant', uuid: 'terminal-final', sessionId: providerSessionId,
            message: { id: 'native-message', role: 'assistant', stop_reason: hookFirst ? null : 'end_turn', content: [{ type: 'text', text }] },
        } });
        await hook(providerSessionId, { hook_event_name: 'Stop', session_id: providerSessionId, last_assistant_message: text });
        await execution;
        expect(runs.get(runId)).toMatchObject({ status: 'succeeded', summary: 'C26_TERMINAL_CHILD_OK',
            inputTurns: { last: { inputIds: ['terminal-input'], state: 'completed' } } });
        expect(ctrl.turnInFlight).toBe(false);
        expect(ctrl.turnCount).toBe(1);
        expect(messages.filter(message => message.type === 'model-output')).toEqual([
            expect.objectContaining({ type: 'model-output', fullText: text }),
        ]);
    } finally { unsubscribeController?.(); unsubscribe(); await host.dispose(); }
});

it.each([
    { streamed: true, quota: false }, { streamed: false, quota: false }, { streamed: false, quota: true },
])('retains Claude SDK text and refuses a terminal provider quota despite trailing success ($streamed, quota=$quota)', async ({ streamed, quota }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-claude-run-text-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    const sdk = createSdkExecFixture();
    const boundary = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service);
    // Only the vendor process/stdio boundary is replaced. SDK decoding, native
    // Run events, host accumulation and completed-input publication are real.
    const exec = {
        systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'claude-cli' }, executablePath: '/managed/claude' }) },
        clients: { spawn: async () => {
            const handle = await sdk.service.spawnClient({ launch: { kind: 'agent-cli', agentId: 'claude' },
                transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } }, protocol: { kind: 'json-stream' } });
            return {
                client: { subscribe: (listener: (record: unknown) => void | Promise<void>) => ({ dispose: handle.client.subscribe(listener) }),
                    write: async (record: unknown) => { await handle.client.writeRecord(record); } },
                process: { write: async () => undefined, dispose: async () => { await handle.dispose(); } },
                wait: async () => { const result = await handle.process.exit; return {
                    termination: { observed: { kind: 'exit', exitCode: result.exitCode ?? 0 }, requestedBy: { kind: 'none' } },
                    stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
                }; },
                dispose: async () => { await handle.dispose(); },
            };
        } },
    } as unknown as ExecService;
    const runtime = createClaudeNativeRuntime({
        openSession: async () => { throw new Error('Detached work must not open a Session'); },
        resolveSupportsEffort: async () => false, resolveSupportsSystemPromptSnapshotOff: async () => false,
    });
    const runId = 'claude-text-run';
    const context = {
        scope: { kind: 'execution_run', executionRunId: runId },
        executionRun: { id: runId, services: { hooks: boundary.agentRuntime.sessionHooks,
            fileFollow: boundary.agentRuntime.transcripts.fileFollow, toolExecution: boundary.agentRuntime.toolExecution } },
        services: { exec, logger: boundary.logger, settings: boundary.settings, storage: boundary.storage },
        protocols: {}, signal: new AbortController().signal,
    } as unknown as AgentExecutionRunRuntimeContextV1;
    if (!runtime.sessions) throw new Error('Expected Claude Session runtime');
    const host = createNativeAgentExecutionRunHostRuntime({ runtime, executionRunContextV1: runtime.sessions.executionRunContextV1,
        lease: { pluginId: 'happier.agent.claude', pluginVersion: '1.0.0', agentId: 'claude', localAgentId: 'claude',
            occurrenceId: 'claude-text-occurrence', isCurrent: () => true },
        options: { cwd: directory, runId, scope: 'detached', backendId: 'claude', permissionMode: 'read_only',
            start: { intent: 'agent', runClass: 'long_lived', retentionPolicy: 'resumable' } },
        createExecutionRunContext: async () => ({ context, async dispose() {} }),
        supportsResume: true,
    });
    const { runtimeId } = await host.provisionRuntime();
    const ctrl: ExecutionRunBackendController = {
        kind: 'backend', controllerOccurrenceId: 'claude-text-controller', backend: host, backendSupportsResume: true, runtimeId,
        buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null, cancelled: false,
        turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
        admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
        terminalPromise: Promise.resolve(), resolveTerminal() {},
    };
    const run: ExecutionRunState = { runId, callId: 'call', sidechainId: 'sidechain', sessionId: null, depth: 0,
        intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude', instructions: '',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
        status: 'running', startedAtMs: 1 };
    const runs = new Map([[runId, run]]);
    const controllers = new Map([[runId, ctrl]]);
    const unsubscribe = host.subscribeMessages(createExecutionRunControllerMessageHandler({
        ctrl, runId, sidechainId: run.sidechainId, ioMode: run.ioMode, computeSidechainStreamText: text => text,
        sendAcp: async () => {}, parentProvider: 'claude', runs, backendSupportsResume: true,
        writeActivityMarker: async () => {}, getNowMs: () => 2,
    }));
    const text = quota ? "You've hit your weekly limit · resets Nov 10, 9pm (Europe/Amsterdam)" : 'BACKGROUND DONE';
    try {
        await expect(sendBackendLongLivedRun({ runId, params: { message: 'Return the marker', localInputId: 'exact-input' },
            runs, controllers, budgetRegistry: null, createRuntime: () => host, maxTurns: null, getNowMs: () => 2,
            finishRun: async () => {}, sendAcp: async () => {}, parentProvider: 'claude', streamedTranscriptSession: null,
            writeActivityMarker: async () => {},
        })).resolves.toEqual({ ok: true });
        if (streamed) {
            for (const delta of ['BACKGROUND ', 'DONE']) {
                await sdk.emit({ type: 'stream_event', uuid: `delta-${delta}`, session_id: 'native-claude', parent_tool_use_id: null,
                    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
            }
            await vi.waitFor(() => expect(ctrl.buffer).toBe(text));
        }
        await sdk.emit({ type: 'assistant', uuid: 'assistant-row', session_id: 'native-claude', parent_tool_use_id: null,
            ...(quota ? { isApiErrorMessage: true, apiError: 'usage_limit_reached', resetsAt: 1_794_340_800 } : {}),
            message: { id: 'native-message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
        await sdk.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-claude', uuid: 'result-row',
            result: text, num_turns: 1, total_cost_usd: 0, duration_ms: 10, duration_api_ms: 8 });
        await vi.waitFor(() => expect(runs.get(runId)?.inputTurns?.last).toBeDefined());
        const response = ExecutionRunGetResponseSchema.parse({ run: runs.get(runId) });
        if (quota) {
            expect(response.run).toMatchObject({ error: { runtimeIssueV1: {
                source: 'usage_limit', usageLimit: { resetAtMs: 1_794_340_800_000 },
            } } });
            expect(response.run.inputTurns?.last).toMatchObject({ inputIds: ['exact-input'], state: 'failed' });
            expect(response.run.inputTurns?.last).not.toHaveProperty('result');
        } else {
            expect(response.run.inputTurns?.last).toMatchObject({ inputIds: ['exact-input'], state: 'completed', result: { kind: 'text', value: text } });
        }
    } finally {
        unsubscribe();
        await host.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});
