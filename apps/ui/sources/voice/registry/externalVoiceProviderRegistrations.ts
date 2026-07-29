import type { VoiceAdapterController } from '@/voice/session/types';
import type {
  PluginVoiceProviderSettingsOperations,
} from '@happier-dev/plugin-sdk/runtime';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

import type { VoiceProviderRegistryEntry } from './providerRegistry';

export type ExternalVoiceProviderRegistration = Readonly<{
  token: object;
  pluginId: string;
  localId: string;
  providerId: string;
  descriptor: VoiceProviderRegistryEntry | null;
  adapter: VoiceAdapterController | null;
  settingsOperations?: Readonly<{
    listCatalog?(input: Readonly<{
      catalog: 'voices' | 'models';
      providerConfig: VoiceRealtimeJsonValue;
      signal: AbortSignal;
    }>): ReturnType<NonNullable<PluginVoiceProviderSettingsOperations['listCatalog']>>;
    provision?(input: Readonly<{
      request: VoiceRealtimeJsonValue;
      providerConfig: VoiceRealtimeJsonValue;
      disabledActionIds: readonly string[];
      extraSystemAppendBlocks: readonly string[];
      signal: AbortSignal;
    }>): ReturnType<NonNullable<PluginVoiceProviderSettingsOperations['provision']>>;
  }>;
}>;

const registrationsByProviderId = new Map<string, ExternalVoiceProviderRegistration>();
const listeners = new Set<() => void>();
let revision = 0;

// One activation-owned source record feeds the existing descriptor and adapter
// registry projections. It makes no selection, readiness, policy, or lifecycle
// decision of its own; the activation scope token is its sole authority.

function emitChange(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function commitExternalVoiceProviderRegistration(registration: ExternalVoiceProviderRegistration): void {
  registrationsByProviderId.set(registration.providerId, registration);
  emitChange();
}

export function removeExternalVoiceProviderRegistration(token: object): void {
  let changed = false;
  for (const [providerId, registration] of registrationsByProviderId) {
    if (registration.token !== token) continue;
    registrationsByProviderId.delete(providerId);
    changed = true;
  }
  if (changed) emitChange();
}

export function listExternalVoiceProviderRegistrations(): readonly ExternalVoiceProviderRegistration[] {
  return Object.freeze([...registrationsByProviderId.values()].sort((left, right) => (
    left.providerId.localeCompare(right.providerId)
  )));
}

export function getExternalVoiceProviderRegistration(
  providerId: string,
): ExternalVoiceProviderRegistration | null {
  return registrationsByProviderId.get(providerId) ?? null;
}

export function subscribeExternalVoiceProviderRegistrations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getExternalVoiceProviderRegistrationsRevision(): number {
  return revision;
}

export function resetExternalVoiceProviderRegistrationsForTests(): void {
  if (registrationsByProviderId.size === 0) return;
  registrationsByProviderId.clear();
  emitChange();
}
