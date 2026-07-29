import { describe, expect, it } from 'vitest';

import { parseRawJsonLinesLine, parseRawJsonLinesObject } from './parseRawJsonLines.js';

describe('parseRawJsonLines', () => {
    it('returns null for empty lines', () => {
        expect(parseRawJsonLinesLine('')).toBeNull();
        expect(parseRawJsonLinesLine('   ')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
        expect(parseRawJsonLinesLine('{')).toBeNull();
        expect(parseRawJsonLinesLine('not json')).toBeNull();
    });

    it('parses a valid assistant message and preserves unknown fields', () => {
        const line = JSON.stringify({
            type: 'assistant',
            uuid: 'u1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
            extra_field: { nested: true },
        });
        const parsed = parseRawJsonLinesLine(line);
        expect(parsed?.type).toBe('assistant');
        expect((parsed as { uuid?: unknown })?.uuid).toBe('u1');
        expect((parsed as { extra_field?: unknown })?.extra_field).toEqual({ nested: true });
    });

    it('accepts a message-less assistant row for durable fail-soft forwarding', () => {
        const parsed = parseRawJsonLinesObject({
            type: 'assistant',
            uuid: 'assistant-api-error',
            isApiErrorMessage: true,
        });

        expect(parsed).toMatchObject({
            type: 'assistant',
            uuid: 'assistant-api-error',
            isApiErrorMessage: true,
        });
    });

    it('parses a valid user message', () => {
        const parsed = parseRawJsonLinesObject({
            type: 'user',
            uuid: 'u2',
            message: { role: 'user', content: 'hello' },
        });
        expect(parsed?.type).toBe('user');
        expect((parsed as { uuid?: unknown })?.uuid).toBe('u2');
    });

    it('parses a progress message', () => {
        const parsed = parseRawJsonLinesObject({
            type: 'progress',
            uuid: 'p1',
            status: 'running',
        });
        expect(parsed?.type).toBe('progress');
        expect((parsed as { uuid?: unknown })?.uuid).toBe('p1');
    });

    it('parses Claude attachment control rows', () => {
        const parsed = parseRawJsonLinesObject({
            type: 'attachment',
            uuid: 'attachment-1',
            attachment: {
                type: 'deferred_tools_delta',
                itemCount: 1,
            },
        });

        expect(parsed?.type).toBe('attachment');
        expect((parsed as { uuid?: unknown })?.uuid).toBe('attachment-1');
    });

    it('does not drop assistant messages when usage schema changes', () => {
        const parsed = parseRawJsonLinesObject({
            type: 'assistant',
            uuid: 'u3',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'hi' }],
                usage: {
                    output_tokens: 5,
                    service_tier: null,
                    something_new: true,
                },
            },
        });

        expect(parsed?.type).toBe('assistant');
        expect((parsed as { uuid?: unknown })?.uuid).toBe('u3');
        expect((parsed as { message?: { usage?: unknown } })?.message?.usage).toBeUndefined();
    });
});
