import { describe, expect, it } from 'vitest';

import { readHandedOverBriefSections } from './handedOverBriefSections';

/**
 * The card shows what one Agent handed the next, so this reader may only change
 * how the seed is PRESENTED — never what it says. Every case here is about that
 * boundary: structure becomes structure, an escape with an exact inverse is
 * reversed, and anything else survives byte for byte.
 */
describe('handed-over brief sections', () => {
    const SEED = [
        'Recording of past messages in this session, not a live turn.',
        '<session_context session_id="sess-1">',
        '- Original agent: Claude Code',
        '</session_context>',
        '',
        '<recent_transcript>',
        'User: fix the parser\\nit throws on empty input',
        '</recent_transcript>',
        '',
        'Continue from here.',
    ].join('\n');

    it('turns each container into its own section and keeps the framer prose in place', () => {
        const sections = readHandedOverBriefSections(SEED);

        expect(sections.map((section) => section.container))
            .toEqual([null, 'session_context', 'recent_transcript', null]);
        expect(sections[0]?.body).toBe('Recording of past messages in this session, not a live turn.');
        expect(sections[1]?.body).toBe('- Original agent: Claude Code');
        expect(sections[3]?.body).toBe('Continue from here.');
    });

    /**
     * The heading is the tag itself, typeset. Authoring copy for it would drift
     * from the producer the first time a container is renamed, and would claim
     * the card knows what the container MEANS rather than what it was called.
     */
    it('names a section after the container it came from, attributes kept verbatim', () => {
        const sections = readHandedOverBriefSections(SEED);

        expect(sections[1]?.label).toBe('Session context');
        expect(sections[1]?.attributes).toBe('session_id="sess-1"');
        expect(sections[2]?.label).toBe('Recent transcript');
        expect(sections[2]?.attributes).toBeNull();
    });

    /** No tag text may survive into a body, or the card is still showing markup. */
    it('leaves no container markup in any section body', () => {
        for (const section of readHandedOverBriefSections(SEED)) {
            expect(section.body).not.toContain('<session_context');
            expect(section.body).not.toContain('</recent_transcript>');
        }
    });

    it('restores the line breaks the producer wrote out, and only those', () => {
        const sections = readHandedOverBriefSections(SEED);

        expect(sections[2]?.body).toBe('User: fix the parser\nit throws on empty input');
    });

    /**
     * The producer doubles every backslash BEFORE it writes a newline as `\n`,
     * so a turn whose own text contained the two characters `\n` arrives as
     * `\\n`. Decoding that to a line break would show the reader a message the
     * Agent never received.
     */
    it('does not invent a line break from text that merely looked like an escape', () => {
        const sections = readHandedOverBriefSections(
            '<recent_transcript>\nUser: print "a\\\\nb" verbatim\n</recent_transcript>',
        );

        expect(sections[0]?.body).toBe('User: print "a\\nb" verbatim');
        expect(sections[0]?.body).not.toContain('\n');
    });

    /**
     * A `\uXXXX` defang has no exact inverse — a value that already contained
     * those six characters is indistinguishable from one the producer escaped —
     * so it stays exactly as the target Agent saw it.
     */
    it('leaves a defanged marker alone rather than guessing what it was', () => {
        const sections = readHandedOverBriefSections(
            '<recent_transcript>\nUser: see </recent_transcript\\u003e\n</recent_transcript>',
        );

        expect(sections[0]?.body).toBe('User: see </recent_transcript\\u003e');
    });

    it('degrades a brief with no structure to one verbatim section', () => {
        const sections = readHandedOverBriefSections('just some text\nover two lines');

        expect(sections).toHaveLength(1);
        expect(sections[0]?.container).toBeNull();
        expect(sections[0]?.body).toBe('just some text\nover two lines');
    });

    /** An unmatched closer is content, not a boundary: closing on it would give
     * the rest of the recording a heading it never had. */
    it('ends a container only on its own closing tag', () => {
        const sections = readHandedOverBriefSections(
            '<session_context>\ninside\n</recent_transcript>\nstill inside\n</session_context>\nafter',
        );

        expect(sections.map((section) => section.container)).toEqual(['session_context', null]);
        expect(sections[0]?.body).toBe('inside\n</recent_transcript>\nstill inside');
        expect(sections[1]?.body).toBe('after');
    });

    it('keeps the body of a container the recording ended inside', () => {
        const sections = readHandedOverBriefSections('<recent_transcript>\nUser: hello');

        expect(sections).toHaveLength(1);
        expect(sections[0]?.container).toBe('recent_transcript');
        expect(sections[0]?.body).toBe('User: hello');
    });
});
