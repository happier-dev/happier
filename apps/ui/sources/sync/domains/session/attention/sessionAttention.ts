import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { deriveExternalSessionAttentionHasUnread } from '@/sync/domains/session/external/readExternalSessionAttention';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionListReadableSeq } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveSessionAttentionState } from './deriveSessionAttentionState';
import { deriveSessionRuntimePresentationState } from './runtimePresentation';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
export { deriveSessionAttentionState } from './deriveSessionAttentionState';
export type { SessionAttentionState } from './types';

export type SessionAttentionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
}>;

export type SessionAttentionFlags = Readonly<{
    hasUnread: boolean;
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
    hasQueuedUserInput: boolean;
}>;

export function deriveSessionAttentionFlags(
    session: Session,
    options?: SessionAttentionOptions,
): SessionAttentionFlags {
    const isSessionActive = session.active === true;
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const pendingFlags = derivePendingRequestFlagsFromSession(session);
    const hasExternalSessionLink = Boolean(readExternalSessionLink(ownerMetadata));
    const externalSessionHasUnread = hasExternalSessionLink
        ? deriveExternalSessionAttentionHasUnread(ownerMetadata)
        : null;

    const hasUnread = options?.showUnread === false
        ? false
        : externalSessionHasUnread ?? computeHasUnreadActivity({
            sessionSeq: hasExternalSessionLink
                ? session.seq ?? 0
                : resolveSessionListReadableSeq(session, undefined),
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
            lastViewedPendingActivityAt: ownerMetadata?.readStateV1?.pendingActivityAt,
        });

    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        hasPendingUserMessages: (session.pendingCount ?? 0) > 0,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
    });

    const hasPendingPermissionRequests = isSessionActive && options?.showPendingPermissionRequests !== false
        ? runtimePresentation.freshPermissionRequired
        : false;

    const hasPendingUserActionRequests = isSessionActive && options?.showPendingUserActionRequests !== false
        ? runtimePresentation.freshActionRequired
        : false;

    const hasQueuedUserInput = options?.showQueuedUserInput === false
        ? false
        : (session.pendingCount ?? 0) > 0;

    return {
        hasUnread,
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
        hasQueuedUserInput,
    };
}

export function hasSessionAttention(session: Session, options?: SessionAttentionOptions): boolean {
    const flags = deriveSessionAttentionFlags(session, options);
    const attentionState = deriveSessionAttentionState({
        active: session.active,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        hasPendingUserMessages: (session.pendingCount ?? 0) > 0,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
        isRunning: session.active === true,
        hasWaitingActivity: flags.hasPendingPermissionRequests
            || flags.hasPendingUserActionRequests,
        hasQueuedUserInput: flags.hasQueuedUserInput,
        hasReviewActivity: flags.hasUnread,
    });
    return (
        attentionState === 'failed' ||
        flags.hasUnread ||
        flags.hasPendingPermissionRequests ||
        flags.hasPendingUserActionRequests ||
        flags.hasQueuedUserInput
    );
}
