import { describe, expect, it } from 'vitest';

import { parseTaskOutputJsonlText } from './taskOutputJsonl.js';

describe('parseTaskOutputJsonlText', () => {
    it('parses valid Claude JSONL records and ignores blank or malformed lines', () => {
        const records = parseTaskOutputJsonlText([
            JSON.stringify({
                type: 'assistant',
                uuid: 'a1',
                message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            }),
            '',
            '{malformed',
            JSON.stringify({
                type: 'progress',
                uuid: 'p1',
            }),
        ].join('\n'));

        expect(records).toEqual([
            expect.objectContaining({ type: 'assistant', uuid: 'a1' }),
            expect.objectContaining({ type: 'progress', uuid: 'p1' }),
        ]);
    });
});
