import { describe, expect, it } from 'vitest';

import { createSessionAccessApiErrorFromResponse, SessionAccessApiError } from '@/sync/api/session/sessionAccessApi';

import { presentSessionAccessFailure, presentSessionAccessReason } from './presentSessionAccessFailure';

describe('session access failure presentation', () => {
    it.each([
        ['session_access_subject_ineligible', 'This person, group, or team can no longer receive access.'],
        ['session_access_team_policy_required', 'Team policy requires this access.'],
    ] as const)('keeps %s distinct for locked manager controls', (code, message) => {
        expect(presentSessionAccessReason(code)).toEqual({ code, message });
    });

    it('explains a manager own-grant row instead of leaking the internal self-grant error', () => {
        const reason = presentSessionAccessReason('session_access_self_grant_invalid');
        expect(reason.code).toBe('session_access_self_grant_invalid');
        expect(reason.message).toBe('Another access manager must change your access.');
        expect(reason.message).not.toBe(presentSessionAccessReason('session_access_forbidden').message);
    });

    it('distinguishes a Home that cannot manage session access from unreadable encrypted content', () => {
        const unsupported = presentSessionAccessFailure(new SessionAccessApiError('unsupported_action'));
        expect(unsupported.message).toBe(
            "This Home doesn't support session access yet. Update it to manage who can open this session.",
        );
        expect(unsupported.message).not.toBe(
            presentSessionAccessFailure(new SessionAccessApiError('data_key_not_required')).message,
        );
    });

    it('explains a Home whose Session sharing is off without the update premise', () => {
        const sharingOff = presentSessionAccessFailure(new SessionAccessApiError('session_access_sharing_unavailable', 404));
        expect(sharingOff).toEqual({
            code: 'session_access_sharing_unavailable',
            message: 'This Home doesn’t support sharing Sessions with people.',
            retryable: false,
        });
        expect(sharingOff.message).not.toMatch(/update/i);
        // A Home that lacks a required capability keeps the genuine update copy.
        expect(presentSessionAccessFailure(new SessionAccessApiError('unsupported_action')).message).toMatch(/Update it/);
    });

    it('states that a Plain Session needs no encrypted-access preparation', () => {
        // `data_key_not_required` is the Home answering "this Session is not
        // encrypted", so it must never read as unreadable encrypted content.
        const notRequired = presentSessionAccessFailure(new SessionAccessApiError('data_key_not_required'));
        expect(notRequired.message).toBe('This session isn’t encrypted, so there’s nothing to prepare.');
        expect(notRequired.message).not.toBe(
            presentSessionAccessFailure(new SessionAccessApiError('session_access_invalid_recipient_envelope')).message,
        );
    });

    it('gives restricted-Team authentication failures actionable, distinct recovery copy', () => {
        const required = presentSessionAccessFailure(new SessionAccessApiError('session_access_authentication_required', 403));
        const unavailable = presentSessionAccessFailure(new SessionAccessApiError('session_access_authentication_unavailable', 503));

        expect(required).toMatchObject({
            code: 'session_access_authentication_required',
            message: 'Sign in with a method accepted by this Team, then try again.',
            retryable: false,
        });
        expect(unavailable).toMatchObject({
            code: 'session_access_authentication_unavailable',
            message: "This Team's required sign-in method is unavailable on this Home.",
            retryable: false,
        });
    });

    it('treats a generic 409 conflict as terminal without blind retry', () => {
        const conflict = presentSessionAccessFailure(new SessionAccessApiError('session_access_request_failed', 409));
        expect(conflict).toMatchObject({ code: 'session_access_request_failed', retryable: false });
    });

    it('treats missing public-link isolation as a Home prerequisite rather than a transient 503', () => {
        const unavailable = presentSessionAccessFailure(createSessionAccessApiErrorFromResponse({ error: 'public_share_isolation_unavailable' }, 503));
        expect(unavailable).toMatchObject({ code: 'public_share_isolation_unavailable', retryable: false });
        expect(unavailable.message).not.toBe(
            presentSessionAccessFailure(new SessionAccessApiError('session_access_request_failed', 503)).message,
        );
        expect(presentSessionAccessFailure(new SessionAccessApiError('session_access_request_failed', 503)).retryable).toBe(true);
    });

    it('keeps a typed 403 capability denial as permission failure rather than login', () => {
        const forbidden = presentSessionAccessFailure(new SessionAccessApiError('session_access_forbidden', 403));
        expect(forbidden).toMatchObject({ code: 'session_access_forbidden', retryable: false });
        expect(forbidden.message).not.toMatch(/sign in/i);
    });
});
