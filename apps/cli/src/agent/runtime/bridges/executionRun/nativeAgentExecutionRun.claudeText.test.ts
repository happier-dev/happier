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
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { reloadConfiguration } from '@/configuration';
import { createNativeAgentExecutionRunHostRuntime, createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { createExecutionRunControllerMessageHandler } from './messages/sessionStateEmission';
import { sendBackendLongLivedRun } from './send/backendLongLivedPrompt';
import { executeBoundedBackendRun } from './bounded/loop';
import type { ExecutionRunState } from './executionRunTypes';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

it.each([false, true])('completes a Claude terminal child through the shared Session Run owner with its native reply (hook first=%s)', async hookFirst => {
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
            startedAtMs: 1, params: run, controllers, runs, sendAcp: async () => {}, parentProvider: 'claude',
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
            expect(messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'stopped' }));
        }
        await native.observeSourceTranscript({ providerSessionId, sourceId: 'terminal-final', row: {
            type: 'assistant', uuid: 'terminal-final', sessionId: providerSessionId,
            message: { id: 'native-message', role: 'assistant', stop_reason: hookFirst ? null : 'end_turn', content: [{ type: 'text', text }] },
        } });
        await hook(providerSessionId, { hook_event_name: 'Stop', session_id: providerSessionId, last_assistant_message: text });
        await execution;
        expect(runs.get(runId)).toMatchObject({ status: 'succeeded', summary: 'C26_TERMINAL_CHILD_OK' });
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
