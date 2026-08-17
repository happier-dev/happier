import * as React from 'react';

import type { LocalSttProviderId, LocalSttProviderSpec } from './_types';
import type { VoiceReadinessRole } from '@happier-dev/protocol';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';

import { deviceSttProviderSpec } from './device/deviceSttProvider';
import { localNeuralSttProviderSpec } from './localNeural/localNeuralSttProvider';
import { createBundledLocalSttProviderSpec } from '../../bundledSpeech/BundledSpeechSettings';

const candidateProviderSpecs = [
  deviceSttProviderSpec,
  localNeuralSttProviderSpec,
] as const satisfies ReadonlyArray<LocalSttProviderSpec>;

export type LocalSttProviderRegistry = Readonly<{
  list: readonly LocalSttProviderSpec[];
  get: (id: unknown) => LocalSttProviderSpec | null;
}>;

export function createLocalSttProviderRegistry(
  voiceRegistry: VoiceProviderRegistry,
  role: Extract<VoiceReadinessRole, 'conversation_stt' | 'dictation_stt'> = 'conversation_stt',
): LocalSttProviderRegistry {
  const projected = voiceRegistry.list()
    .filter((entry) => entry.source.kind !== 'built_in' && entry.kind === 'voice.speech-engine.v1')
    .map((entry) => createBundledLocalSttProviderSpec(entry))
    .filter((entry): entry is LocalSttProviderSpec => entry !== null);
  const list = Object.freeze([...candidateProviderSpecs, ...projected].filter((spec) => {
    const contribution = voiceRegistry.get(spec.id);
    return contribution?.kind === 'voice.speech-engine.v1'
      && (contribution.role === 'stt' || contribution.role === 'both')
      && contribution.roles.includes(role);
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

export function listLocalSttProviderSpecs(
  role: Extract<VoiceReadinessRole, 'conversation_stt' | 'dictation_stt'> = 'conversation_stt',
): readonly LocalSttProviderSpec[] {
  return createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry(), role).list;
}

export function getLocalSttProviderSpec(
  id: unknown,
  role: Extract<VoiceReadinessRole, 'conversation_stt' | 'dictation_stt'> = 'conversation_stt',
): LocalSttProviderSpec | null {
  return createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry(), role).get(id);
}

export function useLocalSttProviderSpecs(
  role: Extract<VoiceReadinessRole, 'conversation_stt' | 'dictation_stt'> = 'conversation_stt',
): readonly LocalSttProviderSpec[] {
  const registry = React.useMemo(() => createDefaultVoiceProviderRegistry(), []);
  const revision = React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  return React.useMemo(() => createLocalSttProviderRegistry(registry, role).list, [registry, revision, role]);
}
