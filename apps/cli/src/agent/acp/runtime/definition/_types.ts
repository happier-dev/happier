import type {
  SessionPermissionFollowUpPromptIntentV1,
  SessionPermissionPersistAllowRuleV1,
} from '@happier-dev/agents';
export type HostAcpMcpInputPolicy = Readonly<{
  policy: 'pass_through' | 'drop';
}>;

export type HostAcpTimeouts = Partial<Readonly<{
  initMs: number;
  initDelayMs: number;
  idleMs: number;
  toolCallMs: number | null;
  investigationToolCallMs: number | null;
  toolKindTimeouts: Readonly<Record<string, number | null>>;
  promptLivenessMs: number | null;
  postPromptNoUpdatesMs: number | null;
  postToolCallIdleMs: number;
  idleWithoutAssistantMessageMs: number;
  preToolCallIdleMs: number;
}>>;

export type HostAcpTransportLifecycle = Readonly<{
  initDelayMs?: number;
}>;

export type HostAcpTransportSpec =
  | Readonly<{
      kind: 'stdio';
      launch:
        | Readonly<{
            kind: 'agent-cli';
            agentId: string;
            args?: readonly string[];
            env?: Readonly<Record<string, string>>;
          }>
        | Readonly<{
            kind: 'executable';
            command: string;
            args?: readonly string[];
            env?: Readonly<Record<string, string>>;
          }>
        | Readonly<{
            kind: 'system-tool';
            toolId: string;
            purpose: string;
            preferredPath?: string | null;
            preferredCommand?: string | null;
            args?: readonly string[];
            env?: Readonly<Record<string, string>>;
          }>;
      timeouts?: HostAcpTimeouts;
    }>
  | Readonly<{
      kind: 'ws';
      url: string | ((context: Readonly<{ sessionId: string }>) => string | Promise<string>);
      headers?: Readonly<Record<string, string>>;
      timeouts?: HostAcpTimeouts;
    }>
  | Readonly<{
      kind: 'tcp';
      host: string;
      port: number;
      timeouts?: HostAcpTimeouts;
    }>;

export type HostAcpCapabilityFlags = Readonly<{
  supportsResume?: boolean;
  supportsStreaming?: boolean;
  supportsToolUse?: boolean;
  supportsPermissionRequests?: boolean;
  supportsInFlightSteer?: boolean;
  supportsModelSwitch?: boolean;
  customMessageKinds?: readonly string[];
  supportsModes?: boolean | 'yes' | 'no' | 'unknown';
  supportsModels?: boolean | 'yes' | 'no' | 'unknown';
  supportsConfigOptions?: boolean | 'yes' | 'no' | 'unknown';
  supportsPromptImages?: boolean | 'unknown';
  promptImageSupport?: 'yes' | 'no' | 'unknown';
}>;

export type HostAcpAuthSpec = Readonly<{
  methodId?: string;
}>;

export type HostAcpPermissionModeArgvSpec = Readonly<{
  flag: string;
  map: Readonly<Record<string, string | null>>;
}>;

export type HostAcpToolNamePattern = Readonly<{
  name: string;
  patterns: readonly string[];
  inputFields?: readonly string[];
  emptyInputDefault?: boolean;
}>;

export type HostAcpToolNameInference = Readonly<{
  patterns?: readonly HostAcpToolNamePattern[];
  preferLongestPattern?: boolean;
  unknownToolNames?: readonly string[];
  hintInputFields?: readonly string[];
  shellBridgeHint?: boolean;
  investigationToolIdPatterns?: readonly string[];
  investigationToolKinds?: readonly string[];
}>;

export type HostAcpStderrMatchRule = Readonly<{
  includes: readonly string[];
  caseSensitive?: boolean;
}>;

export type HostAcpStderrRules = Readonly<{
  suppress?: readonly HostAcpStderrMatchRule[];
  statusErrors?: readonly (HostAcpStderrMatchRule & Readonly<{ detail: string }>)[];
}>;

export type HostAcpMessageMetaHooks = Readonly<{
  enrichOutgoing?: (message: unknown, context: unknown) =>
    Readonly<Record<string, unknown>> | null | undefined | void;
  enrichIncoming?: (message: unknown, context: unknown) =>
    Readonly<Record<string, unknown>> | null | undefined | void;
}>;

export type HostAcpPermissionOptionSelection = Readonly<{
  approved?: 'allow_once' | 'allow_always';
}>;

export type HostAcpToolNameResolver = (
  request: Readonly<{
    toolName: string;
    toolCallId: string;
    input: Readonly<Record<string, unknown>>;
    context: Readonly<{ toolCallCountSincePrompt: number }>;
  }>,
) => string | null | undefined;

export type HostAcpTier2PermissionDecisionResult = Readonly<{
  kind: 'allow' | 'deny' | 'defer';
  rationale?: string;
  followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
  persistAllowRule?: SessionPermissionPersistAllowRuleV1;
}>;

