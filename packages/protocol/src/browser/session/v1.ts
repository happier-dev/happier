import { z } from 'zod';

export const BrowserSessionStateV1Schema = z.enum(['active', 'closing', 'closed', 'failed']);
export type BrowserSessionStateV1 = z.infer<typeof BrowserSessionStateV1Schema>;

export const BrowserSessionV1Schema = z
  .object({
    browserSessionId: z.string().trim().min(1).max(256),
    profileId: z.string().trim().min(1).max(256),
    createdAt: z.number().int().nonnegative(),
    closedAt: z.number().int().nonnegative().optional(),
    state: BrowserSessionStateV1Schema,
  })
  .strict();
export type BrowserSessionV1 = z.infer<typeof BrowserSessionV1Schema>;
