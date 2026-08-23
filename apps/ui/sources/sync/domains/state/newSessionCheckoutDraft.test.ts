import { describe, expect, it } from 'vitest';

import {
    hasExplicitNewSessionCheckoutSelection,
    parseNewSessionCheckoutDraft,
    readPersistedNewSessionCheckoutDraft,
    resolveNewSessionCheckoutSelection,
} from './newSessionCheckoutDraft';

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

    it('distinguishes an explicit current-path selection from an absent or malformed selection', () => {
        expect(hasExplicitNewSessionCheckoutSelection({ checkoutCreationDraft: null })).toBe(true);
        expect(hasExplicitNewSessionCheckoutSelection({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
            },
        })).toBe(true);
        expect(hasExplicitNewSessionCheckoutSelection({})).toBe(false);
        expect(hasExplicitNewSessionCheckoutSelection({ checkoutCreationDraft: { kind: 'git_worktree' } })).toBe(false);
    });

    it('resolves the first explicit source without collapsing an explicit null into a later worktree', () => {
        expect(resolveNewSessionCheckoutSelection(
            { checkoutCreationDraft: null },
            {
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'persisted-worktree',
                    baseRef: 'main',
                },
            },
        )).toEqual({
            checkoutCreationDraft: null,
            explicitMode: 'current_path',
        });
    });

    it('skips absent and malformed sources before resolving a valid persisted selection', () => {
        expect(resolveNewSessionCheckoutSelection(
            {},
            { checkoutCreationDraft: { kind: 'git_worktree' } },
            {
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'persisted-worktree',
                    baseRef: 'main',
                },
            },
        )).toEqual({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'persisted-worktree',
                baseRef: 'main',
                branchMode: 'new',
            },
            explicitMode: 'git_worktree',
        });
    });
});
