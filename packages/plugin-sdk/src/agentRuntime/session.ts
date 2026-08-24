import type { PermissionIntent } from '@happier-dev/agents';

import type { JsonValue } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { AgentSessionConversationRollbackControl } from './controls.js';

export type AgentSessionConnectedAccountSelection = Readonly<{
  purpose: string;
  account: Readonly<{
    service: Readonly<{
      pluginId: string;
      localId: string;
    }>;
    accountId: string;
  }>;
}>;

export type TimestampedAgentValue<T> = Readonly<{
  value: T;
  updatedAtMs: number;
}>;

export type AgentLaunchEnvironment = Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}>;

export type AgentSessionMcpLaunchConfig = Readonly<{
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

/**
 * Public structural projection of the Protocol-owned Provider binding.
 * Validation, materialization, and Provider lifecycle remain Protocol/host
 * responsibilities through the canonical schema binding.
 */
/**
 * The authorized upstream this binding points the Agent at, and whether the
 * binding supplies its own runtime credential. An Agent runtime uses both to
 * decide whether its inherited on-disk identity would otherwise answer for a
 * route the user selected as a model source. `normalizedUrl` is null only for
 * a managed-local deployment, which always mints its own runtime credential.
 */
export type AgentSessionProviderBindingUpstream = Readonly<{
  /**
   * The wire protocol the upstream speaks. Protocol keeps a bundled literal
   * union purely for editor completion; the contract is deliberately open,
   * because an installed Provider or Agent plugin contributes its own
   * identifier, so the declaration-neutral projection is the string it admits.
   */
  protocol: string;
  normalizedUrl: string | null;
  credential: 'none' | 'apiKey';
}>;

/**
 * Declaration-neutral structural projection of the Account's resolved provider
 * sharing policy. `packages/protocol` remains the settings owner and validator;
 * `projections.ts` republishes this exact shape under the canonical name and
 * the projection test holds the two declarations equal.
 */
export type AgentConnectedServicesProviderStateSharingPolicy = Readonly<{
  configMode: 'linked' | 'copied' | 'isolated';
  stateMode: 'isolated' | 'shared';
}>;

export type AgentSessionProviderBinding = Readonly<{
  connectionId: string;
  upstream: AgentSessionProviderBindingUpstream;
  model: Readonly<{
    id: string;
    name: string;
    description?: string;
    contextWindowTokens?: number;
    extendedContextModelId?: string;
    modelOptions?: readonly Readonly<{
      id: string;
      name: string;
      description?: string;
      type: string;
      currentValue: string;
      options?: readonly Readonly<{
        value: string;
        name: string;
        description?: string;
      }>[];
      overridesWhenOn?: Readonly<{
        optionIds: readonly string[];
        forcedValue?: string;
      }>;
    }>[];
    capabilities?: Readonly<{
      toolRoundTrips?: 'supported' | 'unsupported' | 'unknown';
      reasoningControls?: 'supported' | 'unsupported' | 'unknown';
    }>;
  }>;
  materialization:
    | Readonly<{ v: 1; kind: 'spawnEnv' }>
    | Readonly<{
        v: 1;
        kind: 'engineConfig';
        engineConfig: Readonly<Record<string, JsonValue>>;
      }>
    | Readonly<{
        v: 1;
        kind: 'configFile';
        rootPath: string;
        relativePaths: readonly string[];
      }>;
}>;

export type AgentSessionProviderCheckpoint = JsonValue;

type RuntimeEventBase = Readonly<{
  sequence: number;
  sessionId: string;
  emittedAtMs: number;
}>;

type RuntimeTurnEvent = RuntimeEventBase & Readonly<{
  turnId: string;
  agentTurnId?: string;
}>;

type RuntimeEventDiagnostic = PluginDiagnosticData;

type RuntimeEventInputIds = [string, ...string[]];

type RuntimeEventDelivery =
  | Readonly<{ kind: 'newTurn'; turnId: string }>
  | Readonly<{ kind: 'followUp'; turnId: string }>
  | Readonly<{ kind: 'steer'; turnId: string }>;

type RuntimeEventUsageTokens = Readonly<{
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}>;

type RuntimeEventUsageCost = Readonly<{
  reportedUsd: number;
  estimatedUsd: number;
  invoiceUsd?: number;
  billingContext?:
    | 'api_usage'
    | 'subscription_included'
    | 'subscription_with_possible_overage'
    | 'unknown';
  costSource?:
    | 'provider_reported'
    | 'provider_reported_api_equivalent'
    | 'pricing_estimate'
    | 'invoice'
    | 'none';
  currency: string;
  breakdown?: Record<string, number>;
  effectiveUsd?: number;
}>;

type RuntimeEventContextUsage = Readonly<{
  v: 1;
  modelId: string | null;
  usedTokens: number;
  windowTokens: number | null;
  totalProcessedTokens: number | null;
  baselineTokens: number | null;
  isAutoCompactEnabled: boolean | null;
  categories: Array<Readonly<{
    key: string;
    label: string | null;
    tokens: number;
  }>> | null;
  observedAtMs: number;
  source: 'provider_live' | 'provider_turn' | 'derived_estimate';
}>;

type RuntimeCompactionEvent = RuntimeEventBase & Readonly<{
  kind: 'context-compaction';
  compactionId: string;
  turnId?: string;
  trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
  retryAttempt?: number;
}>;

/**
 * Public declaration projection of the Protocol-owned runtime event union.
 * The Protocol schema remains the sole validation and semantic owner; this
 * structural SDK declaration keeps external author closures independent from
 * the host-private Protocol package.
 */
export type AgentSessionRuntimeEvent =
  | (RuntimeEventBase & Readonly<{
      kind: 'input-accepted';
      inputIds: RuntimeEventInputIds;
      delivery: RuntimeEventDelivery;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'input-rejected';
      inputIds: RuntimeEventInputIds;
      diagnostic: RuntimeEventDiagnostic;
      retryable: boolean;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'input-custody-unknown';
      inputIds: RuntimeEventInputIds;
      issue: RuntimeEventDiagnostic;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'input-delivery-failed';
      inputIds: RuntimeEventInputIds;
      delivery: Exclude<RuntimeEventDelivery, Readonly<{ kind: 'steer'; turnId: string }>>;
      issue: RuntimeEventDiagnostic;
      duplicateRisk: 'possible' | 'likely' | 'unknown';
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'provider-session-id';
      providerSessionId: string;
      nativeSessionLogPath?: string;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'available-commands';
      commands: Array<Readonly<{
        name: string;
        description?: string;
      }>>;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'turn-start';
      startedBy: 'host' | 'provider';
      causedByTurnId?: string;
    }>)
  | (RuntimeTurnEvent & Readonly<{ kind: 'turn-progress' }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'turn-agent-id-observed';
      agentTurnId: string;
    }>)
  | (RuntimeTurnEvent & Readonly<{ kind: 'turn-complete' }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'turn-failed';
      diagnostic: RuntimeEventDiagnostic;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'turn-cancelled';
      cause:
        | 'user'
        | 'hostShutdown'
        | 'sessionDispose'
        | 'runtimeRecovery'
        | 'providerCancelled'
        | 'providerInterrupted'
        | 'unknown';
      diagnostic?: RuntimeEventDiagnostic;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'runtime-ended';
      cause: 'providerEnded' | 'connectionLost' | 'processExited' | 'protocolError' | 'unknown';
      retryable: boolean;
      diagnostic?: RuntimeEventDiagnostic;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'message-delta';
      channel: 'assistant' | 'reasoning';
      text: string;
      sidechainId?: string;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: JsonValue;
      sidechainId?: string;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'tool-progress';
      toolCallId: string;
      progress: JsonValue;
      sidechainId?: string;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'tool-result';
      toolCallId: string;
      output: JsonValue;
      isError?: boolean;
      sidechainId?: string;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'transcript-message-committed';
      messageId: string;
      role: 'user' | 'assistant' | 'reasoning';
      text: string;
      turnId?: string;
      sidechainId?: string;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'file-edit';
      editId: string;
      path: string;
      description?: string;
      diff?: string;
      oldContent?: string;
      newContent?: string;
      sidechainId?: string;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'usage-observed';
      observationId: string;
      turnId?: string;
      source: string;
      scope: 'turn_delta' | 'session_cumulative' | 'session_final';
      modelId?: string;
      tokens?: RuntimeEventUsageTokens;
      cost?: RuntimeEventUsageCost;
      context?: RuntimeEventContextUsage;
    }>)
  | (RuntimeTurnEvent & Readonly<{
      kind: 'turn-rollback-boundary';
      agentRollbackOrdinal?: number;
      providerCheckpoint?: AgentSessionProviderCheckpoint;
    }>)
  | (RuntimeEventBase & Readonly<{
      kind: 'runtime-activity-snapshot';
      state: 'active' | 'idle' | 'unknown';
      activeCount: number;
    }>)
  | (RuntimeCompactionEvent & Readonly<{
      phase: 'started';
      tokenCountBefore?: number;
      tokenCountSource?: 'providerReported' | 'providerEstimated' | 'derivedEstimate';
    }>)
  | (RuntimeCompactionEvent & Readonly<{ phase: 'progress' }>)
  | (RuntimeCompactionEvent & Readonly<{
      phase: 'completed';
      tokenCountBefore?: number;
      tokenCountAfter?: number;
      tokenCountSource?: 'providerReported' | 'providerEstimated' | 'derivedEstimate';
      continuation?: 'paused';
      pauseReason?: 'agentIdleAfterCompaction';
    }>)
  | (RuntimeCompactionEvent & Readonly<{
      phase: 'failed';
      diagnostic: RuntimeEventDiagnostic;
    }>)
  | (RuntimeCompactionEvent & Readonly<{
      phase: 'cancelled';
      diagnostic?: RuntimeEventDiagnostic;
    }>)
  | (RuntimeCompactionEvent & Readonly<{
      phase: 'outcomeUnknown';
      diagnostic: RuntimeEventDiagnostic;
    }>);

