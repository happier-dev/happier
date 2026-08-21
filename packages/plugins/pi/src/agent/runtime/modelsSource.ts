import type {
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildPiRuntimeModelsSnapshot } from '../models/catalog.js';

export function createPiSessionModelsSource(params: Readonly<{
  readState(): Promise<unknown>;
  readAvailableModels(): Promise<unknown>;
  onError(error: unknown): void;
}>): AgentSessionModelsSource & Readonly<{
  refresh(): Promise<void>;
  dispose(): void;
}> {
  let disposed = false;
  let refreshGeneration = 0;
  let snapshot: AgentSessionModelsSnapshot = Object.freeze({ models: null });
  const listeners = new Set<(value: AgentSessionModelsSnapshot) => void>();

  return Object.freeze({
    read: () => snapshot,
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      listener(snapshot);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async refresh() {
      if (disposed) return;
      const generation = ++refreshGeneration;
      try {
        const [state, availableModels] = await Promise.all([
          params.readState(),
          params.readAvailableModels(),
        ]);
        if (disposed || generation !== refreshGeneration) return;
        const next = buildPiRuntimeModelsSnapshot({ state, availableModels });
        if (!next) return;
        snapshot = Object.freeze(next);
        for (const listener of listeners) listener(snapshot);
      } catch (error) {
        params.onError(error);
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  });
}
