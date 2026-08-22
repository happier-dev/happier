import { deriveSessionListAttentionState } from '../../../../sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListSecondaryLineMode } from '../../../../sync/domains/session/listing/deriveSessionListActivity';
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
    statusTextKey?: 'status.readyForReview' | 'status.error' | 'status.workingRetained' | 'status.backgroundActive' | 'status.keptInAttention';
}>;

export function resolveLegacySessionRowAttentionState(input: Readonly<{
    hasUnreadMessages: boolean;
    pendingCount: number;
    pendingBlockedCount?: number;
    sessionStatus: SessionStatus;
}>): SessionRowAttentionState {
    return resolveSessionRowAttentionState(deriveSessionListAttentionState({
        hasUnreadMessages: input.hasUnreadMessages,
        pendingCount: input.pendingCount,
        pendingBlockedCount: input.pendingBlockedCount,
        sessionState: input.sessionStatus.state,
    }));
}

export function resolveSessionRowAttentionState(
    attentionState: ReturnType<typeof deriveSessionListAttentionState>,
): SessionRowAttentionState {
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
    const signalIndicator = resolveAttentionIndicator(input.attentionState, input.backgroundActive === true);
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
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.backgroundActive' };
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
    pendingBlockedCount?: number;
    sessionStatus: SessionStatus;
}>): boolean {
    return resolveLegacySessionRowAttentionState(input) !== 'quiet';
}

export function shouldShowMinimalSessionStatusLine(sessionStatus: SessionStatus): boolean {
    void sessionStatus;
    return false;
}

function resolveAttentionIndicator(
    attentionState: SessionRowAttentionState,
    backgroundActive: boolean,
): SessionRowAttentionIndicator {
    if (
        backgroundActive
        && attentionState !== 'failed'
        && attentionState !== 'permission_required'
        && attentionState !== 'action_required'
    ) {
        return 'working';
    }

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
