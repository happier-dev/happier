import type { AgentId, CanonicalAgentId } from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
import { getAgentCliRuntimeSpec } from './cli/runtime.js';

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

type AgentLocalCliConfigInput = Readonly<{
  machineLoginKey: string;
  supportKind: AgentCliSupportKind;
  loginLaunch:
    | Readonly<{
        args: ReadonlyArray<string>;
        initialInput?: string | null;
      }>
    | null;
}>;

function createAgentLocalCliConfig(agentId: AgentId, input: AgentLocalCliConfigInput): AgentLocalCliConfig {
  const binaryName = getAgentCliRuntimeSpec(agentId).binaryName;
  return {
    agentId,
    detectKey: binaryName,
    machineLoginKey: input.machineLoginKey,
    supportKind: input.supportKind,
    loginLaunch: input.loginLaunch
      ? {
          command: binaryName,
          args: input.loginLaunch.args,
          ...(input.loginLaunch.initialInput !== undefined ? { initialInput: input.loginLaunch.initialInput } : {}),
        }
      : null,
  };
}

const AUTHORED_AGENT_LOCAL_CLI_CONFIG = Object.freeze({
  claude: createAgentLocalCliConfig('claude', {
    machineLoginKey: 'claude-code',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/login\r',
    },
  }),
  codex: createAgentLocalCliConfig('codex', {
    machineLoginKey: 'codex',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  gemini: createAgentLocalCliConfig('gemini', {
    machineLoginKey: 'gemini-cli',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: ['auth'],
    },
  }),
  auggie: createAgentLocalCliConfig('auggie', {
    machineLoginKey: 'auggie',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  qwen: createAgentLocalCliConfig('qwen', {
    machineLoginKey: 'qwen',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/auth\r',
    },
  }),
  kimi: createAgentLocalCliConfig('kimi', {
    machineLoginKey: 'kimi',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/setup\r',
    },
  }),
  kilo: createAgentLocalCliConfig('kilo', {
    machineLoginKey: 'kilo',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: [],
      initialInput: '/connect\r',
    },
  }),
  kiro: createAgentLocalCliConfig('kiro', {
    machineLoginKey: 'kiro-cli',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
  cursor: createAgentLocalCliConfig('cursor', {
    machineLoginKey: 'cursor-agent',
    supportKind: 'status_only',
    loginLaunch: null,
  }),
  ohMyPi: createAgentLocalCliConfig('ohMyPi', {
    machineLoginKey: 'oh-my-pi',
    supportKind: 'manual_only',
    loginLaunch: null,
  }),
  pi: createAgentLocalCliConfig('pi', {
    machineLoginKey: 'pi',
    supportKind: 'status_only',
    loginLaunch: null,
  }),
  copilot: createAgentLocalCliConfig('copilot', {
    machineLoginKey: 'copilot',
    supportKind: 'login_terminal',
    loginLaunch: {
      args: ['login'],
    },
  }),
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
