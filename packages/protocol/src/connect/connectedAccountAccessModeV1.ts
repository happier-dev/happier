import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Observed account mode, independent of how credential material is stored. */
export const ConnectedAccountAccessModeV1Schema = lazyZodSchema(() => z.enum(['subscription', 'apiKey']));
export type ConnectedAccountAccessModeV1 = z.infer<typeof ConnectedAccountAccessModeV1Schema>;
