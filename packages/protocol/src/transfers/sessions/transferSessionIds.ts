import { z } from 'zod';

export const MAX_TRANSFER_SESSION_ID_LENGTH = 512 as const;

export const TransferSessionIdSchema = z.string().min(1).max(MAX_TRANSFER_SESSION_ID_LENGTH);
export type TransferSessionId = z.infer<typeof TransferSessionIdSchema>;
