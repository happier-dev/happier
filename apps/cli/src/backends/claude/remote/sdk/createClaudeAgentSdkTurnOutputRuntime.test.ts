import { describe, expect, it, vi } from 'vitest';

import { createClaudeAgentSdkTurnOutputRuntime } from './createClaudeAgentSdkTurnOutputRuntime';

describe('createClaudeAgentSdkTurnOutputRuntime', () => {
    it('keeps reconstructed tool_use buffered when the assembled assistant already contains the same tool_use', async () => {
        const emitMessage = vi.fn();
        const emitAssistantTextMessage = vi.fn();
        const flushStreamedTranscriptWriter = vi.fn(async () => null);

        const runtime = createClaudeAgentSdkTurnOutputRuntime({
            streamedTranscriptWriter: null,
            emitMessage,
            emitAssistantTextMessage,
            flushStreamedTranscriptWriter,
        });

        await runtime.handleStreamEvent({
            type: 'stream_event',
            session_id: 'sess_1',
            parent_tool_use_id: null,
            event: {
                type: 'content_block_start',
                content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
            },
        } as any);

        await runtime.handleStreamEvent({
            type: 'stream_event',
            session_id: 'sess_1',
            parent_tool_use_id: null,
            event: {
                type: 'content_block_delta',
                delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' },
            },
        } as any);

        await runtime.handleStreamEvent({
            type: 'stream_event',
            session_id: 'sess_1',
            parent_tool_use_id: null,
            event: { type: 'content_block_stop' },
        } as any);

        const incomingAssistant = {
            type: 'assistant',
            session_id: 'sess_1',
            parent_tool_use_id: null,
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
            },
        } as any;

        const prepared = runtime.prepareIncomingMessage(incomingAssistant);

        expect(prepared).toEqual(incomingAssistant);
        expect(emitMessage).not.toHaveBeenCalled();
    });
});
