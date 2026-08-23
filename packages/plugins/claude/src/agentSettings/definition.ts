import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
export type ClaudeSettingSourceV2 = (typeof CLAUDE_SETTING_SOURCES_V2)[number];

export const CLAUDE_REMOTE_DEBUG_CATEGORIES = ['api', 'mcp', 'hooks', 'file', '1p'] as const;
export type ClaudeRemoteDebugCategory = (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number];

export const CLAUDE_UNIFIED_TERMINAL_HOSTS = ['auto', 'tmux', 'zellij'] as const;
export type ClaudeUnifiedTerminalHost = (typeof CLAUDE_UNIFIED_TERMINAL_HOSTS)[number];

export const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES = [
  'ask_every_time',
  'resume_from_summary',
  'resume_full_session',
] as const;
export type ClaudeUnifiedTerminalResumeChoice =
  (typeof CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES)[number];
export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE:
  ClaudeUnifiedTerminalResumeChoice = 'ask_every_time';

export const CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES = [
  'ask_every_time',
  'always_trust_happier_workspaces',
  'always_reject_happier_workspaces',
] as const;
export type ClaudeUnifiedTerminalWorkspaceTrustPolicy =
  (typeof CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES)[number];
export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY:
  ClaudeUnifiedTerminalWorkspaceTrustPolicy = 'ask_every_time';

export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS = 16_384;

const BOOLEAN_ANALYTICS = {
  trackCurrentState: true,
  trackChanges: true,
  valueKind: 'boolean',
  privacy: 'safe',
  identityScope: 'person',
} as const;

const ENUM_ANALYTICS = {
  trackCurrentState: true,
  trackChanges: true,
  valueKind: 'enum',
  privacy: 'safe',
  identityScope: 'person',
} as const;

const ENUM_ARRAY_ANALYTICS = {
  ...ENUM_ANALYTICS,
  serializeCurrentRule: 'orderedEnumArrayJoin',
} as const;

const JSON_OBJECT_PRESENCE_ANALYTICS = {
  trackCurrentState: true,
  trackChanges: true,
  valueKind: 'presence',
  privacy: 'presence_only',
  identityScope: 'person',
  serializeCurrentRule: 'jsonObjectStringPresence',
} as const;

function localized(key: string, fallback: string) {
  return { key, fallback };
}

function fieldTitle(fieldId: string, fallback: string) {
  return localized(`settingsAgents.plugins.claude.fields.${fieldId}.title`, fallback);
}

function fieldDescription(fieldId: string, fallback: string) {
  return localized(`settingsAgents.plugins.claude.fields.${fieldId}.subtitle`, fallback);
}

function option(
  fieldId: string,
  value: string,
  title: string,
  description: string,
) {
  return {
    value,
    title: localized(
      `settingsAgents.plugins.claude.fields.${fieldId}.options.${value}.title`,
      title,
    ),
    description: localized(
      `settingsAgents.plugins.claude.fields.${fieldId}.options.${value}.subtitle`,
      description,
    ),
  };
}

