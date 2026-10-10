import { describe, expect, it } from 'vitest';

import { clampPreviewLines, normalizeResultPreview } from './resultPreview';

describe('normalizeResultPreview', () => {
    it('pretty-prints a JSON object payload with 2-space indent', () => {
        const result = normalizeResultPreview('{"b":2,"a":1}');
        expect(result.kind).toBe('json');
        expect(result.display).toBe('{\n  "b": 2,\n  "a": 1\n}');
    });

    it('pretty-prints a JSON array payload', () => {
        const result = normalizeResultPreview('[1,2,3]');
        expect(result.kind).toBe('json');
        expect(result.display).toBe('[\n  1,\n  2,\n  3\n]');
    });

    it('treats surrounding whitespace as JSON-ish and still parses', () => {
        const result = normalizeResultPreview('  \n {"ok": true}\n ');
        expect(result.kind).toBe('json');
        expect(result.display).toBe('{\n  "ok": true\n}');
    });

    it('falls back to text for malformed JSON-ish input', () => {
        const result = normalizeResultPreview('{ not really json ]');
        expect(result.kind).toBe('text');
        expect(result.display).toBe('{ not really json ]');
    });

    it('returns trimmed text for plain prose', () => {
        const result = normalizeResultPreview('  Completed the migration.  ');
        expect(result.kind).toBe('text');
        expect(result.display).toBe('Completed the migration.');
    });

    it('returns empty display for blank input', () => {
        expect(normalizeResultPreview('   ')).toEqual({ kind: 'text', display: '' });
    });

    it('preserves the complete normalized text for inspection', () => {
        const long = 'x'.repeat(5000);
        const result = normalizeResultPreview(long);
        expect(result.kind).toBe('text');
        expect(result.display).toBe(long);
    });

    it('preserves the complete pretty-printed JSON for inspection', () => {
        const big = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ i, v: `value-${i}` })) });
        const result = normalizeResultPreview(big);
        expect(result.kind).toBe('json');
        expect(result.display).toBe(JSON.stringify(JSON.parse(big), null, 2));
    });
});

describe('clampPreviewLines', () => {
    it('returns the text unchanged when within the line budget', () => {
        const text = 'a\nb\nc';
        expect(clampPreviewLines(text, 6)).toEqual({ text, clamped: false, hiddenLines: 0 });
    });

    it('clamps to the requested number of lines and reports the remainder', () => {
        const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
        const result = clampPreviewLines(text, 6);
        expect(result.clamped).toBe(true);
        expect(result.hiddenLines).toBe(4);
        expect(result.text.split('\n')).toHaveLength(6);
    });
});