export type AgentSessionRuntimeAuthApplyRequest = Readonly<{
  serviceId: string;
  reason?:
    | 'usage_limit'
    | 'same_provider_account_exhausted'
    | 'soft_threshold'
    | 'manual'
    | 'diagnostic';
  requireDirectLiveHotApply?: boolean;
  expected?: Readonly<{
    profileId?: string;
    groupId?: string;
    generation?: string | number;
    credentialRevision?: string;
  }>;
  authGeneration: Readonly<Record<string, JsonValue>>;
}>;

export type AgentSessionRuntimeAuthApplyResult =
  | Readonly<{
      ok: true;
      appliedVia: string;
      activeAccountId?: string;
      verification?: Readonly<{
        activeAccountId?: string;
        providerAccountId?: string;
        proofStrength?: 'exact' | 'diagnostic' | 'none' | 'unknown';
        source?: string;
        generationApplication?: Readonly<{
          serviceId: string;
          groupId: string;
          profileId: string;
          generation: string | number;
          credentialRevision?: string;
          credentialFingerprint?: string;
        }>;
      }>;
      durability?: Readonly<{
        persisted: boolean;
        errorCode?: string;
      }>;
    }>
  | Readonly<{
      ok: false;
      error: string;
      errorCode?: string;
      appliedVia?: string;
      activeAccountId?: string;
      recovery?: string;
      verification?: Readonly<{
        activeAccountId?: string;
        providerAccountId?: string;
        proofStrength?: 'exact' | 'diagnostic' | 'none' | 'unknown';
        source?: string;
        generationApplication?: Readonly<{
          serviceId: string;
          groupId: string;
          profileId: string;
          generation: string | number;
          credentialRevision?: string;
          credentialFingerprint?: string;
        }>;
      }>;
      durability?: Readonly<{
        persisted: boolean;
        errorCode?: string;
      }>;
    }>;

