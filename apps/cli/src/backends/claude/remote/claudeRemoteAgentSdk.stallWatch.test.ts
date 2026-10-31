import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { TurnStallNotice } from '@/agent/runtime/session/turn/stallWatch';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

type PermissionHook = (input: unknown, toolUseId: string | undefined, options: { signal?: AbortSignal }) => Promise<unknown>;
type ObservationHook = (input: unknown) => Promise<unknown>;

it('observes a main permission request before its decision and excludes replayed or sidechain hooks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const notices: TurnStallNotice[] = [];
    const lifecycle = createSessionTurnLifecycle({
        sessionId: 'happier-session', enqueueSessionTurn: async () => {},
        turnStallWarnMs: 100, onTurnStallNotice: notice => notices.push(notice),
    });
    let resolveDecision!: (value: { behavior: 'allow'; updatedInput: Record<string, never> }) => void;
    const decision = new Promise<{ behavior: 'allow'; updatedInput: Record<string, never> }>(resolve => { resolveDecision = resolve; });
    let sent = false;
    try {
        await lifecycle.beginTurn({ provider: 'claude' });
        await claudeRemoteAgentSdk({
            sessionId: null, transcriptPath: null, path: '/tmp', claudeExecutablePath: '/tmp/claude',
            canCallTool: () => decision, isAborted: () => false,
            nextMessage: async () => {
                if (sent) return null;
                sent = true;
                return { message: 'hello', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            },
            onReady() {}, onSessionFound() {}, onMessage() {},
            onProviderEvent: () => lifecycle.observeProviderTurnEvent(),
            createQuery: ({ options }) => {
                // Only the external SDK's hook registration shape is asserted at this boundary.
                const hooks = options?.hooks as {
                    PermissionRequest: Array<{ hooks: PermissionHook[] }>;
                    PostToolUse: Array<{ hooks: ObservationHook[] }>;
                };
                const query: Pick<Query, typeof Symbol.asyncIterator | 'close' | 'setPermissionMode' | 'setModel' | 'setMaxThinkingTokens' | 'supportedCommands' | 'supportedModels'> = {
                    async *[Symbol.asyncIterator]() {
                        yield { type: 'system', subtype: 'init', session_id: 'native-main' } as SDKMessage;
                        await vi.advanceTimersByTimeAsync(75);
                        const pending = hooks.PermissionRequest[0]!.hooks[0]!({
                            hook_event_name: 'PermissionRequest', session_id: 'native-main', tool_name: 'Bash', tool_input: {},
                        }, 'permission-1', { signal: new AbortController().signal });
                        await vi.advanceTimersByTimeAsync(99);
                        expect(notices).toEqual([]);
                        await vi.advanceTimersByTimeAsync(1);
                        expect(notices).toMatchObject([{ lastEventAgeMs: 100 }]);
                        resolveDecision({ behavior: 'allow', updatedInput: {} });
                        await pending;
                        await hooks.PermissionRequest[0]!.hooks[0]!({
                            hook_event_name: 'PermissionRequest', session_id: 'native-main', tool_name: 'Bash', tool_input: {}, agent_id: 'child',
                        }, 'permission-child', { signal: new AbortController().signal });
                        await hooks.PostToolUse[0]!.hooks[0]!({ hook_event_name: 'PostToolUse', session_id: 'native-main', agent_id: 'child' });
                        await hooks.PostToolUse[0]!.hooks[0]!({ hook_event_name: 'PostToolUse', session_id: 'native-main', isReplay: true });
                        await vi.advanceTimersByTimeAsync(100);
                        expect(notices).toHaveLength(1);
                        await hooks.PostToolUse[0]!.hooks[0]!({ hook_event_name: 'PostToolUse', session_id: 'native-main' });
                        await vi.advanceTimersByTimeAsync(100);
                        expect(notices).toMatchObject([{ lastEventAgeMs: 100 }, { lastEventAgeMs: 100 }]);
                        yield { type: 'result', subtype: 'success', session_id: 'native-main' } as SDKMessage;
                    },
                    close() {}, async setPermissionMode() {}, async setModel() {}, async setMaxThinkingTokens() {},
                    supportedCommands: async () => [], supportedModels: async () => [],
                };
                return query as Query;
            },
        });
    } finally {
        resolveDecision({ behavior: 'allow', updatedInput: {} });
        await lifecycle.completeTurn({ provider: 'claude' });
        vi.useRealTimers();
    }
});

