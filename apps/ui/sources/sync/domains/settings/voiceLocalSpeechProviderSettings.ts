import { VoiceProviderIdSchema } from '@happier-dev/protocol/voice/realtime';
import { z } from 'zod';

/**
 * Speech-provider ids are an open, validated domain. Runtime admission is owned
 * by the active voice registry, so an unknown or disabled id remains inert.
 */
export const VoiceLocalSpeechProviderIdSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  z.union([
    z.enum(['device', 'local_neural']),
    VoiceProviderIdSchema,
  ]),
);
