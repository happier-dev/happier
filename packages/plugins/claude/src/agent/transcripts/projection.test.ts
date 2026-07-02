import { describe, expect, it } from 'vitest';

import {
    projectClaudeJsonlLineToDirectMessages,
    projectClaudeJsonlLineToRawMessage,
} from './projection.js';

describe('Claude JSONL projection', () => {
    it('drops Claude internal event records from raw message projection', () => {
        expect(projectClaudeJsonlLineToRawMessage({ type: 'rate_limit_event', message: 'capacity' })).toBeNull();
    });

    it('normalizes Claude team tool names while projecting raw messages', () => {
        const projected = projectClaudeJsonlLineToRawMessage({
            type: 'assistant',
            uuid: 'assistant-1',
            message: {
                content: [{ type: 'tool_use', name: 'Agent' }],
            },
        });

        expect(projected?.type).toBe('assistant');
        expect((projected as { message?: { content?: Array<{ name?: string }> } })?.message?.content?.[0]?.name).toBe('SubAgent');
    });

    it('projects plain root user messages to direct text transcript rows', () => {
        const projected = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: {
                type: 'user',
                uuid: 'user-1',
                timestamp: '2026-06-06T00:00:00.000Z',
                message: { content: 'hello' },
            },
        });

        expect(projected).toHaveLength(1);
        expect(projected[0]?.id).toBe('claude:session.jsonl:000000000042');
        expect(projected[0]?.raw).toEqual({
            role: 'user',
            content: { type: 'text', text: 'hello' },
        });
    });

    it('drops compact summary and local-command artifacts from direct transcript rows', () => {
        const rows = [
            {
                type: 'user',
                uuid: 'compact-summary-1',
                isCompactSummary: true,
                isVisibleInTranscriptOnly: true,
                message: { content: 'This session is being continued from a previous conversation.' },
            },
            {
                type: 'user',
                uuid: 'compact-command-1',
                message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
            },
            {
                type: 'user',
                uuid: 'compact-stdout-1',
                message: {
                    content:
                        '<local-command-stdout>\u001b[2mCompacted\u001b[22m\n'
                        + "\u001b[2mPreCompact [python3 '/tmp/hook.py'] completed successfully\u001b[22m</local-command-stdout>",
                },
            },
        ];

        for (const [index, row] of rows.entries()) {
            expect(projectClaudeJsonlLineToDirectMessages({
                fileRelPath: 'session.jsonl',
                lineStartOffsetBytes: index,
                lineValue: row,
            })).toEqual([]);
        }
    });

    it('keeps plain slash compact prompts as direct user text', () => {
        const projected = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 100,
            lineValue: {
                type: 'user',
                uuid: 'plain-compact-1',
                message: { content: '/compact' },
            },
        });

        expect(projected).toHaveLength(1);
        expect(projected[0]?.raw).toEqual({
            role: 'user',
            content: { type: 'text', text: '/compact' },
        });
    });
});
