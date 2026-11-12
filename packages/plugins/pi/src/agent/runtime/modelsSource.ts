import type {
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildPiRuntimeModelsSnapshot } from '../models/catalog.js';
import type { parsePiModelDiscoveryRecord } from '../models/discoveryExtension.js';

export function createPiSessionModelsSource(params: Readonly<{
  providerModelId?: string;
  readState(): Promise<unknown>;
  onError(error: unknown): void;
}>): AgentSessionModelsSource & Readonly<{
  observeCatalog(result: NonNullable<ReturnType<typeof parsePiModelDiscoveryRecord>>): void;
  refresh(): Promise<void>;
  dispose(): void;
}> {
  let disposed = false;
  let refreshGeneration = 0;
  let snapshot: AgentSessionModelsSnapshot = Object.freeze({ models: null });
  let state: unknown;
  const listeners = new Set<(value: AgentSessionModelsSnapshot) => void>();

  const publish = (next: AgentSessionModelsSnapshot | null) => {
    if (!next) {
      params.onError(new Error('Pi returned an invalid model catalog'));
      return;
    }
    if (next === snapshot) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener(snapshot);
  };

  return Object.freeze({
    read: () => snapshot,
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      listener(snapshot);
      return { dispose: () => { listeners.delete(listener); } };
    },
    observeCatalog(result) {
      if (disposed) return;
      if ('error' in result) {
        params.onError(new Error(`Pi model discovery failed: ${result.refreshErrorMessage ?? result.error}`));
        return;
      }
      publish(buildPiRuntimeModelsSnapshot({ providerModelId: params.providerModelId, state, availableModels: result, previous: snapshot, observedAt: Date.now() }));
    },
    async refresh() {
      if (disposed) return;
      const generation = ++refreshGeneration;
      try {
        const nextState = await params.readState();
        if (disposed || generation !== refreshGeneration) return;
        state = nextState;
        publish(buildPiRuntimeModelsSnapshot({ providerModelId: params.providerModelId, state, previous: snapshot }));
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
