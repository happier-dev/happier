import { describe, expect, it } from 'vitest';

import { safeJsonStringify } from './safeJson';

describe('safeJsonStringify', () => {
    it('serializes an object referenced from several places in full', () => {
        const input = { file_path: '/tmp/a.txt', content: 'hello' };
        const event = { options: { toolCall: { rawInput: input }, input } };

        expect(JSON.parse(safeJsonStringify(event))).toEqual({
            options: { toolCall: { rawInput: input }, input },
        });
    });

    it('replaces only true cycles', () => {
        const node: Record<string, unknown> = { ok: true };
        node.self = node;
        node.nested = { parent: node };

        expect(JSON.parse(safeJsonStringify(node))).toEqual({
            ok: true,
            self: '[Circular]',
            nested: { parent: '[Circular]' },
        });
    });
});
