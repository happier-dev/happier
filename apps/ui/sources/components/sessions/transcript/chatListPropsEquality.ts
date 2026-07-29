import { buildSessionTranscriptRenderSignature } from '@/sync/domains/session/transcriptRenderSignature';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ChatListProps } from '@/components/sessions/transcript/chatListTypes';

function areChatListSessionRelevantPropsEqual(left: Session, right: Session): boolean {
    return buildSessionTranscriptRenderSignature(left) === buildSessionTranscriptRenderSignature(right);
}

function areChatListNonSessionPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    return left.bottomNotice === right.bottomNotice
        && left.controlledByUserOverride === right.controlledByUserOverride
        && left.controlSwitchTo === right.controlSwitchTo
        && left.onRequestSwitchToRemote === right.onRequestSwitchToRemote
        && left.externalControlFooter === right.externalControlFooter
        && left.approvalRequests === right.approvalRequests
        && left.jumpToSeq === right.jumpToSeq
        && left.followBottomIntentKey === right.followBottomIntentKey
        && left.onJumpLanded === right.onJumpLanded
        && left.onViewportChange === right.onViewportChange
        && left.onEditPendingMessage === right.onEditPendingMessage
        && left.isWarmKeepAliveInstance === right.isWarmKeepAliveInstance
        && left.routeHydrationPending === right.routeHydrationPending;
}

export function areChatListPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    if (!areChatListNonSessionPropsEqual(left, right)) return false;
    if (left.session === right.session) return true;
    return areChatListSessionRelevantPropsEqual(left.session, right.session);
}
