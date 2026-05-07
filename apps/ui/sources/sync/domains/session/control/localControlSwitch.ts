import type { Session } from '@/sync/domains/state/storageTypes';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { isSessionExclusiveLocalControl } from '@/sync/domains/session/control/sessionLocalControl';

type SessionControlAuthState = CliAuthStatusData['state'] | null | undefined;

export function shouldRequestRemoteControl(session: Session | null, authState?: SessionControlAuthState): boolean {
    if (!session) return false;
    if (authState === 'logged_out') return false;
    return isSessionExclusiveLocalControl(session);
}

export function shouldRequestRemoteControlAfterPendingEnqueue(session: Session | null, authState?: SessionControlAuthState): boolean {
    return shouldRequestRemoteControl(session, authState);
}

export function shouldRenderChatTimelineForSession(opts: {
    committedMessagesCount: number;
    pendingMessagesCount: number;
    controlledByUser: boolean;
    forceRenderFooter?: boolean;
}): boolean {
    return opts.committedMessagesCount > 0
        || opts.pendingMessagesCount > 0
        || opts.controlledByUser === true
        || opts.forceRenderFooter === true;
}
