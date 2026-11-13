import type { DaemonProviderModelProjectionRowV1 } from '@happier-dev/protocol/rpc/providers';
import type { AgentAcpProviderTurnSourceFactory } from './acpProviderTurns.js';
import type { PluginAgentAcpTransport, PluginAgentAcpSkillsSessionDeliveryV2 } from '@happier-dev/protocol';

import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type {
  AgentAcpMcpInputPolicy,
  AgentAcpStderrRules,
  AgentAcpTimeouts,
  AgentAcpToolNameInference,
  AgentAcpToolNameResolver,
} from './acpTypes.js';
import type {
  AgentPermissionIntent,
  AgentConfigurationScalar,
  AgentSessionInput,
  AgentSessionOpenRequest,
  AgentSessionProviderCheckpoint,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from './session.js';
import type { AgentSessionConversationRollbackControl } from './controls.js';
import type {
  AgentExecutionRunConversationRuntimeV1,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
} from './executionRun.js';

export type AgentAcpHistorySession = Readonly<{
  getProviderSessionId(): string | null;
  requestExtension(
    methods: readonly [string, ...string[]],
    params: JsonValue,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<JsonValue>;
}>;

export type AgentAcpCompletionEvidenceOutcome =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'failed'; message?: string; diagnostic?: PluginDiagnosticData }>;

export type AgentAcpExtensionContext = Readonly<{
  method: string;
  requestId?: string;
  signal: AbortSignal;
  providerSessionId?: string;
  currentTurn?: Readonly<{
    turnId: string;
    submitCompletionEvidence(evidence: Readonly<{
      providerSessionId: string;
      promptId: string;
      outcome: AgentAcpCompletionEvidenceOutcome;
    }>): boolean;
  }>;
}>;

export type AgentAcpRequestExtension = (
  params: JsonValue,
  context: AgentAcpExtensionContext,
) => JsonValue | Promise<JsonValue>;

export type AgentAcpNotificationExtension = (
  params: JsonValue,
  context: AgentAcpExtensionContext,
) => void | Promise<void>;

export type AgentAcpRuntimeExtensions = Readonly<{
  requests?: Readonly<Record<string, AgentAcpRequestExtension>>;
  notifications?: Readonly<Record<string, AgentAcpNotificationExtension>>;
}>;

export type AgentAcpRuntimeOptions = Readonly<{
  transport: PluginAgentAcpTransport;
  /** Files required by this native launch; checked by the exec materialization owner. */
  requiredFiles?: readonly string[];
  definition?: AgentAcpRuntimeDefinition;
  extensions?: AgentAcpRuntimeExtensions;
  providerTurnSource?: AgentAcpProviderTurnSourceFactory;
  initialSessionModeId?: string;
  disableSessionModeUpdates?: boolean;
}>;

export type AgentAcpAuthenticationContext = Readonly<{
  advertisedMethodIds: readonly string[];
  initializeMetadata: Readonly<Record<string, JsonValue>> | null;
}>;

export type AgentAcpAuthenticationSelection = Readonly<{
  methodId: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}>;

export type AgentAcpAuthenticationDefinition = Readonly<{
  /** Exact provider declaration; the host exposes only the fixed setup-failure boolean. */
  setupFailure?: Readonly<{ requestErrorCode: number; dataReason: string }>;
}> & (
  | Readonly<{ methodId: string }>
  | Readonly<{
      selectMethod(
        context: AgentAcpAuthenticationContext,
      ): AgentAcpAuthenticationSelection | null | Promise<AgentAcpAuthenticationSelection | null>;
    }>
);

export type AgentAcpToolUpdateContentSanitizer = <T extends { content?: unknown }>(update: T) => T;

export type AgentAcpToolUpdatePolicy = Readonly<{
  /** Minimum interval between admitted `in_progress` updates for one provider tool-call id. */
  minInProgressIntervalMs?: number;
  /** Maximum retained characters per provider-authored string, preserving the newest tail. */
  maxStringChars?: number;
}>;

/**
 * Deliberately has no `overridesWhenOn`, unlike the runtime mirror `AgentSessionModelOption` in
 * `./context.ts`. The asymmetry is honest, not an oversight: nothing in the ACP corridor beneath
 * this type models the rule — the host's own `SessionConfigOption`
 * (`apps/cli/src/agent/acp/sessionSettings/sessionSettingsState.ts`) hand-enumerates its fields and
 * does not carry it — so declaring it here would advertise an SDK field that is dropped before
 * publication. No ACP producer emits the rule today; align the two only alongside the corridor that
 * would actually carry it.
 */
export type AgentAcpModelOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options?: readonly Readonly<{ value: string; name: string; description?: string }>[];
  groups?: readonly Readonly<{ id: string; name: string; options: readonly Readonly<{ value: string; name: string; description?: string }>[] }>[];
}>;

