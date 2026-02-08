import { describe, expect, it } from 'vitest';

import { parseParenIdentifier } from './parseParenIdentifier';

describe('parseParenIdentifier', () => {
    it('parses a name(spec) identifier', () => {
        expect(parseParenIdentifier('Bash(echo hello)')).toEqual({ name: 'Bash', spec: 'echo hello' });
    });

    it('keeps nested parentheses in the parsed spec', () => {
        expect(parseParenIdentifier('Task(run(a, b))')).toEqual({ name: 'Task', spec: 'run(a, b)' });
    });

    it('returns null when value does not contain parentheses', () => {
        expect(parseParenIdentifier('Bash')).toBeNull();
    });

    it('returns null for malformed identifiers', () => {
        expect(parseParenIdentifier('Bash()')).toBeNull();
        expect(parseParenIdentifier('Bash(echo) trailing')).toBeNull();
        expect(parseParenIdentifier('(echo)')).toBeNull();
    });
});
