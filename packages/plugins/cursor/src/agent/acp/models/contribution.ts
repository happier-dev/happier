import {
  listCursorAvailableModels,
  type AcpExtensionRequester,
} from './listAvailableModels.js';
import type { CursorAvailableModel } from './schemas.js';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

type ActiveGeneration = {
  id: number;
  abortController: AbortController;
  discoveryStarted: boolean;
};

export class CursorAvailableModelsContribution {
  private generation = 0;
  private active: ActiveGeneration | null = null;
  private models: readonly CursorAvailableModel[] | null = null;

  constructor(private readonly options: Readonly<{
    onChange(models: readonly CursorAvailableModel[] | null): void;
    timeoutMs?: number;
  }>) {}

  beginAuthenticatedGeneration(): number {
    this.active?.abortController.abort();
    this.generation += 1;
    this.active = {
      id: this.generation,
      abortController: new AbortController(),
      discoveryStarted: false,
    };
    this.replace(null);
    return this.generation;
  }

  current(): readonly CursorAvailableModel[] | null {
    return this.models;
  }

  async discover(generation: number, request: AcpExtensionRequester): Promise<void> {
    const active = this.active;
    if (!active || active.id !== generation || active.discoveryStarted) return;
    active.discoveryStarted = true;
    try {
      const models = await listCursorAvailableModels({
        request,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
        signal: active.abortController.signal,
      });
      if (this.active !== active) return;
      this.replace(models.length > 0 ? models : null);
    } catch {
      if (this.active !== active) return;
      this.replace(null);
    }
  }

  invalidate(): void {
    this.active?.abortController.abort();
    this.active = null;
    this.generation += 1;
    this.replace(null);
  }

  dispose(): void {
    this.invalidate();
  }

  private replace(models: readonly CursorAvailableModel[] | null): void {
    this.models = models;
    this.options.onChange(models);
  }
}
