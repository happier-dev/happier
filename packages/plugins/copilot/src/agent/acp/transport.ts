import type { AcpTimeoutsV1, AcpToolNameInferenceV1 } from '@happier-dev/plugin-sdk/acp';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';

export const COPILOT_ACP_TIMEOUTS = Object.freeze({
  initMs: 90_000,
  toolCallMs: 120_000,
  investigationToolCallMs: 300_000,
  toolKindTimeouts: {
    think: 30_000,
  },
  idleMs: 500,
} satisfies AcpTimeoutsV1);

export const COPILOT_ACP_TOOL_NAME_INFERENCE = Object.freeze({
  preferLongestPattern: true,
  unknownToolNames: ['other', 'Unknown tool', 'unknown'],
  hintInputFields: ['tool_name', 'toolName', 'name'],
  shellBridgeHint: true,
  investigationToolIdPatterns: ['task'],
  investigationToolKinds: ['task'],
  patterns: [
    { name: 'change_title', patterns: CHANGE_TITLE_TOOL_NAME_ALIASES, inputFields: ['title'] },
    { name: 'think', patterns: ['think'], inputFields: ['thought', 'thinking'] },
    { name: 'read', patterns: ['read', 'read_file', 'read-file'], inputFields: ['path', 'filePath', 'uri'] },
    { name: 'write', patterns: ['write', 'write_file', 'write_to_file', 'write-file'], inputFields: ['path', 'filePath', 'content', 'text'] },
    { name: 'edit', patterns: ['edit', 'apply_diff', 'apply_patch', 'apply-diff', 'apply-patch'], inputFields: ['changes', 'old_string', 'new_string', 'edits'] },
    { name: 'bash', patterns: ['bash', 'shell', 'exec', 'exec_command', 'execute_command'], inputFields: ['command', 'cmd'] },
    { name: 'glob', patterns: ['glob', 'glob_files'], inputFields: ['pattern', 'glob'] },
    { name: 'grep', patterns: ['grep', 'search_code', 'code_search'], inputFields: ['pattern', 'query', 'text'] },
    { name: 'ls', patterns: ['ls', 'list_files', 'ls_files'], inputFields: ['path', 'dir'] },
    { name: 'task', patterns: ['task', 'subtask'], inputFields: ['prompt'] },
    { name: 'mcp', patterns: ['use_mcp_tool', 'access_mcp_resource'], inputFields: ['server', 'tool', 'name', 'uri'] },
  ],
} satisfies AcpToolNameInferenceV1);

export const COPILOT_ACP_STDERR_RULES = Object.freeze({
  statusErrors: [{
    includes: ['authentication'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['unauthorized'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['not logged in'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['401'],
    detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
  }, {
    includes: ['model not found'],
    detail: 'Model not found. Check available models with `copilot models`.',
  }, {
    includes: ['unknown model'],
    detail: 'Model not found. Check available models with `copilot models`.',
  }, {
    includes: ['subscription'],
    detail: 'GitHub Copilot subscription required. Check your Copilot access at https://github.com/settings/copilot.',
  }, {
    includes: ['copilot is not enabled'],
    detail: 'GitHub Copilot subscription required. Check your Copilot access at https://github.com/settings/copilot.',
  }],
} as const);
