import type {
  AgentSessionRuntimeEvent,
  AgentSessionStartupInstructionsV1,
  SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';
import type { NormalizedRuntimeIdentityPublicationV1 } from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';
import type {
  AgentSessionProviderBinding,
  AgentSessionRuntime,
  AgentSessionInput,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';

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

/** One immutable read of the active turn facts that must remain causally paired. */
export type RuntimeActiveTurnPermissionWitness = Readonly<{
  turnId: string;
  /** Host-computed cause depth, paired with this exact turn (never plugin input). */
  workDepth?: number;
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
}>;

export type RuntimeTurnConfigUpdate = Readonly<{
  modeId?: string | null;
  modelId?: string | null;
  /** Host-private exact Provider binding; public callers must use session.model.set. */
  providerBinding?: AgentSessionProviderBinding;
  /** Reprojection from the canonical MCP policy owner on the existing configuration path. */
  mcpToolPolicy?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionOpenRequest['mcpToolPolicy'];
  permissionMode?: string | null;
  /** Host-resolved role ceiling, independent of permission intent. */
  workspaceWrites?: 'allow' | 'deny';
  configOption?: Readonly<{
    id: string;
    value: string | number | boolean | null;
  }> | null;
}>;

export type RuntimeTurnSessionOpenIntent =
  Readonly<{ startupInstructions?: AgentSessionStartupInstructionsV1 | null }> & (
  | Readonly<{ kind: 'create' }>
  | Readonly<{
    kind: 'resume';
    providerSessionId: string;
    importHistory: boolean;
  }>);

export type RuntimeTurnCompletionOptions = Readonly<{
  timeoutMs?: number | null;
}>;

export type RuntimeTurnPromptMeta = Readonly<{
  discussionAddressing?: import('@happier-dev/protocol/discussions/participants').DiscussionAddressingV1;
  /** Exact host-admitted request cause; never Agent-authored send options. */
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  /** Host-owned turn correlation; native Agent runtimes must preserve it when supplied. */
  turnId?: string | null;
  localId?: string | null;
  localIds?: readonly string[];
  /** Raw Composer attachments have been resolved away before a runtime sees this envelope. */
  structuredInput?: AgentSessionInput['structuredInput'];
  modelId?: string | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
  /** Exact immutable authority captured at terminal user-input admission. */
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  /** Host-private admission facts, never projected into the Agent's send request. */
  agentStartCaller?: import('@happier-dev/protocol').AgentStartSessionCallerV1;
}>;

/**
 * The host Session runtime stream is exactly the canonical strict Agent Session
 * event union. Host-owned runtime descriptor/capability/facet publication is a
 * separate typed host-private channel (`subscribeRuntimeIdentityPublication`)
 * and must never be grafted onto this union as a pseudo-event.
 */
export type RuntimeTurnMessage = AgentSessionRuntimeEvent;

export type RuntimeTurnMessageHandler = (message: RuntimeTurnMessage) => void;

type RuntimeTurnFailureAlreadySurfacedEvent = Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>;

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

export function readRuntimeTurnFailureAlreadySurfacedEvent(
  error: unknown,
): RuntimeTurnFailureAlreadySurfacedEvent | null {
  return isRuntimeTurnFailureAlreadySurfaced(error)
    ? error[RUNTIME_TURN_FAILURE_EVENT]
    : null;
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
  /** Full plan supplied by the host on this native open, not provider-input acceptance. */
  readSessionStartupInstructions?: () => AgentSessionStartupInstructionsV1 | null;
  /** Concrete open result; an explicit native refusal withdraws manifest support for this incarnation. */
  readSessionStartupInstructionsSupport?: () => boolean | undefined;
  /** Existing native runtime scope, including plugin retirement; never a transport-request lifetime. */
  getRuntimeLifetimeSignal?: () => AbortSignal | null;
  permissionCapability?: RuntimePermissionCapability;
  isProviderNativeCommand?: (prompt: string) => boolean;
  beginTurnLifecycle: () => void;
  /**
   * Dispatch a prompt batch. Committed user-row seqs place runtime output against exact transcript
   * anchors; local ids correlate provider-input outcomes without granting transcript replay authority.
   */
  sendTurnPrompt: (prompt: string, meta?: RuntimeTurnPromptMeta) => Promise<void>;
  compactContext?: (command: string) => Promise<void>;
  /** Effective opened-runtime descriptor and its bound control share one owner. */
  readSessionCompactionCapability?: () => import('@happier-dev/protocol/plugins/agents').AgentSessionCompactionCapability | null;
  compact?: AgentSessionRuntime['compact'];
  steerInFlightTurn: (message: string, meta?: RuntimeTurnPromptMeta) => Promise<void>;
  waitForTurnCompletion: (opts?: RuntimeTurnCompletionOptions) => Promise<void>;
  subscribeRuntimeEvents: (handler: RuntimeTurnMessageHandler) => () => void;
  /**
   * Host-private publication of host-owned runtime identity facts. Present on
   * runtimes composed through `withHostSessionRuntimeIdentityPublication`,
   * which is the single writer of these facts on the Session path.
   */
  subscribeRuntimeIdentityPublication?: (
    handler: (publication: NormalizedRuntimeIdentityPublicationV1) => void,
  ) => () => void;
  respondToPermission?: (requestId: string, approved: boolean) => Promise<RuntimePermissionResponseOutcome>;
  cancelTurn: () => Promise<void>;
  /**
   * Read-only projection of the canonical active-turn admission witness for
   * host-internal consumers such as the per-Session MCP bridge. `null` means
   * no current admitted turn and must not authorize a fallback.
   */
  readActiveTurnPermissionWitness?: () => RuntimeActiveTurnPermissionWitness | null;
  /** Exact local input identity that admitted the currently active parent turn. */
  readActiveTurnInputId?: () => string | null;
  /** Exact initial native input for a canonical started turn; later steers cannot replace it. */
  readTurnStartingInputId?: (turnId: string) => string | null;
  readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
  /**
   * Prepare the live, process-local metadata required by the Agent's existing
   * provider CLI attach surface. This is intentionally transient: durable
   * Session identity publication remains owned by provider acceptance.
   */
  prepareTerminalPresentation?: AgentSessionRuntime['prepareTerminalPresentation'];
  observeTerminalExecution?: AgentSessionRuntime['observeTerminalExecution'];
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
