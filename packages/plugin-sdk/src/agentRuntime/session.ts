import type {
  AgentSessionCapabilitySupportLevel,
  AttachSessionMetadataV1,
  RuntimeCapabilities,
  TerminalHostHandle,
} from '@happier-dev/agents';
import type { $brand } from 'zod/mini';
import type { AgentTerminalLaunchPlan, AgentTerminalLaunchRequest } from './surfaces.js';

import type { JsonValue } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { AgentSessionConversationRollbackControl, AgentSessionGoalControl, AgentSessionUsageLimitRecoveryControl } from './controls.js';

/** Agent-owned runtime identity carried across host-owned session lifecycle. */
export type RuntimeDescriptorV1 = Readonly<{
  v: 1;
  agentId: string;
  agent: Readonly<Record<string, unknown>>;
} & Record<string, unknown>>;

export type AgentSessionConnectedAccountSelection = Readonly<{
  purpose: string;
  /** Credential-free service classification from successful admitted materialization. */
  usageAccountScope?: 'personal' | 'workspace' | 'unknown';
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
  /** Host-filtered real tool catalog; an empty list exposes no tools. */
  enabledTools?: readonly string[];
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
}> & (
  | Readonly<{ connectionId: string; source?: never }>
  | Readonly<{
      connectionId?: never;
      source: Readonly<{
        kind: 'team_resource';
        resourceId: string;
        resourceRevision: number;
      }>;
    }>
);

export type AgentSessionProviderCheckpoint = JsonValue;

export type AgentSessionRuntimeCapabilitySupportLevel = AgentSessionCapabilitySupportLevel;

/**
 * Live, Agent-authored capability facts for the concrete runtime opened for a
 * Session. The host publishes these facts through its canonical runtime
 * capability channel so later lifecycle decisions do not infer them from an
 * Agent id.
 */
export type AgentSessionRuntimeCapabilities = RuntimeCapabilities;

/**
 * Public declaration projection of the Protocol-owned runtime event union.
 * The Protocol schema remains the sole validation and semantic owner; this
 * structural SDK declaration keeps external author closures independent from
 * the host-private Protocol package.
 */
