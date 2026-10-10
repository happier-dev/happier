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

export const CANONICAL_AGENT_LOCAL_CLI_CONFIG: Readonly<Record<CanonicalAgentId, AgentLocalCliConfig | null>> =
  mergeAuthoredWithGeneratedAgentFacts({
    authored: AUTHORED_AGENT_LOCAL_CLI_CONFIG,
    label: 'local CLI config',
    readGenerated: (definition, agentId) => {
      const cli = definition.cli;
      if (!cli) return null;
      const launches = cli.auth.loginLaunches.map((launch) => ({
        ...launch,
        command: cli.executable.binaryName,
      }));
      return {
        agentId,
        detectKey: cli.executable.binaryName,
        machineLoginKey: cli.auth.machineLoginKey ?? cli.executable.binaryName,
        supportKind: cli.auth.support,
        loginLaunch: launches.find((launch) => launch.kind === 'primary') ?? null,
        authLaunches: launches,
      };
    },
    resolveMissing: () => null,
  });

export const AGENT_LOCAL_CLI_CONFIG = CANONICAL_AGENT_LOCAL_CLI_CONFIG;

/**
 * Whether each bundled Agent declares an unattended managed CLI install recipe.
 *
 * Unattended installation is the difference between an Agent a person can set up
 * by following a vendor guide and one a freshly started computer can install by
 * itself. Consumers that must decide the latter — such as Temporary computer
 * authoring — read this fact instead of branching on Agent ids.
 */
export const CANONICAL_AGENT_MANAGED_CLI_INSTALL_DECLARED: Readonly<Record<CanonicalAgentId, boolean>> =
  mergeAuthoredWithGeneratedAgentFacts({
    authored: {},
    label: 'managed CLI install declaration',
    readGenerated: (definition) => definition.cli?.install.managed != null,
  });

/** Typed unavailable (`false`) for an externally installed Agent with no bundled facts. */
export function agentDeclaresManagedCliInstall(agentId: AgentId): boolean {
  return readBundledAgentFact(CANONICAL_AGENT_MANAGED_CLI_INSTALL_DECLARED, agentId) ?? false;
}

export function getAgentLocalCliConfig(agentId: AgentId): AgentLocalCliConfig | null {
  return readBundledAgentFact(AGENT_LOCAL_CLI_CONFIG, agentId);
}
