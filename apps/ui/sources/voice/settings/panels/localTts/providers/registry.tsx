import * as React from 'react';

import type { LocalTtsProviderId, LocalTtsProviderSpec } from './_types';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { deviceTtsProviderSpec } from './device/deviceTtsProvider';
import { localNeuralTtsProviderSpec } from './localNeural/localNeuralTtsProvider';
import { createBundledLocalTtsProviderSpec } from '../../bundledSpeech/BundledSpeechSettings';

const candidateProviderSpecs = [
  deviceTtsProviderSpec,
  localNeuralTtsProviderSpec,
] as const satisfies ReadonlyArray<LocalTtsProviderSpec>;

export type LocalTtsProviderRegistry = Readonly<{
  list: readonly LocalTtsProviderSpec[];
  get: (id: unknown) => LocalTtsProviderSpec | null;
}>;

export function createLocalTtsProviderRegistry(
  voiceRegistry: VoiceProviderRegistry,
): LocalTtsProviderRegistry {
  const projected = voiceRegistry.list()
    .filter((entry) => entry.source.kind !== 'built_in' && entry.kind === 'voice.speech-engine.v1')
    .map((entry) => createBundledLocalTtsProviderSpec(entry))
    .filter((entry): entry is LocalTtsProviderSpec => entry !== null);
  const list = Object.freeze([...candidateProviderSpecs, ...projected].filter((spec) => {
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

export function listLocalTtsProviderSpecs(): readonly LocalTtsProviderSpec[] {
  return createLocalTtsProviderRegistry(createDefaultVoiceProviderRegistry()).list;
}

export function getLocalTtsProviderSpec(id: unknown): LocalTtsProviderSpec | null {
  return createLocalTtsProviderRegistry(createDefaultVoiceProviderRegistry()).get(id);
}

export function useLocalTtsProviderSpecs(): readonly LocalTtsProviderSpec[] {
  const registry = React.useMemo(() => createDefaultVoiceProviderRegistry(), []);
  const revision = React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  return React.useMemo(() => createLocalTtsProviderRegistry(registry).list, [registry, revision]);
}
