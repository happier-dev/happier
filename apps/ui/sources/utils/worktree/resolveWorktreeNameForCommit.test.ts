import { describe, expect, it } from 'vitest';

import { resolveWorktreeNameForCommit } from './resolveWorktreeNameForCommit';

const SUGGESTION = 'clever-ocean';

describe('resolveWorktreeNameForCommit', () => {
    it('returns the normalized name for a clean custom value', () => {
        expect(resolveWorktreeNameForCommit('my-fix', SUGGESTION)).toBe('my-fix');
        expect(resolveWorktreeNameForCommit('feature/login', SUGGESTION)).toBe('feature/login');
    });

    it('normalizes whitespace and git-invalid characters so the stored name matches what git creates', () => {
        expect(resolveWorktreeNameForCommit('  My Fix  ', SUGGESTION)).toBe('My-Fix');
        expect(resolveWorktreeNameForCommit('a:b?c', SUGGESTION)).toBe('a-b-c');
    });

    it('falls back to the suggestion when the typed value normalizes to nothing', () => {
        expect(resolveWorktreeNameForCommit('', SUGGESTION)).toBe(SUGGESTION);
        expect(resolveWorktreeNameForCommit('   ', SUGGESTION)).toBe(SUGGESTION);
        expect(resolveWorktreeNameForCommit('...', SUGGESTION)).toBe(SUGGESTION);
    });

    it('falls back to the suggestion for git-forbidden names rather than committing a name git will reject', () => {
        expect(resolveWorktreeNameForCommit('feature.lock', SUGGESTION)).toBe(SUGGESTION);
        expect(resolveWorktreeNameForCommit('@', SUGGESTION)).toBe(SUGGESTION);
    });
});
