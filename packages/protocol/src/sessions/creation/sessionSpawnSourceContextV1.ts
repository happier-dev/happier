import { z } from 'zod';

import { SessionForkPointSchema } from '../forkPoint.js';

/**
 * Typed source recipe for a configurable Replay-seeded child Session.
 *
 * Reuses the already-shared {@link SessionForkPointSchema} as the cutoff type.
 * There is no second cutoff vocabulary: `latest` and `seq/upToSeqInclusive` are
 * the only cutoffs anywhere in this feature.
 *
 * When present this is REQUIRED SEMANTICS, not an ignorable hint:
 * - source and target server/account must match in V1;
 * - the daemon resolves the source transcript and Replay seed BEFORE creating
 *   the child;
 * - failure leaves the authoring draft/chip intact and creates no child;
 * - the resolved cutoff becomes immutable child lineage.
 */
export const SessionSpawnSourceContextV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('session_replay'),
    sourceSessionId: z.string().trim().min(1),
    forkPoint: SessionForkPointSchema,
  })
  .strict();
export type SessionSpawnSourceContextV1 = z.infer<typeof SessionSpawnSourceContextV1Schema>;
