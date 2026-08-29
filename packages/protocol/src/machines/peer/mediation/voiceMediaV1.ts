import { z } from 'zod';

export const VOICE_MEDIA_VERSION_V1 = 1 as const;

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const VoiceMediaApplicationKindV1Schema = z.literal('speech_transcription');
export type VoiceMediaApplicationKindV1 = z.infer<typeof VoiceMediaApplicationKindV1Schema>;

export const VoiceMediaApplicationAuthorityV1Schema = z.object({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  applicationKind: VoiceMediaApplicationKindV1Schema,
  applicationAttemptId: z.string().min(1).max(256),
  applicationAuthorityDigest: Sha256DigestSchema,
}).strict();
export type VoiceMediaApplicationAuthorityV1 = z.infer<
  typeof VoiceMediaApplicationAuthorityV1Schema
>;
