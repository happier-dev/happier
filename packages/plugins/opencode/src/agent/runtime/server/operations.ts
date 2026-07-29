import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';

export type OpenCodePromptSendMeta = Readonly<{
  localInputId?: string | null;
  localInputIds?: readonly string[];
  modelId?: string | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
  promptParts?: readonly import('./promptParts.js').OpenCodePromptPart[];
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
    providerUserMessageId: string;
    effectiveModelId?: string | null;
  }>>;
  steerInFlightTurn(
    message: string,
    meta?: OpenCodePromptSendMeta,
  ): Promise<Readonly<{
    providerUserMessageId: string;
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
  isHappierAuthoredProviderUserMessageId(messageId: string): boolean;
  updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void>;
  handleProviderEvent(event: unknown): Promise<void>;
  resetOrDisposeRuntime(): Promise<void>;
}>;
