import type { AgentId, BundledAgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts, readBundledAgentFact } from './definitions/generatedFacts.js';

export type AgentCliSupportKind = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';
export type AgentCliLaunchKind = 'primary' | 'device_code';

export type AgentCliLaunchCommand = Readonly<{
  command: string;
  args: ReadonlyArray<string>;
  initialInput?: string | null;
}>;

export type AgentLocalCliConfig = Readonly<{
  agentId: BundledAgentId;
  detectKey: string;
  machineLoginKey: string;
  supportKind: AgentCliSupportKind;
  loginLaunch: AgentCliLaunchCommand | null;
  /** Ordered native login actions; `loginLaunch` remains the primary compatibility projection. */
  authLaunches?: ReadonlyArray<AgentCliLaunchCommand & Readonly<{ kind: 'primary' | 'device_code' }>>;
}>;

const AUTHORED_AGENT_LOCAL_CLI_CONFIG = Object.freeze({
} satisfies Partial<Record<CanonicalAgentId, AgentLocalCliConfig>>);

export const CANONICAL_AGENT_LOCAL_CLI_CONFIG: Readonly<Record<CanonicalAgentId, AgentLocalCliConfig>> =
  mergeAuthoredWithGeneratedAgentFacts({
    authored: AUTHORED_AGENT_LOCAL_CLI_CONFIG,
    label: 'local CLI config',
    readGenerated: (definition, agentId) => {
      const launches = definition.cli.auth.loginLaunches.map((launch) => ({
        ...launch,
        command: definition.cli.executable.binaryName,
      }));
      return {
        agentId,
        detectKey: definition.cli.executable.binaryName,
        machineLoginKey: definition.cli.auth.machineLoginKey ?? definition.cli.executable.binaryName,
        supportKind: definition.cli.auth.support,
        loginLaunch: launches.find((launch) => launch.kind === 'primary') ?? null,
        authLaunches: launches,
      };
    },
  });

export const AGENT_LOCAL_CLI_CONFIG: Readonly<Record<CanonicalAgentId, AgentLocalCliConfig>> = CANONICAL_AGENT_LOCAL_CLI_CONFIG;

export function getAgentLocalCliConfig(agentId: BundledAgentId): AgentLocalCliConfig;
export function getAgentLocalCliConfig(agentId: AgentId): AgentLocalCliConfig | null;
export function getAgentLocalCliConfig(agentId: AgentId): AgentLocalCliConfig | null {
  return readBundledAgentFact(AGENT_LOCAL_CLI_CONFIG, agentId);
}
