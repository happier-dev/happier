import type { VoiceAdapterController, VoiceAdapterId } from './types';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

type Registry = Readonly<{
  get: (id: VoiceAdapterId) => VoiceAdapterController | null;
  list: () => ReadonlyArray<VoiceAdapterController>;
}>;

let controllers: VoiceAdapterController[] = [];

export function registerVoiceAdapters(next: ReadonlyArray<VoiceAdapterController>): void {
  const seen = new Set<string>();
  controllers = next.flatMap((controller) => {
    const id = normalizeNonEmptyString(controller.id);
    if (id === null || seen.has(id)) return [];
    seen.add(id);
    return [{ ...controller, id }];
  });
}

export function getVoiceAdapterRegistry(): Registry {
  return {
    get: (id) => {
      const normalizedId = normalizeNonEmptyString(id);
      if (normalizedId === null) return null;
      return controllers.find((c) => c.id === normalizedId) ?? null;
    },
    list: () => controllers,
  };
}

export function resetVoiceAdapterRegistryForTests(): void {
  controllers = [];
}
