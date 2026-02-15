import type { LocalSttProviderId, LocalSttProviderSpec } from './_types';

import { deviceSttProviderSpec } from './device/deviceSttProvider';
import { googleGeminiSttProviderSpec } from './googleGemini/googleGeminiSttProvider';
import { localNeuralSttProviderSpec } from './localNeural/localNeuralSttProvider';
import { openaiCompatSttProviderSpec } from './openaiCompat/openaiCompatSttProvider';

export const localSttProviderSpecs = [
  deviceSttProviderSpec,
  openaiCompatSttProviderSpec,
  googleGeminiSttProviderSpec,
  localNeuralSttProviderSpec,
] as const satisfies ReadonlyArray<LocalSttProviderSpec>;

const providerById = new Map<LocalSttProviderId, LocalSttProviderSpec>(localSttProviderSpecs.map((spec) => [spec.id, spec]));

export function getLocalSttProviderSpec(id: unknown): LocalSttProviderSpec {
  const resolved = typeof id === 'string' ? providerById.get(id as LocalSttProviderId) : undefined;
  return resolved ?? openaiCompatSttProviderSpec;
}
