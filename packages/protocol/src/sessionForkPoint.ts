import { z } from 'zod';

/**
 * The one transcript cutoff vocabulary: `latest`, or an exact
 * `seq`/`upToSeqInclusive` bound.
 *
 * It is owned here rather than inside the fork RPC module because three
 * unrelated owners need the cutoff without needing the fork request: the fork
 * RPC itself, the source-context spawn recipe, and the bounded same-Session
 * context pass. Keeping it in a module whose only import is `zod` also stops a
 * consumer from dragging the fork request's LLM-task and backend-target schemas
 * into its bundle graph.
 *
 * `sessionFork.ts` re-exports this symbol, so every existing importer and the
 * protocol index entry are unaffected.
 *
 * Do NOT introduce a second cutoff field (for example `throughSeqInclusive`).
 */
export const SessionForkPointSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('latest') }).strict(),
  z
    .object({
      type: z.literal('seq'),
      upToSeqInclusive: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type SessionForkPoint = z.infer<typeof SessionForkPointSchema>;
