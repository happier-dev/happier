import { storage } from '@/sync/domains/state/storage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { isReadAloudAvailable, type LocalVoiceSettingsInput } from './localVoiceSettings';

// Availability only depends on the voice settings record. The store keeps that record's identity
// across unrelated updates, so one parse per distinct record serves every mounted button.
const availabilityByVoice = new WeakMap<object, boolean>();

export function resolveReadAloudAvailable(settings: LocalVoiceSettingsInput): boolean {
  const voice = settings?.voice;
  if (!voice || typeof voice !== 'object') return isReadAloudAvailable(settings);
  const cached = availabilityByVoice.get(voice);
  if (cached !== undefined) return cached;
  const available = isReadAloudAvailable(settings);
  availabilityByVoice.set(voice, available);
  return available;
}

/** A boolean selector, so only a change in availability (not any voice preference) rerenders the reader. */
export function useReadAloudAvailable(): boolean {
  const voiceEnabled = useFeatureEnabled('voice', { scopeKind: 'runtime' });
  return storage((state) => voiceEnabled && resolveReadAloudAvailable(state.settings));
}
