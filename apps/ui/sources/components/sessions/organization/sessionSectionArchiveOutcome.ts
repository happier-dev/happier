import { SessionSectionsArchiveResultV1Schema } from '@happier-dev/protocol/actions/sessionSections';

/**
 * What a section's Archive all says afterwards (P5 §7). Every member archived says nothing: the rows
 * leaving the section are the result. Otherwise it counts what archived against the exact membership
 * the Action read; failed and unconfirmed members are the rest. A result it cannot read has no total.
 */
export type SessionSectionArchiveOutcome = Readonly<{
    archived: number;
    total: number | null;
    recovery?: 'stop_sessions';
}>;

export function resolveSessionSectionArchiveOutcome(result: unknown): SessionSectionArchiveOutcome | null {
    const parsed = SessionSectionsArchiveResultV1Schema.safeParse(result);
    if (!parsed.success) return { archived: 0, total: null };
    const { archivedSessionIds, failures, unknownSessionIds } = parsed.data;
    const rest = failures.length + unknownSessionIds.length;
    if (rest === 0) return null;
    const needsStop = failures.some(({ code }) => code === 'session_active' || code === 'session_stop_unconfirmed'
        || code === 'session_stop_failed' || code === 'session_stop_requested');
    return { archived: archivedSessionIds.length, total: archivedSessionIds.length + rest,
        ...(needsStop ? { recovery: 'stop_sessions' as const } : {}) };
}
