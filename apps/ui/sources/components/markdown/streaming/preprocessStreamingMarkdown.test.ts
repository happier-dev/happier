import { describe, expect, it } from 'vitest';

import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';
import { STREAMING_INCOMPLETE_LINK_HREF } from './streamingMarkdownRepairConfig';

describe('preprocessStreamingMarkdown', () => {
    it('completes incomplete display math blocks while streaming', () => {
        const markdown = [
            'Formula:',
            '',
            '$$',
            'E = mc^2',
        ].join('\n');

        expect(preprocessStreamingMarkdown(markdown)).toBe([
            'Formula:',
            '',
            '$$',
            'E = mc^2',
            '$$',
        ].join('\n'));
    });
});

describe('preprocessStreamingMarkdown — incomplete inline links close eagerly', () => {
    // MEASURED on real Codex streams (2026-08-03): every inline link label re-animated
    // mid-stream — 12/12 labels, 0/38 bold tokens. Bold is immune because `**` closes
    // eagerly, so its text sits inside the Bold node from the first render. A link label
    // that streams as plain paragraph text is re-parented into a Link node when `)`
    // arrives, which remounts the live reveal span and restarts its opacity keyframe.
    // Closing the link eagerly with a placeholder destination removes the re-parent.

    it.each([
        ['the opening bracket only', 'See [zli'],
        ['the opened destination', 'See [zlink-006]('],
        ['a partially streamed URL', 'See [zlink-006](https://exa'],
        ['a fully streamed URL with no closing paren', 'See [zlink-006](https://example.com/docs'],
    ])('closes a link whose %s has arrived', (_case, chunk) => {
        const prepared = preprocessStreamingMarkdown(chunk);

        expect(prepared).toContain(`](${STREAMING_INCOMPLETE_LINK_HREF})`);
        // A half-streamed destination must never reach the renderer as an href.
        expect(prepared).not.toContain('https://exa');
        expect(prepared).not.toContain('https://example.com/docs');
    });

    it('leaves a completed link untouched', () => {
        const chunk = 'See [zlink-006](https://example.com/docs) and more.';

        expect(preprocessStreamingMarkdown(chunk)).toBe(chunk);
    });

    it.each([
        ['bold', 'A **bold run and [zlink-006](https://exa', '**'],
        ['italic', 'A _emphasised run and [zlink-006](https://exa', '_'],
        ['strikethrough', 'A ~~struck run and [zlink-006](https://exa', '~~'],
        ['display math', 'A $$x = 1 and [zlink-006](https://exa', '$$'],
    ])('still terminates an unclosed %s run that opened before the incomplete link', (_case, chunk, terminator) => {
        // remend stops running its remaining handlers as soon as it closes a link with
        // the placeholder. Without finishing the repair, `**[Title](url` — a very common
        // shape — paints literal `**` in prose for as long as the URL streams, which is
        // the literal-syntax defect this corridor already fixed once.
        const prepared = preprocessStreamingMarkdown(chunk);

        expect(prepared).toContain(`](${STREAMING_INCOMPLETE_LINK_HREF})`);
        expect(prepared.endsWith(terminator)).toBe(true);
    });
});
