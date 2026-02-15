import type { VoiceAdapterController, VoiceAdapterId } from './types';

type Registry = Readonly<{
  get: (id: VoiceAdapterId) => VoiceAdapterController | null;
  list: () => ReadonlyArray<VoiceAdapterController>;
}>;

let controllers: VoiceAdapterController[] = [];

export function registerVoiceAdapters(next: ReadonlyArray<VoiceAdapterController>): void {
  controllers = [...next];
}

export function getVoiceAdapterRegistry(): Registry {
  return {
    get: (id) => controllers.find((c) => c.id === id) ?? null,
    list: () => controllers,
  };
}

