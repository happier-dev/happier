import { describe, expect, it } from 'vitest';

import { extractFrontMatter, reattachFrontMatter } from '../markdownFrontmatter';

describe('extractFrontMatter', () => {
    it('returns the raw body unchanged when there is no frontmatter', () => {
        const raw = '# Title\n\nBody text.';
        expect(extractFrontMatter(raw)).toEqual({ frontmatter: null, body: raw });
    });

    it('splits a leading YAML frontmatter block off the body', () => {
        const raw = '---\ntitle: Hello\ntags: [a, b]\n---\n# Title\n\nBody.';
        const { frontmatter, body } = extractFrontMatter(raw);

        expect(frontmatter).toBe('---\ntitle: Hello\ntags: [a, b]\n---\n');
        expect(body).toBe('# Title\n\nBody.');
    });

    it('supports the YAML end-of-document delimiter (...)', () => {
        const raw = '---\ntitle: Hello\n...\nBody.';
        const { frontmatter, body } = extractFrontMatter(raw);

        expect(frontmatter).toBe('---\ntitle: Hello\n...\n');
        expect(body).toBe('Body.');
    });

    it('does not treat a horizontal rule mid-document as frontmatter', () => {
        const raw = '# Title\n\n---\n\nMore.';
        expect(extractFrontMatter(raw)).toEqual({ frontmatter: null, body: raw });
    });

    it('round-trips losslessly through reattachFrontMatter', () => {
        const raw = '---\ntitle: Hello\n---\n# Title\n\nBody.';
        const { frontmatter, body } = extractFrontMatter(raw);
        expect(reattachFrontMatter(frontmatter, body)).toBe(raw);
    });

    it('reattach is a no-op when frontmatter is null', () => {
        expect(reattachFrontMatter(null, '# Body')).toBe('# Body');
    });
});
