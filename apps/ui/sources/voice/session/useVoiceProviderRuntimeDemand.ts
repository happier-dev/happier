import { useMemo } from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { resolveStoredVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { useVoiceSessionStore } from './voiceSessionStore';

/** Selection prepares the next provider; the published attempt retains its own provider. */
export function useVoiceProviderRuntimeDemand(): ReadonlySet<string> {
  const settings = useSetting('voiceSettingsV1');
  const selected = resolveStoredVoiceProviderId(settings.providerId);
  const active = useVoiceSessionStore(state => state.adapterId);
  return useMemo(() => new Set([
    ...(selected ? [selected] : []),
    ...(active ? [active] : []),
  ]), [selected, active]);
}
