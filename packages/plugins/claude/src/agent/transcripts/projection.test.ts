import { describe, expect, it } from 'vitest';
import { resolveTranscriptBodySemanticEvent } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';

import {
    projectClaudeJsonlLineRecord,
    projectClaudeJsonlLineToDirectMessages,
    projectClaudeJsonlLineToRawMessage,
} from './projection.js';

describe('Claude JSONL projection', () => {
    it.each([
        { body: 'command output\n'.repeat(100), native: { stdout: 'command output\n'.repeat(100), stderr: '', exitCode: 0, backgroundTaskId: 'job-1' } },
        { body: 'Task report\n'.repeat(100), native: { content: [{ type: 'text', text: 'Task report\n'.repeat(100) }], status: 'completed', agentId: 'child-1', totalTokens: 42 } },
    ])('stores an exact repeated native body once and retains its structured facts', ({ body, native }) => {
        const [item] = projectClaudeJsonlLineToDirectMessages({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42,
            lineValue: { type: 'user', uuid: 'result', message: { content: [
                { type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: body }] },
            ] }, toolUseResult: native },
        });
        expect(item?.raw).toMatchObject({ content: { data: { type: 'tool-result', callId: 'call', output: native } } });
        expect(JSON.stringify(item).split(JSON.stringify(body).slice(1, -1))).toHaveLength(2);
    });

    it('retains different native text and native diff facts with the canonical result', () => {
        const native = { stdout: 'separate output', structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }] };
        const [item] = projectClaudeJsonlLineToDirectMessages({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42,
            lineValue: { type: 'user', uuid: 'result', message: { content: [
                { type: 'tool_result', tool_use_id: 'call', content: 'canonical output' },
            ] }, toolUseResult: native },
        });
        expect(item?.raw).toMatchObject({ content: { data: { output: { content: 'canonical output', tool_use_result: native } } } });
    });
    it('keeps canonical text-block facts that are absent from the native body', () => {
        const content = [{ type: 'text', text: 'body', citations: [{ source: 'file.txt' }] }];
        const [item] = projectClaudeJsonlLineToDirectMessages({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42,
            lineValue: { type: 'user', uuid: 'result', message: { content: [
                { type: 'tool_result', tool_use_id: 'call', content },
            ] }, toolUseResult: { stdout: 'body' } },
        });
        expect(item?.raw).toMatchObject({ content: { data: { output: { content, tool_use_result: { stdout: 'body' } } } } });
    });
    it('summarizes searchable text and exact ordinals without transporting tool payloads', () => {
        const params = { fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42,
            lineValue: { type: 'user', uuid: 'mixed-result', message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'read', content: 'private tool output '.repeat(1000) },
                { type: 'text', text: 'First visible text' },
                { type: 'thinking', thinking: ' ' },
                { type: 'tool_use', id: 'call', name: 'Read', input: { path: 'private tool metadata' } },
                { type: 'text', text: 'Second visible text' },
                { type: 'image', source: { type: 'base64', data: 'private image bytes' } },
            ] }, toolUseResult: { file: { content: 'private duplicate output' } } } };
        const full = projectClaudeJsonlLineRecord(params);
        expect(full.items).toHaveLength(5);
        expect(projectClaudeJsonlLineRecord({ ...params, projection: 'content_search',
            matchText: text => text.includes('visible') ? text : null })).toEqual({
            disposition: 'unsupported', itemCount: 5,
            match: { itemIndex: 1, sourceItemId: 'claude:000000000042', snippet: 'First visible text' },
        });
    });
    it.each([
        { name: 'tool-only phrase', query: 'private output', lineValue: { type: 'user', uuid: 'result',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'private output' }] } },
            itemCount: 1, matchingItemIndex: null },
        { name: 'tool transport fallback', query: 'unsupported content block',
            // JSON.parse can produce a non-finite number from a native JSON exponent.
            lineValue: JSON.parse('{"type":"assistant","uuid":"tool","message":{"content":[{"type":"tool_use","id":"call","name":"Read","input":{"number":1e999}}]}}'),
            itemCount: 1, matchingItemIndex: 0 },
        { name: 'empty thinking', query: 'anything', lineValue: { type: 'assistant', uuid: 'thinking',
            message: { content: [{ type: 'thinking', thinking: '  ' }] } }, itemCount: 0, matchingItemIndex: null },
        { name: 'withheld meta text', query: 'private', lineValue: { type: 'user', uuid: 'meta', isMeta: true,
            message: { content: 'private context' } }, itemCount: 0, matchingItemIndex: null },
        { name: 'unknown row', query: 'unsupported', lineValue: { type: 'future-record' },
            itemCount: 1, matchingItemIndex: 0 },
    ])('keeps the transcript count and text semantics for $name', ({ query, lineValue, itemCount, matchingItemIndex }) => {
        const params = { fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42, lineValue };
        const full = projectClaudeJsonlLineRecord(params);
        const summary = projectClaudeJsonlLineRecord({ ...params, projection: 'content_search',
            matchText: text => text.includes(query) ? text : null });
        const matchedItem = matchingItemIndex === null ? null : full.items[matchingItemIndex]!;
        expect(summary).toMatchObject({ disposition: full.disposition, itemCount,
            match: matchedItem ? { itemIndex: matchingItemIndex, sourceItemId: matchedItem.id, snippet: expect.stringContaining(query) } : null });
        expect(summary.itemCount).toBe(full.items.length);
    });
    it('projects image tool results without inline bytes while retaining text, tool correlation and the visible unsupported image', () => {
        const bytes = 'A'.repeat(628_392);
        const projection = projectClaudeJsonlLineRecord({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42,
            lineValue: { type: 'user', uuid: 'result', message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'read-image', content: [
                    { type: 'text', text: 'Image caption' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } },
                ] },
            ] }, toolUseResult: { type: 'image', file: { base64: bytes, type: 'image/png', width: 20, height: 10 } } },
        });
        expect(JSON.stringify(projection).includes(bytes)).toBe(false);
        expect(projection.disposition).toBe('unsupported');
        expect(projection.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ messageRole: 'event', raw: { role: 'agent', content: {
                type: 'acp', agentId: 'claude', data: expect.objectContaining({ type: 'tool-result', callId: 'read-image',
                    output: expect.objectContaining({ content: expect.arrayContaining([{ type: 'text', text: 'Image caption' }]),
                        tool_use_result: { type: 'image', file: { type: 'image/png', width: 20, height: 10 } } }) }),
            } } }),
            expect.objectContaining({ messageRole: 'agent', raw: { role: 'agent', content: {
                type: 'acp', agentId: 'claude', data: { type: 'message', message: 'Claude emitted an unsupported image content block.' },
            } } }),
        ]));
    });
    it.each([
        { type: 'cost-state', sessionId: 'native', totalCostUSD: 0, modelUsage: {}, hasUnknownModelCost: false },
        { type: 'atis-latch', sessionId: 'native', atis: 'fixture bookkeeping' },
    ])('recognizes observed native bookkeeping without losing transcript continuity: $type', lineValue => {
        expect(projectClaudeJsonlLineRecord({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42, lineValue }))
            .toEqual({ disposition: 'known_non_transcript', items: [] });
    });
    it('keeps native API request bookkeeping out of the conversation while preserving subsequent assistant text', () => {
        // Claude 2.1.302, CLAUDETERM c11 native JSONL (2026-10-16): request
        // shapes and content-addressed blobs record the API input, not new speech.
        const records = [
            { type: 'api-request-shape', sessionId: 'native', shapeHash: 'shape', timestamp: '2026-10-16T23:31:08.400Z',
                version: '2.1.302', shape: { messages: [] } },
            { type: 'api-request-blob', sessionId: 'native', hash: 'blob',
                message: { role: 'user', content: [{ type: 'text', text: 'previous private request input' }] } },
            { type: 'api-request', sessionId: 'native', id: 'request', timestamp: '2026-10-16T23:31:08.400Z',
                version: '2.1.302', shapeHash: 'shape', params: {}, keep: [], tail: [], cacheControl: [], requestDigest: 'digest' },
        ];
        const projected = records.map((lineValue, index) => projectClaudeJsonlLineRecord({
            fileRelPath: 'session.jsonl', lineStartOffsetBytes: index * 100, lineValue,
        }));
        expect(projected).toEqual(records.map(() => ({ disposition: 'known_non_transcript', items: [] })));
        const reply = projectClaudeJsonlLineRecord({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 400,
            lineValue: { type: 'assistant', uuid: 'reply', message: { role: 'assistant', content: [{ type: 'text', text: 'next reply' }] } },
        });
        expect(reply.disposition).toBe('mapped');
        expect(reply.items).toHaveLength(1);
        expect(reply.items[0]?.raw).toMatchObject({ role: 'agent', content: { data: { type: 'message', message: 'next reply' } } });
    });
    it.each([
        { type: 'thinking', thinking: null, signature: 'fixture-signature' },
        { type: 'image', source: { type: 'base64', data: 'fixture-image' } },
        { type: 'tool_use', name: 'Read' },
    ])('keeps an unsupported native block admissible by the strict transcript consumer: $type', (block) => {
        const [item] = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42,
            lineValue: { type: 'assistant', uuid: 'unsupported', message: { role: 'assistant', content: [block] } },
        });
        expect(item?.raw.role).toBe('agent');
        if (!item || item.raw.role !== 'agent') throw new Error('Expected a visible unsupported-content marker');
        const semantic = resolveTranscriptBodySemanticEvent({ protocol: 'acp', body: item.raw.content });
        expect(semantic).not.toBeNull();
        expect(item.messageRole).toBe(semantic?.role);
    });

    it('advances past empty signed thinking without inventing unsupported assistant speech', () => {
        // Observed Claude native JSONL, 2026-10-15: signed thinking may be intentionally empty.
        const lineValue = { type: 'assistant', uuid: 'empty-thinking', message: {
            role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'native-signature' }],
        } };
        expect(projectClaudeJsonlLineRecord({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42, lineValue }))
            .toEqual({ disposition: 'known_non_transcript', items: [] });
    });

    it('keeps mixed native tool-result and text rows admissible by the strict transcript consumer', () => {
        const items = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42,
            lineValue: { type: 'user', uuid: 'mixed-result', message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'call', content: 'tool output' },
                { type: 'text', text: 'additional result context' },
            ] } },
        });
        expect(items).toHaveLength(2);
        for (const item of items) {
            expect(item.raw.role).toBe('agent');
            if (item.raw.role !== 'agent') throw new Error('Expected canonical agent content');
            const semantic = resolveTranscriptBodySemanticEvent({ protocol: 'acp', body: item.raw.content });
            expect(semantic).not.toBeNull();
            expect(item.messageRole).toBe(semantic?.role);
        }
    });

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

    it.each(['completed', 'failed', 'stopped'] as const)('projects native queued %s into the existing direct-history tool result contract', status => {
        const notification = { type: 'attachment', uuid: 'native-terminal', attachment: {
            type: 'queued_command', commandMode: 'task-notification', prompt:
                `<task-notification><task-id>native-task</task-id><tool-use-id>original-tool</tool-use-id><status>${status}</status><result>Native findings</result></task-notification>`,
        } };
        const [projected] = projectClaudeJsonlLineToDirectMessages({ fileRelPath: 'session.jsonl', lineStartOffsetBytes: 42, lineValue: notification });
        expect(projected?.raw).toMatchObject({ role: 'agent', content: { type: 'acp', agentId: 'claude',
            data: { type: 'tool-result', callId: 'original-tool', isError: status !== 'completed' } } });
        expect(JSON.stringify(projected?.raw)).toContain('Native findings');
        expect(JSON.stringify(projected?.raw)).not.toContain('queued_command');
        expect(projected?.userProjection).toBeUndefined();
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
        [
            'assistant API error carrying text',
            { type: 'assistant', uuid: 'assistant-api-error-text', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'provider failed' }] } },
            'event',
            {
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: 'claude',
                    data: { type: 'turn_failed', id: 'claude-jsonl:main:assistant:assistant-api-error-text' },
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

    it('marks opaque rows without disclosing private source metadata through the transcript', () => {
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

        expect(projected).toHaveLength(1);
        expect(projected[0]?.raw).toMatchObject({ role: 'agent', content: { type: 'acp',
            data: { type: 'message', message: 'Agent emitted an unsupported content block.' } } });
        expect(JSON.stringify(projected)).not.toContain('must remain private');
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

/**
 * Row shapes taken from the local `~/.claude/projects` corpus written by the
 * pinned Claude CLI. Unsupported records retain a visible fallback; ratified
 * `bridge-session` / `ai-title` / `agent-setting` carry no message body,
 * and a sidechain or `isMeta` `user` row is a conversation row this projection
 * withholds on purpose because it has no admissible user projection.
 */
describe('Claude JSONL record disposition', () => {
    function project(lineValue: unknown) {
        return projectClaudeJsonlLineRecord({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 0,
            lineValue,
        });
    }

    it.each([
        ['bridge-session', { type: 'bridge-session', bridgeSessionId: 'b1', lastSequenceNum: 4, sessionId: 's1' }],
        ['ai-title', { type: 'ai-title', aiTitle: 'Refactor the parser', sessionId: 's1' }],
        ['custom-title', { type: 'custom-title', customTitle: 'User title', sessionId: 's1' }],
        ['agent-setting', { type: 'agent-setting', agentSetting: 'model', sessionId: 's1' }],
    ])('advances past the durable content-free record %s', (_label, record) => {
        expect(project(record)).toEqual({ disposition: 'known_non_transcript', items: [] });
    });

    it.each([
        ['a sidechain prompt', { isSidechain: true }],
        ['an isMeta context row', { isMeta: true }],
    ])('advances past %s whose text this projection withholds', (_label, flags) => {
        expect(project({
            type: 'user',
            uuid: 'user-1',
            timestamp: '2026-01-01T00:00:00.000Z',
            ...flags,
            message: { role: 'user', content: 'spawned work' },
        })).toEqual({ disposition: 'known_non_transcript', items: [] });
    });

    it('publishes a root user turn as a source fact', () => {
        const projected = project({
            type: 'user',
            uuid: 'user-2',
            timestamp: '2026-01-01T00:00:00.000Z',
            message: { role: 'user', content: 'hello' },
        });
        expect(projected.disposition).toBe('mapped');
        expect(projected.items).toHaveLength(1);
        expect(projected.items[0]?.userProjection).toBe('source_fact');
    });

    it.each([
        { type: 'not-a-real-claude-record', sessionId: 's1', privateContent: 'do not disclose' },
        { type: 'assistant', uuid: 'assistant-9', message: 7 },
        { type: 'assistant', uuid: 'missing-content', message: {} },
        null,
    ])('represents an unsupported native record with a safe visible fallback: %j', record => {
        const projected = project(record);
        expect(projected.disposition).toBe('unsupported');
        expect(projected.items).toHaveLength(1);
        expect(projected.items[0]).toMatchObject({ id: 'claude:000000000000', messageRole: 'agent',
            raw: { role: 'agent', content: { type: 'acp', data: { type: 'message',
                message: 'Agent emitted an unsupported content block.' } } } });
        expect(JSON.stringify(projected.items)).not.toContain('do not disclose');
    });
});
