import type { AgentId } from './types.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';

export type AgentCliAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';

type AgentCliLaunchBase = Readonly<{
  kind: 'primary' | 'device_code';
  args: ReadonlyArray<string>;
  initialInput?: string | null;
}>;

export type AgentCliLaunchCommand =
  | (AgentCliLaunchBase & Readonly<{ target: 'provider_cli'; command: string }>)
  | (AgentCliLaunchBase & Readonly<{ target: 'happier_cli' }>);

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
        target?: 'provider_cli' | 'happier_cli';
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
    authLaunches: input.authLaunches.map((launch): AgentCliLaunchCommand => {
      const shared = {
        kind: launch.kind,
        args: launch.args,
        ...(launch.initialInput !== undefined ? { initialInput: launch.initialInput } : {}),
      };
      return launch.target === 'happier_cli'
        ? { ...shared, target: 'happier_cli' }
        : { ...shared, target: 'provider_cli', command: binaryName };
    }),
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
      args: ['login'],
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
  devin: createAgentLocalCliConfig('devin', {
    machineLoginKey: 'devin',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: ['auth', 'login'],
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
  agy: createAgentLocalCliConfig('agy', {
    machineLoginKey: 'antigravity-cli',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      target: 'happier_cli',
      args: ['agy', 'auth', 'login'],
    }],
  }),
  fx: createAgentLocalCliConfig('fx', {
    machineLoginKey: 'fx',
    authSupport: 'login_terminal',
    authLaunches: [{ kind: 'primary', args: ['login'] }],
  }),
  droid: createAgentLocalCliConfig('droid', {
    machineLoginKey: 'droid',
    authSupport: 'login_terminal',
    authLaunches: [{ kind: 'primary', args: [] }],
  }),
  codebuddy: createAgentLocalCliConfig('codebuddy', {
    machineLoginKey: 'codebuddy',
    authSupport: 'login_terminal',
    authLaunches: [{
      kind: 'primary',
      args: [],
      initialInput: '/login\r',
    }],
  }),
});

export function getAgentLocalCliConfig(agentId: AgentId): AgentLocalCliConfig {
  return AGENT_LOCAL_CLI_CONFIG[agentId];
}
