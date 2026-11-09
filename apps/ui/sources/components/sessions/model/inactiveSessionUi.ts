export type InactiveSessionNoticeKind = 'none' | 'not-resumable' | 'machine-offline';

export type InactiveSessionUiState = Readonly<{
    shouldShowInput: boolean;
    inactiveStatusTextKey: 'session.inactiveResumable' | 'session.inactiveArchived' | 'session.inactiveMachineOffline' | 'session.inactiveNotResumable' | null;
    noticeKind: InactiveSessionNoticeKind;
}>;

export function getInactiveSessionUiState(opts: {
    isSessionActive: boolean;
    /** Null means the viewer has no owner facts; it is not an unsupported-context verdict. */
    isResumable: boolean | null;
    isMachineOnline: boolean | null;
    /** Archived sessions say so; sending resumes one, and resuming unarchives it. */
    isArchived?: boolean;
    allowInputWhileInactive?: boolean;
}): InactiveSessionUiState {
    if (opts.isSessionActive) {
        return { shouldShowInput: true, inactiveStatusTextKey: null, noticeKind: 'none' };
    }

    if (opts.allowInputWhileInactive) {
        return { shouldShowInput: true, inactiveStatusTextKey: null, noticeKind: 'none' };
    }

    if (opts.isResumable === null) {
        return { shouldShowInput: false, inactiveStatusTextKey: null, noticeKind: 'none' };
    }

    if (!opts.isResumable) {
        return {
            shouldShowInput: false,
            inactiveStatusTextKey: opts.isArchived ? 'session.inactiveArchived' : 'session.inactiveNotResumable',
            noticeKind: 'not-resumable',
        };
    }

    if (opts.isMachineOnline === null) {
        return { shouldShowInput: true, inactiveStatusTextKey: null, noticeKind: 'none' };
    }
    if (!opts.isMachineOnline) {
        return {
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.inactiveMachineOffline',
            noticeKind: 'machine-offline',
        };
    }

    return {
        shouldShowInput: true,
        inactiveStatusTextKey: opts.isArchived ? 'session.inactiveArchived' : 'session.inactiveResumable',
        noticeKind: 'none',
    };
}
