import type { AcpBackendSpecV1, AcpStderrRulesV1 } from '@happier-dev/plugin-sdk/experimental/acp';

export const KIRO_ACP_STDERR_RULES = Object.freeze({
  suppress: [
    {
      includes: ['error handling notification', '_kiro.dev/', 'method not found'],
    },
  ],
} satisfies AcpStderrRulesV1);

export const KIRO_ACP_BACKEND_SPEC = Object.freeze({
  backendId: 'kiro',
  transport: {
    kind: 'stdio',
    launch: {
      kind: 'agent-cli',
      agentId: 'kiro',
      args: ['acp'],
    },
  },
  ux: {
    name: 'kiro',
    title: 'Kiro',
    defaultMode: 'default',
  },
  capabilities: {
    supportsResume: true,
    supportsStreaming: true,
    supportsToolUse: true,
    supportsPermissionRequests: true,
    supportsLoadSession: true,
    supportsModes: true,
    supportsModels: true,
    supportsConfigOptions: 'unknown',
    supportsPromptImages: true,
    promptImageSupport: 'yes',
  },
  auth: {
    config: {
      support: 'login_terminal',
      machineLoginKey: 'kiro-cli',
      docsUrl: 'https://kiro.dev/docs/cli/acp/',
      loginCommand: {
        command: 'kiro-cli',
        args: ['login'],
      },
      statusCommand: ['whoami', '--format', 'json'],
      parser: 'kiroWhoamiJson',
    },
  },
  sessionIdHeaderName: 'kiroSessionId',
  stderrRules: KIRO_ACP_STDERR_RULES,
  mcp: {
    policy: 'pass_through',
  },
} satisfies AcpBackendSpecV1);
