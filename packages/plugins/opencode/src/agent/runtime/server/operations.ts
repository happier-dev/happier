import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';
import type { OpenCodePreflightModel } from '../../preflight/models.js';

export type OpenCodeModelCatalogSnapshot = Readonly<{
  observedAt: number;
  models: readonly OpenCodePreflightModel[] | null;
}>;

export type OpenCodeModeCatalogSnapshot = Readonly<{
  observedAt: number;
  modes: readonly Readonly<{ id: string; name: string; description?: string }>[] | null;
  currentModeId: string | null;
}>;

export type OpenCodePromptSendMeta = Readonly<{
  localInputId?: string | null;
  localInputIds?: readonly string[];
  modelId?: string | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
  promptParts?: readonly import('./promptParts.js').OpenCodePromptPart[];
  delivery?: 'steer';
}>;

export type OpenCodeSessionOpenRequest =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'resume'; providerSessionId: string }>
  | Readonly<{
      kind: 'fork';
      source: Readonly<{
        providerSessionId: string;
        providerCheckpoint?: unknown;
      }>;
    }>;

export type OpenCodeRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(turnId: string): void;
  openSession(request: OpenCodeSessionOpenRequest): Promise<string>;
  sendTurnPrompt(
    prompt: string,
    meta?: OpenCodePromptSendMeta,
  ): Promise<Readonly<{
    providerUserMessageId: string | null;
    effectiveModelId?: string | null;
  }>>;
  steerInFlightTurn(
    message: string,
    meta?: OpenCodePromptSendMeta,
  ): Promise<Readonly<{
    providerUserMessageId: string | null;
    effectiveModelId?: string | null;
  }>>;
  waitForTurnCompletion(): Promise<void>;
  subscribeRuntimeEvents(handler: (message: OpenCodeRuntimeEvent) => void): () => void;
  cancelTurn(): Promise<void>;
  compactContext(request: Readonly<{
    compactionId: string;
    instructions?: string;
  }>): Promise<void>;
  listSkills(input?: Readonly<{ directory?: string | null }>): Promise<unknown>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  readModelCatalog(): OpenCodeModelCatalogSnapshot;
  readModeCatalog(): OpenCodeModeCatalogSnapshot;
  isHappierAuthoredProviderUserMessageId(messageId: string): boolean;
  updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<'applied' | 'deferred' | void>;
  handleProviderEvent(event: unknown): Promise<void>;
  resetOrDisposeRuntime(): Promise<void>;
}>;
