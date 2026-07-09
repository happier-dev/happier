import { deriveSessionListAttentionState } from '../../../../sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListSecondaryLineMode } from '../../../../sync/domains/session/listing/deriveSessionListActivity';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';

export type SessionRowAttentionState =
    | 'quiet'
    | 'unread'
    | 'pending'
    | 'working'
    | 'backgroundActive'
    | 'ready'
    | 'failed'
    | 'permission_required'
    | 'action_required';

export type SessionRowDensity = 'default' | 'compact' | 'minimal';
export type SessionRowAttentionIndicator = 'none' | 'working' | 'background' | 'ready' | 'failed' | 'unread' | 'pending' | 'permission' | 'action';
export type SessionRowTitleTone = 'quiet' | 'normal' | 'emphasized';
export type SessionRowSecondaryLine = 'none' | 'path' | 'status';

export type SessionRowPresentation = Readonly<{
    attentionIndicator: SessionRowAttentionIndicator;
    titleTone: SessionRowTitleTone;
    secondaryLine: SessionRowSecondaryLine;
    statusTextKey?: 'status.readyForReview' | 'status.error' | 'status.workingRetained' | 'status.backgroundActive';
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
    /**
     * Retained working placement: the session is held in the working group
     * while its live signals are stale, so the status line must not imply
     * live activity (e.g. "online") under the paused indicator.
     */
    workingRetained?: boolean;
}>): SessionRowPresentation {
    const attentionIndicator = resolveAttentionIndicator(input.attentionState);
    const titleTone = input.attentionState === 'quiet'
        ? 'quiet'
        : attentionIndicator === 'none'
            ? 'normal'
            : 'emphasized';

    if (input.density === 'minimal') {
        return { attentionIndicator, titleTone, secondaryLine: 'none' };
    }

    if (input.attentionState === 'ready') {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.readyForReview' };
    }

    if (input.attentionState === 'failed') {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.error' };
    }

    if (input.attentionState === 'quiet') {
        return {
            attentionIndicator,
            titleTone,
            secondaryLine: input.requestedSecondaryLineMode === 'path' && input.hasPathSubtitle ? 'path' : 'none',
        };
    }

    if (input.attentionState === 'working' && input.workingRetained === true) {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.workingRetained' };
    }

    if (input.attentionState === 'backgroundActive') {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.backgroundActive' };
    }

    if (
        input.attentionState === 'working'
        || input.attentionState === 'backgroundActive'
        || input.attentionState === 'permission_required'
        || input.attentionState === 'action_required'
    ) {
        return { attentionIndicator, titleTone, secondaryLine: 'status' };
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

function resolveAttentionIndicator(attentionState: SessionRowAttentionState): SessionRowAttentionIndicator {
    switch (attentionState) {
        case 'working':
            return 'working';
        case 'backgroundActive':
            return 'background';
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
