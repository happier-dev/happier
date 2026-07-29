import type { LocalTtsProviderId, LocalTtsProviderSpec } from './_types';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { deviceTtsProviderSpec } from './device/deviceTtsProvider';
import { localNeuralTtsProviderSpec } from './localNeural/localNeuralTtsProvider';
import { openaiCompatTtsProviderSpec } from './openaiCompat/openaiCompatTtsProvider';
import { createBundledLocalTtsProviderSpec } from '../../bundledSpeech/BundledSpeechSettings';

const candidateProviderSpecs = [
  deviceTtsProviderSpec,
  openaiCompatTtsProviderSpec,
  localNeuralTtsProviderSpec,
] as const satisfies ReadonlyArray<LocalTtsProviderSpec>;

export type LocalTtsProviderRegistry = Readonly<{
  list: readonly LocalTtsProviderSpec[];
  get: (id: unknown) => LocalTtsProviderSpec | null;
}>;

export function createLocalTtsProviderRegistry(
  voiceRegistry: VoiceProviderRegistry,
): LocalTtsProviderRegistry {
  const bundled = voiceRegistry.list()
    .filter((entry) => entry.source.kind === 'bundled' && entry.kind === 'voice.speech-engine.v1')
    .map((entry) => createBundledLocalTtsProviderSpec(entry))
    .filter((entry): entry is LocalTtsProviderSpec => entry !== null);
  const list = Object.freeze([...candidateProviderSpecs, ...bundled].filter((spec) => {
    const contribution = voiceRegistry.get(spec.id);
    return contribution?.kind === 'voice.speech-engine.v1'
      && (contribution.role === 'tts' || contribution.role === 'both');
  }));
  const providerById = new Map<LocalTtsProviderId, LocalTtsProviderSpec>(
    list.map((spec) => [spec.id, spec]),
  );

  return Object.freeze({
    list,
    get(id: unknown): LocalTtsProviderSpec | null {
      const resolvedId = normalizeNonEmptyString(id);
      return resolvedId ? providerById.get(resolvedId as LocalTtsProviderId) ?? null : null;
    },
  });
}

const defaultRegistry = createLocalTtsProviderRegistry(createDefaultVoiceProviderRegistry());

export const localTtsProviderSpecs = defaultRegistry.list;

export function getLocalTtsProviderSpec(id: unknown): LocalTtsProviderSpec | null {
  return defaultRegistry.get(id);
}