type HostAcpTier2ArgvBuilder = (params: Readonly<{
  baseArgs: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: string;
}>) => readonly string[] | Promise<readonly string[]>;

type HostAcpTier2EnvBuilder = (params: Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: string;
}>) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

type HostAcpTier2Preflight = (params: Readonly<{ cwd: string }>) => void | Promise<void>;

type HostAcpTier2PermissionDecision = (
  request: Readonly<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>,
) => HostAcpTier2PermissionDecisionResult | Promise<HostAcpTier2PermissionDecisionResult>;

export type HostAcpBackendSpec = Readonly<{
  backendId: string;
  transport: HostAcpTransportSpec;
  ux?: Readonly<{
    name?: string;
    title?: string;
    description?: string;
    defaultMode?: string;
    defaultModel?: string;
  }>;
  launchEnv?: Readonly<Record<string, string>>;
  capabilities?: HostAcpCapabilityFlags;
  auth?: HostAcpAuthSpec;
  fsEnabled?: boolean;
  transportLifecycle?: HostAcpTransportLifecycle;
  permissionModeArgv?: HostAcpPermissionModeArgvSpec;
  sessionIdHeaderName?: string;
  toolNameInference?: HostAcpToolNameInference;
  stderrRules?: HostAcpStderrRules;
  permissionOptionSelection?: HostAcpPermissionOptionSelection;
  messageMeta?: HostAcpMessageMetaHooks;
  mcp?: HostAcpMcpInputPolicy;
  callbacks?: Readonly<{
    argvBuilder?: HostAcpTier2ArgvBuilder;
    envBuilder?: HostAcpTier2EnvBuilder;
    preflight?: HostAcpTier2Preflight;
    permissionDecision?: HostAcpTier2PermissionDecision;
    toolNameResolver?: HostAcpToolNameResolver;
  }>;
}>;

export type AcpRuntimeDefinitionSource =
  | Readonly<{
      kind: 'built_in';
      pluginId?: never;
      legacyCarrier?: never;
    }>
  | Readonly<{
      kind: 'account_configured';
      pluginId?: never;
      legacyCarrier?: 'customAcp';
    }>
  | Readonly<{
      kind: 'plugin_contributed';
      pluginId?: string;
      legacyCarrier?: never;
    }>;

export type AcpRuntimeDefinition = Readonly<{
  backendId: string;
  source: AcpRuntimeDefinitionSource;
  identity: Readonly<{
    agentId?: string;
    backendId: string;
  }>;
  engine: Readonly<{
    kind: 'acp';
  }>;
  ux: Readonly<{
    name?: string;
    title: string;
    description?: string;
    defaultMode?: string;
    defaultModel?: string;
  }>;
  transport: HostAcpTransportSpec;
  launchEnv: Readonly<Record<string, string>>;
  capabilities: HostAcpCapabilityFlags;
  timeouts?: HostAcpTimeouts;
  auth?: HostAcpAuthSpec;
  fsEnabled?: boolean;
  transportLifecycle?: HostAcpTransportLifecycle;
  permissionModeArgv?: HostAcpPermissionModeArgvSpec;
  sessionIdHeaderName?: string;
  toolNameInference?: HostAcpToolNameInference;
  modelConfigOptionId?: string;
  stderrRules?: HostAcpStderrRules;
  permissionOptionSelection?: HostAcpPermissionOptionSelection;
  messageMeta?: HostAcpMessageMetaHooks;
  mcp: HostAcpMcpInputPolicy;
  callbacks: Readonly<{
    argvBuilder?: HostAcpTier2ArgvBuilder;
    envBuilder?: HostAcpTier2EnvBuilder;
    preflight?: HostAcpTier2Preflight;
    permissionDecision?: HostAcpTier2PermissionDecision;
    toolNameResolver?: HostAcpToolNameResolver;
  }>;
}>;

export type AcpRuntimeDefinitionInit = Readonly<{
  backendId: string;
  source: AcpRuntimeDefinitionSource;
  identity?: Readonly<{
    agentId?: string;
    backendId?: string;
  }>;
  ux: AcpRuntimeDefinition['ux'];
  transport: HostAcpTransportSpec;
  launchEnv?: Readonly<Record<string, string>>;
  capabilities?: HostAcpCapabilityFlags;
  timeouts?: HostAcpTimeouts;
  auth?: HostAcpAuthSpec;
  fsEnabled?: boolean;
  transportLifecycle?: HostAcpTransportLifecycle;
  permissionModeArgv?: HostAcpPermissionModeArgvSpec;
  sessionIdHeaderName?: string;
  toolNameInference?: HostAcpToolNameInference;
  modelConfigOptionId?: string;
  stderrRules?: HostAcpStderrRules;
  permissionOptionSelection?: HostAcpPermissionOptionSelection;
  messageMeta?: HostAcpMessageMetaHooks;
  mcp?: HostAcpMcpInputPolicy;
  callbacks?: AcpRuntimeDefinition['callbacks'];
}>;
