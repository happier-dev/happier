import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';

/** Content-free projection; live inventory and owner references stay host-internal. */
export const ManagedActivityReasonV1Schema = lazyDefinition(() => z.enum(['session', 'finite', 'terminal', 'service', 'transfer',
  'handoff', 'sync', 'setup', 'input', 'execution_run', 'workflow_run', 'agents', 'attention', 'coverage_unknown']));
export type ManagedActivityReasonV1 = z.infer<typeof ManagedActivityReasonV1Schema>;
export const ActivityDecisionV1Schema = lazyDefinition(() => {
  const reasons = z.array(ManagedActivityReasonV1Schema);
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('busy'), reasons }),
    z.strictObject({ kind: z.literal('unknown'), reasons }),
    z.strictObject({ kind: z.literal('idle'), since: z.number().check(z.gte(0)) }),
  ]);
});
export type ActivityDecisionV1 = Readonly<z.infer<typeof ActivityDecisionV1Schema>>;
