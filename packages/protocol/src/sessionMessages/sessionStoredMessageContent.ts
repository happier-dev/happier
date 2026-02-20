import { z } from 'zod';

export const SessionStoredMessageContentSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }),
  z.object({
    t: z.literal('plain'),
    v: z.unknown(),
  }),
]);

export type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

