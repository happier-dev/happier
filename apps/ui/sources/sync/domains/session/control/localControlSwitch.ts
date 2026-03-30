import type { Session } from '@/sync/domains/state/storageTypes';
import { isSessionExclusiveLocalControl } from '@/sync/domains/session/control/sessionLocalControl';

export function shouldRequestRemoteControlAfterPendingEnqueue(session: Session | null): boolean {
    if (!session) return false;
    return isSessionExclusiveLocalControl(session);
}

export function shouldRenderChatTimelineForSession(opts: {
    committedMessagesCount: number;
    pendingMessagesCount: number;
    controlledByUser: boolean;
    forceRenderFooter?: boolean;
    showLocalControlFooter?: boolean;
}): boolean {
    return opts.committedMessagesCount > 0
        || opts.pendingMessagesCount > 0
        || opts.controlledByUser === true
        || opts.showLocalControlFooter === true
        || opts.forceRenderFooter === true;
}
