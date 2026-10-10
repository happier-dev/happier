import { z } from 'zod';



export const VoiceWelcomeSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['immediate', 'on_first_turn']).default('immediate'),
  templateId: z.string().nullable().default(null),
});

export type VoiceWelcomeSettings = z.infer<typeof VoiceWelcomeSchema>;

export type VoiceWelcomeSelection = 'off' | 'immediate' | 'on_first_turn';

export function resolveVoiceWelcomeSelection(welcome: VoiceWelcomeSettings): VoiceWelcomeSelection {
  return welcome.enabled ? welcome.mode : 'off';
}

export function applyVoiceWelcomeSelection<T extends Readonly<{ welcome: VoiceWelcomeSettings }>>(
  settings: T,
  selection: VoiceWelcomeSelection,
): T {
  return {
    ...settings,
    welcome: {
      ...settings.welcome,
      enabled: selection !== 'off',
      mode: selection === 'on_first_turn' ? 'on_first_turn' : 'immediate',
    },
  };
}
