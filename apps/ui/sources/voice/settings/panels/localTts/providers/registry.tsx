import type { LocalTtsProviderId, LocalTtsProviderSpec } from './_types';

import { deviceTtsProviderSpec } from './device/deviceTtsProvider';
import { googleCloudTtsProviderSpec } from './googleCloud/googleCloudTtsProvider';
import { localNeuralTtsProviderSpec } from './localNeural/localNeuralTtsProvider';
import { openaiCompatTtsProviderSpec } from './openaiCompat/openaiCompatTtsProvider';

export const localTtsProviderSpecs = [
  deviceTtsProviderSpec,
  openaiCompatTtsProviderSpec,
  localNeuralTtsProviderSpec,
  googleCloudTtsProviderSpec,
] as const satisfies ReadonlyArray<LocalTtsProviderSpec>;

const providerById = new Map<LocalTtsProviderId, LocalTtsProviderSpec>(
  localTtsProviderSpecs.map((spec) => [spec.id, spec]),
);

export function getLocalTtsProviderSpec(id: unknown): LocalTtsProviderSpec {
  const resolved = typeof id === 'string' ? providerById.get(id as LocalTtsProviderId) : undefined;
  return resolved ?? openaiCompatTtsProviderSpec;
}
