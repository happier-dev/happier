import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

type AuggieAcpRuntimeDefinition = NonNullable<AgentAcpRuntimeOptions['definition']>;

export const AUGGIE_ACP_TIMEOUTS = Object.freeze({
  initMs: 60_000,
  toolCallMs: 120_000,
  investigationToolCallMs: 600_000,
  toolKindTimeouts: {
    think: 30_000,
  },
  idleMs: 500,
} satisfies NonNullable<AuggieAcpRuntimeDefinition['timeouts']>);

export const AUGGIE_TOOL_NAME_INFERENCE = Object.freeze({
  patterns: [
    {
      name: 'change_title',
      patterns: ['change_title', 'change-title', 'update_title', 'update-title', 'set_title', 'set-title'],
      inputFields: ['title'],
    },
    {
      name: 'save_memory',
      patterns: ['save_memory', 'save-memory'],
      inputFields: ['memory', 'content'],
    },
    {
      name: 'think',
      patterns: ['think'],
      inputFields: ['thought', 'thinking'],
    },
    {
      name: 'read',
      patterns: ['read', 'read_file'],
      inputFields: ['filePath', 'file_path', 'path', 'locations'],
    },
    {
      name: 'write',
      patterns: ['write', 'write_file'],
      inputFields: ['filePath', 'file_path', 'path', 'content'],
    },
    {
      name: 'edit',
      patterns: ['edit', 'replace'],
      inputFields: ['oldText', 'newText', 'old_string', 'new_string', 'oldString', 'newString'],
    },
    {
      name: 'execute',
      patterns: ['run_shell_command', 'shell', 'exec', 'bash'],
      inputFields: ['command', 'cmd'],
    },
  ],
  preferLongestPattern: true,
  unknownToolNames: ['other', 'unknown tool'],
  investigationToolIdPatterns: ['investigat', 'index', 'search'],
  investigationToolKinds: ['investigation'],
} satisfies NonNullable<AuggieAcpRuntimeDefinition['toolNameInference']>);

export const AUGGIE_STDERR_RULES = Object.freeze({
  statusErrors: [
    {
      includes: ['unauthorized'],
      detail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
    },
    {
      includes: ['authentication'],
      detail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
    },
    {
      includes: ['api key'],
      detail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
    },
    {
      includes: ['token'],
      detail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
    },
  ],
} satisfies NonNullable<AuggieAcpRuntimeDefinition['stderrRules']>);
