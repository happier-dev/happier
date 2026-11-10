import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const VoiceCapabilitiesSchema = lazyZodSchema(() => z.object({
  configured: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => (typeof value === 'boolean' ? value : undefined)), z._default(z.optional(z.boolean()), false)),
  provider: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => (value === 'elevenlabs' ? value : null)), z.nullable(z.enum(['elevenlabs']))),
  /**
   * Whether the server operator/environment is attempting to enable Happier Voice.
   * This is diagnostic-only (not a feature gate); actual enablement is still represented via `features.voice.*.enabled`.
   */
  requested: z._default(z.optional(z.boolean()), false),
  /**
   * Diagnostic-only: whether build policy denies Happier Voice in this environment.
   * This allows server routes to select the correct error semantics without re-evaluating build policy ad hoc.
   */
  disabledByBuildPolicy: z._default(z.optional(z.boolean()), false),
}));

export type VoiceCapabilities = z.infer<typeof VoiceCapabilitiesSchema>;

export const DEFAULT_VOICE_CAPABILITIES: VoiceCapabilities = {
  configured: false,
  provider: null,
  requested: false,
  disabledByBuildPolicy: false,
};
