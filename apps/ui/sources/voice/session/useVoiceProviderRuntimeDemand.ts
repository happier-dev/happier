import { useMemo } from 'react';

import { useSettingsSelector } from '@/sync/domains/state/storage';
import { resolveStoredVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { useVoiceSessionStore } from './voiceSessionStore';

/** An admitted attempt owns its executable provider and any deliberate active handoff. */
export function useVoiceProviderRuntimeDemand(): ReadonlySet<string> {
  const active = useVoiceSessionStore(state => state.adapterId);
  const canStop = useVoiceSessionStore(state => state.canStop);
  const selected = useSettingsSelector(settings => settings.voiceSettingsV1.providerId, ['voiceSettingsV1']);
  const handoff = active && canStop ? resolveStoredVoiceProviderId(selected) : null;
  return useMemo(() => new Set([
    ...(active ? [active] : []),
    ...(handoff ? [handoff] : []),
  ]), [active, handoff]);
}
