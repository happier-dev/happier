import { z } from 'zod';

export const SESSION_PROVIDER_HOOK_EVENT_ID_V1 = '@happier/session/provider-hook' as const;
export const SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1 = '@happier/session/provider-transcript' as const;

const ProviderPayloadV1Schema = z.record(z.string(), z.unknown());

export const SessionProviderHookEventPayloadV1Schema = z.object({
  providerId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  providerSessionId: z.string().trim().min(1).optional(),
  eventName: z.string().trim().min(1),
  turnId: z.string().trim().min(1).optional(),
  detail: z.string().trim().min(1).optional(),
  providerPayload: ProviderPayloadV1Schema.optional(),
}).strict();
export type SessionProviderHookEventPayloadV1 = z.infer<typeof SessionProviderHookEventPayloadV1Schema>;

export const SessionProviderTranscriptEventPayloadV1Schema = z.object({
  providerId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  providerSessionId: z.string().trim().min(1).optional(),
  kind: z.string().trim().min(1),
  turnId: z.string().trim().min(1).optional(),
  text: z.string().optional(),
  stopReason: z.string().trim().min(1).optional(),
  providerPayload: ProviderPayloadV1Schema.optional(),
}).strict();
export type SessionProviderTranscriptEventPayloadV1 = z.infer<typeof SessionProviderTranscriptEventPayloadV1Schema>;
