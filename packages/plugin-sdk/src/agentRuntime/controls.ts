import type { PluginDiagnosticData } from '../diagnostics.js';
import type { SessionGoalControlFailureV1 } from '../actions/dtos/pluginActionDtoSupport.generated.js';
import type { SkillCatalogItemV1 } from '@happier-dev/protocol/runtime/catalog/skills';
import type {
  AgentSessionExecutionRunRuntimeFactoryV1,
} from './executionRun.js';
import type {
  WorkStatePublisher,
} from '../services/sessions.js';
import type { JsonValue } from '../identity.js';
import type { AgentRuntimeContext, AgentSessionHostServices, AgentSessionRuntimeContext, AgentTranscriptIdentityCodec, TerminalHostKind } from './context.js';
import type {
  AgentSessionConnectedAccountSelection,
  AgentSessionConfigurationSnapshot,
  AgentSessionCompactionCapability,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from './session.js';

export type AgentSessionControlFailure =
  | Readonly<{
      status: 'rejected' | 'unavailable';
      diagnostic: PluginDiagnosticData;
      retryable: boolean;
    }>
  | Readonly<{ status: 'unsupported'; diagnostic: PluginDiagnosticData }>;

export type AgentSessionControlContext = Omit<AgentSessionRuntimeContext, 'session' | 'workState'> & Readonly<{
  session: Readonly<{
    id: string;
    cwd: string;
    activity: 'active' | 'inactive';
    providerSessionId?: string;
    /** Target Session's admitted native scope; never the requesting Session's environment. */
    launchEnvironment?: AgentSessionOpenRequest['launchEnvironment'];
    connectedAccounts: readonly AgentSessionConnectedAccountSelection[];
  }>;
}>;

/** SDK-local projection of the parsed, host-resolved rollback request. */
export type AgentSessionConversationRollbackRequest = Readonly<{
  operationId: string;
  target: Readonly<{ kind: 'beforeTurn'; turnId: string }>;
  affectedTurns: readonly [
    Readonly<{
      turnId: string;
      providerCheckpoint?: JsonValue;
    }>,
    ...Readonly<{
      turnId: string;
      providerCheckpoint?: JsonValue;
    }>[],
  ];
  providerSessionId: string;
  runtimeIncarnationId: string;
  managedServerInstanceId?: string;
}>;

export type AgentSessionConversationRollbackResult =
  | Readonly<{ status: 'applied' }>
  | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>
  | AgentSessionControlFailure;

export type AgentSessionConversationRollbackReconciliationRequest =
  AgentSessionConversationRollbackRequest;

export type AgentSessionConversationRollbackReconciliationResult =
  | Readonly<{ status: 'applied' | 'notApplied' }>
  | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>
  | Readonly<{
    status: 'unavailable';
    diagnostic: PluginDiagnosticData;
    retryable: boolean;
  }>;

export interface AgentSessionConversationRollbackControl {
  rollback(
    request: AgentSessionConversationRollbackRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionConversationRollbackResult>;
  reconcile(
    request: AgentSessionConversationRollbackRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionConversationRollbackReconciliationResult>;
}

export type AgentSessionGoalMutation =
  | Readonly<{ objective: string; status?: 'active' | 'paused' | 'complete'; tokenBudget?: number | null }>
  | Readonly<{ objective?: string; status: 'active' | 'paused' | 'complete'; tokenBudget?: number | null }>
  | Readonly<{ objective?: string; status?: 'active' | 'paused' | 'complete'; tokenBudget: number | null }>;

export type AgentSessionGoalCommittedResult =
  | Readonly<{ status: 'applied' | 'unchanged'; revision: string }>
  | Readonly<{ status: 'pending'; operationId: string; diagnostic?: PluginDiagnosticData }>;

export type GoalControlFailure = AgentSessionControlFailure & Readonly<{
  goalControlFailure?: SessionGoalControlFailureV1;
}>;

export type AgentSessionGoalRefreshResult = AgentSessionGoalCommittedResult | GoalControlFailure;
export type AgentSessionGoalMutationResult =
  | AgentSessionGoalCommittedResult
  | Readonly<{ status: 'scheduledForResume'; revision: string }>
  | GoalControlFailure;

export type AgentSessionGoalControlContext = AgentSessionControlContext & Readonly<{
  goalSource: WorkStatePublisher;
}>;

export interface AgentSessionGoalControl {
  get(
    context: AgentSessionGoalControlContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionGoalRefreshResult>;
  set(
    mutation: AgentSessionGoalMutation,
    context: AgentSessionGoalControlContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionGoalMutationResult>;
  clear(
    context: AgentSessionGoalControlContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionGoalMutationResult>;
}

export type AgentSessionVendorPluginCatalogItem = Readonly<{
  id: string;
  name: string;
  displayName: string;
  description?: string;
  installed: boolean;
  enabled: boolean;
  mentionable: boolean;
}>;

export type AgentSessionCatalogRequest =
  | Readonly<{ kind: 'vendorPlugins'; cursor?: string; limit?: number }>
  | Readonly<{ kind: 'skills'; cursor?: string; limit?: number }>;

export type AgentSessionCatalogResult =
  | Readonly<{
      status: 'ok';
      kind: 'vendorPlugins';
      items: readonly AgentSessionVendorPluginCatalogItem[];
      nextCursor?: string;
    }>
  | Readonly<{
      status: 'ok';
      kind: 'skills';
      items: readonly SkillCatalogItemV1[];
      nextCursor?: string;
    }>
  | AgentSessionControlFailure;

export interface AgentSessionCatalogControl {
  list(
    request: AgentSessionCatalogRequest,
    context: AgentSessionControlContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionCatalogResult>;
}

export type AgentSessionUsageLimitRecoveryRequest =
  | Readonly<{
      kind: 'checkNow';
      issueFingerprint?: string;
      resumePromptMode?: 'standard' | 'off' | 'custom';
    }>
  | Readonly<{ kind: 'consumeResetCredit'; issueFingerprint: string }>;

export type AgentSessionUsageLimitRecoveryResult =
  | Readonly<{
      status:
        | 'ready'
        | 'waiting'
        | 'resumed'
        | 'switchAttempted'
        | 'switchApplied'
        | 'switchObserved'
        | 'alreadyReady'
        | 'noRecoveryNeeded'
        | 'cancelled';
      retryAfterMs?: number;
      diagnostic?: PluginDiagnosticData;
    }>
  | AgentSessionControlFailure;

export interface AgentSessionUsageLimitRecoveryControl {
  execute(
    request: AgentSessionUsageLimitRecoveryRequest,
    context: AgentSessionControlContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionUsageLimitRecoveryResult>;
}

export type AgentSessionContinuationProbeResult =
  | Readonly<{ status: 'reachable' }>
  | Readonly<{
      status: 'unreachable' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
    }>;

export interface AgentSessionContinuationControl {
  verify(
    request: Extract<AgentSessionOpenRequest, { kind: 'resume' | 'fork' }>,
    context: AgentSessionControlContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionContinuationProbeResult>;
}

export interface AgentSessionRuntimeFactory {
  readonly transcriptIdentity?: AgentTranscriptIdentityCodec;
  /** Developer Preview: selected runtime owns placement and captures its launch intent. */
  readonly resolveTerminalPresentation?: (selection: Readonly<
    Pick<AgentSessionOpenRequest, 'runtimeDescriptorV1' | 'launchEnvironment'>
    & {
      cwd?: string;
      requestedHost?: TerminalHostKind | 'plain';
      configuration?: Pick<AgentSessionConfigurationSnapshot, 'options'>;
    }
  >, context: Readonly<{
    settings: AgentRuntimeContext['services']['settings'];
    features: AgentSessionHostServices['features'];
  }>) => Promise<Readonly<{
    kind: 'runner' | 'managed_terminal' | 'provider_attach' | 'none';
    startingMode?: 'terminal' | 'remote';
    runtimeDescriptorV1?: AgentSessionOpenRequest['runtimeDescriptorV1'];
    /** Selected-mode capability resolved by the Agent before native Session open. */
    compaction?: AgentSessionCompactionCapability | null;
    /** Resume may rebind a surviving owned terminal through this runtime's admission owner. */
    retainedTerminalRecovery?: 'adopt';
    /** Applied over the already prepared environment; never replaces credentials or unset keys. */
    environmentOverlay?: Readonly<Record<string, string>>;
  }>>;
  readonly goals?: AgentSessionGoalControl;
  readonly catalog?: AgentSessionCatalogControl;
  readonly usageLimitRecovery?: AgentSessionUsageLimitRecoveryControl;
  readonly continuation?: AgentSessionContinuationControl;
  /** Capability-gated detached execution; Session V1 remains unchanged. */
  readonly executionRunContextV1?: AgentSessionExecutionRunRuntimeFactoryV1;
  open(
    request: AgentSessionOpenRequest,
    context: AgentSessionRuntimeContext,
  ): AgentSessionRuntime | Promise<AgentSessionRuntime>;
}

// Prevent accidental import collapse: factory creation is generation-scoped and
// receives AgentRuntimeFactoryContext from the activation contract, while these
// operations receive the service-bearing contexts above.
export type AgentRuntimeFactory = (
  context: import('../invocation.js').AgentRuntimeFactoryContext,
) => import('./runtime.js').AgentRuntime | Promise<import('./runtime.js').AgentRuntime>;
