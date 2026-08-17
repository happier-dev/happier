import { describe, expect, it } from 'vitest';

import {
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
} from './bounds.js';
import {
    normalizeTriageSingleLineV1,
    projectTriageDisplayTextV1,
    truncateTriageUtf8V1,
} from './text.js';

const SINGLE_LINE = new RegExp(TRIAGE_SINGLE_LINE_STRING_PATTERN_V1, 'u');

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

describe('normalizeTriageSingleLineV1', () => {
    it('collapses every control run to one space so the entity survives instead of being rejected', () => {
        const normalized = normalizeTriageSingleLineV1('Fix the parser\r\n\tand its caller');

        expect(normalized).toBe('Fix the parser and its caller');
        expect(SINGLE_LINE.test(normalized)).toBe(true);
    });

    it('collapses a control run to one separator rather than concatenating the words around it', () => {
        expect(normalizeTriageSingleLineV1('first\n\n\nsecond')).toBe('first second');
        expect(normalizeTriageSingleLineV1('first \n second')).toBe('first second');
    });

    it('leaves text that is already single-line unchanged', () => {
        expect(normalizeTriageSingleLineV1('Already one line')).toBe('Already one line');
    });

    it('reports no surviving text rather than a blank required field', () => {
        expect(normalizeTriageSingleLineV1('\n\t\r')).toBe('');
    });
});

describe('truncateTriageUtf8V1', () => {
    it('cuts on a UTF-8 boundary without splitting a code point', () => {
        const bounded = truncateTriageUtf8V1('é'.repeat(100), 21);

        expect(bounded.truncated).toBe(true);
        expect(bounded.value).toBe('é'.repeat(10));
        expect(utf8Bytes(bounded.value)).toBeLessThanOrEqual(21);
    });

    it('never strands a lone surrogate half', () => {
        const bounded = truncateTriageUtf8V1('\u{1F680}'.repeat(10), 7);

        expect(bounded.value).toBe('\u{1F680}');
        expect([...bounded.value].every((point) => point === '\u{1F680}')).toBe(true);
    });

    it('passes a fitting value through unchanged and unflagged', () => {
        expect(truncateTriageUtf8V1('short', 64)).toEqual({ value: 'short', truncated: false });
    });
});

describe('projectTriageDisplayTextV1', () => {
    it('normalizes before bounding so a newline-bearing provider title parses', () => {
        const projected = projectTriageDisplayTextV1('Crash in\nrender() ');

        expect(projected).toEqual({ value: 'Crash in render()', truncated: false });
        expect(SINGLE_LINE.test(projected.value)).toBe(true);
    });

    it('charges normalization no truncation, because collapsing a control run loses no content', () => {
        expect(projectTriageDisplayTextV1('a\nb').truncated).toBe(false);
    });

    it('truncates and reports it rather than dropping oversized display text', () => {
        const projected = projectTriageDisplayTextV1(
            `${'x'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1)}\nmore`,
        );

        expect(projected.truncated).toBe(true);
        expect(utf8Bytes(projected.value)).toBeLessThanOrEqual(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
        expect(SINGLE_LINE.test(projected.value)).toBe(true);
    });

    it('never publishes a value the single-line pattern rejects, at any bound', () => {
        const projected = projectTriageDisplayTextV1('one\ttwo\tthree', 5);

        expect(projected).toEqual({ value: 'one t', truncated: true });
        expect(SINGLE_LINE.test(projected.value)).toBe(true);
    });

    it('never publishes the trailing space a truncation stranded', () => {
        // The collapsed separator would otherwise become the last byte, which the
        // non-empty single-line pattern still admits but no row should render.
        const projected = projectTriageDisplayTextV1('one\ttwo', 4);

        expect(projected).toEqual({ value: 'one', truncated: true });
        expect(SINGLE_LINE.test(projected.value)).toBe(true);
    });

    it('answers with no surviving text when the provider supplied only control characters', () => {
        expect(projectTriageDisplayTextV1('\n\n')).toEqual({ value: '', truncated: false });
    });
});
