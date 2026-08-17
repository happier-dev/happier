import { z } from 'zod';

import { SessionForkPointSchema } from './sessionForkPoint.js';

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
 *
 * ATTACHMENT POINT (predecessor). This tree has no `SessionSpawnNewInputV2`.
 * The field is carried on `SessionSpawnNewInputSchema`, the `session.spawn_new`
 * Action input declared inline in `actions/actionSpecs.ts`. That schema IS
 * `.strict()`, so a daemon that predates this field rejects the whole request —
 * the same operation-scoped degradation the successor gets, not a silent strip.
 *
 * An earlier revision of this note assumed the only attachment point was
 * `SpawnDaemonSessionRequestCompatSchema` in
 * `apps/cli/src/rpc/handlers/spawnSessionOptionsContract.ts`. That schema is
 * indeed a plain `z.object` and would silently strip an unknown field, but it is
 * the daemon-local spawn contract beneath the Action owner, not the ingress the
 * authoring client sends `sourceContext` on.
 *
 * The pre-send live inspection call therefore remains the primary defence — the
 * UI must not issue a source-context spawn without an `available` result from
 * `session.continuation.inspect` on the exact selected target machine. A daemon
 * that predates this field also predates that operation and answers
 * METHOD_NOT_AVAILABLE, so operation availability IS the answer; the strict
 * rejection is the backstop.
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
