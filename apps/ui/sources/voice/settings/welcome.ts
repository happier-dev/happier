import { z } from 'zod';

import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';

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

export function applyVoiceWelcomeSelection(
  settings: VoiceSettings,
  selection: VoiceWelcomeSelection,
): VoiceSettings {
  return {
    ...settings,
    welcome: {
      ...settings.welcome,
      enabled: selection !== 'off',
      mode: selection === 'on_first_turn' ? 'on_first_turn' : 'immediate',
    },
  };
}
