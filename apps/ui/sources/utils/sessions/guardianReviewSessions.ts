import { getSessionDisplayTitle, type SessionNameSource } from '@/utils/sessions/sessionUtils';

/** Codex names its approval-review sessions exactly this; the match is deliberately strict. */
const GUARDIAN_REVIEW_TITLE = 'Guardian review';

export function isGuardianReviewSession(session: SessionNameSource): boolean {
    return getSessionDisplayTitle(session) === GUARDIAN_REVIEW_TITLE;
}

/** Returns `sessions` itself when nothing is to be hidden, so unchanged lists keep their identity. */
export function excludeGuardianReviewSessions<T extends SessionNameSource>(
    sessions: readonly T[],
    hide: boolean,
): readonly T[] {
    if (!hide) return sessions;
    return sessions.filter((session) => !isGuardianReviewSession(session));
}
