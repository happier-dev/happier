import { describe, expect, it } from 'vitest';

import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';

describe('getInactiveSessionUiState', () => {
    it('does not claim unsupported context when eligibility is unknown and input is not authorized', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false, isResumable: null, isMachineOnline: null,
        })).toEqual({ shouldShowInput: false, inactiveStatusTextKey: null, noticeKind: 'none' });
    });
    it('does not label unobserved Machine presence offline or ready while keeping the draft available', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false, isResumable: true, isMachineOnline: null,
        })).toEqual({ shouldShowInput: true, inactiveStatusTextKey: null, noticeKind: 'none' });
    });
    // A pending import or takeover is the session's way forward; "can't be resumed" beside its Resume contradicts it.
    it('says nothing about resuming the session while an external import or takeover operation is pending', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false, isResumable: false, isMachineOnline: true, externalOperationPending: true,
        })).toEqual({ shouldShowInput: false, inactiveStatusTextKey: null, noticeKind: 'none' });
        expect(getInactiveSessionUiState({
            isSessionActive: false, isResumable: false, isMachineOnline: true, externalOperationPending: false,
        })).toMatchObject({ noticeKind: 'not-resumable' });
    });
    it('shows input for active sessions', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: true,
            isResumable: false,
            isMachineOnline: false,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: null,
            noticeKind: 'none',
        });
    });

    it('hides input and shows a not-resumable notice when vendor resume is not available', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: false,
            isMachineOnline: true,
        })).toEqual({
            shouldShowInput: false,
            inactiveStatusTextKey: 'session.inactiveNotResumable',
            noticeKind: 'not-resumable',
        });
    });

    it('keeps input visible and shows a machine-offline notice for a resumable session', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: false,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.inactiveMachineOffline',
            noticeKind: 'machine-offline',
        });
    });

    it('shows input for inactive resumable sessions when machine is online', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: true,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.inactiveResumable',
            noticeKind: 'none',
        });
    });

    it('says Archived for an archived session, which sending resumes and unarchives', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: true,
            isArchived: true,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.inactiveArchived',
            noticeKind: 'none',
        });
        // An offline machine still blocks it, so that stays the one thing said.
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: false,
            isArchived: true,
        }).inactiveStatusTextKey).toBe('session.inactiveMachineOffline');
    });

    it('shows input for inactive voice conversation sessions even when normal resume is unavailable', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: false,
            isMachineOnline: false,
            allowInputWhileInactive: true,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: null,
            noticeKind: 'none',
        });
    });
});
