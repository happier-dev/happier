import { describe, expect, it } from 'vitest';

import { maybeParseJson } from './parseJson';

describe('maybeParseJson', () => {
    it('parses direct JSON objects', () => {
        expect(maybeParseJson('{"status":"ok"}')).toEqual({ status: 'ok' });
    });

    it('parses double-encoded JSON objects', () => {
        expect(maybeParseJson('"{\\"status\\":\\"timeout\\",\\"summary\\":\\"Timed out\\"}"')).toEqual({
            status: 'timeout',
            summary: 'Timed out',
        });
    });

    it('does not parse plain quoted strings', () => {
        expect(maybeParseJson('"hello"')).toBe('"hello"');
    });

    it('returns original value for malformed JSON', () => {
        const malformed = '{"status":';
        expect(maybeParseJson(malformed)).toBe(malformed);
    });
});
