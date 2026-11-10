import { lazyZodSchema } from '../../lazyZodSchema.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { z } from '../../zodRuntimePolicy.js';

export const SESSION_PROVIDER_HOOK_EVENT_ID_V1 = '@happier/session/provider-hook' as const;
export const SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1 = '@happier/session/provider-transcript' as const;

const ProviderPayloadV1Schema = lazyZodSchema(() => z.record(z.string(), z.unknown()));

export const SessionProviderHookEventPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  providerId: z.string().check(z.trim(), z.minLength(1)),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  providerSessionId: z.optional(NonBlankOpaqueIdentifierSchema),
  eventName: z.string().check(z.trim(), z.minLength(1)),
  turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  detail: z.optional(z.string().check(z.trim(), z.minLength(1))),
  providerPayload: z.optional(ProviderPayloadV1Schema),
}));
export type SessionProviderHookEventPayloadV1 = z.infer<typeof SessionProviderHookEventPayloadV1Schema>;

export const SessionProviderTranscriptEventPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  providerId: z.string().check(z.trim(), z.minLength(1)),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  providerSessionId: z.optional(NonBlankOpaqueIdentifierSchema),
  kind: z.string().check(z.trim(), z.minLength(1)),
  turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  text: z.optional(z.string()),
  stopReason: z.optional(z.string().check(z.trim(), z.minLength(1))),
  providerPayload: z.optional(ProviderPayloadV1Schema),
}));
export type SessionProviderTranscriptEventPayloadV1 = z.infer<typeof SessionProviderTranscriptEventPayloadV1Schema>;
