import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/**
 * Person-authored Automation presentation travels inside the incumbent
 * Account-scoped definition carrier. The public Automation row is deliberately
 * only a neutral storage projection for current writers.
 */
export const AutomationDefinitionDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  description: z.nullable(z.string().check(z.maxLength(2_000))),
}));
export type AutomationDefinitionDisplayV1 = z.infer<typeof AutomationDefinitionDisplayV1Schema>;
