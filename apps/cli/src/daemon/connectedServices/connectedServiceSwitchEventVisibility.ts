/**
 * Single visibility policy for connected-service switch reasons.
 *
 * A "background" reason is fully silent on BOTH user-visible surfaces — the
 * transcript switch event (committer) and the activity notification
 * (dispatcher) read this ONE predicate so the two surfaces can never drift.
 *
 * Membership decisions:
 * - `same_provider_account_exhausted` — cross-session sibling FANOUT: a
 *   protective switch propagated to OTHER sessions when one session exhausts a
 *   shared account. Not user-relevant to the sibling session; stays silent.
 * - `soft_threshold` (preemptive soft-swap) SURFACES like a hard-limit switch:
 *   transcript event + preventive notification copy. It was previously silent,
 *   which hid the preemptive swap ("swap works live … but no notifications").
 *
 * `manual` is NOT background: it commits a transcript event; only the
 * notification dispatcher self-suppresses it (the user performed it).
 */
export function isBackgroundConnectedServiceSwitchReason(reason: string | null | undefined): boolean {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  return normalized === 'same_provider_account_exhausted';
}
