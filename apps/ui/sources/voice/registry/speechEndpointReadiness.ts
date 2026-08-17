import {
  resolveVoiceSpeechEndpointPolicy,
  type VoiceProviderSettingsEnvelopeV1,
  type VoiceReadinessRole,
} from '@happier-dev/protocol';

import type { VoiceReadinessFact } from './readiness';
import {
  type VoiceProviderRegistry,
} from './providerRegistry';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Passive endpoint-policy fact for one selected qualified speech leaf. */
export function projectVoiceSpeechEndpointReadiness(input: Readonly<{
  registry: VoiceProviderRegistry;
  role: VoiceReadinessRole;
  providerId: string;
  providerEnvelope: VoiceProviderSettingsEnvelopeV1 | null;
  executionMachineId: string | null;
}>): VoiceReadinessFact {
  const entry = input.registry.get(input.providerId);
  if (entry?.kind !== 'voice.speech-engine.v1'
    || !entry.roles.includes(input.role)) return 'unknown';

  const owner = entry.providerSettings;
  if (!owner) return 'ready';
  if (!input.providerEnvelope || input.providerEnvelope.schemaVersion !== owner.schemaVersion) {
    return 'unknown';
  }
  const config = owner.parseConfig(input.providerEnvelope.config);
  if (!isRecord(config)) return 'unknown';
  if (!Object.hasOwn(config, 'baseUrl')) return 'ready';
  if (typeof config.baseUrl !== 'string' || config.baseUrl.trim().length === 0) return 'missing';

  try {
    const policy = resolveVoiceSpeechEndpointPolicy({
      settings: config,
      machineId: input.executionMachineId,
    });
    return policy?.insecureHttpConfirmed === false ? 'missing' : 'ready';
  } catch {
    return 'incompatible';
  }
}
