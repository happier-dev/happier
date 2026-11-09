import type { PluginAgentAcpMcpInputPolicyV2 } from '@happier-dev/protocol';

export type { PluginAgentAcpMcpInputPolicyV2, PluginAgentAcpNativeSessionMcpConfigV2, PluginAgentAcpSkillsSessionDeliveryV2 } from '@happier-dev/protocol';

export type AgentAcpMcpInputPolicy = Readonly<PluginAgentAcpMcpInputPolicyV2>;

export type AgentAcpTimeouts = Partial<Readonly<{
  initMs: number;
  initDelayMs: number;
  idleMs: number;
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
  authenticationErrorDetail?: string;
  suppress?: readonly AgentAcpStderrMatchRule[];
  statusErrors?: readonly AgentAcpStderrStatusErrorRule[];
}>;
