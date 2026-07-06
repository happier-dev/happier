import type { AgentId } from './types.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';

export type AgentCliAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';

export type AgentCliLaunchCommand = Readonly<{
  command: string;
  args: ReadonlyArray<string>;
  initialInput?: string | null;
}>;

export type AgentLocalCliConfig = Readonly<{
  agentId: AgentId;
  detectKey: string;
  machineLoginKey: string;
  authSupport: AgentCliAuthSupport;
  loginLaunch: AgentCliLaunchCommand | null;
}>;

type AgentLocalCliConfigInput = Readonly<{
  machineLoginKey: string;
  authSupport: AgentCliAuthSupport;
  loginLaunch:
    | Readonly<{
        args: ReadonlyArray<string>;
        initialInput?: string | null;
      }>
    | null;
}>;

function createAgentLocalCliConfig(agentId: AgentId, input: AgentLocalCliConfigInput): AgentLocalCliConfig {
  const binaryName = getProviderCliRuntimeSpec(agentId).binaryName;
  return {
    agentId,
    detectKey: binaryName,
    machineLoginKey: input.machineLoginKey,
    authSupport: input.authSupport,
    loginLaunch: input.loginLaunch
      ? {
          command: binaryName,
          args: input.loginLaunch.args,
          ...(input.loginLaunch.initialInput !== undefined ? { initialInput: input.loginLaunch.initialInput } : {}),
        }
      : null,
  };
}

export const AGENT_LOCAL_CLI_CONFIG: Readonly<Record<AgentId, AgentLocalCliConfig>> = Object.freeze({
  claude: createAgentLocalCliConfig('claude', {
    machineLoginKey: 'claude-code',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/login\r',
    },
  }),
  codex: createAgentLocalCliConfig('codex', {
    machineLoginKey: 'codex',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  opencode: createAgentLocalCliConfig('opencode', {
    machineLoginKey: 'opencode',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: ['auth', 'login'],
    },
  }),
  gemini: createAgentLocalCliConfig('gemini', {
    machineLoginKey: 'gemini-cli',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: ['auth'],
    },
  }),
  auggie: createAgentLocalCliConfig('auggie', {
    machineLoginKey: 'auggie',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  qwen: createAgentLocalCliConfig('qwen', {
    machineLoginKey: 'qwen',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/auth\r',
    },
  }),
  kimi: createAgentLocalCliConfig('kimi', {
    machineLoginKey: 'kimi',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/setup\r',
    },
  }),
  kilo: createAgentLocalCliConfig('kilo', {
    machineLoginKey: 'kilo',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/connect\r',
    },
  }),
  kiro: createAgentLocalCliConfig('kiro', {
    machineLoginKey: 'kiro-cli',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  customAcp: createAgentLocalCliConfig('customAcp', {
    machineLoginKey: 'custom-acp',
    authSupport: 'unsupported',
    loginLaunch: null,
  }),
  pi: createAgentLocalCliConfig('pi', {
    machineLoginKey: 'pi',
    authSupport: 'status_only',
    loginLaunch: null,
  }),
  copilot: createAgentLocalCliConfig('copilot', {
    machineLoginKey: 'copilot',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  cursor: createAgentLocalCliConfig('cursor', {
    machineLoginKey: 'cursor-agent',
    authSupport: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  agy: createAgentLocalCliConfig('agy', {
    machineLoginKey: 'agy',
    authSupport: 'login_terminal',
    // Antigravity CLI has no `auth` subcommand: running `agy` triggers the Google
    // Sign-In flow automatically (cached in the system keyring) when no session exists.
    loginLaunch: {
      args: [],
    },
  }),
  grok: createAgentLocalCliConfig('grok', {
    machineLoginKey: 'grok',
    authSupport: 'login_terminal',
    // Grok Build CLI authenticates via the `grok login` subcommand (browser OIDC), not a
    // `/login` TUI slash command. `--device-auth` is the headless variant it falls back to.
    loginLaunch: {
      args: ['login'],
    },
  }),
});

export function getAgentLocalCliConfig(agentId: AgentId): AgentLocalCliConfig {
  return AGENT_LOCAL_CLI_CONFIG[agentId];
}
