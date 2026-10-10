import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * One Account's private view frontier for one Session (Lane 09B, L09B-I1/I2).
 *
 * Absence is a first-class state: `not_started` means "quiet", never "read from
 * zero" and never "all history is unread". That distinction is the whole reason
 * this is a union instead of a nullable number — a nullable scalar forced every
 * consumer to re-decide what `null` meant, and they disagreed.
 */
export const ViewerReadStateV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_started') }).strict(),
  z
    .object({
      state: z.literal('tracking'),
      lastViewedSessionSeq: z.number().int().nonnegative(),
      /** Stable unread-entry instant (ms). Null while caught up. */
      unreadSince: z.number().int().nonnegative().nullable(),
    })
    .strict(),
]));
export type ViewerReadStateV1 = z.infer<typeof ViewerReadStateV1Schema>;

export const NOT_STARTED_VIEWER_READ_STATE_V1: ViewerReadStateV1 = Object.freeze({
  state: 'not_started',
});

function normalizeSeq(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * The one viewer-read normalizer. It applies the visible publication ceiling
 * (L09B-I3) once, here, instead of relying on every surface to remember a second
 * check. It does not hide a retained cursor: the producer treats a reader that
 * holds its own frontier as tracked, so a cursor-only reader projects
 * `tracking`. Attention, badge membership and automatic stamping remain
 * owner-or-Follow decisions made by their own owners.
 */
export function projectViewerReadStateV1(params: Readonly<{
  tracked: boolean;
  row: Readonly<{ lastViewedSessionSeq: number; unreadSince: number | null }> | null | undefined;
  visibleSessionSeq: number;
}>): ViewerReadStateV1 {
  if (!params.tracked || !params.row) return NOT_STARTED_VIEWER_READ_STATE_V1;
  const ceiling = normalizeSeq(params.visibleSessionSeq);
  return {
    state: 'tracking',
    lastViewedSessionSeq: Math.min(normalizeSeq(params.row.lastViewedSessionSeq), ceiling),
    unreadSince: typeof params.row.unreadSince === 'number' && Number.isFinite(params.row.unreadSince)
      ? Math.max(0, Math.floor(params.row.unreadSince))
      : null,
  };
}

/**
 * Compatibility wire adapter for the released top-level scalar. An untracked but
 * accessible viewer projects the current visible ceiling rather than `null`,
 * because released readers interpret `null` as "everything is unread" and would
 * turn quiet Team access into an unread flood. This is a projection, never storage.
 */
export function projectLegacyViewerLastViewedSessionSeqV1(params: Readonly<{
  readState: ViewerReadStateV1;
  visibleSessionSeq: number;
}>): number {
  return params.readState.state === 'tracking'
    ? params.readState.lastViewedSessionSeq
    : normalizeSeq(params.visibleSessionSeq);
}

/** The released `unreadSince` ordering fact, disclosed only to a tracked viewer. */
export function projectLegacyViewerUnreadSinceV1(readState: ViewerReadStateV1): number | null {
  return readState.state === 'tracking' ? readState.unreadSince : null;
}