const CLAUDE_AGENT_SETTINGS_FIELDS = [
  {
    id: 'claudeRemoteAgentSdkEnabled',
    title: fieldTitle('claudeRemoteAgentSdkEnabled', 'Use Agent SDK (remote)'),
    description: fieldDescription(
      'claudeRemoteAgentSdkEnabled',
      'Use the official @anthropic-ai/claude-agent-sdk for remote mode.',
    ),
    schema: { type: 'boolean', description: 'Use Claude Agent SDK in remote mode' },
    default: true,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeUnifiedTerminalEnabled',
    title: fieldTitle('claudeUnifiedTerminalEnabled', 'Use unified terminal mode'),
    description: fieldDescription(
      'claudeUnifiedTerminalEnabled',
      'Keep Claude Code as the canonical terminal session and send supported Happier prompts into that session.',
    ),
    schema: { type: 'boolean', description: 'Enable Claude unified terminal runtime' },
    default: false,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeCodeExperimentalAgentTeamsEnabled',
    title: fieldTitle('claudeCodeExperimentalAgentTeamsEnabled', 'Force-enable Agent Teams'),
    description: fieldDescription(
      'claudeCodeExperimentalAgentTeamsEnabled',
      'Enable Claude Code experimental Agent Teams in every Claude session started by Happier.',
    ),
    schema: { type: 'boolean', description: 'Force-enable Claude experimental agent teams' },
    default: false,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeUnifiedTerminalHost',
    title: fieldTitle('claudeUnifiedTerminalHost', 'Terminal host'),
    description: fieldDescription(
      'claudeUnifiedTerminalHost',
      'Choose which terminal multiplexer Happier uses for unified Claude sessions.',
    ),
    schema: {
      type: 'string',
      description: 'Claude unified terminal host adapter preference',
      enum: [...CLAUDE_UNIFIED_TERMINAL_HOSTS],
    },
    default: 'auto',
    analytics: ENUM_ANALYTICS,
    presentation: {
      control: 'select',
      options: [
        option('claudeUnifiedTerminalHost', 'auto', 'Auto', 'Prefer the best supported host on this machine.'),
        option('claudeUnifiedTerminalHost', 'tmux', 'tmux', 'Use tmux when it is available.'),
        option('claudeUnifiedTerminalHost', 'zellij', 'Zellij', 'Use Zellij when it is available and supported.'),
      ],
    },
  },
  {
    id: 'claudeUnifiedTerminalResumeChoice',
    title: fieldTitle('claudeUnifiedTerminalResumeChoice', 'Large-session resume'),
    description: fieldDescription(
      'claudeUnifiedTerminalResumeChoice',
      'Choose how Happier responds when Claude asks how to resume a large session.',
    ),
    schema: {
      type: 'string',
      description: 'Default action for Claude heavy-session resume choice prompts',
      enum: [...CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES],
    },
    default: DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE,
    analytics: ENUM_ANALYTICS,
    presentation: {
      control: 'select',
      options: [
        option('claudeUnifiedTerminalResumeChoice', 'ask_every_time', 'Ask every time', 'Show a user action in the session whenever Claude asks.'),
        option('claudeUnifiedTerminalResumeChoice', 'resume_from_summary', 'Resume from summary', "Use Claude's summary so large sessions resume faster."),
        option('claudeUnifiedTerminalResumeChoice', 'resume_full_session', 'Resume full session', 'Load the full session context when Claude offers the choice.'),
      ],
    },
  },
  {
    id: 'claudeUnifiedTerminalWorkspaceTrust',
    title: fieldTitle('claudeUnifiedTerminalWorkspaceTrust', 'Workspace trust'),
    description: fieldDescription(
      'claudeUnifiedTerminalWorkspaceTrust',
      'Choose how Happier responds when Claude asks whether to trust a workspace.',
    ),
    schema: {
      type: 'string',
      description: 'Default action for Claude workspace trust prompts opened by Happier',
      enum: [...CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES],
    },
    default: DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
    analytics: ENUM_ANALYTICS,
    presentation: {
      control: 'select',
      options: [
        option('claudeUnifiedTerminalWorkspaceTrust', 'ask_every_time', 'Ask every time', 'Show the exact workspace trust question in the session.'),
        option('claudeUnifiedTerminalWorkspaceTrust', 'always_trust_happier_workspaces', 'Always trust Happier workspaces', 'Trust the current recaptured Claude prompt for workspaces opened by Happier.'),
        option('claudeUnifiedTerminalWorkspaceTrust', 'always_reject_happier_workspaces', 'Always reject Happier workspaces', 'Reject the current recaptured Claude prompt for workspaces opened by Happier.'),
      ],
    },
  },
  {
    id: 'claudeRemoteSettingSources',
    title: fieldTitle('claudeRemoteSettingSources', 'Legacy setting sources'),
    description: fieldDescription('claudeRemoteSettingSources', 'Legacy Claude settings source mode.'),
    schema: {
      type: 'string',
      description: 'Legacy Claude settings source mode',
      enum: ['project', 'user_project', 'none'],
    },
    default: 'user_project',
    presentation: {
      control: 'select',
      options: [
        option('claudeRemoteSettingSources', 'project', 'Project', 'Load project settings only.'),
        option('claudeRemoteSettingSources', 'user_project', 'User and project', 'Load user and project settings.'),
        option('claudeRemoteSettingSources', 'none', 'None', 'Do not load Claude settings.'),
      ],
    },
  },
  {
    id: 'claudeRemoteSettingSourcesV2',
    title: fieldTitle('claudeRemoteSettingSourcesV2', 'Setting sources'),
    description: fieldDescription('claudeRemoteSettingSourcesV2', 'Controls which Claude settings are loaded.'),
    schema: {
      type: 'array',
      description: 'Claude settings sources',
      items: { type: 'string', enum: [...CLAUDE_SETTING_SOURCES_V2] },
      maxItems: 3,
    },
    default: [...CLAUDE_SETTING_SOURCES_V2],
    analytics: ENUM_ARRAY_ANALYTICS,
    presentation: {
      control: 'multiSelect',
      options: [
        option('claudeRemoteSettingSourcesV2', 'user', 'User', 'Loads user-global Claude config.'),
        option('claudeRemoteSettingSourcesV2', 'project', 'Project', 'Loads repo settings (including CLAUDE.md).'),
        option('claudeRemoteSettingSourcesV2', 'local', 'Local', 'Loads local-only overrides.'),
      ],
    },
  },
  {
    id: 'claudeLocalPermissionBridgeEnabled',
    title: fieldTitle('claudeLocalPermissionBridgeEnabled', 'Experimental: local permission bridge'),
    description: fieldDescription(
      'claudeLocalPermissionBridgeEnabled',
      'Forward Claude local-mode permission prompts to Happier so you can approve or deny from the app UI.',
    ),
    schema: { type: 'boolean', description: 'Enable local Claude permission bridge' },
    default: true,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeLocalPermissionBridgeWaitIndefinitely',
    title: fieldTitle('claudeLocalPermissionBridgeWaitIndefinitely', 'Keep requests open until answered'),
    description: fieldDescription(
      'claudeLocalPermissionBridgeWaitIndefinitely',
      'When enabled, Happier keeps Claude local permission requests pending until you approve or deny them from the app UI.',
    ),
    schema: { type: 'boolean', description: 'Keep local permission requests open until the user responds' },
    default: true,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeLocalPermissionBridgeTimeoutSeconds',
    title: fieldTitle('claudeLocalPermissionBridgeTimeoutSeconds', 'Optional permission timeout (seconds)'),
    description: fieldDescription(
      'claudeLocalPermissionBridgeTimeoutSeconds',
      "Only used when indefinite waiting is turned off. After this delay, Happier falls back to Claude's terminal prompt.",
    ),
    schema: {
      type: 'integer',
      description: 'Local permission bridge timeout in seconds',
      minimum: 1,
    },
    default: 600,
    presentation: {
      control: 'number',
      step: 30,
      placeholder: { key: 'common.default', fallback: 'Default' },
    },
  },
  {
    id: 'claudeRemoteEnableFileCheckpointing',
    title: fieldTitle('claudeRemoteEnableFileCheckpointing', 'File checkpointing + /rewind'),
    description: fieldDescription(
      'claudeRemoteEnableFileCheckpointing',
      'Enables file checkpoints and /rewind (files-only; does not rewind the conversation). Use /checkpoints to list and /rewind --confirm to apply (higher overhead).',
    ),
    schema: { type: 'boolean', description: 'Enable Claude file checkpointing' },
    default: false,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeRemoteMaxThinkingTokens',
    title: fieldTitle('claudeRemoteMaxThinkingTokens', 'Max thinking tokens'),
    description: fieldDescription(
      'claudeRemoteMaxThinkingTokens',
      "Limit Claude's internal thinking budget (null = default).",
    ),
    schema: {
      description: 'Maximum Claude thinking tokens override',
      anyOf: [
        { type: 'integer', minimum: 1 },
        { type: 'null' },
      ],
    },
    default: null,
    presentation: {
      control: 'number',
      step: 100,
      placeholder: { key: 'common.default', fallback: 'Default' },
    },
  },
  {
    id: 'claudeRemoteDisableTodos',
    title: fieldTitle('claudeRemoteDisableTodos', 'Disable TODOs'),
    description: fieldDescription(
      'claudeRemoteDisableTodos',
      'Prevent Claude from creating TODO items in remote mode.',
    ),
    schema: { type: 'boolean', description: 'Disable TODO generation in Claude remote mode' },
    default: false,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeRemoteStrictMcpServerConfig',
    title: fieldTitle('claudeRemoteStrictMcpServerConfig', 'Strict MCP server config'),
    description: fieldDescription(
      'claudeRemoteStrictMcpServerConfig',
      'Fail if any MCP server config is invalid.',
    ),
    schema: { type: 'boolean', description: 'Fail if Claude MCP server config is invalid' },
    default: false,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeRemoteDebugEnabled',
    title: fieldTitle('claudeRemoteDebugEnabled', 'Debug mode'),
    description: fieldDescription(
      'claudeRemoteDebugEnabled',
      'Enables Claude Code debug logs (same as passing --debug).',
    ),
    schema: { type: 'boolean', description: 'Enable Claude Code debug mode (remote)' },
    default: false,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeRemoteVerboseEnabled',
    title: fieldTitle('claudeRemoteVerboseEnabled', 'Verbose'),
    description: fieldDescription(
      'claudeRemoteVerboseEnabled',
      'Enables verbose logging (same as passing --verbose).',
    ),
    schema: { type: 'boolean', description: 'Enable Claude Code verbose logging (remote)' },
    default: false,
    analytics: BOOLEAN_ANALYTICS,
    presentation: { control: 'switch' },
  },
  {
    id: 'claudeRemoteDebugCategories',
    title: fieldTitle('claudeRemoteDebugCategories', 'Debug categories'),
    description: fieldDescription(
      'claudeRemoteDebugCategories',
      'Optional debug category filter. When empty, Claude logs all debug categories.',
    ),
    schema: {
      type: 'array',
      description: 'Claude Code debug categories filter (remote)',
      items: { type: 'string', enum: [...CLAUDE_REMOTE_DEBUG_CATEGORIES] },
      maxItems: 5,
    },
    default: [],
    analytics: ENUM_ARRAY_ANALYTICS,
    presentation: {
      control: 'multiSelect',
      options: [
        option('claudeRemoteDebugCategories', 'api', 'API', 'HTTP/API requests and responses.'),
        option('claudeRemoteDebugCategories', 'mcp', 'MCP', 'MCP server connections and tool traffic.'),
        option('claudeRemoteDebugCategories', 'hooks', 'Hooks', 'Hook lifecycle and hook command execution.'),
        option('claudeRemoteDebugCategories', 'file', 'Files', 'Filesystem operations and file helpers.'),
        option('claudeRemoteDebugCategories', '1p', '1p', 'First-party internal debug category.'),
      ],
    },
  },
  {
    id: 'claudeRemoteAdvancedOptionsJson',
    title: fieldTitle('claudeRemoteAdvancedOptionsJson', 'Advanced options (JSON)'),
    description: fieldDescription(
      'claudeRemoteAdvancedOptionsJson',
      'Power-user Claude Agent SDK overrides. The value must be empty or a JSON object.',
    ),
    schema: {
      type: 'string',
      description: 'Advanced Claude remote options JSON',
      maxLength: MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
    },
    default: '',
    analytics: JSON_OBJECT_PRESENCE_ANALYTICS,
    // The persisted compatibility value is a JSON-encoded string. The generic `json` control
    // parses drafts into objects, so use a textarea and retain the exact released string key/shape.
    presentation: { control: 'textarea' },
  },
] satisfies PluginSettingsContribution['fields'];

