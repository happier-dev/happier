import type { LocalSttProviderId, LocalSttProviderSpec } from './_types';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';

import { deviceSttProviderSpec } from './device/deviceSttProvider';
import { localNeuralSttProviderSpec } from './localNeural/localNeuralSttProvider';
import { openaiCompatSttProviderSpec } from './openaiCompat/openaiCompatSttProvider';
import { createBundledLocalSttProviderSpec } from '../../bundledSpeech/BundledSpeechSettings';

const candidateProviderSpecs = [
  deviceSttProviderSpec,
  openaiCompatSttProviderSpec,
  localNeuralSttProviderSpec,
] as const satisfies ReadonlyArray<LocalSttProviderSpec>;

export type LocalSttProviderRegistry = Readonly<{
  list: readonly LocalSttProviderSpec[];
  get: (id: unknown) => LocalSttProviderSpec | null;
}>;

export function createLocalSttProviderRegistry(
  voiceRegistry: VoiceProviderRegistry,
): LocalSttProviderRegistry {
  const bundled = voiceRegistry.list()
    .filter((entry) => entry.source.kind === 'bundled' && entry.kind === 'voice.speech-engine.v1')
    .map((entry) => createBundledLocalSttProviderSpec(entry))
    .filter((entry): entry is LocalSttProviderSpec => entry !== null);
  const list = Object.freeze([...candidateProviderSpecs, ...bundled].filter((spec) => {
    const contribution = voiceRegistry.get(spec.id);
    return contribution?.kind === 'voice.speech-engine.v1'
      && (contribution.role === 'stt' || contribution.role === 'both');
  }));
  const providerById = new Map<LocalSttProviderId, LocalSttProviderSpec>(
    list.map((spec) => [spec.id, spec]),
  );

  return Object.freeze({
    list,
    get(id: unknown): LocalSttProviderSpec | null {
      const resolvedId = normalizeNonEmptyString(id);
      return resolvedId ? providerById.get(resolvedId as LocalSttProviderId) ?? null : null;
    },
  });
}

const defaultRegistry = createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry());

export const localSttProviderSpecs = defaultRegistry.list;

export function getLocalSttProviderSpec(id: unknown): LocalSttProviderSpec | null {
  return defaultRegistry.get(id);
}
