import { z } from '../../zodRuntimePolicy.js';

export const BrowserSessionStateV1Schema = z.enum(['active', 'closing', 'closed', 'failed']);
export type BrowserSessionStateV1 = z.infer<typeof BrowserSessionStateV1Schema>;

export const BrowserSessionV1Schema = z.strictObject({
    browserSessionId: z.string().check(z.trim(), z.minLength(1)),
    profileId: z.string().check(z.trim(), z.minLength(1)),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    closedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    state: BrowserSessionStateV1Schema,
  });
export type BrowserSessionV1 = z.infer<typeof BrowserSessionV1Schema>;
