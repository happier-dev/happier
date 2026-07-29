import type { RuntimeEventV1 } from '@happier-dev/protocol';
import type { HappierStructuredInputV1 } from '@happier-dev/protocol/runtime';
import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';
import type {
  AgentSessionProviderBinding,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agent-runtime';

export type { RuntimeConfigUpdateOutcomeV1 };

export const RUNTIME_TURN_OPERATION_SET = [
  'beginTurnLifecycle',
  'sendTurnPrompt',
  'steerInFlightTurn',
  'waitForTurnCompletion',
  'subscribeRuntimeEvents',
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
  /** Host-private exact Provider binding; public callers must use session.model.set. */
  providerBinding?: AgentSessionProviderBinding;
  permissionMode?: string | null;
  configOption?: Readonly<{
    id: string;
    value: string | number | boolean | null;
  }> | null;
}>;

export type RuntimeTurnSessionOpenIntent =
  | Readonly<{ kind: 'create' }>
  | Readonly<{
    kind: 'resume';
    providerSessionId: string;
    importHistory: boolean;
  }>;

export type RuntimeTurnCompletionOptions = Readonly<{
  timeoutMs?: number | null;
}>;

export type RuntimeTurnPromptMeta = Readonly<{
  /** Host-owned turn correlation; native Agent runtimes must preserve it when supplied. */
  turnId?: string | null;
  localId?: string | null;
  localIds?: readonly string[];
  structuredInput?: HappierStructuredInputV1;
  modelId?: string | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

export type RuntimePublicationEvent = Readonly<{
  type: 'event';
  name: 'runtime.descriptor' | 'runtime.capabilities' | 'runtime.facets';
  payload?: unknown;
}>;

export type RuntimeTurnMessage = RuntimeEventV1 | RuntimePublicationEvent;

export type RuntimeTurnMessageHandler = (message: RuntimeTurnMessage) => void;

type RuntimeTurnFailureAlreadySurfacedEvent = Extract<RuntimeEventV1, { kind: 'turn-failed' }>;

const RUNTIME_TURN_FAILURE_ALREADY_SURFACED = '__happierRuntimeTurnFailureAlreadySurfaced';
const RUNTIME_TURN_FAILURE_EVENT = '__happierRuntimeTurnFailureEvent';

export type RuntimeTurnFailureAlreadySurfacedError = Error & Readonly<{
  [RUNTIME_TURN_FAILURE_ALREADY_SURFACED]: true;
  [RUNTIME_TURN_FAILURE_EVENT]: RuntimeTurnFailureAlreadySurfacedEvent | null;
}>;

export function createRuntimeTurnFailureAlreadySurfacedError(input: Readonly<{
  message: string;
  event?: RuntimeTurnFailureAlreadySurfacedEvent | null;
}>): RuntimeTurnFailureAlreadySurfacedError {
  const error = new Error(input.message) as RuntimeTurnFailureAlreadySurfacedError;
  error.name = 'RuntimeTurnFailureAlreadySurfacedError';
  Object.defineProperties(error, {
    [RUNTIME_TURN_FAILURE_ALREADY_SURFACED]: {
      configurable: false,
      enumerable: false,
      value: true,
    },
    [RUNTIME_TURN_FAILURE_EVENT]: {
      configurable: false,
      enumerable: false,
      value: input.event ?? null,
    },
  });
  return error;
}

export function isRuntimeTurnFailureAlreadySurfaced(error: unknown): error is RuntimeTurnFailureAlreadySurfacedError {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as Readonly<Record<typeof RUNTIME_TURN_FAILURE_ALREADY_SURFACED, unknown>>)[RUNTIME_TURN_FAILURE_ALREADY_SURFACED] === true,
  );
}

export type RuntimePermissionResponseOutcome = Readonly<{ delivered: true }>
  | Readonly<{
    delivered: false;
    reason: 'no_active_session' | 'unknown_request';
  }>;

export type RuntimePermissionCapability = 'responds' | 'inline' | 'static';

export type RuntimeTurnDisposeReason = NonNullable<
  Parameters<AgentSessionRuntime['dispose']>[0]
>;

export type RuntimeTurnOperations = Readonly<{
  permissionCapability?: RuntimePermissionCapability;
  beginTurnLifecycle: () => void;
  /**
   * Dispatch a prompt batch. Committed user-row seqs place runtime output against exact transcript
   * anchors; local ids correlate provider-input outcomes without granting transcript replay authority.
   */
  sendTurnPrompt: (prompt: string, meta?: RuntimeTurnPromptMeta) => Promise<void>;
  compactContext?: (command: string) => Promise<void>;
  steerInFlightTurn: (message: string, meta?: RuntimeTurnPromptMeta) => Promise<void>;
  waitForTurnCompletion: (opts?: RuntimeTurnCompletionOptions) => Promise<void>;
  subscribeRuntimeEvents: (handler: RuntimeTurnMessageHandler) => () => void;
  respondToPermission?: (requestId: string, approved: boolean) => Promise<RuntimePermissionResponseOutcome>;
  cancelTurn: () => Promise<void>;
  readSessionIdentity: () => RuntimeTurnSessionIdentity;
  updateSessionRuntimeConfig: (update: RuntimeTurnConfigUpdate) => Promise<RuntimeConfigUpdateOutcomeV1 | void>;
  resetOrDisposeRuntime: (
    reason?: RuntimeTurnDisposeReason,
    nextSessionOpenIntent?: RuntimeTurnSessionOpenIntent,
  ) => Promise<void>;
}>;

export function isRuntimeTurnOperations(value: unknown): value is RuntimeTurnOperations {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<RuntimeTurnOperation, unknown>>;
  return RUNTIME_TURN_OPERATION_SET.every((operation) => typeof candidate[operation] === 'function');
}
