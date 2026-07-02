import type {
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
} from '@happier-dev/protocol';

/**
 * Typed outcome returned by `updateSessionRuntimeConfig`.
 *
 * The host must KNOW whether a runtime-config override actually took effect, was deferred, or was
 * swallowed. A bare `Promise<void>` cannot distinguish "applied" from "no-op", which let the host
 * mark a swallowed override as applied and never retry it (the "swallowed forever" bug, gap 27).
 *
 * `status` is the frozen five-status protocol contract (`RuntimeConfigOutcomeStatusV1`); deferred /
 * queued state is carried by the optional `timing`, never by new status values. Returning `void`
 * remains valid and is treated by the override-synchronizer as `applied` (legacy back-compat) so a
 * runtime that genuinely applies the change need not opt in.
 */
export type RuntimeConfigUpdateOutcomeV1 = Readonly<{
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1;
  reason?: string;
}>;

/**
 * Whether a runtime-config update outcome means the override took effect and should NOT be retried.
 *
 * `void`/`undefined` (the legacy bare return) counts as applied for back-compat. A typed outcome is
 * "applied" only when `status === 'applied'` and the timing is not a still-pending deferral, or when
 * the change was already effective (`skipped_already_effective`). Every other status/timing keeps the
 * override pending so the synchronizer re-attempts it at the next safe boundary.
 */
export function isRuntimeConfigUpdateOutcomeApplied(
  outcome: RuntimeConfigUpdateOutcomeV1 | void | null | undefined,
): boolean {
  if (!outcome || typeof outcome !== 'object') return true;
  if (outcome.status === 'applied') {
    return outcome.timing !== 'queued_until_safe_window'
      && outcome.timing !== 'scheduled_for_next_prompt'
      && outcome.timing !== 'next_idle';
  }
  return outcome.timing === 'skipped_already_effective';
}
