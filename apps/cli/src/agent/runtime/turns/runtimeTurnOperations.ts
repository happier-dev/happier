import type { RuntimeEventV1 } from '@happier-dev/protocol';
import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';

export type { RuntimeConfigUpdateOutcomeV1 };

export const RUNTIME_TURN_OPERATION_SET = [
  'beginTurnLifecycle',
  'startOrLoadSession',
  'sendTurnPrompt',
  'steerInFlightTurn',
  'waitForTurnCompletion',
  'subscribeRuntimeEvents',
  'respondToPermission',
  'cancelTurn',
  'readSessionIdentity',
  'updateSessionRuntimeConfig',
  'resetOrDisposeRuntime',
] as const;

export type RuntimeTurnOperation = (typeof RUNTIME_TURN_OPERATION_SET)[number];

export type RuntimeTurnSessionIdentity = Readonly<{
  sessionId: string | null;
}>;

export type RuntimeTurnConfigUpdate = Readonly<{
  modeId?: string | null;
  modelId?: string | null;
  configOption?: Readonly<{
    id: string;
    value: string | number | boolean | null;
  }> | null;
}>;

export type RuntimeTurnStartOrLoadOptions = Readonly<{
  resumeId?: string | null;
  importHistory?: boolean;
}>;

export type RuntimeTurnCompletionOptions = Readonly<{
  timeoutMs?: number | null;
}>;

export type RuntimePublicationEvent = Readonly<{
  type: 'event';
  name: 'runtime.descriptor' | 'runtime.capabilities' | 'runtime.facets';
  payload?: unknown;
}>;

export type RuntimeTurnMessage = RuntimeEventV1 | RuntimePublicationEvent;

export type RuntimeTurnMessageHandler = (message: RuntimeTurnMessage) => void;

export type RuntimeTurnOperations = Readonly<{
  beginTurnLifecycle: () => void;
  startOrLoadSession: (opts?: RuntimeTurnStartOrLoadOptions) => Promise<unknown>;
  sendTurnPrompt: (prompt: string) => Promise<void>;
  compactContext?: (command: string) => Promise<void>;
  steerInFlightTurn: (message: string) => Promise<void>;
  waitForTurnCompletion: (opts?: RuntimeTurnCompletionOptions) => Promise<void>;
  subscribeRuntimeEvents: (handler: RuntimeTurnMessageHandler) => () => void;
  respondToPermission: (requestId: string, approved: boolean) => Promise<void>;
  cancelTurn: () => Promise<void>;
  readSessionIdentity: () => RuntimeTurnSessionIdentity;
  updateSessionRuntimeConfig: (update: RuntimeTurnConfigUpdate) => Promise<RuntimeConfigUpdateOutcomeV1 | void>;
  resetOrDisposeRuntime: () => Promise<void>;
}>;

export function isRuntimeTurnOperations(value: unknown): value is RuntimeTurnOperations {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<RuntimeTurnOperation, unknown>>;
  return RUNTIME_TURN_OPERATION_SET.every((operation) => typeof candidate[operation] === 'function');
}
