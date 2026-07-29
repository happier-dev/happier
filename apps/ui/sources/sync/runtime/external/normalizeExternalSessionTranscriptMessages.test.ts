import { describe, expect, it } from 'vitest';

import { normalizeExternalSessionTranscriptMessages } from './normalizeExternalSessionTranscriptMessages';

describe('normalizeExternalSessionTranscriptMessages', () => {
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
