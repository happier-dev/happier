import { describe, expect, it } from 'vitest';

import { deriveTranscriptInteraction, deriveTranscriptInteractionFromSession } from './deriveTranscriptInteraction';

describe('deriveTranscriptInteraction', () => {
    it('treats missing accessLevel as owner (full interaction)', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', accessLevel: undefined, canApprovePermissions: undefined })).toEqual({
            canSendMessages: true,
            canApprovePermissions: true,
            permissionDisabledReason: undefined,
            disableToolNavigation: undefined,
        });
    });

    it('disables permission approvals when the session is inactive (owner)', () => {
        expect(
            deriveTranscriptInteraction({
                kind: 'session',
                accessLevel: undefined,
                canApprovePermissions: undefined,
                isSessionActive: false,
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            permissionDisabledReason: 'inactive',
            disableToolNavigation: undefined,
        });
    });

    it('treats view access as read-only', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', accessLevel: 'view', canApprovePermissions: false })).toEqual({
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'readOnly',
            disableToolNavigation: undefined,
        });
    });

    it('treats inactive sessions as inactive even for view-only access', () => {
        expect(
            deriveTranscriptInteraction({
                kind: 'session',
                accessLevel: 'view',
                canApprovePermissions: false,
                isSessionActive: false,
            }),
        ).toEqual({
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'inactive',
            disableToolNavigation: undefined,
        });
    });

    it('allows sending in edit/admin while permission approvals may be not granted', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', accessLevel: 'edit', canApprovePermissions: false })).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            permissionDisabledReason: 'notGranted',
            disableToolNavigation: undefined,
        });
    });

    it('allows approvals when canApprovePermissions is true', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', accessLevel: 'edit', canApprovePermissions: true })).toEqual({
            canSendMessages: true,
            canApprovePermissions: true,
            permissionDisabledReason: undefined,
            disableToolNavigation: undefined,
        });
    });

    it('disables approvals when inactive even if approvals are granted', () => {
        expect(
            deriveTranscriptInteraction({
                kind: 'session',
                accessLevel: 'edit',
                canApprovePermissions: true,
                isSessionActive: false,
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            permissionDisabledReason: 'inactive',
            disableToolNavigation: undefined,
        });
    });

    it('supports public read-only transcripts', () => {
        expect(deriveTranscriptInteraction({ kind: 'public', disableToolNavigation: true })).toEqual({
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'public',
            disableToolNavigation: true,
        });
    });
});

describe('deriveTranscriptInteractionFromSession', () => {
    it('treats session.active as the source of truth (even if presence is stale)', () => {
        expect(
            deriveTranscriptInteractionFromSession({
                accessLevel: undefined,
                canApprovePermissions: true,
                active: false,
                presence: 'online',
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            permissionDisabledReason: 'inactive',
            disableToolNavigation: undefined,
        });
    });

    it('treats missing session.active as inactive for permission approvals (avoids presence drift)', () => {
        expect(
            deriveTranscriptInteractionFromSession({
                accessLevel: undefined,
                canApprovePermissions: true,
                active: undefined,
                presence: 'online',
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            permissionDisabledReason: 'inactive',
            disableToolNavigation: undefined,
        });
    });
});