export type AgentSessionRuntimeAuthIdentityRequest = Readonly<{
  serviceId: string;
  reason?:
    | 'same_provider_account_exhausted'
    | 'soft_threshold'
    | 'diagnostic'
    | 'usage_limit'
    | 'manual';
  requireExactProof?: boolean;
  expected?: Readonly<{
    profileId?: string;
    groupId?: string;
    generation?: string | number;
    credentialRevision?: string;
  }>;
}>;

export type AgentSessionRuntimeAuthIdentityResult =
  | Readonly<{
      ok: true;
      serviceId: string;
      identity: Readonly<{
        strategy: 'provider_account_id' | 'shared_group_auth_surface' | 'none';
        proofStrength: 'exact' | 'diagnostic' | 'none' | 'unknown';
        providerAccountId?: string;
        sharedAuthSurfaceId?: string;
        accountLabel?: string;
        source?: string;
      }>;
      runtime?: Readonly<{
        safeToProbe?: boolean;
        safeToApply?: boolean;
        inProviderTurn?: boolean;
        profileId?: string;
        groupId?: string;
        generation?: string | number;
        credentialRevision?: string;
      }>;
    }>
  | Readonly<{
      ok: false;
      error: string;
      errorCode?: string;
    }>;

export type AgentSessionRuntimeAuthControl = Readonly<{
  apply(request: AgentSessionRuntimeAuthApplyRequest): Promise<AgentSessionRuntimeAuthApplyResult>;
  readIdentity(
    request: AgentSessionRuntimeAuthIdentityRequest,
  ): Promise<AgentSessionRuntimeAuthIdentityResult>;
}>;

export type AgentConfigurationScalar = string | number | boolean | null;
export type AgentPermissionIntent = PermissionIntent;

export type AgentSessionConfigurationSnapshot = Readonly<{
  mode: TimestampedAgentValue<string | null>;
  model: TimestampedAgentValue<string | null>;
  permissionIntent: TimestampedAgentValue<AgentPermissionIntent | null>;
  options: Readonly<Record<string, TimestampedAgentValue<AgentConfigurationScalar>>>;
}>;

export type AgentSessionStartupInstructions = Readonly<{
  v: 1;
  id: string;
  revision: number;
  instructions: string;
}>;

