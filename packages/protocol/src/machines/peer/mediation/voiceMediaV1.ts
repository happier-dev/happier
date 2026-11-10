import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { sha256 } from '@noble/hashes/sha2';

import { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';

export const VOICE_MEDIA_VERSION_V1 = 1 as const;

const Sha256DigestSchema = lazyZodSchema(() => z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)));

export const VoiceMediaApplicationKindV1Schema = lazyZodSchema(() => z.literal('speech_transcription'));
export type VoiceMediaApplicationKindV1 = z.infer<typeof VoiceMediaApplicationKindV1Schema>;

export const VoiceMediaApplicationAuthorityV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  applicationKind: VoiceMediaApplicationKindV1Schema,
  applicationAttemptId: z.string().check(z.minLength(1), z.maxLength(256)),
  applicationAuthorityDigest: Sha256DigestSchema,
}));
export type VoiceMediaApplicationAuthorityV1 = z.infer<
  typeof VoiceMediaApplicationAuthorityV1Schema
>;

/** The exact Voice transcription attempt's authority digest, bound by route grants and daemon admission. */
export function createSpeechTranscriptionApplicationAuthorityDigestV1(applicationAttemptId: string): string {
  const attemptId = z.string().check(z.minLength(1), z.maxLength(256)).parse(applicationAttemptId);
  const canonical = new TextEncoder().encode(createCanonicalJsonSigningInput({
    v: 1, applicationKind: 'speech_transcription', applicationAttemptId: attemptId,
  }));
  let hex = '';
  for (const byte of sha256(canonical)) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}
