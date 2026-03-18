import type { AgentId } from './types.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';

export type AgentAuthProbeParser =
  | 'unknown'
  | 'claudeCredentialsFile'
  | 'codexLoginStatus'
  | 'geminiCredentialFiles'
  | 'opencodeAuthList'
  | 'piEnvOnly'
  | 'copilotGhAuth'
  | 'kiroWhoamiJson';

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

export const AGENT_AUTH_PROBE_CONFIG: Readonly<Record<AgentId, AgentAuthProbeConfig>> = Object.freeze({
  claude: {
    agentId: 'claude',
    binaryNames: [getProviderCliRuntimeSpec('claude').binaryName],
    statusCommand: null,
    parser: 'claudeCredentialsFile',
    backgroundChecks: 'safe',
    envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    credentialPaths: ['~/.claude/.credentials.json'],
  },
  codex: {
    agentId: 'codex',
    binaryNames: [getProviderCliRuntimeSpec('codex').binaryName],
    statusCommand: ['login', 'status'],
    parser: 'codexLoginStatus',
    backgroundChecks: 'safe',
    envVars: ['OPENAI_API_KEY'],
    credentialPaths: ['~/.codex/auth.json'],
  },
  opencode: {
    agentId: 'opencode',
    binaryNames: [getProviderCliRuntimeSpec('opencode').binaryName],
    statusCommand: ['auth', 'list'],
    parser: 'opencodeAuthList',
    backgroundChecks: 'safe',
  },
  gemini: {
    agentId: 'gemini',
    binaryNames: [getProviderCliRuntimeSpec('gemini').binaryName],
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
    binaryNames: [getProviderCliRuntimeSpec('auggie').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  qwen: {
    agentId: 'qwen',
    binaryNames: [getProviderCliRuntimeSpec('qwen').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  kimi: {
    agentId: 'kimi',
    binaryNames: [getProviderCliRuntimeSpec('kimi').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  kilo: {
    agentId: 'kilo',
    binaryNames: [getProviderCliRuntimeSpec('kilo').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'safe',
  },
  kiro: {
    agentId: 'kiro',
    binaryNames: [getProviderCliRuntimeSpec('kiro').binaryName],
    statusCommand: ['whoami', '--format', 'json'],
    parser: 'kiroWhoamiJson',
    backgroundChecks: 'manual_only',
  },
  customAcp: {
    agentId: 'customAcp',
    binaryNames: [getProviderCliRuntimeSpec('customAcp').binaryName],
    statusCommand: null,
    parser: 'unknown',
    backgroundChecks: 'manual_only',
  },
  pi: {
    agentId: 'pi',
    binaryNames: [getProviderCliRuntimeSpec('pi').binaryName],
    statusCommand: null,
    parser: 'piEnvOnly',
    backgroundChecks: 'safe',
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  copilot: {
    agentId: 'copilot',
    binaryNames: [getProviderCliRuntimeSpec('copilot').binaryName],
    statusCommand: null,
    parser: 'copilotGhAuth',
    backgroundChecks: 'safe',
    envVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  },
});

export function getAgentAuthProbeConfig(agentId: AgentId): AgentAuthProbeConfig {
  return AGENT_AUTH_PROBE_CONFIG[agentId];
}

export function isAgentAuthProbeSafeForBackgroundChecks(agentId: AgentId): boolean {
  return getAgentAuthProbeConfig(agentId).backgroundChecks === 'safe';
}