export type AgentSessionOpenRequest =
  Readonly<{
    sessionId: string;
    cwd: string;
    launchEnvironment?: AgentLaunchEnvironment;
    configuration?: AgentSessionConfigurationSnapshot;
    connectedAccounts?: readonly AgentSessionConnectedAccountSelection[];
    mcpServers?: Readonly<Record<string, AgentSessionMcpLaunchConfig>>;
    providerBinding?: AgentSessionProviderBinding;
    /**
     * The account's resolved provider state-sharing policy for this Agent, as
     * decided by the canonical settings owner
     * (`resolveConnectedServicesProviderStateSharingPolicyV1`). An Agent that
     * materializes its own launch-time home reads the user's choice here
     * instead of deciding sharing for itself; the host resolves it, the
     * Agent's `ConnectedServiceStateSharingDescriptor` says which entries the
     * mode governs.
     */
    stateSharing?: AgentConnectedServicesProviderStateSharingPolicy;
  }> & (
    | Readonly<{
        kind: 'create';
        startupInstructions?: AgentSessionStartupInstructions;
      }>
    | Readonly<{
        kind: 'resume';
        providerSessionId: string;
        /**
         * The host found the exact machine-local cross-agent return record.
         * The provider must not publish an alternate resumed identity.
         */
        strictNativeResumeIdentity?: boolean;
        startupInstructions?: AgentSessionStartupInstructions;
      }>
    | Readonly<{
        kind: 'fork';
        source: Readonly<{
          sessionId: string;
          providerSessionId: string;
          cwd: string;
          target?: Readonly<{
            turnId: string;
            providerCheckpoint: AgentSessionProviderCheckpoint;
          }>;
        }>;
      }>
  );

export type AgentSessionInput = Readonly<{
  text: string;
  structuredInput?: JsonValue;
}>;

export type AgentSessionSendRequest = {
  inputIds: [string, ...string[]];
  input: {
    text: string;
    structuredInput?: JsonValue;
  };
  delivery:
    | { kind: 'newTurn'; turnId: string }
    | { kind: 'steer'; turnId: string }
    | { kind: 'followUp'; turnId: string; afterTurnId: string };
  causalPermissionAuthority?: {
    kind: 'admittedSessionInputV1';
    admittedPermissionCeiling: AgentPermissionIntent;
    sourceAuthority?: {
      kind: 'mediatedExternal';
      mediatorPluginId: string;
      sourceRef: string;
      sourceRevisionOrEpoch: string;
      admittedPermissionCeiling: AgentPermissionIntent;
      remoteApprovalMaxScope: 'off' | 'request' | 'session';
    };
  };
};

export type AgentSessionSendResult =
  | Readonly<{ status: 'admitted' }>
  | Readonly<{
      status: 'rejected' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
      retryable: boolean;
    }>;

export type AgentSessionCancelResult =
  | Readonly<{ status: 'requested'; turnId: string }>
  | Readonly<{
      status: 'notRunning' | 'unavailable' | 'unsupported';
      diagnostic?: PluginDiagnosticData;
    }>;

export type AgentSessionConfigurationUpdate = AgentSessionConfigurationSnapshot & Readonly<{
  providerBinding?: AgentSessionProviderBinding;
}>;

export type AgentSessionConfigurationResult =
  | Readonly<{ status: 'applied' | 'deferred'; changed: readonly string[] }>
  | Readonly<{
      status: 'rejected' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
    }>;

export type AgentSessionCompactRequest = {
  compactionId: string;
  trigger: 'manual';
  instructions?: string;
};

export type AgentSessionCompactResult =
  | Readonly<{ status: 'admitted' }>
  | Readonly<{
      status: 'rejected' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
      retryable: boolean;
    }>;

export type AgentSessionDisposeReason =
  | 'session_closed'
  | 'plugin_deactivated'
  | 'host_shutdown'
  | 'runtime_recovery';

export interface AgentSessionRuntime extends Disposable {
  dispose(reason?: AgentSessionDisposeReason): void | Promise<void>;
  readonly conversationRollback?: AgentSessionConversationRollbackControl;
  readonly runtimeAuth?: AgentSessionRuntimeAuthControl;
  connectedServiceApplicationSettled?(request: Readonly<{
    serviceId: string;
    groupId: string;
  }>): Promise<void>;
  send(
    request: AgentSessionSendRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionSendResult>;
  cancel?(
    request: Readonly<{
      turnId: string;
      reason: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery';
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionCancelResult>;
  updateConfiguration?(
    request: AgentSessionConfigurationUpdate,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionConfigurationResult>;
  compact?(
    request: AgentSessionCompactRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionCompactResult>;
  watch(listener: (event: AgentSessionRuntimeEvent) => void): Disposable;
}
