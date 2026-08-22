import type { PermissionIntent } from '@happier-dev/agents';

import type { JsonValue } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { AgentSessionConversationRollbackControl } from './controls.js';

/**
 * Declaration-neutral structural projection of the canonical Protocol event
 * union. Protocol remains the validator and producer owner through the
 * explicitly typed schema binding in `projections.ts`.
 */
export type AgentSessionRuntimeEvent = {
  sequence: number;
  sessionId: string;
  emittedAtMs: number;
} & (
  | {
      kind: 'input-accepted';
      inputIds: [string, ...string[]];
      delivery:
        | { kind: 'newTurn'; turnId: string }
        | { kind: 'followUp'; turnId: string }
        | { kind: 'steer'; turnId: string };
    }
  | {
      kind: 'input-rejected';
      inputIds: [string, ...string[]];
      diagnostic: {
        code: string;
        severity: 'info' | 'warning' | 'error';
        message?: string;
        details?: JsonValue;
        remediation?:
          | { kind: 'retry' }
          | { kind: 'openSettings'; path: string }
          | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
          | { kind: 'installDependency'; dependencyId: string }
          | { kind: 'openUrl'; url: string };
      };
      retryable: boolean;
    }
  | {
      kind: 'input-custody-unknown';
      inputIds: [string, ...string[]];
      issue: {
        code: string;
        severity: 'info' | 'warning' | 'error';
        message?: string;
        details?: JsonValue;
        remediation?:
          | { kind: 'retry' }
          | { kind: 'openSettings'; path: string }
          | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
          | { kind: 'installDependency'; dependencyId: string }
          | { kind: 'openUrl'; url: string };
      };
    }
  | {
      kind: 'input-delivery-failed';
      inputIds: [string, ...string[]];
      delivery:
        | { kind: 'newTurn'; turnId: string }
        | { kind: 'followUp'; turnId: string };
      issue: {
        code: string;
        severity: 'info' | 'warning' | 'error';
        message?: string;
        details?: JsonValue;
        remediation?:
          | { kind: 'retry' }
          | { kind: 'openSettings'; path: string }
          | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
          | { kind: 'installDependency'; dependencyId: string }
          | { kind: 'openUrl'; url: string };
      };
      duplicateRisk: 'possible' | 'likely' | 'unknown';
    }
  | {
      kind: 'provider-session-id';
      providerSessionId: string;
      /**
       * Where this Agent keeps its own session log for `providerSessionId` on
       * THIS machine, when the runtime knows the path. It rides the same event
       * as the id whose conversation it names, and it is a pointer offered to a
       * successor Agent rather than a gate on resuming.
       */
      nativeSessionLogPath?: string;
    }
  | ({
      turnId: string;
      agentTurnId?: string;
    } & (
      | {
          kind: 'turn-start';
          startedBy: 'host' | 'provider';
          causedByTurnId?: string;
        }
      | { kind: 'turn-progress' }
      | { kind: 'turn-agent-id-observed'; agentTurnId: string }
      | { kind: 'turn-complete' }
      | {
          kind: 'turn-failed';
          diagnostic: {
            code: string;
            severity: 'info' | 'warning' | 'error';
            message?: string;
            details?: JsonValue;
            remediation?:
              | { kind: 'retry' }
              | { kind: 'openSettings'; path: string }
              | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
              | { kind: 'installDependency'; dependencyId: string }
              | { kind: 'openUrl'; url: string };
          };
        }
      | {
          kind: 'turn-cancelled';
          cause:
            | 'user'
            | 'hostShutdown'
            | 'sessionDispose'
            | 'runtimeRecovery'
            | 'providerCancelled'
            | 'providerInterrupted'
            | 'unknown';
          diagnostic?: {
            code: string;
            severity: 'info' | 'warning' | 'error';
            message?: string;
            details?: JsonValue;
            remediation?:
              | { kind: 'retry' }
              | { kind: 'openSettings'; path: string }
              | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
              | { kind: 'installDependency'; dependencyId: string }
              | { kind: 'openUrl'; url: string };
          };
        }
      | {
          kind: 'message-delta';
          channel: 'assistant' | 'reasoning';
          text: string;
          sidechainId?: string;
        }
      | {
          kind: 'tool-call';
          toolCallId: string;
          toolName: string;
          input: JsonValue;
          sidechainId?: string;
        }
      | {
          kind: 'tool-progress';
          toolCallId: string;
          progress: JsonValue;
          sidechainId?: string;
        }
      | {
          kind: 'tool-result';
          toolCallId: string;
          output: JsonValue;
          isError?: boolean;
          sidechainId?: string;
        }
      | {
          kind: 'file-edit';
          editId: string;
          path: string;
          description?: string;
          diff?: string;
          oldContent?: string;
          newContent?: string;
          sidechainId?: string;
        }
      | {
          kind: 'turn-rollback-boundary';
          agentRollbackOrdinal?: number;
          providerCheckpoint?: JsonValue;
        }
    ))
  | {
      kind: 'runtime-ended';
      cause: 'providerEnded' | 'connectionLost' | 'processExited' | 'protocolError' | 'unknown';
      retryable: boolean;
      diagnostic?: {
        code: string;
        severity: 'info' | 'warning' | 'error';
        message?: string;
        details?: JsonValue;
        remediation?:
          | { kind: 'retry' }
          | { kind: 'openSettings'; path: string }
          | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
          | { kind: 'installDependency'; dependencyId: string }
          | { kind: 'openUrl'; url: string };
      };
    }
  | {
      kind: 'transcript-message-committed';
      messageId: string;
      role: 'user' | 'assistant' | 'reasoning';
      text: string;
      turnId?: string;
      sidechainId?: string;
    }
  | {
      kind: 'usage-observed';
      observationId: string;
      turnId?: string;
      source: string;
      scope: 'turn_delta' | 'session_cumulative' | 'session_final';
      modelId?: string;
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
      cost?: {
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
      };
      context?: {
        v: 1;
        modelId: string | null;
        usedTokens: number;
        windowTokens: number | null;
        totalProcessedTokens: number | null;
        baselineTokens: number | null;
        isAutoCompactEnabled: boolean | null;
        categories: Array<{
          key: string;
          label: string | null;
          tokens: number;
        }> | null;
        observedAtMs: number;
        source: 'provider_live' | 'provider_turn' | 'derived_estimate';
      };
    }
  | {
      kind: 'runtime-activity-snapshot';
      state: 'active' | 'idle' | 'unknown';
      activeCount: number;
    }
  | {
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'started';
      tokenCountBefore?: number;
      tokenCountSource?: 'providerReported' | 'providerEstimated' | 'derivedEstimate';
    }
  | {
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'progress';
    }
  | {
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'completed';
      tokenCountBefore?: number;
      tokenCountAfter?: number;
      tokenCountSource?: 'providerReported' | 'providerEstimated' | 'derivedEstimate';
      continuation?: 'paused';
      pauseReason?: 'agentIdleAfterCompaction';
    }
  | {
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'failed';
      diagnostic: {
        code: string;
        severity: 'info' | 'warning' | 'error';
        message?: string;
        details?: JsonValue;
        remediation?:
          | { kind: 'retry' }
          | { kind: 'openSettings'; path: string }
          | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
          | { kind: 'installDependency'; dependencyId: string }
          | { kind: 'openUrl'; url: string };
      };
    }
  | {
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'cancelled';
      diagnostic?: {
        code: string;
        severity: 'info' | 'warning' | 'error';
        message?: string;
        details?: JsonValue;
        remediation?:
          | { kind: 'retry' }
          | { kind: 'openSettings'; path: string }
          | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
          | { kind: 'installDependency'; dependencyId: string }
          | { kind: 'openUrl'; url: string };
      };
    }
  | {
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'outcomeUnknown';
      diagnostic: {
        code: string;
        severity: 'info' | 'warning' | 'error';
        message?: string;
        details?: JsonValue;
        remediation?:
          | { kind: 'retry' }
          | { kind: 'openSettings'; path: string }
          | { kind: 'selectAccount'; service: { pluginId: string; localId: string } }
          | { kind: 'installDependency'; dependencyId: string }
          | { kind: 'openUrl'; url: string };
      };
    }
);

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
export type AgentSessionProviderBinding = Readonly<{
  connectionId: string;
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
  }> & (
    | Readonly<{
        kind: 'create';
        startupInstructions?: AgentSessionStartupInstructions;
      }>
    | Readonly<{
        kind: 'resume';
        providerSessionId: string;
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
