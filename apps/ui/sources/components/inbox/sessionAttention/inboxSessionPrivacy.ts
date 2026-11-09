import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import type { readSessionPresentationInputDisplay } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { getSessionName, readLockedSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { t } from '@/text';

/**
 * Whether the Inbox may show this Session only as a status: its content cannot be read on this
 * device. Titles, paths and requests stay hidden then (S0-D privacy). The viewer projection's
 * `status_only` is the Home's notification-preview ceiling, not a statement about this device, so
 * it governs off-app surfaces only.
 */
export function isInboxSessionStatusOnly(session: ReturnType<typeof readSessionPresentationInputDisplay>, serverId?: string | null): boolean {
    // Content visibility is already settled by decryption, independently of runtime/pending state.
    return !readSessionRecordingVisibility()({ sessionId: session.id, serverId: serverId ?? session.serverId })
        || !isSessionContentReadable(readSessionContentAvailability(session));
}

/** The one Inbox name for a Session: its title, or the locked name when only its status may show. */
export function readInboxSessionTitle(session: ReturnType<typeof readSessionPresentationInputDisplay>, serverId: string | null): string {
    if (!readSessionRecordingVisibility()({ sessionId: session.id, serverId })) return t('session.untitled');
    return isInboxSessionStatusOnly(session, serverId) ? readLockedSessionName() : getSessionName(session, serverId);
}
