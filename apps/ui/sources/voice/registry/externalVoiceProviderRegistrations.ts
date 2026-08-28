import type { VoiceAdapterController } from '@/voice/session/types';
import type { RealtimeVoiceProviderSettingsOperations } from '@happier-dev/plugin-sdk/voice/client';
import type {
  PluginSettingsActionInput,
  PluginSettingsActionResult,
} from '@happier-dev/plugin-sdk/settings';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

import type { VoiceProviderRegistryEntry } from './providerRegistry';

export type ExternalVoiceProviderRegistration = Readonly<{
  token: object;
  pluginId: string;
  localId: string;
  providerId: string;
  /** Exact daemon projection generation; required while projection authority is present. */
  projectionGeneration?: string;
  descriptor: VoiceProviderRegistryEntry | null;
  adapter: VoiceAdapterController | null;
  settingsOperations?: Readonly<{
    listCatalog?(input: Readonly<{
      catalog: 'voices' | 'models';
      providerConfig: VoiceRealtimeJsonValue;
      signal: AbortSignal;
    }>): ReturnType<NonNullable<RealtimeVoiceProviderSettingsOperations['listCatalog']>>;
  }>;
  settingsActions?: Readonly<{
    execute(input: PluginSettingsActionInput & Readonly<{
      /** Host snapshot receipt; non-speech action runtimes may ignore it. */
      settingsRevision?: string;
      signal: AbortSignal;
    }>): Promise<PluginSettingsActionResult>;
  }>;
}>;

const registrationsByProviderId = new Map<string, ExternalVoiceProviderRegistration>();
const authoritativeProvidersByToken = new Map<object, ReadonlyMap<string, string>>();
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
  if (authoritativeProvidersByToken.delete(token)) changed = true;
  if (changed) emitChange();
}

/**
 * Publishes the exact provider identities admitted by the current daemon
 * projection. While at least one projection is present, generated bundled
 * descriptors are discovery-only fallback bytes and must not re-admit a
 * disabled or stale provider behind the projection's back.
 *
 * Projection authority and runtime registration remain deliberately distinct
 * facts: the former says which exact generation may exist; the latter says
 * activation actually succeeded. A projected provider without its matching
 * registration is unavailable, never silently restored from fallback bytes.
 *
 * The activation token already owns registration lifetime, so this adds no
 * second generation or enablement owner.
 */
export function replaceExternalVoiceProviderProjectionAuthority(
  previousToken: object | null,
  token: object,
  providers: ReadonlyMap<string, string>,
): void {
  if (previousToken) {
    for (const [providerId, registration] of registrationsByProviderId) {
      if (registration.token === previousToken) registrationsByProviderId.delete(providerId);
    }
    authoritativeProvidersByToken.delete(previousToken);
  }
  authoritativeProvidersByToken.set(token, Object.freeze(new Map(providers)));
  emitChange();
}

export function getExternalVoiceProviderProjectionAuthority(): ReadonlyMap<string, string> | null {
  if (authoritativeProvidersByToken.size === 0) return null;
  const providers = new Map<string, string>();
  for (const entries of authoritativeProvidersByToken.values()) {
    for (const [id, generation] of entries) providers.set(id, generation);
  }
  return Object.freeze(providers);
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
  if (registrationsByProviderId.size === 0 && authoritativeProvidersByToken.size === 0) return;
  registrationsByProviderId.clear();
  authoritativeProvidersByToken.clear();
  emitChange();
}
