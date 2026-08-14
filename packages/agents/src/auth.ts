import type { AgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
import { getAgentLocalCliConfig } from './localCli.js';
import { getAgentCliBinaryNames } from './cli/runtime.js';
import type { ProviderAuthAdapter } from './runtime/adjunctAdapters/types.js';

export type AgentAuthProbeParser =
  | 'none'
  | 'unknown'
  | 'envOnly'
  | 'claudeCredentialsFile'
  | 'codexLoginStatus'
  | 'geminiCredentialFiles'
  | 'opencodeAuthList'
  | 'piEnvOnly'
  | 'copilotGhAuth'
  | 'kiroWhoamiJson'
  | 'cursorAboutJson';

export type AgentAuthProbeBackgroundChecks = 'safe' | 'manual_only';

export type AgentAuthProbeConfig = Readonly<{
  agentId: AgentId;
  binaryNames: ReadonlyArray<string>;
  statusCommand: ReadonlyArray<string> | null;
  parser: AgentAuthProbeParser;
  backgroundChecks: AgentAuthProbeBackgroundChecks;
  envVars?: ReadonlyArray<string>;
  credentialPaths?: ReadonlyArray<string>;
}>;

const AUTHORED_AGENT_AUTH_PROBE_CONFIG = Object.freeze({
} satisfies Partial<Record<CanonicalAgentId, AgentAuthProbeConfig>>);

export const CANONICAL_AGENT_AUTH_PROBE_CONFIG: Readonly<Record<CanonicalAgentId, AgentAuthProbeConfig>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentAuthProbeConfig>({
    authored: AUTHORED_AGENT_AUTH_PROBE_CONFIG,
    label: 'auth probe config',
    readGenerated: (definition) => ({
      agentId: definition.id as AgentId,
      binaryNames: [
        definition.cli.executable.binaryName,
        ...(definition.cli.executable.alternativeBinaryNames ?? []),
      ],
      statusCommand: definition.cli.auth.probe.statusArgs ?? null,
      parser: definition.cli.auth.probe.parser,
      backgroundChecks: definition.cli.auth.probe.backgroundChecks,
      ...(definition.cli.auth.probe.envVars ? { envVars: definition.cli.auth.probe.envVars } : {}),
      ...(definition.cli.auth.probe.credentialPaths
        ? { credentialPaths: definition.cli.auth.probe.credentialPaths }
        : {}),
    }),
  });

export const AGENT_AUTH_PROBE_CONFIG: Readonly<Record<CanonicalAgentId, AgentAuthProbeConfig>> = CANONICAL_AGENT_AUTH_PROBE_CONFIG;

export function getAgentAuthProbeConfig(
  agentId: AgentId,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): AgentAuthProbeConfig {
  const config = AGENT_AUTH_PROBE_CONFIG[agentId];
  return {
    ...config,
    binaryNames: getAgentCliBinaryNames(agentId, processEnv),
  };
}

export function getProviderAuthAdapter(agentId: AgentId): ProviderAuthAdapter {
  const localCli = getAgentLocalCliConfig(agentId);
  const localCliAuth = getAgentAuthProbeConfig(agentId);

  return {
    supportKind: localCli.supportKind,
    localCliAuth,
    ...(localCli.loginLaunch ? { loginLaunch: localCli.loginLaunch } : {}),
  };
}

export function isAgentAuthProbeSafeForBackgroundChecks(agentId: AgentId): boolean {
  return getAgentAuthProbeConfig(agentId).backgroundChecks === 'safe';
}
