import { describe, expect, it } from 'vitest';

import { canonicalizeToolNameForRendering } from './nameInference';

describe('canonicalizeToolNameForRendering (change_title aliases)', () => {
    it.each([
        'change_title',
        'change-title',
        'mcp__happier__change_title',
        'mcp__happy__change_title',
        'happier__change_title',
        'happy__change_title',
    ])('normalizes %s to change_title', (toolName) => {
        expect(canonicalizeToolNameForRendering(toolName, {})).toBe('change_title');
    });
});
