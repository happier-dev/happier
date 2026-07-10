import { describe, expect, it } from 'vitest';

import {
    projectClaudeJsonlLineToDirectMessages,
    projectClaudeJsonlLineToRawMessage,
} from './projection.js';

describe('Claude JSONL projection', () => {
    it('drops Claude internal event records from raw message projection', () => {
        expect(projectClaudeJsonlLineToRawMessage({ type: 'rate_limit_event', message: 'capacity' })).toBeNull();
    });

    it('drops Claude attachment control rows from transcript projection', () => {
        const attachment = {
            type: 'attachment',
            uuid: 'attachment-1',
            attachment: {
                type: 'deferred_tools_delta',
                itemCount: 1,
            },
        };

        expect(projectClaudeJsonlLineToRawMessage(attachment)).toBeNull();
        expect(projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: attachment,
        })).toEqual([]);
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

    it('drops Claude slash-command rows from raw message projection', () => {
        for (const row of [
            {
                type: 'user',
                uuid: 'model-command-1',
                message: {
                    content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
                },
            },
            {
                type: 'user',
                uuid: 'model-stdout-1',
                message: {
                    content: '<local-command-stdout>Set model to Opus 4.8 and saved as your default for new sessions</local-command-stdout>',
                },
            },
        ]) {
            expect(projectClaudeJsonlLineToRawMessage(row)).toBeNull();
        }
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

    it('projects command and compact artifacts as sanitized visible direct transcript rows', () => {
        const compactSummary = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 1,
            lineValue: {
                type: 'user',
                uuid: 'compact-summary-1',
                isCompactSummary: true,
                isVisibleInTranscriptOnly: true,
                message: { content: 'This session is being continued from a previous conversation.' },
            },
        });
        const slashCommand = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 2,
            lineValue: {
                type: 'user',
                uuid: 'compact-command-1',
                message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
            },
        });
        const commandStdout = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 3,
            lineValue: {
                type: 'user',
                uuid: 'compact-stdout-1',
                message: {
                    content:
                        '<local-command-stdout>\u001b[2mCompacted\u001b[22m\n'
                        + "\u001b[2mPreCompact [python3 '/tmp/hook.py'] completed successfully\u001b[22m</local-command-stdout>",
                },
            },
        });

        expect(compactSummary[0]?.raw).toEqual({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'claude_compact_summary',
                    text: 'This session is being continued from a previous conversation.',
                },
            },
        });
        expect(slashCommand[0]?.raw).toEqual({
            role: 'user',
            content: { type: 'text', text: '/compact' },
        });
        expect(commandStdout[0]?.raw).toEqual({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'claude_local_command_output',
                    text: 'Compacted\nPreCompact [python3 \'/tmp/hook.py\'] completed successfully',
                },
            },
        });
        expect(JSON.stringify([compactSummary, slashCommand, commandStdout])).not.toContain('<command-name>');
        expect(JSON.stringify([compactSummary, slashCommand, commandStdout])).not.toContain('<local-command-stdout>');
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