export const CLAUDE_AGENT_SETTINGS_CONTRIBUTION = {
  id: 'agent-settings',
  version: 1,
  title: { key: 'settingsAgents.plugins.claude.title', fallback: 'Claude (remote)' },
  target: { kind: 'agent', agent: 'claude' },
  scope: 'account',
  fields: CLAUDE_AGENT_SETTINGS_FIELDS,
  presentation: {
    icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'orange' } },
    subagentSections: [
      {
        id: 'claude-teams',
        title: {
          key: 'subAgentGuidance.settings.agents.claude.title',
          fallback: 'Claude team agents',
        },
        description: {
          key: 'subAgentGuidance.settings.agents.claude.footer',
          fallback: 'Agent-specific subagent behavior stays owned by the agent settings screen.',
        },
        items: [
          {
            id: 'claude-teams-agent-settings',
            title: {
              key: 'subAgentGuidance.settings.agents.claude.openTitle',
              fallback: 'Claude subagent options',
            },
            description: {
              key: 'subAgentGuidance.settings.agents.claude.openSubtitle',
              fallback: 'Manage Agent Teams and other Claude-specific subagent behavior.',
            },
            iconIonName: 'sparkles-outline',
          },
        ],
      },
    ],
    sections: [
      {
        id: 'claude-code-experiments',
        title: {
          key: 'settingsAgents.plugins.claude.sections.claudeCodeExperiments.title',
          fallback: 'Claude Code experiments',
        },
        description: {
          key: 'settingsAgents.plugins.claude.sections.claudeCodeExperiments.footer',
          fallback: 'These settings apply to both terminal and Agent SDK sessions started by Happier.',
        },
        fields: [
          'claudeCodeExperimentalAgentTeamsEnabled',
        ],
      },
      {
        id: 'claude-remote-sdk',
        title: {
          key: 'settingsAgents.plugins.claude.sections.claudeRemoteSdk.title',
          fallback: 'Claude Agent SDK (remote mode)',
        },
        description: {
          key: 'settingsAgents.plugins.claude.sections.claudeRemoteSdk.footer',
          fallback: 'Remote mode runs Claude on your machine, but controlled from the Happier UI. Local mode is the Claude Code TUI in your terminal. These settings affect remote mode only.',
        },
        fields: [
          'claudeRemoteAgentSdkEnabled',
          'claudeRemoteDebugEnabled',
          'claudeRemoteVerboseEnabled',
          'claudeRemoteDebugCategories',
          'claudeRemoteAdvancedOptionsJson',
          'claudeRemoteSettingSourcesV2',
          'claudeLocalPermissionBridgeEnabled',
          'claudeLocalPermissionBridgeWaitIndefinitely',
          'claudeLocalPermissionBridgeTimeoutSeconds',
          'claudeRemoteEnableFileCheckpointing',
          'claudeRemoteMaxThinkingTokens',
          'claudeRemoteDisableTodos',
          'claudeRemoteStrictMcpServerConfig',
        ],
      },
      {
        id: 'claude-unified-terminal',
        title: {
          key: 'settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.title',
          fallback: 'Claude unified terminal',
        },
        description: {
          key: 'settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.footer',
          fallback: 'Runs Claude Code in a terminal-hosted session and lets Happier deliver supported prompts through the terminal host.',
        },
        fields: [
          'claudeUnifiedTerminalEnabled',
          'claudeUnifiedTerminalHost',
          'claudeUnifiedTerminalResumeChoice',
          'claudeUnifiedTerminalWorkspaceTrust',
        ],
      },
    ],
  },
} satisfies PluginSettingsContribution;

