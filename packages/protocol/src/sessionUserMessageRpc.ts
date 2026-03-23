import { z } from 'zod';

export const SessionUserMessageSendMetaSchema = z.record(z.string(), z.unknown());
export type SessionUserMessageSendMeta = z.infer<typeof SessionUserMessageSendMetaSchema>;

export const SessionUserMessageSendRequestSchema = z.object({
  text: z.string().min(1),
  localId: z.string().min(1).optional(),
  meta: SessionUserMessageSendMetaSchema.default({}),
}).passthrough();
export type SessionUserMessageSendRequest = z.infer<typeof SessionUserMessageSendRequestSchema>;

const SessionUserMessageSendSuccessResponseSchema = z.object({
  ok: z.literal(true),
}).passthrough();

const SessionUserMessageSendErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  errorCode: z.string().min(1),
}).passthrough();

export const SessionUserMessageSendResponseSchema = z.union([
  SessionUserMessageSendSuccessResponseSchema,
  SessionUserMessageSendErrorResponseSchema,
]);
export type SessionUserMessageSendResponse = z.infer<typeof SessionUserMessageSendResponseSchema>;
