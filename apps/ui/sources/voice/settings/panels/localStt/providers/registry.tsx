import type { LocalSttProviderId, LocalSttProviderSpec } from './_types';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

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
  const resolvedId = normalizeNonEmptyString(id);
  const resolved = resolvedId ? providerById.get(resolvedId as LocalSttProviderId) : undefined;
  return resolved ?? openaiCompatSttProviderSpec;
}