export type AgentSessionRuntimeEvent =
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'input-accepted';
      inputIds: [string, ...string[]];
      delivery:
        | Readonly<{ kind: 'newTurn'; turnId: string }>
        | Readonly<{ kind: 'followUp'; turnId: string }>
        | Readonly<{ kind: 'steer'; turnId: string }>;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'input-rejected';
      inputIds: [string, ...string[]];
      diagnostic: PluginDiagnosticData;
      retryable: boolean;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'input-custody-unknown';
      inputIds: [string, ...string[]];
      issue: PluginDiagnosticData;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'input-delivery-failed';
      inputIds: [string, ...string[]];
      delivery:
        | Readonly<{ kind: 'newTurn'; turnId: string }>
        | Readonly<{ kind: 'followUp'; turnId: string }>;
      issue: PluginDiagnosticData;
      duplicateRisk: 'possible' | 'likely' | 'unknown';
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'provider-session-id';
      providerSessionId: string;
      nativeSessionLogPath?: string;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'available-commands';
      commands: Array<Readonly<{
        name: string;
        description?: string;
      }>>;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'turn-start';
      startedBy: 'host' | 'provider';
      causedByTurnId?: string;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'turn-progress';
    }>
  | (Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
    }> & Readonly<{
      kind: 'turn-agent-id-observed';
      agentTurnId: string;
    }>)
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'turn-complete';
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'turn-failed';
      diagnostic: PluginDiagnosticData;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'turn-cancelled';
      cause:
        | 'user'
        | 'hostShutdown'
        | 'sessionDispose'
        | 'runtimeRecovery'
        | 'providerCancelled'
        | 'providerInterrupted'
        | 'unknown';
      diagnostic?: PluginDiagnosticData;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'runtime-ended';
      cause: 'providerEnded' | 'connectionLost' | 'processExited' | 'protocolError' | 'unknown';
      retryable: boolean;
      diagnostic?: PluginDiagnosticData;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'mcp-tool-usage';
      /** Native final-result queue count; null/absent means unobserved. */
      queuedTurnCount?: number | null;
      window: Readonly<{ startMs: number; endMs: number }>;
      coverage: 'complete' | 'partial';
      servers: Array<Readonly<{
        serverName: string;
        toolCallCount: number;
        schemaBytes: number | null;
      }>>;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'skill-usage';
      skills: Array<Readonly<{ name: string; path?: string }>>;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      /**
       * The host-admitted turn proven to own this output. Omit for Session-scoped,
       * historical, replayed or late output; never infer it from the current turn.
       * Without this identity, the output cannot become foreground Run output.
       */
      turnId?: string;
      agentTurnId?: string;
      kind: 'message-delta';
      /** Stable transcript identity, shared with the committed message when the Agent supplies it. */
      messageId?: string;
      channel: 'assistant' | 'reasoning';
      text: string;
      /** Sidechain output is Session scoped, even when an originating host turn is known. */
      sidechainId?: string;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      /** Omit for Session output that does not belong to a foreground host turn. */
      turnId?: string;
      agentTurnId?: string;
      kind: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: JsonValue;
      sidechainId?: string;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      /** Omit for Session output that does not belong to a foreground host turn. */
      turnId?: string;
      agentTurnId?: string;
      kind: 'tool-progress';
      toolCallId: string;
      progress: JsonValue;
      sidechainId?: string;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      /** Omit for Session output that does not belong to a foreground host turn. */
      turnId?: string;
      agentTurnId?: string;
      kind: 'tool-result';
      toolCallId: string;
      output: JsonValue;
      isError?: boolean;
      sidechainId?: string;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'transcript-message-committed';
      messageId: string;
      role: 'user' | 'assistant' | 'reasoning';
      text: string;
      /**
       * The host-admitted turn proven to own this output. Omit for Session-scoped,
       * historical, replayed or late output; never infer it from the current turn.
       * Without this identity, the output cannot become a foreground Run snapshot.
       */
      turnId?: string;
      /** Sidechain output is Session scoped, even when an originating host turn is known. */
      sidechainId?: string;
      /**
       * Session-scoped assistant-channel text another agent delivered into this conversation
       * (a teammate message or a subagent hand-back). It is never the Agent's own reply.
       */
      peer?: Readonly<{ name: string | null; handback: boolean }>;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      /** Omit for Session output that does not belong to a foreground host turn. */
      turnId?: string;
      agentTurnId?: string;
      kind: 'file-edit';
      editId: string;
      path: string;
      description?: string;
      diff?: string;
      oldContent?: string;
      newContent?: string;
      sidechainId?: string;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'usage-observed';
      observationId: string;
      /** Native request evidence; the host validates it against the accepted source and matching turn. */
      attribution?: Readonly<{
        v: 1; turnId: string;
        source: Readonly<{
          kind: 'native';
          connectedAccount: Readonly<{ service: Readonly<{ pluginId: string; localId: string }>; accountId: string }> | null;
          /** Prospective native request fact; absent or invalidated evidence remains unknown. */
          accountScope?: 'personal' | 'workspace';
        }>
          | Readonly<{ kind: 'provider'; providerId: string | null; providerConnectionId: string & $brand<'ProviderConnectionId'> }>;
      }>;
      /** Witnessed accounting identity and counter semantics, never an inferred host turn identity. */
      accounting?: Readonly<{
        nativeSessionId?: string;
        inferenceId?: string;
        inputIncludesCache?: boolean;
        outputIncludesReasoning?: boolean;
        historyComplete?: boolean;
      }>;
      turnId?: string;
      source: string;
      scope: 'turn_delta' | 'session_cumulative' | 'session_final';
      modelId?: string;
      tokens?: Readonly<{
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      }>;
      cost?: Readonly<{
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
      context?: Readonly<{
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
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      turnId: string;
      agentTurnId?: string;
      kind: 'turn-rollback-boundary';
      agentRollbackOrdinal?: number;
      providerCheckpoint?: AgentSessionProviderCheckpoint;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'runtime-activity-snapshot';
      state: 'active' | 'idle' | 'unknown';
      activeCount: number;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'idle' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'started';
      tokenCountBefore?: number;
      tokenCountSource?: 'providerReported' | 'providerEstimated' | 'derivedEstimate';
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'idle' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'progress';
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'idle' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'completed';
      tokenCountBefore?: number;
      tokenCountAfter?: number;
      tokenCountSource?: 'providerReported' | 'providerEstimated' | 'derivedEstimate';
      continuation?: 'paused';
      pauseReason?: 'agentIdleAfterCompaction';
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'idle' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'failed';
      diagnostic: PluginDiagnosticData;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'idle' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'cancelled';
      diagnostic?: PluginDiagnosticData;
    }>
  | Readonly<{
      sequence: number;
      sessionId: string;
      emittedAtMs: number;
      kind: 'context-compaction';
      compactionId: string;
      turnId?: string;
      trigger: 'manual' | 'idle' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      retryAttempt?: number;
      phase: 'outcomeUnknown';
      diagnostic: PluginDiagnosticData;
    }>;

export type AgentSessionRuntimeAuthApplyRequest = Readonly<{
  serviceId: string;
  reason?:
    | 'usage_limit'
    | 'same_provider_account_exhausted'
    | 'soft_threshold'
    | 'manual'
    | 'diagnostic';
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
export type AgentPermissionIntent = 'default' | 'read-only' | 'safe-yolo' | 'yolo' | 'plan';

export type AgentSessionConfigurationSnapshot = Readonly<{
  allowedTools?: readonly string[];
  unlistedTools?: 'ask' | 'deny';
  mode: TimestampedAgentValue<string | null>;
  model: TimestampedAgentValue<string | null>;
  permissionIntent: TimestampedAgentValue<AgentPermissionIntent | null>;
  /** Host-resolved role restriction. An Agent that cannot enforce deny must refuse before effects. */
  workspaceWrites?: 'allow' | 'deny';
  options: Readonly<Record<string, TimestampedAgentValue<AgentConfigurationScalar>>>;
}>;

export type AgentSessionStartupInstructions = Readonly<{
  // Unsupported installed native transports reject before effects with PluginError
  // code 'agent_session_startup_instructions_unsupported'; the host owns prefix fallback.
  v: 1;
  id: string;
  revision: number;
  instructions: string;
}>;

export type AgentSessionSkillDelivery = Readonly<{
  /** Host-owned, read-only to the Agent; the host deletes this root at runner exit.
   * .claude-plugin/plugin.json declares name "happier"; skills/<source folder>/SKILL.md includes supporting files. */
  pluginRoot: string;
  /** The skills directory inside pluginRoot. */
  skillsRoot: string;
  /** directory is the materializer-admitted absolute skill folder; never derive it from name. */
  items: readonly Readonly<{ name: string; skillId: string; digest: string; directory: string }>[];
  /** Native SKILL.md paths, supplied only when nativeDisable is supported. */
  nativeDisables: readonly Readonly<{ name: string; path: string }>[];
}>;

export type AgentSessionMcpToolPolicy = Readonly<{
  unlisted: 'allow' | 'ask' | 'deny';
  tools: Readonly<Record<string, 'off' | 'allow' | 'ask' | 'deny'>>;
}>;

export type AgentSessionOpenRequest =
  Readonly<{
    sessionId: string;
    cwd: string;
    /** Informational host directory classification; absence means path, not filesystem authority. */
    sessionDirectoryKind?: 'path' | 'managed';
    launchEnvironment?: AgentLaunchEnvironment;
    /** Agent-owned runtime identity, interpreted only by the target Agent. */
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    configuration?: AgentSessionConfigurationSnapshot;
    connectedAccounts?: readonly AgentSessionConnectedAccountSelection[];
    mcpServers?: Readonly<Record<string, AgentSessionMcpLaunchConfig>>;
    /** Host-resolved startup failure policy; optional servers may be skipped. */
    mcpServersStrictMode?: boolean;
    mcpToolPolicy?: Readonly<Record<string, AgentSessionMcpToolPolicy>>;
    skills?: AgentSessionSkillDelivery;
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
  mcpToolPolicy?: Readonly<Record<string, AgentSessionMcpToolPolicy>>;
}>;

export type AgentSessionConfigurationResult =
  | Readonly<{ status: 'applied' | 'deferred'; changed: readonly string[] }>
  | Readonly<{
      status: 'rejected' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
    }>;

export type AgentSessionCompactRequest = {
  compactionId: string;
  trigger: 'manual' | 'idle';
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
  /**
   * Bounded Agent-owned runtime identity resolved while this Session opened.
   * The host publishes it through its canonical Session identity owner before
   * exposing the runtime to consumers.
   */
  readonly runtimeDescriptorV1?: RuntimeDescriptorV1;
  readonly runtimeCapabilities?: AgentSessionRuntimeCapabilities;
  /** Per-open active goal support; false suppresses manifest-declared live goal controls. */
  readonly nativeGoalControlsSupported?: boolean;
  /** Declared live Goals use this opened runtime's native connection before factory controls. */
  readonly goals?: AgentSessionGoalControl;
  /** Declared live usage recovery uses this opened runtime's native connection before factory controls. */
  readonly usageLimitRecovery?: AgentSessionUsageLimitRecoveryControl;
  /** False when this opened launch path cannot honor the requested skills. */
  readonly skillsDelivered?: boolean;
  /** Invoked by the host only for declared liveReload support. */
  refreshSkills?(
    request: Readonly<{ skills: AgentSessionSkillDelivery }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ kind: 'applied' }> | Readonly<{ kind: 'restart_required'; reason: 'launch_path_unsupported' }>>;
  readonly conversationRollback?: AgentSessionConversationRollbackControl;
  readonly runtimeAuth?: AgentSessionRuntimeAuthControl;
  /**
   * Prepares presentation of this opened Session, preserving its selected
   * runtime and native identity. A managed terminal is already owned by this
   * runtime; the host must not launch it again or enter an exclusive switch
   * loop. Provider attach metadata is transient, not an identity publication.
   * Developer Preview source-cut: hosts must fail operation-scoped unsupported
   * when absent, rather than launching a bare terminal for a selected Session.
   */
  prepareTerminalPresentation?(
    request?: Readonly<Pick<AgentTerminalLaunchRequest, 'configuration' | 'modelSelection'>>,
  ): Promise<
    | Readonly<{ kind: 'provider_attach'; metadata: AttachSessionMetadataV1 }>
    | Readonly<{ kind: 'terminal_launch'; plan: AgentTerminalLaunchPlan }>
    | Readonly<{ kind: 'managed_terminal'; handle: TerminalHostHandle }>
  >;
  /** Observes this prepared terminal's actual host-owned execution; grants no process control. */
  observeTerminalExecution?(input:
    | Readonly<{ kind: 'started' | 'observation_lost' | 'launch_failed'; plan: AgentTerminalLaunchPlan }>
    | Readonly<{ kind: 'provider_stopped'; plan: AgentTerminalLaunchPlan; exitCode: number | null; signal: string | null }>
  ): void | Promise<void>;
  /**
   * Receives ordered native source evidence after preceding output has durable
   * custody. Initial replay establishes provider correlation only; it must not
   * admit historical rows as fresh work. Omitted phase retains live semantics.
   */
  observeSourceTranscript?(input: Readonly<{
    providerSessionId: string;
    sourceId: string;
    row: JsonValue;
    phase?: 'initial_replay';
  }>): Promise<void>;
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
