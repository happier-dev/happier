import {
    QUIET_SESSION_PERSONAL_ATTENTION_V1,
    resolveSessionPersonalAttentionV1,
    type SessionPersonalAttentionProjectionV1,
} from '@happier-dev/protocol';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Message } from "@happier-dev/session-core/messages";
import {
    projectUiSessionRuntimeAwareness,
    readSessionRuntimePresentationFreshnessExpirations,
} from '../attention/runtimePresentation';
import { deriveLatestPendingRequestObservedAtFromSession, derivePendingRequestFlagsFromSession } from '../pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '../readCursor/resolveLastViewedSessionSeq';
import { resolveSessionListReadableSeq } from '../listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '../readSessionOwnerMetadataView';
import { readExternalSessionLink } from '../external/readExternalSessionLink';
import { deriveExternalSessionAttentionHasUnread } from '../external/readExternalSessionAttention';
import { isSessionPersonallyTrackedForViewer } from './sessionViewer';
import type { SessionListRenderableSession } from '../listing/sessionListRenderable';

/** Only consumed admission/attention facts invalidate Activity and Inbox projections. */
export function readSessionViewerAttentionSignature(session: Session | SessionListRenderableSession): string {
    const viewer = session.viewer;
    return [
        session.archivedAt ?? '',
        isSessionPersonallyTrackedForViewer(session) ? 1 : 0,
        viewer?.attention.needsAttention ? 1 : 0,
        viewer?.attention.primary ?? '',
        viewer?.attention.presentation ?? '',
        viewer?.attention.reasons.join(',') ?? '',
    ].join('|');
}

const NO_ATTENTION_EXPIRATIONS: readonly number[] = [];

/**
 * The one legacy runtime input. Attention and its clock boundaries are read from
 * the same object so a consumer can never wake on a boundary the decision does
 * not actually use.
 */
function buildPreViewerRuntimeInput(
    session: Session,
    nowMs: number,
    messages?: readonly Message[],
) {
    const pending = derivePendingRequestFlagsFromSession(session, messages);
    return {
        ...session,
        hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session, messages),
        nowMs,
    };
}

/**
 * When this Session's personal attention would change by the clock alone.
 *
 * Only pre-viewer Homes have such an instant: their pending-request attention is
 * gated on a freshness budget that elapses while nothing arrives, so a mounted
 * surface that never re-projects keeps showing retired attention. A modern
 * viewer row is server-owned and expires nowhere on the client. Both legacy
 * permission and user-action freshness use the existing runtime owner budget.
 */
export function readSessionPersonalAttentionExpirationsForViewer(
    session: Session,
    nowMs: number,
    messages?: readonly Message[],
): readonly number[] {
    if (session.archivedAt != null) return NO_ATTENTION_EXPIRATIONS;
    if (session.viewer !== undefined) return NO_ATTENTION_EXPIRATIONS;
    if (!isSessionPersonallyTrackedForViewer(session)) return NO_ATTENTION_EXPIRATIONS;
    return readSessionRuntimePresentationFreshnessExpirations(
        buildPreViewerRuntimeInput(session, nowMs, messages),
        nowMs,
    );
}

/** Modern viewer facts win; pre-viewer Home owners use the same Protocol decision owner. */
export function resolveSessionPersonalAttentionForViewer(
    session: Session,
    nowMs: number,
    messages?: readonly Message[],
): SessionPersonalAttentionProjectionV1 {
    if (session.archivedAt != null) {
        return QUIET_SESSION_PERSONAL_ATTENTION_V1;
    }
    // A modern server projection already applied owner-or-Follow tracking and
    // owns the sole due-reminder exception. Do not suppress that exception by
    // re-running the older tracking guard in a consumer.
    if (session.viewer !== undefined) return session.viewer.attention;
    if (!isSessionPersonallyTrackedForViewer(session)) {
        return QUIET_SESSION_PERSONAL_ATTENTION_V1;
    }

    // 0.2.11 owner compatibility: legacy scalar/metadata is read only, never
    // authoritative over a modern viewer row. Remove with pre-viewer Home support.
    const metadata = readSessionOwnerMetadataView(session);
    const runtime = projectUiSessionRuntimeAwareness(
        buildPreViewerRuntimeInput(session, nowMs, messages),
    );
    const externalUnread = readExternalSessionLink(metadata)
        ? deriveExternalSessionAttentionHasUnread(metadata) : null;
    const legacyCursor = resolveLastViewedSessionSeq(session);
    return resolveSessionPersonalAttentionV1({
        tracked: true,
        accessible: true,
        accountSuspended: false,
        contentAvailable: session.metadataLayoutVersion !== 1 || metadata != null,
        visibleSessionSeq: resolveSessionListReadableSeq(session, undefined),
        ...(externalUnread === null ? {} : { externalSessionHasUnread: externalUnread }),
        readState: legacyCursor === undefined
            ? { state: 'not_started' }
            : { state: 'tracking', lastViewedSessionSeq: legacyCursor, unreadSince: null },
        latestReadyEventSeq: session.latestReadyEventSeq ?? null,
        hasPrimarySessionFailure: runtime.operational.reasons.includes('failed'),
        pendingBlockedCount: session.pendingBlockedCount ?? 0,
        pendingPermissionRequestCount: runtime.freshPermissionRequired ? 1 : 0,
        pendingUserActionRequestCount: runtime.freshActionRequired ? 1 : 0,
        capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
        responsible: false,
        discussion: { hasUnread: false, hasMention: false },
        attentionStanding: 'none',
        reminderDue: false,
    });
}
