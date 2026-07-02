import type { AgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
import { getAgentLocalCliConfig } from './localCli.js';
import { getAgentCliBinaryNames, getAgentCliRuntimeSpec } from './cli/runtime.js';
import type { ProviderAuthAdapter } from './runtime/adjunctAdapters/types.js';

export type AgentAuthProbeParser =
  | 'unknown'
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
  claude: {
    agentId: 'claude',
    binaryNames: [getAgentCliRuntimeSpec('claude').binaryName],
    statusCommand: null,
    parser: 'claudeCredentialsFile',
    backgroundChecks: 'safe',
    envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    credentialPaths: ['~/.claude/.credentials.json', '~/.claude/.claude.json'],
  },
  codex: {
    agentId: 'codex',
    binaryNames: [getAgentCliRuntimeSpec('codex').binaryName],
    statusCommand: ['login', 'status'],
    parser: 'codexLoginStatus',
    backgroundChecks: 'safe',
    envVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    credentialPaths: ['~/.codex/auth.json'],
  },
  gemini: {
    agentId: 'gemini',
    binaryNames: [getAgentCliRuntimeSpec('gemini').binaryName],
    statusCommand: null,
    parser: 'geminiCredentialFiles',
    backgroundChecks: 'safe',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    credentialPaths: [
      '~/.gemini/oauth_creds.json',
      '~/.gemini/config.json',
      '~/.config/gemini/config.json',
      '~/.gemini/auth.json',
      '~/.config/gemini/auth.json',
      '~/.config/gcloud/application_default_credentials.json',
    ],
  },
  auggie: {
    agentId: 'auggie',
    binaryNames: [getAgentCliRuntimeSpec('auggie').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  qwen: {
    agentId: 'qwen',
    binaryNames: [getAgentCliRuntimeSpec('qwen').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  kimi: {
    agentId: 'kimi',
    binaryNames: [getAgentCliRuntimeSpec('kimi').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  kilo: {
    agentId: 'kilo',
    binaryNames: [getAgentCliRuntimeSpec('kilo').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  kiro: {
    agentId: 'kiro',
    binaryNames: [getAgentCliRuntimeSpec('kiro').binaryName],
    statusCommand: ['whoami', '--format', 'json'],
    parser: 'kiroWhoamiJson',
    backgroundChecks: 'manual_only',
  },
  cursor: {
    agentId: 'cursor',
    binaryNames: getAgentCliBinaryNames('cursor'),
    statusCommand: ['about', '--format', 'json'],
    parser: 'cursorAboutJson',
    backgroundChecks: 'safe',
    envVars: ['CURSOR_API_KEY'],
  },
  ohMyPi: {
    agentId: 'ohMyPi',
    binaryNames: [getAgentCliRuntimeSpec('ohMyPi').binaryName],
    statusCommand: null,
    parser: 'piEnvOnly',
    backgroundChecks: 'safe',
    envVars: [
      'OPENAI_CODEX_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
    ],
  },
  pi: {
    agentId: 'pi',
    binaryNames: [getAgentCliRuntimeSpec('pi').binaryName],
    statusCommand: null,
    parser: 'piEnvOnly',
    backgroundChecks: 'safe',
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  copilot: {
    agentId: 'copilot',
    binaryNames: [getAgentCliRuntimeSpec('copilot').binaryName],
    statusCommand: null,
    parser: 'copilotGhAuth',
    backgroundChecks: 'safe',
    envVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  },
} satisfies Partial<Record<CanonicalAgentId, AgentAuthProbeConfig>>);

export const CANONICAL_AGENT_AUTH_PROBE_CONFIG: Readonly<Record<CanonicalAgentId, AgentAuthProbeConfig>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentAuthProbeConfig>({
    authored: AUTHORED_AGENT_AUTH_PROBE_CONFIG,
    label: 'auth probe config',
    readGenerated: (definition) => definition.authProbeConfig,
  });

export const AGENT_AUTH_PROBE_CONFIG: Readonly<Record<CanonicalAgentId, AgentAuthProbeConfig>> = CANONICAL_AGENT_AUTH_PROBE_CONFIG;

export function getAgentAuthProbeConfig(
  agentId: AgentId,
  processEnv: NodeJS.ProcessEnv = process.env,
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
