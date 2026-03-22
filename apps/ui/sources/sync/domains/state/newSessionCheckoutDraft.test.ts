import { describe, expect, it } from 'vitest';

import { parseNewSessionCheckoutDraft, readPersistedNewSessionCheckoutDraft } from './newSessionCheckoutDraft';

describe('parseNewSessionCheckoutDraft', () => {
    it('accepts a git worktree creation draft and normalizes an empty base ref to null', () => {
        expect(parseNewSessionCheckoutDraft({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: '   ',
            },
        })).toEqual({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
                branchMode: 'new',
            },
        });
    });

    it('drops malformed checkout creation drafts', () => {
        expect(parseNewSessionCheckoutDraft({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: ' ',
                baseRef: 'main',
            },
        })).toEqual({
            checkoutCreationDraft: null,
        });
    });

    it('preserves a valid checkout creation draft in persisted state', () => {
        expect(readPersistedNewSessionCheckoutDraft({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
        })).toEqual({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'new',
            },
        });
    });

    it('preserves an explicit existing-branch worktree mode in persisted state', () => {
        expect(readPersistedNewSessionCheckoutDraft({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
                branchMode: 'existing',
            },
        })).toEqual({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
                branchMode: 'existing',
            },
        });
    });
});
