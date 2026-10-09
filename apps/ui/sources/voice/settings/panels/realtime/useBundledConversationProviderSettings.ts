import * as React from 'react';

import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createBundledConversationUi } from '@/voice/credentials/bundledConversationClient';
import {
  getExternalVoiceProviderRegistrationsRevision,
  subscribeExternalVoiceProviderRegistrations,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';

import {
  parseRealtimeSettingsDescriptor,
  resolveRealtimeProviderConfig,
  type RealtimeProviderSettingsOwner,
  type RealtimeSettingsDescriptor,
  type ResolvedRealtimeProviderConfig,
} from './descriptor';

function createUiSafely(providerId: string) {
  try {
    return createBundledConversationUi(providerId);
  } catch {
    return null;
  }
}

/**
 * The account's selected bundled conversation provider as its settings surfaces read it: the bundled
 * UI (client, descriptor, settings owner) and the account's resolved provider config. One derivation
 * for Voice settings and a Session's Work voice picker.
 */
export function useBundledConversationProviderSettings(voice: VoiceSettings): Readonly<{
  providerId: string | null;
  bundledUi: ReturnType<typeof createBundledConversationUi>;
  descriptor: RealtimeSettingsDescriptor | null;
  owner: RealtimeProviderSettingsOwner | null;
  resolved: ResolvedRealtimeProviderConfig | null;
  config: Readonly<Record<string, unknown>> | null;
}> {
  const providerId = resolveVoiceProviderId(voice.providerId);
  const registrationsRevision = React.useSyncExternalStore(
    subscribeExternalVoiceProviderRegistrations,
    getExternalVoiceProviderRegistrationsRevision,
    getExternalVoiceProviderRegistrationsRevision,
  );
  const bundledUi = React.useMemo(
    () => providerId ? createUiSafely(providerId) : null,
    // The external registrations revision re-resolves a provider contributed after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providerId, registrationsRevision],
  );
  const descriptor = React.useMemo(
    () => providerId && bundledUi ? parseRealtimeSettingsDescriptor(providerId, bundledUi.settingsDescriptor) : null,
    [bundledUi, providerId],
  );
  const owner = React.useMemo<RealtimeProviderSettingsOwner | null>(() => bundledUi ? Object.freeze({
    ...bundledUi.settingsOwner,
    schemaVersion: bundledUi.settingsOwner.currentSchemaVersion,
  }) : null, [bundledUi]);
  const envelope = providerId ? voice.providers?.[providerId] ?? null : null;
  const resolved = React.useMemo(() => owner ? resolveRealtimeProviderConfig(owner, envelope) : null, [envelope, owner]);
  const config = resolved?.status === 'ready' ? resolved.config : null;
  return { providerId, bundledUi, descriptor, owner, resolved, config };
}
