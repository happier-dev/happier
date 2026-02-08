import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testHelpers';

describe('claudeRemoteAgentSdk checkpoints and rewind', () => {
    it('captures checkpoint ids and supports /rewind --confirm when file checkpointing is enabled', async () => {
        const rewindFiles = vi.fn(async () => ({ canRewind: true }));
        const onMessage = vi.fn();
        const onCompletionEvent = vi.fn();
        const onCheckpointCaptured = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'user',
                        uuid: 'cp_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                    } as any;
                    yield { type: 'result' } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
                rewindFiles,
            } as any;
        });

        const messages = [
            { message: 'hello', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
            { message: '/rewind --confirm', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
        ];

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => messages.shift() ?? null,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            onCompletionEvent,
            onCheckpointCaptured,
            createQuery,
        } as any);

        expect(onCheckpointCaptured).toHaveBeenCalledWith('cp_1');
        expect(rewindFiles).toHaveBeenCalledWith('cp_1', undefined);
        expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('Rewound files'));
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ happierTraceMarker: 'checkpoint-rewind' }));
    });

    it('requires explicit confirmation before rewinding files and warns that rewind is files-only', async () => {
        const rewindFiles = vi.fn(async () => ({ canRewind: true }));
        const onCompletionEvent = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'user',
                        uuid: 'cp_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                    } as any;
                    yield { type: 'result' } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
                rewindFiles,
            } as any;
        });

        const messages = [
            { message: 'hello', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
            { message: '/rewind', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
        ];

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => messages.shift() ?? null,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent,
            createQuery,
        } as any);

        expect(rewindFiles).not.toHaveBeenCalled();
        expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringMatching(/files/i));
        expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringMatching(/conversation/i));
        expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringMatching(/--confirm|confirm/i));
    });

    it('captures checkpoint ids from replayed user messages when content is a plain string', async () => {
        const onCheckpointCaptured = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'user',
                        uuid: 'cp_1',
                        isReplay: true,
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'user', content: 'hello' },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onCheckpointCaptured,
            createQuery,
        } as any);

        expect(onCheckpointCaptured).toHaveBeenCalledWith('cp_1');
    });

    it('lists captured checkpoints via /checkpoints', async () => {
        const onCompletionEvent = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'user',
                        uuid: 'cp_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                    } as any;
                    yield {
                        type: 'user',
                        uuid: 'cp_2',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'user', content: [{ type: 'text', text: 'world' }] },
                    } as any;
                    yield { type: 'result' } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        const messages = [
            { message: 'hello', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
            { message: '/checkpoints', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
        ];

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => messages.shift() ?? null,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent,
            createQuery,
        } as any);

        const combined = onCompletionEvent.mock.calls.map((c) => String(c[0])).join('\n');
        expect(combined).toContain('Available checkpoints');
        expect(combined).toContain('cp_2');
        expect(combined).toContain('cp_1');
        expect(combined).toMatch(/does not rewind the conversation/i);
    });

    it('does not treat tool_result user messages as file checkpoints for /rewind --confirm', async () => {
        const rewindFiles = vi.fn(async () => ({ canRewind: true }));
        const onMessage = vi.fn();
        const onCheckpointCaptured = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'user',
                        uuid: 'cp_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                    } as any;
                    yield {
                        type: 'user',
                        uuid: 'tool_res_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'user',
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: 'toolu_1',
                                    content: 'ok',
                                },
                            ],
                        },
                    } as any;
                    yield { type: 'result' } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
                rewindFiles,
            } as any;
        });

        const messages = [
            { message: 'hello', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
            { message: '/rewind --confirm', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
        ];

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => messages.shift() ?? null,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            onCheckpointCaptured,
            createQuery,
        } as any);

        expect(onCheckpointCaptured).toHaveBeenCalledWith('cp_1');
        expect(onCheckpointCaptured).not.toHaveBeenCalledWith('tool_res_1');
        expect(rewindFiles).toHaveBeenCalledWith('cp_1', undefined);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ happierTraceMarker: 'checkpoint-rewind' }));
    });

    it('treats replayed user messages as file checkpoints for /rewind --confirm when they are the only checkpoint candidate', async () => {
        const rewindFiles = vi.fn(async () => ({ canRewind: true }));
        const onCheckpointCaptured = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'user',
                        uuid: 'cp_replay_1',
                        isReplay: true,
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                    } as any;
                    yield { type: 'result' } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
                rewindFiles,
            } as any;
        });

        const messages = [
            { message: 'hello', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
            { message: '/rewind --confirm', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
        ];

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => messages.shift() ?? null,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onCheckpointCaptured,
            createQuery,
        } as any);

        expect(onCheckpointCaptured).toHaveBeenCalledWith('cp_replay_1');
        expect(rewindFiles).toHaveBeenCalledWith('cp_replay_1', undefined);
    });

    it('records a checkpoint-rewind marker to tool trace when /rewind --confirm succeeds', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-claude-remote-sdk-'));
        const traceFile = join(testDir, 'tooltrace.jsonl');

        const previousTrace = process.env.HAPPIER_STACK_TOOL_TRACE;
        const previousTraceFile = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
        process.env.HAPPIER_STACK_TOOL_TRACE = '1';
        process.env.HAPPIER_STACK_TOOL_TRACE_FILE = traceFile;
        __resetToolTraceForTests();

        try {
            const rewindFiles = vi.fn(async () => ({ canRewind: true }));

            const createQuery = vi.fn((_params: any) => {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: 'user',
                            uuid: 'cp_1',
                            session_id: 'sess_1',
                            parent_tool_use_id: null,
                            message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                        } as any;
                        yield { type: 'result' } as any;
                        yield { type: 'result' } as any;
                    },
                    close: vi.fn(),
                    setPermissionMode: vi.fn(),
                    setModel: vi.fn(),
                    setMaxThinkingTokens: vi.fn(),
                    supportedCommands: vi.fn(async () => []),
                    supportedModels: vi.fn(async () => []),
                    rewindFiles,
                } as any;
            });

            const messages = [
                { message: 'hello', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
                { message: '/rewind --confirm', mode: makeMode({ claudeRemoteEnableFileCheckpointing: true }) },
            ];

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
                allowedTools: [],
                mcpServers: {},
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage: async () => messages.shift() ?? null,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                createQuery,
            } as any);

            expect(existsSync(traceFile)).toBe(true);
            const raw = await readFile(traceFile, 'utf8');
            expect(raw).toContain('"protocol":"claude"');
            expect(raw).toContain('"provider":"claude"');
            expect(raw).toContain('"kind":"checkpoint-rewind"');
            expect(raw).toContain('checkpoint-rewind');
        } finally {
            if (previousTrace == null) {
                delete process.env.HAPPIER_STACK_TOOL_TRACE;
            } else {
                process.env.HAPPIER_STACK_TOOL_TRACE = previousTrace;
            }
            if (previousTraceFile == null) {
                delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
            } else {
                process.env.HAPPIER_STACK_TOOL_TRACE_FILE = previousTraceFile;
            }
            __resetToolTraceForTests();
            await rm(testDir, { recursive: true, force: true });
        }
    });

});
