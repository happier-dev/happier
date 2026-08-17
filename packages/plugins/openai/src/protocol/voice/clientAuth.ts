import { z } from 'zod';

const OpenAiRealtimeSessionResponseSchema = z.object({
  type: z.literal('realtime'),
  object: z.literal('realtime.session'),
  id: z.string().trim().min(1).max(512),
  model: z.string().trim().min(1).max(128),
}).passthrough();

export const OpenAiRealtimeClientAuthProviderResponseSchema = z.object({
  value: z.string().trim().min(1).max(16_384),
  expires_at: z.number().int().positive(),
  // The provider response includes the created session. Its full evolving
  // configuration is bounded by the action's 64 KiB response limit; only the
  // stable discriminants are consumed before the session is projected away.
  session: OpenAiRealtimeSessionResponseSchema,
}).strict();
