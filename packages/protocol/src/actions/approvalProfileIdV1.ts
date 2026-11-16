import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Reference identity is independent of the Action policy overlay and catalog. */
export const ApprovalProfileIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
