import { z } from 'zod';

export const VoiceCapabilitiesSchema = z.object({
  configured: z.boolean(),
  provider: z.enum(['elevenlabs']).nullable(),
  /**
   * Whether the server operator/environment is attempting to enable Happier Voice.
   * This is diagnostic-only (not a feature gate); actual enablement is still represented via `features.voice.*.enabled`.
   */
  requested: z.boolean().optional().default(false),
  /**
   * Diagnostic-only: whether build policy denies Happier Voice in this environment.
   * This allows server routes to select the correct error semantics without re-evaluating build policy ad hoc.
   */
  disabledByBuildPolicy: z.boolean().optional().default(false),
});

export type VoiceCapabilities = z.infer<typeof VoiceCapabilitiesSchema>;

export const DEFAULT_VOICE_CAPABILITIES: VoiceCapabilities = {
  configured: false,
  provider: null,
  requested: false,
  disabledByBuildPolicy: false,
};
