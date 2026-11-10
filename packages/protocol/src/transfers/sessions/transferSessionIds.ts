import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const MAX_TRANSFER_SESSION_ID_LENGTH = 512 as const;

export const TransferSessionIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(MAX_TRANSFER_SESSION_ID_LENGTH)));
export type TransferSessionId = z.infer<typeof TransferSessionIdSchema>;
