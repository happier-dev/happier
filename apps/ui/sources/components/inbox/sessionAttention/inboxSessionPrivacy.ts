import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';

import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

/**
 * Whether the Inbox may show this Session only as a status: the viewer projection says so, or its
 * content cannot be read on this device. Titles, paths and requests stay hidden then (S0-D privacy).
 */
export function isInboxSessionStatusOnly(session: Session, nowMs: number = Date.now()): boolean {
    return session.viewer?.attention.presentation === 'status_only'
        || !isSessionAwarenessContentReadableV1(projectUiSessionAwareness(session, nowMs).encryption);
}

/** The one Inbox name for a Session: its title, or the locked name when only its status may show. */
export function readInboxSessionTitle(session: Session, serverId: string | null, nowMs: number = Date.now()): string {
    return isInboxSessionStatusOnly(session, nowMs) ? t('sessionBoard.item.locked.title') : getSessionName(session, serverId);
}
