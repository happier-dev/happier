import type {
  BundledVoiceSpeechSettingsDescriptor,
  BundledVoiceSpeechSettingsField,
} from '@happier-dev/bundled-voice-runtime-contract';
import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';

export type BundledSpeechSettingsField = BundledVoiceSpeechSettingsField;
export type BundledSpeechSettingsDescriptor = BundledVoiceSpeechSettingsDescriptor;

export type BundledSpeechSettingsEntry = VoiceProviderRegistryEntry;

export function readBundledSpeechSettingsDescriptorFromEntry(
  providerId: string,
  entry: BundledSpeechSettingsEntry | null | undefined,
): BundledSpeechSettingsDescriptor | null {
  if (!entry || entry.kind !== 'voice.speech-engine.v1' || entry.providerId !== providerId) return null;
  const createSettingsSpec = entry.internal?.createSettingsSpec;
  if (!createSettingsSpec) return null;
  try {
    const descriptor = createSettingsSpec(providerId);
    return descriptor?.providerId === providerId ? descriptor : null;
  } catch {
    return null;
  }
}
