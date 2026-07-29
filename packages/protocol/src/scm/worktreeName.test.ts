import { describe, expect, it } from 'vitest';

import {
    WORKTREE_RELATIVE_PARENT_DIR,
    buildWorktreeRelativePath,
    hasForbiddenGitRefName,
    normalizeWorktreeDisplayName,
} from './worktreeName.js';

describe('normalizeWorktreeDisplayName', () => {
    it('keeps a simple kebab name unchanged', () => {
        expect(normalizeWorktreeDisplayName('feature-auth')).toBe('feature-auth');
    });

    it('trims surrounding whitespace and collapses inner whitespace to a single dash', () => {
        expect(normalizeWorktreeDisplayName('  my fix  ')).toBe('my-fix');
        expect(normalizeWorktreeDisplayName('my   fix')).toBe('my-fix');
    });

    it('preserves slash as a path separator between normalized segments', () => {
        expect(normalizeWorktreeDisplayName('feature/auth')).toBe('feature/auth');
    });

    it('normalizes backslashes to forward slashes', () => {
        expect(normalizeWorktreeDisplayName('feature\\auth')).toBe('feature/auth');
    });

    it('replaces git-invalid characters with a dash', () => {
        expect(normalizeWorktreeDisplayName('a~b^c:d?e*f[g]h')).toBe('a-b-c-d-e-f-g-h');
    });

    it('collapses consecutive dots and dashes', () => {
        expect(normalizeWorktreeDisplayName('foo..bar')).toBe('foo-bar');
        expect(normalizeWorktreeDisplayName('a---b')).toBe('a-b');
    });

    it('strips leading and trailing separators per segment', () => {
        expect(normalizeWorktreeDisplayName('/leading')).toBe('leading');
        expect(normalizeWorktreeDisplayName('trailing/')).toBe('trailing');
        expect(normalizeWorktreeDisplayName('-.foo.-')).toBe('foo');
    });

    it('returns an empty string for content that normalizes to nothing', () => {
        expect(normalizeWorktreeDisplayName('')).toBe('');
        expect(normalizeWorktreeDisplayName('   ')).toBe('');
        expect(normalizeWorktreeDisplayName('...')).toBe('');
        expect(normalizeWorktreeDisplayName('/')).toBe('');
    });
});

describe('hasForbiddenGitRefName', () => {
    it('flags a name whose segment ends in .lock', () => {
        expect(hasForbiddenGitRefName('feature.lock')).toBe(true);
        expect(hasForbiddenGitRefName('feature/inner.lock')).toBe(true);
    });

    it('flags a bare @ segment', () => {
        expect(hasForbiddenGitRefName('@')).toBe(true);
        expect(hasForbiddenGitRefName('feature/@')).toBe(true);
    });

    it('allows ordinary names', () => {
        expect(hasForbiddenGitRefName('feature-auth')).toBe(false);
        expect(hasForbiddenGitRefName('feature/auth')).toBe(false);
        expect(hasForbiddenGitRefName('clever-ocean')).toBe(false);
    });
});

describe('buildWorktreeRelativePath', () => {
    it('joins the branch name under the managed worktree parent dir', () => {
        expect(buildWorktreeRelativePath('clever-ocean')).toBe(`${WORKTREE_RELATIVE_PARENT_DIR}/clever-ocean`);
        expect(buildWorktreeRelativePath('feature/auth')).toBe(`${WORKTREE_RELATIVE_PARENT_DIR}/feature/auth`);
    });

    it('returns the parent dir alone (no trailing slash) for an empty name', () => {
        expect(buildWorktreeRelativePath('')).toBe(WORKTREE_RELATIVE_PARENT_DIR);
        expect(buildWorktreeRelativePath('   ')).toBe(WORKTREE_RELATIVE_PARENT_DIR);
    });

    it('matches the daemon `.dev/worktree` convention', () => {
        // Locks the shared constant the daemon uses for `git worktree add` so the
        // UI path preview can never drift from where the worktree actually lands.
        expect(WORKTREE_RELATIVE_PARENT_DIR).toBe('.dev/worktree');
    });
});
