import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from '@/sync/reducer/reducer';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/protocol';

import { projectClaudeJsonlLineToDirectMessages } from '../../../../../../packages/plugins/claude/src/agent/transcripts/projection';

import { normalizeExternalSessionTranscriptMessages } from './normalizeExternalSessionTranscriptMessages';

describe('normalizeExternalSessionTranscriptMessages', () => {
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

    it.each([
        {
            label: 'current ACP text',
            data: { type: 'text', text: 'current transcript text' },
            expectedText: 'current transcript text',
        },
        {
            label: 'released ACP message',
            data: { type: 'message', message: 'released transcript text' },
            expectedText: 'released transcript text',
        },
    ])('normalizes $label records through the canonical raw transcript owner', ({ data, expectedText }) => {
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'item-text',
            createdAtMs: 1,
            raw: {
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: 'acme.agent',
                    data,
                },
            },
        }]);

        expect(message).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: expectedText,
            }],
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

    it('keeps a child user row sidechain-scoped when only the validated external item carries its sidechain id', () => {
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'child-user-1',
            createdAtMs: 1,
            sidechainId: 'child-1',
            raw: { role: 'user', content: { type: 'text', text: 'child prompt' } },
        }]);

        expect(message).toMatchObject({
            role: 'user',
            sidechainId: 'child-1',
            isSidechain: true,
            content: { type: 'text', text: 'child prompt' },
        });
    });

    it('keeps a child agent row sidechain-scoped when only the validated external item carries its sidechain id', () => {
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'child-agent-1',
            createdAtMs: 1,
            sidechainId: 'child-1',
            raw: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: { type: 'message', message: 'child response' },
                },
            },
        }]);

        expect(message).toMatchObject({
            role: 'agent',
            sidechainId: 'child-1',
            isSidechain: true,
            content: [{ type: 'text', text: 'child response' }],
        });
    });

    it('keeps an output/user child row sidechain-scoped when only the validated external item carries its sidechain id', () => {
        const [message] = normalizeExternalSessionTranscriptMessages([{
            id: 'child-output-user-1',
            createdAtMs: 1,
            sidechainId: 'child-1',
            raw: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: { content: 'child tool response' },
                    },
                },
            },
        }]);

        expect(message).toMatchObject({
            role: 'user',
            sidechainId: 'child-1',
            isSidechain: true,
            content: { type: 'text', text: 'child tool response' },
        });
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
