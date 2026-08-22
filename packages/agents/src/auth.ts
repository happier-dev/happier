import type { AgentId, BundledAgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts, readBundledAgentFact } from './definitions/generatedFacts.js';
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
  agentId: BundledAgentId;
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
    readGenerated: (definition, agentId) => ({
      agentId,
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
  agentId: BundledAgentId,
  processEnv?: Readonly<Record<string, string | undefined>>,
): AgentAuthProbeConfig;
export function getAgentAuthProbeConfig(
  agentId: AgentId,
  processEnv?: Readonly<Record<string, string | undefined>>,
): AgentAuthProbeConfig | null;
export function getAgentAuthProbeConfig(
  agentId: AgentId,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): AgentAuthProbeConfig | null {
  const config = readBundledAgentFact(AGENT_AUTH_PROBE_CONFIG, agentId);
  if (config == null) {
    return null;
  }
  return {
    ...config,
    binaryNames: getAgentCliBinaryNames(agentId, processEnv),
  };
}

export function getProviderAuthAdapter(agentId: BundledAgentId): ProviderAuthAdapter;
export function getProviderAuthAdapter(agentId: AgentId): ProviderAuthAdapter | null;
export function getProviderAuthAdapter(agentId: AgentId): ProviderAuthAdapter | null {
  const localCli = getAgentLocalCliConfig(agentId);
  const localCliAuth = getAgentAuthProbeConfig(agentId);
  if (localCli == null || localCliAuth == null) {
    return null;
  }

  return {
    supportKind: localCli.supportKind,
    localCliAuth,
    ...(localCli.loginLaunch ? { loginLaunch: localCli.loginLaunch } : {}),
  };
}

export function isAgentAuthProbeSafeForBackgroundChecks(agentId: AgentId): boolean {
  return getAgentAuthProbeConfig(agentId)?.backgroundChecks === 'safe';
}
