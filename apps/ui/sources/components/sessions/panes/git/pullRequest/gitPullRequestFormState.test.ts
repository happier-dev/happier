import { afterEach, describe, expect, it } from 'vitest';

import {
    closeGitPullRequestForm,
    moveGitPullRequestForm,
    readGitPullRequestFormState,
    requestGitPullRequestForm,
    resetGitPullRequestFormsForTests,
    resolveGitPullRequestFormAfterCreate,
    resolveGitPullRequestFormPlacement,
} from './gitPullRequestFormState';

afterEach(() => resetGitPullRequestFormsForTests());

describe('where a new pull request form opens', () => {
    it('follows the placement setting on a wide screen and always uses Details on a phone', () => {
        expect(resolveGitPullRequestFormPlacement({ setting: 'sidebar', phone: false })).toBe('sidebar');
        expect(resolveGitPullRequestFormPlacement({ setting: undefined, phone: false })).toBe('sidebar');
        expect(resolveGitPullRequestFormPlacement({ setting: 'details', phone: false })).toBe('details');
        expect(resolveGitPullRequestFormPlacement({ setting: 'sidebar', phone: true })).toBe('details');
    });

    it('opens, moves and closes one session\'s form without touching another session', () => {
        requestGitPullRequestForm('session-a', 'server-1');
        expect(readGitPullRequestFormState('session-a', 'server-1')).toEqual({ open: true, placement: null });
        expect(readGitPullRequestFormState('session-b', 'server-1')).toEqual({ open: false, placement: null });
        // Same session id on another Home is another session.
        expect(readGitPullRequestFormState('session-a', 'server-2')).toEqual({ open: false, placement: null });

        moveGitPullRequestForm('session-a', 'server-1', 'details');
        expect(readGitPullRequestFormState('session-a', 'server-1')).toEqual({ open: true, placement: 'details' });
        moveGitPullRequestForm('session-a', 'server-1', 'sidebar');
        expect(readGitPullRequestFormState('session-a', 'server-1')).toEqual({ open: true, placement: 'sidebar' });

        closeGitPullRequestForm('session-a', 'server-1');
        expect(readGitPullRequestFormState('session-a', 'server-1')).toEqual({ open: false, placement: null });
    });
});

describe('the form after a create attempt', () => {
    it('a created pull request becomes the card and the draft is spent', () => {
        expect(resolveGitPullRequestFormAfterCreate({ kind: 'created', number: 2501, url: 'https://github.com/o/r/pull/2501' })).toEqual({
            clearDraft: true,
            closeForm: true,
            created: { number: 2501, url: 'https://github.com/o/r/pull/2501' },
            failure: null,
            openedProviderPage: null,
        });
        expect(resolveGitPullRequestFormAfterCreate({ kind: 'reused', url: 'https://github.com/o/r/pull/7' })).toMatchObject({
            clearDraft: true, closeForm: true, created: { number: null, url: 'https://github.com/o/r/pull/7' },
        });
    });

    it('a failure keeps the form and the draft and names the cause', () => {
        expect(resolveGitPullRequestFormAfterCreate({ kind: 'failed', errorCode: 'REMOTE_AUTH_REQUIRED', message: 'gh: not logged in', outcome: { v: 1, kind: 'needs_input', errorCode: 'REMOTE_AUTH_REQUIRED', nextActions: [{ kind: 'authenticate' }] } })).toEqual({
            clearDraft: false,
            closeForm: false,
            created: null,
            failure: { errorCode: 'REMOTE_AUTH_REQUIRED', message: 'gh: not logged in' },
            openedProviderPage: null,
        });
        expect(resolveGitPullRequestFormAfterCreate({ kind: 'blocked', message: 'push is running' })).toMatchObject({
            clearDraft: false, closeForm: false, failure: { blocked: true, message: 'push is running' },
        });
    });

    it('a provider page hand-off keeps the draft so the text can still be used there', () => {
        expect(resolveGitPullRequestFormAfterCreate({ kind: 'provider-page', url: 'https://github.com/o/r/compare/dev...v0.3' })).toEqual({
            clearDraft: false,
            closeForm: false,
            created: null,
            failure: null,
            openedProviderPage: 'https://github.com/o/r/compare/dev...v0.3',
        });
    });
});
