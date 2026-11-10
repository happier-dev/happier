import { z } from '../../zodRuntimePolicy.js';



export const VoiceWelcomeSchema = z.object({
  enabled: z._default(z.boolean(), false),
  mode: z._default(z.enum(['immediate', 'on_first_turn']), 'immediate'),
  templateId: z._default(z.nullable(z.string()), null),
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
