import { useMemo, useSyncExternalStore } from 'react';

import { useSettingsSelector } from '@/sync/domains/state/storage';
import { resolveStoredVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { useVoiceSessionStore } from './voiceSessionStore';
import { getVoiceProviderSettingsRuntimeDemand, subscribeVoiceProviderSettingsRuntimeDemand } from './voiceProviderRuntimeDemand';

/** Admitted attempts and Settings operations share the one executable demand. */
export function useVoiceProviderRuntimeDemand(): ReadonlySet<string> {
  const settings = useSyncExternalStore(subscribeVoiceProviderSettingsRuntimeDemand,
    getVoiceProviderSettingsRuntimeDemand, getVoiceProviderSettingsRuntimeDemand);
  const active = useVoiceSessionStore(state => state.adapterId);
  const canStop = useVoiceSessionStore(state => state.canStop);
  const selected = useSettingsSelector(settings => settings.voiceSettingsV1.providerId, ['voiceSettingsV1']);
  const handoff = active && canStop ? resolveStoredVoiceProviderId(selected) : null;
  return useMemo(() => new Set([
    ...settings,
    ...(active ? [active] : []),
    ...(handoff ? [handoff] : []),
  ]), [active, handoff, settings]);
}
