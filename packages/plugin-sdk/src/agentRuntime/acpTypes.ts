export type AgentAcpMcpInputPolicy = Readonly<{
  policy: 'pass_through' | 'drop';
}>;

export type AgentAcpTimeouts = Partial<Readonly<{
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

export type AgentAcpToolNameResolver = (
  request: Readonly<{
    toolName: string;
    toolCallId: string;
    input: Readonly<Record<string, unknown>>;
    context: Readonly<{
      toolCallCountSincePrompt: number;
    }>;
  }>
) => string | null | undefined;

export type AgentAcpToolNamePattern = Readonly<{
  name: string;
  patterns: readonly string[];
  inputFields?: readonly string[];
  emptyInputDefault?: boolean;
}>;

export type AgentAcpToolNameInference = Readonly<{
  patterns?: readonly AgentAcpToolNamePattern[];
  preferLongestPattern?: boolean;
  unknownToolNames?: readonly string[];
  hintInputFields?: readonly string[];
  shellBridgeHint?: boolean;
  investigationToolIdPatterns?: readonly string[];
  investigationToolKinds?: readonly string[];
}>;

export type AgentAcpStderrMatchRule = Readonly<{
  includes: readonly string[];
  caseSensitive?: boolean;
}>;

export type AgentAcpStderrStatusErrorRule = AgentAcpStderrMatchRule & Readonly<{
  detail: string;
}>;

export type AgentAcpStderrRules = Readonly<{
  suppress?: readonly AgentAcpStderrMatchRule[];
  statusErrors?: readonly AgentAcpStderrStatusErrorRule[];
}>;