export type AgentAcpModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  modelOptions?: readonly AgentAcpModelOption[];
}>;

export type AgentAcpModelState = Readonly<{
  currentModelId: string;
  availableModels: readonly AgentAcpModel[];
}>;

export type AgentAcpModelControls = Readonly<{
  /** Native catalog provenance; this does not alter private active-model controls. */
  catalogConfidence?: DaemonProviderModelProjectionRowV1['confidence'];
  projectModel(rawModel: JsonValue, normalizedModel: AgentAcpModel): AgentAcpModel;
  projectModelState?(input: Readonly<{
    normalizedModelState: AgentAcpModelState;
  }>): AgentAcpModelState;
  projectModelId?(input: Readonly<{
    modelId: string;
    modelState: AgentAcpModelState | null;
  }>): string;
  resolveModelUpdate?(input: Readonly<{
    modelId: string;
    modelState: AgentAcpModelState | null;
  }>):
    | Readonly<{
        modelId: string;
        requestMeta?: Readonly<Record<string, JsonValue>>;
      }>
    | null
    | undefined;
  projectUpdate?(input: Readonly<{
    configId: string;
    value: AgentConfigurationScalar;
    currentModel: AgentAcpModel;
  }>):
    | Readonly<{
        modelId: string;
        requestMeta?: Readonly<Record<string, JsonValue>>;
      }>
    | null
    | undefined;
  projectSetModelResponse?(input: Readonly<{
    response: JsonValue;
    requestedModelId: string;
    requestMeta: Readonly<Record<string, JsonValue>> | null;
    targetModel: AgentAcpModel;
  }>): AgentAcpModel | null;
}>;

export type AgentAcpInFlightSteerDefinition = Readonly<{
  method: string;
  /** Optional native capability negotiation; false refuses delivery before a transport write. */
  isSupported?(agentCapabilities: JsonValue): boolean;
  /** Return null when the native steer cannot represent this input; the host retains custody. */
  buildParams(input: Readonly<{
    providerSessionId: string;
    inputIds: readonly [string, ...string[]];
    input: AgentSessionInput;
    /** ACP text/image blocks projected and verified by the host before dispatch. */
    content: readonly JsonValue[];
  }>): JsonValue;
  isAccepted(response: JsonValue): boolean;
  /** A definite native refusal, safe for the host's existing retry/resend contract. */
  isRejected?(response: JsonValue): boolean;
}>;

export type AgentAcpPromptUsageDefinition = Readonly<{
  projectPromptUsage(input: Readonly<{
    usage: JsonValue;
    promptResponse: JsonValue;
  }>): JsonValue | null;
}>;

/** Provider-declared quota diagnostic carried as ordinary ACP assistant output. */
export type AgentAcpUsageLimitDiagnosticDefinition = Readonly<{
  pattern: string;
  connectedAccountService: PluginContributionRef;
}>;

