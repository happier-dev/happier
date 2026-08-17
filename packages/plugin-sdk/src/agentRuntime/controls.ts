import type { PluginDiagnosticData } from '../diagnostics.js';
import type {
  WorkStatePublisher,
} from '../services/sessions.js';
import type { JsonValue } from '../identity.js';
import type { AgentRuntimeContext, AgentSessionRuntimeContext } from './context.js';
import type {
  AgentSessionConnectedAccountSelection,
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

export type AgentSessionGoalRefreshResult = AgentSessionGoalCommittedResult | AgentSessionControlFailure;
export type AgentSessionGoalMutationResult =
  | AgentSessionGoalCommittedResult
  | Readonly<{ status: 'scheduledForResume'; revision: string }>
  | AgentSessionControlFailure;

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

export type AgentSessionSkillCatalogItem = Readonly<{
  id: string;
  name: string;
  displayName: string;
  description?: string;
  path?: string;
  enabled: boolean;
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
      items: readonly AgentSessionSkillCatalogItem[];
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
  readonly goals?: AgentSessionGoalControl;
  readonly catalog?: AgentSessionCatalogControl;
  readonly usageLimitRecovery?: AgentSessionUsageLimitRecoveryControl;
  readonly continuation?: AgentSessionContinuationControl;
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
