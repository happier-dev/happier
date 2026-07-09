import { describe, expect, it } from 'vitest';

import { buildGitWorktreeCheckoutCreationDraft } from './buildGitWorktreeCheckoutCreationDraft';

describe('buildGitWorktreeCheckoutCreationDraft', () => {
    it('creates a new git worktree draft with the fallback display name and explicit base ref', () => {
        expect(buildGitWorktreeCheckoutCreationDraft({
            existingDraft: null,
            fallbackDisplayName: 'quiet-harbor',
            baseRef: 'origin/release',
        })).toEqual({
            kind: 'git_worktree',
            displayName: 'quiet-harbor',
            baseRef: 'origin/release',
            branchMode: 'new',
        });
    });

    it('preserves the existing display name while updating the selected base ref', () => {
        expect(buildGitWorktreeCheckoutCreationDraft({
            existingDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
                branchMode: 'new',
            },
            fallbackDisplayName: 'quiet-harbor',
            baseRef: 'main',
        })).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
            branchMode: 'new',
        });
    });

    it('uses an explicit displayName as authoritative, overriding any preserved existing name', () => {
        expect(buildGitWorktreeCheckoutCreationDraft({
            existingDraft: {
                kind: 'git_worktree',
                displayName: 'previous-auto-name',
                baseRef: null,
                branchMode: 'new',
            },
            displayName: 'my-custom-name',
            fallbackDisplayName: 'quiet-harbor',
            baseRef: 'main',
        })).toEqual({
            kind: 'git_worktree',
            displayName: 'my-custom-name',
            baseRef: 'main',
            branchMode: 'new',
        });
    });

    it('ignores a blank explicit displayName and uses the fallback', () => {
        expect(buildGitWorktreeCheckoutCreationDraft({
            existingDraft: null,
            displayName: '   ',
            fallbackDisplayName: 'quiet-harbor',
            baseRef: 'main',
        })).toEqual({
            kind: 'git_worktree',
            displayName: 'quiet-harbor',
            baseRef: 'main',
            branchMode: 'new',
        });
    });

    it('falls back to a generated display name when converting an existing-branch draft back to new-branch mode', () => {
        expect(buildGitWorktreeCheckoutCreationDraft({
            existingDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
                branchMode: 'existing',
            },
            fallbackDisplayName: 'quiet-harbor',
            baseRef: 'main',
        })).toEqual({
            kind: 'git_worktree',
            displayName: 'quiet-harbor',
            baseRef: 'main',
            branchMode: 'new',
        });
    });
});