export type AgentAcpRuntimeDefinition = Readonly<{
  /** Native child requests use the root session; the provider settles the requesting tool. */
  permissions?: Readonly<{ scope: 'session' }>;
  auth?: AgentAcpAuthenticationDefinition;
  parameterizedModelPicker?: boolean;
  modelConfigOptionId?: string;
  /** Forward explicit unlisted choices for native acceptance/refusal; inherited choices still use the advertised catalog. */
  allowExplicitUnlistedModels?: boolean;
  /** Ordered candidates require an advertised Session mode; no match refuses configuration. */
  permissionModeMapping?: Readonly<Partial<Record<
    AgentPermissionIntent,
    string | readonly string[] | null
  >>>;
  permissionModeArgv?: Readonly<{
    flag: string;
    map: Readonly<Partial<Record<AgentPermissionIntent, string | null>>>;
  }>;
  models?: AgentAcpModelControls;
  acceptsVerifiedImageInput?: true;
  timeouts?: AgentAcpTimeouts;
  toolNameInference?: AgentAcpToolNameInference;
  stderrRules?: AgentAcpStderrRules;
  /** Exact provider-declared quota diagnostics carried as ordinary ACP assistant output. */
  usageLimitDiagnostic?: AgentAcpUsageLimitDiagnosticDefinition;
  toolNameResolver?: AgentAcpToolNameResolver;
  sanitizeToolUpdateContent?: AgentAcpToolUpdateContentSanitizer;
  toolUpdates?: AgentAcpToolUpdatePolicy;
  /** Native metadata codec only; the host retains tool accumulation and lifecycle ownership. */
  sessionUpdates?: Readonly<{
    /** Interpret an exact native diagnostic emitted as assistant text, once at terminal completion. */
    projectOutputDiagnostic?(text: string): PluginDiagnosticData | null;
    /** Translate an Agent extension to ACP v1; null leaves an unknown reason unclassified. */
    projectStopReason?(stopReason: string): 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | null;
    project(update: JsonValue): Readonly<{
      toolMetadata?: Readonly<{
        internal?: boolean;
        mcp?: Readonly<{ server: string; tool: string }>;
      }>;
      diagnostic?: PluginDiagnosticData;
      /** Correlated response retry evidence; null denotes observed recovery or an explicit clear. */
      retry?: Extract<AgentSessionRuntimeEvent, { kind: 'turn-progress' }>['retry'] | null;
    }> | null;
  }>;
  generatedMedia?: Readonly<{
    projectTerminalOutput(input: Readonly<{
      rawOutput: unknown;
      toolCallId: string;
      toolName: string;
    }>): readonly Readonly<{ rootPath: string; path: string }>[] | null;
  }>;
  delivery?: Readonly<{
    steer?: AgentAcpInFlightSteerDefinition;
  }>;
  usage?: AgentAcpPromptUsageDefinition;
  history?: Readonly<{
    projectUserMessageProviderCheckpoint(input: JsonValue): AgentSessionProviderCheckpoint | null;
    fork?: Readonly<{
      methods: readonly [string, ...string[]];
      buildParams(input: Readonly<{
        sourceProviderSessionId: string;
        sourceCwd: string;
        newCwd: string;
        providerCheckpoint?: AgentSessionProviderCheckpoint;
      }>): JsonValue;
      readProviderSessionId(response: JsonValue): string | null;
    }>;
    createConversationRollback?(
      session: AgentAcpHistorySession,
    ): AgentSessionConversationRollbackControl;
  }>;
  mcp: AgentAcpMcpInputPolicy;
  skills?: Readonly<{ sessionDelivery: PluginAgentAcpSkillsSessionDeliveryV2 }>;
}>;

export interface AgentAcpRuntimeComposer {
  open(
    request: AgentSessionOpenRequest,
    options: AgentAcpRuntimeOptions,
  ): Promise<AgentSessionRuntime>;
  /** Versioned ACP composition for a truthful detached Execution Run. */
  openExecutionRunV1(
    request: AgentExecutionRunOpenRequest,
    options: AgentAcpRuntimeOptions,
  ): Promise<AgentExecutionRunRuntime>;
  /** Optional retained detached conversation; the host submits all inputs after watch. */
  openExecutionRunConversationV1?(
    request: AgentExecutionRunOpenRequest,
    options: AgentAcpRuntimeOptions,
  ): Promise<AgentExecutionRunConversationRuntimeV1>;
}

export interface AgentRuntimeProtocolComposers {
  readonly acp: AgentAcpRuntimeComposer;
}
