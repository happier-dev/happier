import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Shared lifecycle vocabulary; independent of native checkpoint codecs. */
export const SessionTurnLifecycleStatusV1Schema = lazyZodSchema(() => z.enum([
    'in_progress', 'waiting', 'completed', 'cancelled', 'failed',
]));
export type SessionTurnLifecycleStatusV1 = z.infer<typeof SessionTurnLifecycleStatusV1Schema>;
