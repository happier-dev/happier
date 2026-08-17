import type { IconName } from '@/components/ui/icons/Icon';

/**
 * How live "this is the one this Session actually uses" currently is.
 *
 * The composer's Agent picker answers two different questions at once: what runs
 * next (the selection, carried by a checkmark) and what runs now (this). They are
 * only the same question until the reader chooses another Agent, which is exactly
 * when the second one stops being obvious — the checkmark travels to the new
 * choice and the running one is left with nothing.
 */
export type AppliedRuntimeStatus = 'running' | 'lastUsed' | 'lastReported';

export function resolveAppliedRuntimeStatus(sessionActive: boolean | null | undefined): AppliedRuntimeStatus {
    if (sessionActive === true) return 'running';
    if (sessionActive === false) return 'lastUsed';
    return 'lastReported';
}

/**
 * One glyph table for "this is the one in use".
 *
 * The model list has drawn this beside the Session's applied model for a long
 * time; the Agent rail draws the same glyph beside the Session's Agent. They are
 * two columns of ONE popover, so a second table here would let them disagree
 * about the same Session in the same glance.
 */
export const APPLIED_RUNTIME_MARKER_ICON: Readonly<Record<AppliedRuntimeStatus, IconName>> = {
    running: 'play-circle',
    lastUsed: 'clock',
    lastReported: 'info',
};

/**
 * The rail marker's size.
 *
 * It stands in the checkmark's slot rather than beside it, so it is the
 * checkmark's size — 14 — not the model list's 16, which sits in a roomier row.
 */
export const APPLIED_RUNTIME_MARKER_RAIL_SIZE = 14;
