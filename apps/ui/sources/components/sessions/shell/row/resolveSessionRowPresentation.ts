import {
    deriveSessionListAttentionState,
    type SessionListAttentionState,
    type SessionListSecondaryLineMode,
} from '../../../../sync/domains/session/listing/deriveSessionListActivity';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';

export type SessionRowAttentionState =
    | 'quiet'
    | 'unread'
    | 'pending'
    | 'working'
    | 'ready'
    | 'failed'
    | 'permission_required'
    | 'action_required';

export type SessionRowDensity = 'default' | 'compact' | 'minimal';
export type SessionRowAttentionIndicator = 'none' | 'working' | 'ready' | 'failed' | 'unread' | 'pending' | 'permission' | 'action' | 'standing';
export type SessionRowTitleTone = 'quiet' | 'normal' | 'emphasized';
export type SessionRowSecondaryLine = 'none' | 'path' | 'status';

export type SessionRowPresentation = Readonly<{
    attentionIndicator: SessionRowAttentionIndicator;
    titleTone: SessionRowTitleTone;
    secondaryLine: SessionRowSecondaryLine;
    statusTextKey?: 'status.readyForReview' | 'status.error' | 'status.workingRetained' | 'status.keptInAttention';
    /**
     * The status line is the session's background-activity line.
     *
     * It carries no key of its own, deliberately: that line now states HOW MUCH work is running in
     * the background, and the count belongs to `getSessionStatus`, which is the one owner of what a
     * session's status says. A key here would have to be re-interpolated with a second copy of the
     * count, and the list row and the session view would start disagreeing the moment one of them
     * changed. The row renders `sessionStatus.statusText` instead.
     *
     * It is still flagged, because the row treats this line differently from an attention line: it
     * takes ordinary secondary ink and is not announced as an attention state.
     */
    backgroundActivityStatusLine?: true;
}>;

export function resolveLegacySessionRowAttentionState(input: Readonly<{
    hasUnreadMessages: boolean;
    pendingCount: number;
    sessionStatus: SessionStatus;
}>): SessionRowAttentionState {
    return resolveSessionRowAttentionState(deriveSessionListAttentionState({
        hasUnreadMessages: input.hasUnreadMessages,
        pendingCount: input.pendingCount,
        sessionState: input.sessionStatus.state,
    }));
}

export function resolveSessionRowAttentionState(attentionState: SessionListAttentionState): SessionRowAttentionState {
    return attentionState === 'thinking' ? 'working' : attentionState;
}

export function resolveSessionRowPresentation(input: Readonly<{
    attentionState: SessionRowAttentionState;
    density: SessionRowDensity;
    requestedSecondaryLineMode: SessionListSecondaryLineMode;
    hasPathSubtitle: boolean;
    backgroundActive?: boolean;
    /**
     * Retained working placement: the session is held in the working group
     * while its live signals are stale, so the status line must not imply
     * live activity (e.g. "online") under the paused indicator.
     */
    workingRetained?: boolean;
    /**
     * Attention standing: the person asked for this session to stay in Needs
     * attention, so it sits there with nothing of its own to say. It is a
     * separate input rather than an attention state on purpose — standing says
     * nothing about whether the session was read, and must not colour the title
     * or the badge the way unread does.
     */
    standing?: boolean;
}>): SessionRowPresentation {
    const backgroundActiveUsesWorkingIndicator = input.backgroundActive === true
        && input.attentionState !== 'working'
        && input.attentionState !== 'failed'
        && input.attentionState !== 'permission_required'
        && input.attentionState !== 'action_required';
    const signalIndicator = backgroundActiveUsesWorkingIndicator
        ? 'working'
        : resolveAttentionIndicator(input.attentionState);
    // Standing is the weakest thing a row can say, so it only speaks for a row
    // that has no signal of its own: anything the session is actually doing —
    // unread, ready, working, failed, permission, action — keeps the row.
    const presentsStanding = input.standing === true && signalIndicator === 'none';
    const attentionIndicator: SessionRowAttentionIndicator = presentsStanding ? 'standing' : signalIndicator;
    const titleTone = input.attentionState === 'quiet'
        ? 'quiet'
        : signalIndicator === 'none'
            ? 'normal'
            : 'emphasized';

    if (input.density === 'minimal') {
        // A minimal row draws no secondary line, but the marker still needs the
        // key: it is what the row is announced with.
        return presentsStanding
            ? { attentionIndicator, titleTone, secondaryLine: 'none', statusTextKey: 'status.keptInAttention' }
            : { attentionIndicator, titleTone, secondaryLine: 'none' };
    }

    if (input.attentionState === 'failed') {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.error' };
    }

    if (input.attentionState === 'working' && input.workingRetained === true) {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.workingRetained' };
    }

    if (
        input.attentionState === 'working'
        || input.attentionState === 'permission_required'
        || input.attentionState === 'action_required'
    ) {
        return { attentionIndicator, titleTone, secondaryLine: 'status' };
    }

    if (input.backgroundActive === true) {
        return { attentionIndicator, titleTone, secondaryLine: 'status', backgroundActivityStatusLine: true };
    }

    if (input.attentionState === 'ready') {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.readyForReview' };
    }

    if (presentsStanding) {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.keptInAttention' };
    }

    if (input.requestedSecondaryLineMode === 'path' && input.hasPathSubtitle) {
        return { attentionIndicator, titleTone, secondaryLine: 'path' };
    }

    return { attentionIndicator, titleTone, secondaryLine: 'none' };
}

export function shouldEmphasizeSessionRowTitle(input: Readonly<{
    hasUnreadMessages: boolean;
    pendingCount: number;
    sessionStatus: SessionStatus;
}>): boolean {
    return resolveLegacySessionRowAttentionState(input) !== 'quiet';
}

export function shouldShowMinimalSessionStatusLine(_sessionStatus: SessionStatus): boolean {
    return false;
}

function resolveAttentionIndicator(attentionState: SessionRowAttentionState): SessionRowAttentionIndicator {
    switch (attentionState) {
        case 'working':
            return 'working';
        case 'ready':
            return 'ready';
        case 'failed':
            return 'failed';
        case 'unread':
            return 'unread';
        case 'pending':
            return 'pending';
        case 'permission_required':
            return 'permission';
        case 'action_required':
            return 'action';
        case 'quiet':
            return 'none';
    }
}
