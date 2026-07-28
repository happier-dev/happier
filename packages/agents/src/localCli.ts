import type { AgentId } from './types.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';

export type AgentCliAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';

export type AgentCliLaunchCommand = Readonly<{
  kind: 'primary' | 'device_code';
  command: string;
  args: ReadonlyArray<string>;
  initialInput?: string | null;
}>;

export type AgentLocalCliConfig = Readonly<{
  agentId: AgentId;
  detectKey: string;
  machineLoginKey: string;
  authSupport: AgentCliAuthSupport;
  authLaunches: ReadonlyArray<AgentCliLaunchCommand>;
}>;

type AgentLocalCliConfigInput = Readonly<{
  machineLoginKey: string;
  authSupport: AgentCliAuthSupport;
  authLaunches: ReadonlyArray<
    Readonly<{
        kind: 'primary' | 'device_code';
        args: ReadonlyArray<string>;
        initialInput?: string | null;
      }>
  >;
}>;

function createAgentLocalCliConfig(agentId: AgentId, input: AgentLocalCliConfigInput): AgentLocalCliConfig {
  const binaryName = getProviderCliRuntimeSpec(agentId).binaryName;
  return {
    agentId,
    detectKey: binaryName,
    machineLoginKey: input.machineLoginKey,
    authSupport: input.authSupport,
    authLaunches: input.authLaunches.map((launch) => ({
          kind: launch.kind,
          command: binaryName,
          args: launch.args,
          ...(launch.initialInput !== undefined ? { initialInput: launch.initialInput } : {}),
    })),
  };
}

export const AGENT_LOCAL_CLI_CONFIG: Readonly<Record<AgentId, AgentLocalCliConfig>> = Object.freeze({
  claude: createAgentLocalCliConfig('claude', {
    machineLoginKey: 'claude-code',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: [],
      initialInput: '/login\r',
    }],
  }),
  codex: createAgentLocalCliConfig('codex', {
    machineLoginKey: 'codex',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['login'],
    }],
  }),
  opencode: createAgentLocalCliConfig('opencode', {
    machineLoginKey: 'opencode',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['auth', 'login'],
    }],
  }),
  gemini: createAgentLocalCliConfig('gemini', {
    machineLoginKey: 'gemini-cli',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['auth'],
    }],
  }),
  auggie: createAgentLocalCliConfig('auggie', {
    machineLoginKey: 'auggie',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['login'],
    }],
  }),
  qwen: createAgentLocalCliConfig('qwen', {
    machineLoginKey: 'qwen',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: [],
      initialInput: '/auth\r',
    }],
  }),
  kimi: createAgentLocalCliConfig('kimi', {
    machineLoginKey: 'kimi',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: [],
      initialInput: '/setup\r',
    }],
  }),
  kilo: createAgentLocalCliConfig('kilo', {
    machineLoginKey: 'kilo',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: [],
      initialInput: '/connect\r',
    }],
  }),
  kiro: createAgentLocalCliConfig('kiro', {
    machineLoginKey: 'kiro-cli',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['login'],
    }],
  }),
  customAcp: createAgentLocalCliConfig('customAcp', {
    machineLoginKey: 'custom-acp',
    authSupport: 'unsupported',
    authLaunches: [],
  }),
  pi: createAgentLocalCliConfig('pi', {
    machineLoginKey: 'pi',
    authSupport: 'status_only',
    authLaunches: [],
  }),
  copilot: createAgentLocalCliConfig('copilot', {
    machineLoginKey: 'copilot',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['login'],
    }],
  }),
  cursor: createAgentLocalCliConfig('cursor', {
    machineLoginKey: 'cursor-agent',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['login'],
    }],
  }),
  grok: createAgentLocalCliConfig('grok', {
    machineLoginKey: 'grok',
    authSupport: 'login_terminal',
    authLaunches: [
      { kind: 'primary', args: ['login'] },
      { kind: 'device_code', args: ['login', '--device-auth'] },
    ],
  }),
});

export function getAgentLocalCliConfig(agentId: AgentId): AgentLocalCliConfig {
  return AGENT_LOCAL_CLI_CONFIG[agentId];
}
