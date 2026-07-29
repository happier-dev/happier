import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import {
  parseRealtimeSettingsDescriptor,
  readRealtimeProviderConfigPath,
} from '@/voice/settings/panels/realtime/descriptor';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * Projects the selected authentication source's own explanatory copy into the
 * generic Voice recovery surface. The provider settings descriptor remains the
 * sole owner of source names and semantics.
 */
export function resolveVoiceSurfaceCredentialErrorSubtitleKey(input: Readonly<{
  activeAdapterId: string | null;
  errorCode: unknown;
  providerConfig: unknown;
  providerEntry: VoiceProviderRegistryEntry | null;
}>): string | null {
  if (
    input.errorCode !== 'provider_auth_invalid'
    || input.providerEntry?.kind !== 'voice.conversation-provider.v1'
    || input.activeAdapterId !== input.providerEntry.providerId
    || typeof input.providerEntry.internal?.createSettingsSection !== 'function'
  ) {
    return null;
  }

  const config = record(input.providerConfig);
  if (!config) return null;

  try {
    const descriptor = parseRealtimeSettingsDescriptor(
      input.providerEntry.providerId,
      input.providerEntry.internal.createSettingsSection(),
    );
    const authenticationField = descriptor?.fields.find(
      (field) => field.kind === 'authentication_source',
    );
    if (!authenticationField) return null;

    const authentication = record(
      readRealtimeProviderConfigPath(config, authenticationField.pathSegments),
    );
    const source = authentication?.source;
    if (typeof source !== 'string') return null;

    const selectedOption = Array.isArray(authenticationField.options)
      ? authenticationField.options
        .map(record)
        .find((option) => option?.id === source)
      : null;
    return typeof selectedOption?.subtitleKey === 'string'
      && selectedOption.subtitleKey.trim().length > 0
      ? selectedOption.subtitleKey
      : null;
  } catch {
    return null;
  }
}
