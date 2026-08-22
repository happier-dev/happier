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

    it.each([
        [
            'message-less assistant',
            { type: 'assistant', uuid: 'assistant-api-error', isApiErrorMessage: true },
            'event',
            {
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: 'claude',
                    data: { type: 'turn_failed', id: 'claude-jsonl:main:assistant:assistant-api-error' },
                },
            },
        ],
        [
            'assistant text with missing nested role',
            { type: 'assistant', uuid: 'assistant-missing-role', message: { content: [{ type: 'text', text: 'hello' }] } },
            'agent',
            {
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: 'claude',
                    data: { type: 'message', message: 'hello' },
                },
            },
        ],
    ] as const)('projects a canonical semantic body for %s', (_name, lineValue, expectedRole, expectedRaw) => {
        const [projected] = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue,
        });

        expect(projected?.messageRole).toBe(expectedRole);
        expect(projected?.raw).toEqual(expectedRaw);
        expect(projected?.userProjection).toBeUndefined();
    });

    it('drops opaque rows instead of disclosing private source metadata through the transcript', () => {
        const projected = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'private/projects/session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: {
                type: 'assistant',
                uuid: 42,
                fileRelPath: '/private/provider/session.jsonl',
                message: { content: [{ type: 'text', text: 'must remain private' }] },
            },
        });

        expect(projected).toEqual([]);
        expect(JSON.stringify(projected)).not.toContain('fileRelPath');
        expect(JSON.stringify(projected)).not.toContain('/private/provider/session.jsonl');
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
        expect(projected[0]?.id).toBe('claude:000000000042');
        expect(projected[0]?.localId).toBe('claude-jsonl:main:user:user-1');
        expect(projected[0]?.userProjection).toBe('source_fact');
        expect(projected[0]?.raw).toEqual({
            role: 'user',
            content: { type: 'text', text: 'hello' },
        });
    });

    it('keeps recipient-safe cursor identity separate from sidechain provider-fact identity', () => {
        const projected = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: {
                type: 'assistant',
                uuid: 'assistant-1',
                sidechainId: 'agent-7',
                message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
            },
        });

        expect(projected[0]?.id).toBe('claude:000000000042');
        expect(projected[0]?.localId).toBe('claude-jsonl:agent-7:assistant:assistant-1');
    });

    it('keeps a sidechain command fact distinct from an equally named main-chain fact without exposing either file path', () => {
        const main = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'private/projects/main-session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: {
                type: 'user',
                uuid: 'shared-command-row',
                message: {
                    content: '<command-name>/review</command-name><command-args>main</command-args>',
                },
            },
        });
        const sidechain = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'private/projects/sidechain-session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: {
                type: 'user',
                uuid: 'shared-command-row',
                isSidechain: true,
                message: {
                    content: '<command-name>/review</command-name><command-args>sidechain</command-args>',
                },
            },
        });
        const repeatedSidechain = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'private/projects/sidechain-session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: {
                type: 'user',
                uuid: 'shared-command-row',
                isSidechain: true,
                message: {
                    content: '<command-name>/review</command-name><command-args>sidechain</command-args>',
                },
            },
        });

        expect(main).toHaveLength(1);
        expect(sidechain).toHaveLength(1);
        expect(repeatedSidechain).toHaveLength(1);
        expect(main[0]?.localId).not.toBe(sidechain[0]?.localId);
        expect(repeatedSidechain[0]?.localId).toBe(sidechain[0]?.localId);
        expect(main[0]?.userProjection).toBe('source_fact');
        expect(sidechain[0]?.userProjection).toBeUndefined();
        expect(JSON.stringify([main, sidechain])).not.toContain('fileRelPath');
        expect(JSON.stringify([main, sidechain])).not.toContain('private/projects/');
    });

    it('does not label metadata command echoes as independently authored source facts', () => {
        const projected = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 43,
            lineValue: {
                type: 'user',
                uuid: 'metadata-command-row',
                isMeta: true,
                message: {
                    content: '<command-name>/review</command-name><command-args>metadata</command-args>',
                },
            },
        });

        expect(projected).toHaveLength(1);
        expect(projected[0]?.raw).toEqual({
            role: 'user',
            content: { type: 'text', text: '/review metadata' },
        });
        expect(projected[0]?.userProjection).toBeUndefined();
    });

    it('keeps distinct recipient-safe identities and text for rows with shared canonical message semantics', () => {
        const [assistant] = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'private/projects/claude-session.jsonl',
            lineStartOffsetBytes: 11,
            lineValue: {
                type: 'assistant',
                uuid: 'assistant-1',
                nativeEnvelope: { private: 'do-not-publish' },
                message: { content: [{ type: 'text', text: 'assistant visible' }] },
            },
        });
        const [compact] = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'private/projects/claude-session.jsonl',
            lineStartOffsetBytes: 12,
            lineValue: {
                type: 'user',
                uuid: 'compact-1',
                isCompactSummary: true,
                nativeEnvelope: { private: 'do-not-publish' },
                message: { content: 'compact visible' },
            },
        });
        const [localCommand] = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'private/projects/claude-session.jsonl',
            lineStartOffsetBytes: 13,
            lineValue: {
                type: 'user',
                uuid: 'local-command-1',
                nativeEnvelope: { private: 'do-not-publish' },
                message: { content: '<local-command-stdout>local command visible</local-command-stdout>' },
            },
        });
        const projected = [assistant, compact, localCommand];

        expect(projected).not.toContain(undefined);
        expect(projected.map((item) => item?.id)).toEqual([
            'claude:000000000011',
            'claude:000000000012',
            'claude:000000000013',
        ]);
        expect(projected.map((item) => item?.localId)).toEqual([
            'claude-jsonl:main:assistant:assistant-1',
            'claude-jsonl:main:user:compact-1',
            'claude-jsonl:main:user:local-command-1',
        ]);
        expect(projected.map((item) => item?.raw)).toEqual([
            {
                role: 'agent',
                content: { type: 'acp', agentId: 'claude', data: { type: 'message', message: 'assistant visible' } },
            },
            {
                role: 'agent',
                content: { type: 'acp', agentId: 'claude', data: { type: 'message', message: 'compact visible' } },
            },
            {
                role: 'agent',
                content: { type: 'acp', agentId: 'claude', data: { type: 'message', message: 'local command visible' } },
            },
        ]);
        expect(JSON.stringify(projected)).not.toContain('fileRelPath');
        expect(JSON.stringify(projected)).not.toContain('private/projects/claude-session.jsonl');
        expect(JSON.stringify(projected)).not.toContain('nativeEnvelope');
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
                type: 'acp',
                agentId: 'claude',
                data: { type: 'message', message: 'This session is being continued from a previous conversation.' },
            },
        });
        expect(slashCommand[0]?.raw).toEqual({
            role: 'user',
            content: { type: 'text', text: '/compact' },
        });
        expect(slashCommand[0]?.userProjection).toBe('source_fact');
        expect(commandStdout[0]?.raw).toEqual({
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'claude',
                data: {
                    type: 'message',
                    message: 'Compacted\nPreCompact [python3 \'/tmp/hook.py\'] completed successfully',
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
        expect(projected[0]?.userProjection).toBe('source_fact');
    });
});
