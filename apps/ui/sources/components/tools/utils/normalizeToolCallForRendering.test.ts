import { describe, expect, it } from 'vitest';

import { normalizeToolCallForRendering } from './normalizeToolCallForRendering';
import { makeTool } from './normalizeToolCallForRendering._testHelpers';

describe('normalizeToolCallForRendering (smoke)', () => {
    it('parses JSON-string inputs/results into objects', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                state: 'running',
                input: '{"a":1}',
                result: '[1,2,3]',
                completedAt: null,
            }),
        );
        expect(normalized.input).toEqual({ a: 1 });
        expect(normalized.result).toEqual([1, 2, 3]);
    });

    it('returns the same reference when no normalization is needed', () => {
        const tool = makeTool({
            name: 'Read',
            input: { file_path: '/etc/hosts' },
            result: { ok: true },
        });

        const normalized = normalizeToolCallForRendering(tool);
        expect(normalized).toBe(tool);
    });
});
