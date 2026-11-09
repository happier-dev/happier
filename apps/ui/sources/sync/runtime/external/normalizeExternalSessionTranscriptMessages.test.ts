import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from "@happier-dev/session-core/reducer";
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/protocol/sessions/messages/agentExternalSessionTranscriptRawRecord';
import { buildHappierBaseSystemPromptV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

import { projectClaudeJsonlLineToDirectMessages } from '../../../../../../packages/plugins/claude/src/agent/transcripts/projection';

import { normalizeExternalSessionTranscriptMessages } from './normalizeExternalSessionTranscriptMessages';

describe('normalizeExternalSessionTranscriptMessages', () => {
    it.each(['user', 'agent'] as const)('retains transient native images on normalized and reduced %s rows', role => {
        const media = [{ type: 'image' as const, mimeType: 'image/png' as const, data: 'aW1hZ2U=' }];
        const raw = role === 'user'
            ? { role, content: { type: 'text' as const, text: '' }, media }
            : { role, content: { type: 'acp', agentId: 'fx', data: { type: 'message', message: 'image result' } }, media };
        const normalized = normalizeExternalSessionTranscriptMessages([{ id: 'image-1', createdAtMs: 1, raw }]);
        expect(normalized[0]?.meta?.externalSessionMedia).toEqual(media);
        const reduced = reducer(createReducer(), normalized).messages;
        expect(reduced).toHaveLength(1);
        expect(reduced[0]?.meta?.externalSessionMedia).toEqual(media);
        expect(raw).not.toHaveProperty('meta');
    });

    it.each([{ length: 1 }, 'legacy-media-value'])('ignores non-array media in the compatibility wire carrier: %j', media => {
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'legacy-media', createdAtMs: 1,
            raw: { role: 'user', content: { type: 'text', text: 'hello' }, media },
        }]);
        expect(message?.meta?.externalSessionMedia).toBeUndefined();
        expect(message).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello' } });
    });

    it.each([undefined, { agentId: 'claude', remoteSessionId: 'native-1' }])('uses the host display projection under native/imported identity %j', sourceIdentity => {
        const raw = { role: 'user', content: { type: 'text', text: 'Catalog guidance\n\nReal request' } };
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'user-1', createdAtMs: 1, displayUserText: 'Real request', raw,
        }], sourceIdentity);
        expect(message).toMatchObject({ role: 'user', content: { type: 'text', text: 'Real request' } });
        expect(raw.content.text).toBe('Catalog guidance\n\nReal request');
    });

    it('projects injected user text for display without changing native records or agent text', () => {
        const prefix = buildHappierBaseSystemPromptV1();
        const text = `${prefix}\n\nFix the literal # Session title heading in my file.  Keep spacing.\n`;
        const userRaw = Object.freeze({ role: 'user' as const, content: Object.freeze({ type: 'text' as const, text }) });
        const items = [
            { id: 'user', createdAtMs: 1, raw: userRaw },
            { id: 'agent', createdAtMs: 2, raw: { role: 'agent' as const, content: {
                type: 'acp', agentId: 'acme.agent', data: { type: 'text', text },
            } } },
            { id: 'ordinary', createdAtMs: 3, raw: { role: 'user' as const, content: {
                type: 'text' as const, text: '# Session title\nPlease preserve this user-authored heading.',
            } } },
        ];
        const [user, agent, ordinary] = normalizeExternalSessionTranscriptMessages(items);
        expect(user).toMatchObject({ role: 'user', content: {
            type: 'text', text: 'Fix the literal # Session title heading in my file.  Keep spacing.\n',
        } });
        expect(agent).toMatchObject({ role: 'agent', content: [{ type: 'text', text }] });
        expect(ordinary).toMatchObject({ role: 'user', content: {
            type: 'text', text: '# Session title\nPlease preserve this user-authored heading.',
        } });
        expect(userRaw.content.text).toBe(text);
    });

    it('round-trips Claude agent output through current admission and the persisted transcript normalizer', () => {
        const projected = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: 'session.jsonl',
            lineStartOffsetBytes: 42,
            lineValue: {
                type: 'assistant',
                uuid: 'assistant-1',
                message: { content: [{ type: 'text', text: 'hello from Claude' }] },
            },
        });
        const admitted = projected.map((item) => ({
            ...item,
            raw: AgentExternalSessionTranscriptRawRecordSchema.parse(item.raw),
        }));

        const [message] = normalizeExternalSessionTranscriptMessages(admitted);

        expect(message).toMatchObject({
            role: 'agent',
            content: [{ type: 'text', text: 'hello from Claude' }],
        });
    });

    it('uses the historical-import identity so authority swaps do not duplicate rows or lose anchors', () => {
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'item-7',
            createdAtMs: 1,
            raw: { role: 'user', content: { type: 'text', text: 'hello' } },
        }], {
            agentId: 'opencode',
            remoteSessionId: 'remote-1',
        });

        expect(message?.id).toBe('direct-import:v1:opencode:b203ba1eb5dad52e461385bc');
    });

    it.each([
        {
            label: 'child user row',
            item: { id: 'child-user-1', raw: { role: 'user', content: { type: 'text', text: 'child prompt' } } },
            expected: { role: 'user', content: { type: 'text', text: 'child prompt' } },
        },
        {
            label: 'child agent row',
            item: { id: 'child-agent-1', raw: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'child response' } } } },
            expected: { role: 'agent', content: [{ type: 'text', text: 'child response' }] },
        },
        {
            label: 'output/user child row',
            item: {
                id: 'child-output-user-1',
                raw: { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: 'child tool response' } } } },
            },
            expected: { role: 'user', content: { type: 'text', text: 'child tool response' } },
        },
    ])('keeps a $label sidechain-scoped when only the validated external item carries its sidechain id', ({ item, expected }) => {
        const [message] = normalizeExternalSessionTranscriptMessages([{ ...item, createdAtMs: 1, sidechainId: 'child-1' }] as never);

        expect(message).toMatchObject({ ...expected, sidechainId: 'child-1', isSidechain: true });
    });

    it('prefers a validated external sidechain id over conflicting provider-raw agent metadata', () => {
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'child-agent-conflict-1',
            createdAtMs: 1,
            sidechainId: 'public-child-1',
            raw: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: 'child response',
                        sidechainId: 'provider-child-1',
                    },
                },
            },
        }]);

        expect(message).toMatchObject({
            role: 'agent',
            sidechainId: 'public-child-1',
            isSidechain: true,
        });
    });

    it('folds a projected tool-call/tool-call-result pair into one completed call instead of dropping the result', () => {
        // A Codex rollout page is ~half `tool-call-result` rows (real 102-item page: 48 calls,
        // 48 results, 6 messages). Those results are not transcript rows of their own — the
        // reducer merges each into its call — so a raw page/row-count comparison looks lossy.
        // Pin the merge itself: a pipeline that dropped the result would leave a `running`
        // call with no output, which is exactly the silent loss this guards.
        const callId = 'call_8JhLujT9BflU97jl2ITlrxZ4';
        const normalized = normalizeExternalSessionTranscriptMessages([
            {
                id: 'codex:rollout.jsonl:000000171215:000',
                localId: 'codex:rollout.jsonl:000000171215:000',
                createdAtMs: 1785950075252,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId,
                            name: 'exec',
                            input: { _raw: 'sed -n \'1,240p\' SKILL.md' },
                            id: 'codex:rollout.jsonl:000000171215:000',
                        },
                    },
                },
            },
            {
                id: 'codex:rollout.jsonl:000000171982:000',
                localId: 'codex:rollout.jsonl:000000171982:000',
                createdAtMs: 1785950075486,
                raw: {
                    role: 'agent',
                    media: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId,
                            output: [{ type: 'input_text', text: 'Script completed' }],
                            id: 'codex:rollout.jsonl:000000171982:000',
                        },
                    },
                },
            },
        ], { agentId: 'codex', remoteSessionId: 'remote-1' });

        expect(normalized.map((message) => (
            Array.isArray(message.content) ? message.content[0]?.type : null
        ))).toEqual(['tool-call', 'tool-result']);

        const reduced = reducer(createReducer(), normalized);
        expect(reduced.messages).toHaveLength(1);
        expect(reduced.messages[0]).toMatchObject({
            kind: 'tool-call',
            tool: { id: callId, name: 'exec', state: 'completed' },
        });
        expect(String((reduced.messages[0] as { tool: { result?: unknown } }).tool.result)).toContain('Script completed');
        expect(reduced.messages[0]?.meta?.externalSessionMedia).toEqual([{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]);
    });

    it('filters non-renderable rows using the producer role metadata', () => {
        // The projection classifies every external row; dropping that role here is what let
        // content-less event rows reach the transcript as unclassified agent output.
        const normalized = normalizeExternalSessionTranscriptMessages([{
            id: 'item-api-error',
            createdAtMs: 1,
            messageRole: 'event',
            raw: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', uuid: 'assistant-api-error', isApiErrorMessage: true },
                },
            },
        }]);

        expect(normalized).toEqual([]);
    });
});
