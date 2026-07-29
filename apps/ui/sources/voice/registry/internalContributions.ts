import type { BundledVoiceUiEntry } from '@happier-dev/bundled-voice-runtime-contract';

import { BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES } from './generatedBundledVoiceEntries';

/**
 * Internal build-time executable contribution lookup. This is deliberately not
 * part of the public plugin SDK or manifest projection. A physically absent or
 * reservation-only first-party package yields null and all consumers fail closed.
 */
export function getBundledVoiceUiEntry(providerId: string): BundledVoiceUiEntry | null {
  return BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES.find((entry) => entry.providerId === providerId) ?? null;
}
