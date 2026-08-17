import type { PluginAgentAcpTransport } from '@happier-dev/protocol';

import type { JsonValue } from '../identity.js';
import type {
  AgentAcpMcpInputPolicy,
  AgentAcpStderrRules,
  AgentAcpTimeouts,
  AgentAcpToolNameInference,
  AgentAcpToolNameResolver,
} from './acpTypes.js';
import type {
  AgentConfigurationScalar,
  AgentSessionOpenRequest,
  AgentSessionProviderCheckpoint,
  AgentSessionRuntime,
} from './session.js';
import type { AgentSessionConversationRollbackControl } from './controls.js';

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
  | Readonly<{ kind: 'failed'; message?: string }>;

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
  definition?: AgentAcpRuntimeDefinition;
  extensions?: AgentAcpRuntimeExtensions;
}>;

export type AgentAcpAuthenticationContext = Readonly<{
  advertisedMethodIds: readonly string[];
  initializeMetadata: Readonly<Record<string, JsonValue>> | null;
}>;

export type AgentAcpAuthenticationSelection = Readonly<{
  methodId: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}>;

export type AgentAcpAuthenticationDefinition =
  | Readonly<{ methodId: string }>
  | Readonly<{
      selectMethod(
        context: AgentAcpAuthenticationContext,
      ): AgentAcpAuthenticationSelection | null | Promise<AgentAcpAuthenticationSelection | null>;
    }>;

export type AgentAcpToolUpdateContentSanitizer = <T extends { content?: unknown }>(update: T) => T;

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
  type: string;
  currentValue: string;
  options?: readonly Readonly<{ value: string; name: string; description?: string }>[];
}>;

export type AgentAcpModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  modelOptions?: readonly AgentAcpModelOption[];
}>;

export type AgentAcpModelControls = Readonly<{
  projectModel(rawModel: JsonValue, normalizedModel: AgentAcpModel): AgentAcpModel;
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

export type AgentAcpRuntimeDefinition = Readonly<{
  auth?: AgentAcpAuthenticationDefinition;
  parameterizedModelPicker?: boolean;
  modelConfigOptionId?: string;
  models?: AgentAcpModelControls;
  acceptsVerifiedImageInput?: true;
  timeouts?: AgentAcpTimeouts;
  toolNameInference?: AgentAcpToolNameInference;
  stderrRules?: AgentAcpStderrRules;
  toolNameResolver?: AgentAcpToolNameResolver;
  sanitizeToolUpdateContent?: AgentAcpToolUpdateContentSanitizer;
  generatedMedia?: Readonly<{
    projectTerminalOutput(input: Readonly<{
      rawOutput: unknown;
      toolCallId: string;
      toolName: string;
    }>): readonly Readonly<{ rootPath: string; path: string }>[] | null;
  }>;
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
}>;

export interface AgentAcpRuntimeComposer {
  open(
    request: AgentSessionOpenRequest,
    options: AgentAcpRuntimeOptions,
  ): Promise<AgentSessionRuntime>;
}

export interface AgentRuntimeProtocolComposers {
  readonly acp: AgentAcpRuntimeComposer;
}
