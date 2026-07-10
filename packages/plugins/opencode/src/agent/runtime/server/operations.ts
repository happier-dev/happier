import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

export type OpenCodePromptSendMeta = Readonly<{
  localInputId?: string | null;
  localInputIds?: readonly string[];
  modelId?: string | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

export type OpenCodeRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(): void;
  startOrLoadSession(opts?: Readonly<{ resumeId?: string | null }>): Promise<string | null | Readonly<Record<string, unknown>>>;
  sendTurnPrompt(prompt: string, meta?: OpenCodePromptSendMeta): Promise<void>;
  steerInFlightTurn(message: string, meta?: OpenCodePromptSendMeta): Promise<void>;
  waitForTurnCompletion(): Promise<void>;
  subscribeRuntimeEvents(handler: (message: RuntimeEventV1) => void): () => void;
  cancelTurn(): Promise<void>;
  listSkills(input?: Readonly<{ directory?: string | null }>): Promise<unknown>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  isHappierAuthoredProviderUserMessageId(messageId: string): boolean;
  updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void>;
  handleProviderEvent(event: unknown): Promise<void>;
  resetOrDisposeRuntime(): Promise<void>;
}>;
