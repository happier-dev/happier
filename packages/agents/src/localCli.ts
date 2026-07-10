import type { AgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';

export type AgentCliSupportKind = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';

export type AgentCliLaunchCommand = Readonly<{
  command: string;
  args: ReadonlyArray<string>;
  initialInput?: string | null;
}>;

export type AgentLocalCliConfig = Readonly<{
  agentId: AgentId;
  detectKey: string;
  machineLoginKey: string;
  supportKind: AgentCliSupportKind;
  loginLaunch: AgentCliLaunchCommand | null;
}>;

const AUTHORED_AGENT_LOCAL_CLI_CONFIG = Object.freeze({
} satisfies Partial<Record<CanonicalAgentId, AgentLocalCliConfig>>);

export const CANONICAL_AGENT_LOCAL_CLI_CONFIG: Readonly<Record<CanonicalAgentId, AgentLocalCliConfig>> =
  mergeAuthoredWithGeneratedAgentFacts({
    authored: AUTHORED_AGENT_LOCAL_CLI_CONFIG,
    label: 'local CLI config',
    readGenerated: (definition) => definition.localCli,
  });

export const AGENT_LOCAL_CLI_CONFIG: Readonly<Record<CanonicalAgentId, AgentLocalCliConfig>> = CANONICAL_AGENT_LOCAL_CLI_CONFIG;

export function getAgentLocalCliConfig(agentId: AgentId): AgentLocalCliConfig {
  return AGENT_LOCAL_CLI_CONFIG[agentId];
}