it('observes actual Agent SDK stdout while a tool-boundary transcript commit blocks iteration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-sdk-receipt-'));
    const executable = join(dir, 'provider.js');
    await writeFile(executable, `
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const message = JSON.parse(line);
            if (message.type === 'control_request') {
                send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
                    response: { commands: [], models: [], agents: [] } } });
            } else if (message.type === 'fixture_emit') {
                for (const frame of message.messages) send(frame);
            } else if (message.type === 'user') {
                send({ type: 'system', subtype: 'init', session_id: 'native-main' });
                send({ type: 'stream_event', session_id: 'native-main', parent_tool_use_id: null,
                    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Before tool' } } });
                send({ type: 'stream_event', session_id: 'native-main', parent_tool_use_id: null,
                    event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} } } });
            }
        }).on('close', () => process.exit(0));
    `);
    const notices: TurnStallNotice[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'happier-session', enqueueSessionTurn: async () => {},
        now: () => Date.now(), turnStallWarnMs: 100, onTurnStallNotice: notice => notices.push(notice) });
    const commitEntered = createDeferred();
    const releaseCommit = createDeferred();
    const finishInput = createDeferred();
    const childReady = createDeferred<ChildProcessWithoutNullStreams>();
    const writer = createStreamedTranscriptWriter({ provider: 'claude', session: {
        sendAgentMessage: () => {},
        sendAgentMessageCommitted: async () => { commitEntered.resolve(); await releaseCommit.promise; },
    }, initialCheckpointDelayMs: 10_000 });
    let run: Promise<void> | undefined;
    let sent = false;
    try {
        run = claudeRemoteAgentSdk({
            sessionId: null, transcriptPath: null, path: dir, claudeExecutablePath: executable,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
            nextMessage: async () => {
                if (sent) { await finishInput.promise; return null; }
                sent = true;
                return { message: 'hello', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            },
            onReady: () => { finishInput.resolve(); }, onSessionFound() {}, onMessage() {}, streamedTranscriptWriter: writer,
            onProviderEvent: () => lifecycle.observeProviderTurnEvent(),
            spawnClaudeCodeProcess: options => {
                const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: 'pipe' });
                childReady.resolve(child);
                return child;
            },
        });
        void run.catch(error => { childReady.reject(error); commitEntered.reject(error); });
        const child = await childReady.promise;
        const emit = async (messages: unknown[]) => {
            const received = once(child.stdout, 'data');
            child.stdin.write(JSON.stringify({ type: 'fixture_emit', messages }) + '\n');
            await received;
            await new Promise<void>(resolve => setImmediate(resolve));
        };
        await commitEntered.promise;
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(0);
        await lifecycle.beginTurn({ provider: 'claude' });
        await vi.advanceTimersByTimeAsync(75);
        await emit([
            { type: 'system', subtype: 'compact_boundary', session_id: 'native-compacted', compact_metadata: { trigger: 'auto', pre_tokens: 1 } },
        ]);
        await vi.advanceTimersByTimeAsync(75);
        await emit([
            { type: 'rate_limit_event', session_id: 'native-compacted', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } },
        ]);
        await vi.advanceTimersByTimeAsync(99);
        expect(notices).toEqual([]);
        await emit([
            { type: 'rate_limit_event', session_id: 'foreign-session' },
            { type: 'rate_limit_event', session_id: 'native-compacted', isReplay: true },
            { type: 'rate_limit_event', session_id: 'native-compacted', parent_tool_use_id: 'child' },
            { type: 'keep_alive' },
        ]);
        await vi.advanceTimersByTimeAsync(1);
        expect(notices).toMatchObject([{ lastEventAgeMs: 100 }]);
        lifecycle.dispose();
        vi.useRealTimers();
        releaseCommit.resolve();
        await emit([{ type: 'result', subtype: 'success', session_id: 'native-compacted', is_error: false }]);
        await run;
    } finally {
        lifecycle.dispose();
        vi.useRealTimers();
        releaseCommit.resolve();
        finishInput.resolve();
        const child = await childReady.promise.catch(() => null);
        child?.stdin.end();
        await run?.catch(() => {});
        writer.discard();
        await rm(dir, { recursive: true, force: true });
    }
});
