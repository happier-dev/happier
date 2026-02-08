import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testHelpers';

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
});
