import { describe, expect, it } from 'vitest';

import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';

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
