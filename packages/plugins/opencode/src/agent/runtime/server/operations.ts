import type { RuntimeEventV1 } from '@happier-dev/protocol';

export type OpenCodeRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(): void;
  startOrLoadSession(opts?: Readonly<{ resumeId?: string | null }>): Promise<string | null | Readonly<Record<string, unknown>>>;
  sendTurnPrompt(prompt: string): Promise<void>;
  steerInFlightTurn(message: string): Promise<void>;
  waitForTurnCompletion(): Promise<void>;
  subscribeRuntimeEvents(handler: (message: RuntimeEventV1) => void): () => void;
  respondToPermission(requestId: string, approved: boolean): Promise<void>;
  cancelTurn(): Promise<void>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void>;
  handleProviderEvent(event: unknown): Promise<void>;
  resetOrDisposeRuntime(): Promise<void>;
}>;
