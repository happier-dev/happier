import { VoiceProviderIdSchema } from '../realtime/index.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * Speech-provider ids are an open, validated domain. Runtime admission is owned
 * by the active voice registry, so an unknown or disabled id remains inert.
 */
export const VoiceLocalSpeechProviderIdSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => typeof value === 'string' ? value.trim() : value), z.union([
    z.enum(['device', 'local_neural']),
    VoiceProviderIdSchema,
  ]));
