import { describe, expect, it } from 'vitest';

import { normalizeWriteInput } from './write';

describe('normalizeWriteInput', () => {
    it('derives file_path + content from ACP diff items[0] when missing', () => {
        const normalized = normalizeWriteInput({
            items: [{ path: '/tmp/a.txt', oldText: 'old', newText: 'new', type: 'diff' }],
        });

        expect(normalized.file_path).toBe('/tmp/a.txt');
        expect(normalized.content).toBe('new');
    });

    it('derives file_path from ACP single locations entry when missing', () => {
        const normalized = normalizeWriteInput({
            locations: [{ filePath: '/tmp/b.txt' }],
            content: 'hello',
        });

        expect(normalized.file_path).toBe('/tmp/b.txt');
    });
});

