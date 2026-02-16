import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

describe('claudeRemoteAgentSdk stream events', () => {
    it('coalesces Agent SDK stream_event text deltas into synthetic assistant partial messages', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'Hel' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_2',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'lo' },
                        },
                    } as any;
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
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

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, claudeRemoteIncludePartialMessages: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage.mock.calls.some(([msg]) => msg?.type === 'stream_event')).toBe(false);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            happierPartial: true,
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'text', text: 'Hel' })],
            }),
        }));
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            happierPartial: true,
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'text', text: 'lo' })],
            }),
        }));
    });

    it('reconstructs tool_use blocks from stream_event tool deltas so tool trace is not lost', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_stop',
                        },
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

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, claudeRemoteIncludePartialMessages: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage.mock.calls.some(([msg]) => msg?.type === 'stream_event')).toBe(false);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'tool_use', id: 'toolu_1', name: 'Bash' })],
            }),
        }));
    });

    it('does not emit duplicate tool_use when the assembled SDK assistant message also includes the same tool_use block', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;

                    // Some Agent SDK versions emit the assembled assistant message containing tool_use
                    // in addition to the raw stream events.
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
                        },
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

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, claudeRemoteIncludePartialMessages: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1'));

        expect(toolUseMessages).toHaveLength(1);
    });

    it('does not emit duplicate tool_use when system/status messages interleave before the assembled assistant tool_use message', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;

                    // Interleaving system messages can appear before the assembled assistant message.
                    yield {
                        type: 'system',
                        subtype: 'status',
                        session_id: 'sess_1',
                        uuid: 'sys_1',
                    } as any;

                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
                        },
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

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, claudeRemoteIncludePartialMessages: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1'));

        expect(toolUseMessages).toHaveLength(1);
    });

    it('does not emit duplicate tool_use when stream events for a tool_use arrive after the assembled assistant tool_use message', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    // Assembled assistant tool_use arrives first.
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
                        },
                    } as any;

                    // Late stream events for the same tool_use should not cause a synthetic duplicate.
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
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

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, claudeRemoteIncludePartialMessages: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1'));

        expect(toolUseMessages).toHaveLength(1);
    });

    it('strips duplicate tool_use blocks from later assistant messages that also include non-tool content', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    // Tool use arrives as raw stream events only (so we synthesize a tool_use message).
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_tool_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_tool_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_tool_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;

                    // Tool result is delivered as an assembled user message. This forces the synthetic tool_use flush.
                    yield {
                        type: 'user',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'user',
                            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'OK', is_error: false }],
                        },
                    } as any;

                    // Some Agent SDK versions can later emit an assistant message that contains both text and a tool_use
                    // block we've already emitted. The duplicate tool_use must be stripped while preserving the text.
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [
                                { type: 'text', text: 'Ran tool.' },
                                { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
                            ],
                        },
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

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, claudeRemoteIncludePartialMessages: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseBlocksSeen = onMessage.mock.calls
            .map(([msg]) => msg)
            .flatMap((msg) => (Array.isArray(msg?.message?.content) ? msg.message.content : []))
            .filter((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1');

        expect(toolUseBlocksSeen).toHaveLength(1);

        const laterAssistant = onMessage.mock.calls
            .map(([msg]) => msg)
            .find((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content) && msg.message.content.some((c: any) => c?.type === 'text'));

        expect(laterAssistant).toBeTruthy();
        expect(laterAssistant.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1')).toBe(false);
        expect(laterAssistant.message.content.some((c: any) => c?.type === 'text' && c?.text === 'Ran tool.')).toBe(true);
    });

    it('reconstructs tool_result blocks from stream_event deltas so tool trace is not lost', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_result', tool_use_id: 'toolu_1' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'OK' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_stop',
                        },
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

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, claudeRemoteIncludePartialMessages: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage.mock.calls.some(([msg]) => msg?.happierPartial === true)).toBe(false);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'user',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_1' })],
            }),
        }));
    });
});