type ClaudeSettingsDefaults = {
  claudeRemoteAgentSdkEnabled: boolean;
  claudeCodeExperimentalAgentTeamsEnabled: boolean;
  claudeUnifiedTerminalEnabled: boolean;
  claudeUnifiedTerminalHost: ClaudeUnifiedTerminalHost;
  claudeUnifiedTerminalResumeChoice: ClaudeUnifiedTerminalResumeChoice;
  claudeUnifiedTerminalWorkspaceTrust: ClaudeUnifiedTerminalWorkspaceTrustPolicy;
  claudeRemoteSettingSources: 'project' | 'user_project' | 'none';
  claudeRemoteSettingSourcesV2: ClaudeSettingSourceV2[];
  claudeLocalPermissionBridgeEnabled: boolean;
  claudeLocalPermissionBridgeWaitIndefinitely: boolean;
  claudeLocalPermissionBridgeTimeoutSeconds: number;
  claudeRemoteEnableFileCheckpointing: boolean;
  claudeRemoteMaxThinkingTokens: number | null;
  claudeRemoteDisableTodos: boolean;
  claudeRemoteStrictMcpServerConfig: boolean;
  claudeRemoteDebugEnabled: boolean;
  claudeRemoteVerboseEnabled: boolean;
  claudeRemoteDebugCategories: ClaudeRemoteDebugCategory[];
  claudeRemoteAdvancedOptionsJson: string;
};

function deriveSettingsDefaults<T extends object>(
  fields: readonly { id: string; default?: unknown }[],
): T {
  const defaults: Record<string, unknown> = {};
  fields.forEach((field) => {
    defaults[field.id] = field.default;
  });
  return Object.assign({} as T, defaults);
}

export const CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS = deriveSettingsDefaults<ClaudeSettingsDefaults>(
  CLAUDE_AGENT_SETTINGS_CONTRIBUTION.fields,
);
