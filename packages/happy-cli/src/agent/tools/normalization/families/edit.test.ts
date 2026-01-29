import { describe, expect, it } from 'vitest';

import { normalizeEditInput } from './edit';

describe('normalizeEditInput', () => {
    it('derives file_path from ACP diff items[0].path when missing', () => {
        const normalized = normalizeEditInput({
            items: [{ path: '/tmp/a.txt', oldText: 'old', newText: 'new', type: 'diff' }],
        });

        expect(normalized.file_path).toBe('/tmp/a.txt');
        expect(normalized.old_string).toBe('old');
        expect(normalized.new_string).toBe('new');
    });

    it('derives file_path from ACP single locations entry when missing', () => {
        const normalized = normalizeEditInput({
            locations: [{ path: '/tmp/b.txt' }],
            oldText: 'a',
            newText: 'b',
        });

        expect(normalized.file_path).toBe('/tmp/b.txt');
    });
});

